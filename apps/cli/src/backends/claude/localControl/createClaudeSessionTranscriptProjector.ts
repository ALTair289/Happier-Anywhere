import type { Metadata } from '@/api/types';
import { updateMetadataBestEffort } from '@/api/session/sessionWritesBestEffort';
import { mergeSessionWorkStateMetadataV1 } from '@/session/workState/sessionWorkStateMetadata';
import { logger } from '@/ui/logger';

import type { Session } from '../session';
import type { RawJSONLines } from '../types';
import { createClaudeRawMessageTurnDiffBridge } from '../utils/createClaudeRawMessageTurnDiffBridge';
import { isClaudeInternalTranscriptMessage } from '../utils/isClaudeInternalTranscriptMessage';
import { buildClaudeTodoWriteWorkState, createClaudeTaskToolWorkStateTracker } from '../workState/claudeWorkState';
import { createClaudeGoalWorkStateSource } from '../workState/claudeGoalSource';
import {
  CLAUDE_GOAL_WORK_STATE_ITEM_ID,
  CLAUDE_GOAL_WORK_STATE_SOURCE_FAMILY,
} from '../workState/claudeGoalStatus';
import type { ClaudeWorkflowActivitySource } from '../workflows/claudeWorkflowActivitySource';
import { filterWorkflowOwnedWorkStateItems } from '../workflows/claudeWorkflowOwnedWorkState';
import { mapClaudeRateLimitEventToUsageDetails, type NormalizedProviderUsageLimitDetailsV1 } from '../connectedServices/mapClaudeRateLimitEventToUsageDetails';
import { surfaceClaudeRateLimitRuntimeIssue } from '../connectedServices/surfaceClaudeRuntimeIssues';
import {
  buildClaudeCompactionCompletedEvent,
  buildClaudeCompactionLifecycleId,
  buildClaudeCompactionStartedEvent,
} from '../contextCompactionEvents';
import { buildClaudeSessionModelsMetadataWithCurrentModelId } from '../remote/buildClaudeSessionModelsMetadataFromSupportedModels';

type ClaudeLocalWorkStateSnapshot = ReturnType<typeof buildClaudeTodoWriteWorkState>
  & Readonly<{ ownedSourceFamilies?: readonly string[] }>;

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

/**
 * The CLAUDE transcript session id for this session, read from the metadata snapshot (set from the
 * Claude `system.session_id`). This — NOT the Happier `session.sessionId` — is what `goal_status`
 * attachments are matched against. May be null early (before the snapshot populates); the goal
 * source then self-learns it from the observed transcript records.
 */
function readClaudeSessionIdFromSession(session: Session): string | null {
  return readString(session.client.getMetadataSnapshot?.()?.claudeSessionId);
}

type CompactCommandMarkerKind = 'local-command' | 'plain';

function readCompactCommandMarkerKind(message: RawJSONLines): CompactCommandMarkerKind | null {
  const record = message as Record<string, unknown>;
  const nested = readRecord(record.message);
  const content = nested?.content;
  const texts = typeof content === 'string'
    ? [content]
    : Array.isArray(content)
      ? content.flatMap((entry) => {
        const entryRecord = readRecord(entry);
        const text = readString(entryRecord?.text ?? entryRecord?.content ?? entry);
        return text ? [text] : [];
      })
      : [];
  if (texts.some((text) => text.includes('<command-name>/compact</command-name>'))) return 'local-command';
  if (texts.some((text) => text.trim() === '/compact')) return 'plain';
  return null;
}

function readSystemSubtype(message: RawJSONLines): string | null {
  return message.type === 'system' ? readString((message as Record<string, unknown>).subtype) : null;
}

/**
 * Effective model id carried on a main-chain assistant transcript row.
 *
 * Sidechain rows are skipped (subagents may run a different model) and synthetic placeholders
 * (e.g. `<synthetic>` on API-error rows) are never real model ids.
 */
function readMainChainAssistantModelId(message: RawJSONLines): string | null {
  if (message.type !== 'assistant') return null;
  const record = message as Record<string, unknown>;
  if (record.isSidechain === true) return null;
  const model = readString(readRecord(record.message)?.model);
  if (!model || model.includes('<')) return null;
  return model;
}

export function createClaudeSessionTranscriptProjector(params: Readonly<{
  session: Session;
  logPrefix: string;
  /**
   * Centralized Claude Dynamic Workflow ACTIVITY source (CWF2/CWF3/CWF4), wired by the launcher with
   * the session credentials + stored-content encryption it needs for durable `activity/workflow_run.v1`
   * records. The projector feeds it the SAME raw transcript channel that drives the goal source
   * (`observeRaw`), and applies its CWF4 owned-id filter at the work-state merge chokepoint so
   * workflow agents do not ALSO render as top-level task/todo rows. Optional: when absent (e.g. no
   * credentials yet) the goal/work-state path is unchanged.
   */
  workflowActivitySource?: ClaudeWorkflowActivitySource | null;
}>): Readonly<{
  observe(message: RawJSONLines): void;
  observeRaw(value: unknown): void;
  /**
   * Remove the published Claude goal work-state item (used by the active-session clear effector,
   * since Claude's `/goal clear` emits no `goal_status`). Idempotent.
   */
  clearGoalWorkState(): void;
  /**
   * Record a goal-control SET intent (used by the active-session set effector) so re-setting the same
   * objective after a clear is accepted instead of suppressed as a stale post-clear replay (G2).
   */
  recordGoalSetIntent(): void;
  /** Drain pending workflow-activity writes immediately (turn end / stream close / finalize). No-op without a source. */
  flushWorkflowActivity(): Promise<void>;
  reset(): void;
}> {
  const workflowActivitySource = params.workflowActivitySource ?? null;
  const turnDiffBridge = createClaudeRawMessageTurnDiffBridge({
    getSessionId: () => params.session.sessionId ?? params.session.client.sessionId ?? 'unknown',
    sendMessage: (message) => {
      params.session.client.sendClaudeSessionMessage(message);
    },
  });
  const publishWorkStateSnapshot = (snapshot: ClaudeLocalWorkStateSnapshot): void => {
    // CWF4 coherence: a canonical Workflow run's agents live in the durable `activity/workflow_run.v1`
    // record + workflow UI surfaces. Drop any work-state rows the workflow normalizer marked
    // workflow-owned BEFORE the merge, so they do not ALSO render as top-level task/todo rows. The
    // pure filter preserves the snapshot's extra fields (e.g. `ownedSourceFamilies`) and is a no-op
    // when no source is wired or it owns nothing.
    const filtered = (workflowActivitySource
      ? filterWorkflowOwnedWorkStateItems(snapshot, workflowActivitySource.getWorkflowOwnedAgentToolUseIds())
      : snapshot) as ClaudeLocalWorkStateSnapshot;
    // The Claude goal item id (`goal:claude`) is NOT namespaced under its source family, so
    // source-family ownership alone cannot REMOVE it on an empty (clear) snapshot. Declare the goal
    // item id explicitly so a clear (empty goal snapshot) actually drops the existing goal item.
    const ownedItemIds = (filtered.ownedSourceFamilies ?? []).includes(CLAUDE_GOAL_WORK_STATE_SOURCE_FAMILY)
      ? [CLAUDE_GOAL_WORK_STATE_ITEM_ID]
      : undefined;
    updateMetadataBestEffort(
      params.session.client,
      (metadata) => mergeSessionWorkStateMetadataV1({
        metadata,
        nextOwned: filtered,
        ownedSourceFamilies: filtered.ownedSourceFamilies,
        ...(ownedItemIds ? { ownedItemIds } : {}),
      }) as unknown as Metadata,
      params.logPrefix,
      'claude_terminal_work_state',
    );
  };
  const taskToolWorkStateTracker = createClaudeTaskToolWorkStateTracker({
    backendId: 'claude',
    agentId: 'claude',
  });
  // Centralized Claude native `/goal` source (plan H6/H7). The `goal_status`
  // attachment and the system/init `slash_commands` records are control
  // bookkeeping the session scanner DROPS before the post-strip `onMessage`
  // channel (`isClaudeInternalTranscriptMessage` → true for `type:'attachment'`
  // and side-channels `system` rows — the F2 "keep attachments out of the visible
  // transcript" gate). They survive ONLY on the scanner's RAW channel, so the
  // goal source is fed from `observeRaw` (the raw transcript value), NOT from
  // `observe` — which would never see a goal_status anyway. Every Claude launcher
  // wires the raw transcript channel into `observeRaw`, so there is ONE goal-source
  // implementation observing ONE channel, not per-launcher routing.
  const goalWorkStateSource = createClaudeGoalWorkStateSource({
    backendId: 'claude',
    agentId: 'claude',
    publishWorkStateSnapshot: (snapshot) => publishWorkStateSnapshot(snapshot),
    // The CLAUDE transcript session id (NOT the Happier `session.sessionId`) — the goal source
    // matches `goal_status` attachments against it. Null until known; the source then self-learns it
    // from the observed transcript records.
    getCurrentClaudeSessionId: () => readClaudeSessionIdFromSession(params.session),
    logPrefix: params.logPrefix,
  });
  const maybeProjectWorkState = (message: RawJSONLines): void => {
    const updatedAt = Date.now();
    const messageRecord = readRecord((message as Record<string, unknown>).message);
    const content = Array.isArray(messageRecord?.content) ? messageRecord.content : [];
    for (const blockValue of content) {
      const block = readRecord(blockValue);
      if (block?.type !== 'tool_use' || block.name !== 'TodoWrite') continue;
      const snapshot = buildClaudeTodoWriteWorkState({
        backendId: 'claude',
        updatedAt,
        input: block.input,
      });
      publishWorkStateSnapshot(snapshot);
    }
    const taskSnapshot = taskToolWorkStateTracker.applyMessage(message, updatedAt);
    if (taskSnapshot) {
      publishWorkStateSnapshot(taskSnapshot);
    }
  };
  const surfaceRateLimit = (details: NormalizedProviderUsageLimitDetailsV1): void => {
    void surfaceClaudeRateLimitRuntimeIssue(params.session, details, params.logPrefix).catch((error) => {
      logger.debug(`${params.logPrefix}: failed to surface Claude rate-limit runtime issue`, error);
    });
  };
  // Terminal-hosted Claude (unified/local) has no SDK system-message stream, so the transcript is
  // the only place the EFFECTIVE model id is visible. Mirroring the SDK launcher's
  // `runtime_model_update` adoption keeps session models metadata (and therefore UI context-window
  // resolution) correct for terminal sessions.
  let lastAdoptedModelId: string | null = null;
  const maybeAdoptEffectiveModel = (message: RawJSONLines): void => {
    const modelId = readMainChainAssistantModelId(message);
    if (!modelId || modelId === lastAdoptedModelId) return;
    lastAdoptedModelId = modelId;
    updateMetadataBestEffort(
      params.session.client,
      (metadata) => ({
        ...metadata,
        ...(buildClaudeSessionModelsMetadataWithCurrentModelId({
          currentModelId: modelId,
          metadata,
        }) ?? {}),
      }),
      params.logPrefix,
      'runtime_model_update',
    );
  };
  let compactionSequence = 0;
  let activeCompactionLifecycleId: string | null = null;
  let suppressNextLocalCommandCompactStart = false;
  const nextCompactionLifecycleId = (): string => buildClaudeCompactionLifecycleId({
    sessionId: params.session.sessionId ?? params.session.client.sessionId,
    sequence: ++compactionSequence,
  });
  const maybeEmitCompactionEvents = (message: RawJSONLines): void => {
    if (readSystemSubtype(message) === 'compact_boundary') {
      const lifecycleId = activeCompactionLifecycleId ?? nextCompactionLifecycleId();
      activeCompactionLifecycleId = null;
      suppressNextLocalCommandCompactStart = true;
      const providerSessionId = readString((message as Record<string, unknown>).session_id);
      params.session.client.sendSessionEvent(buildClaudeCompactionCompletedEvent({
        lifecycleId,
        source: 'provider-event',
        ...(providerSessionId ? { providerSessionId } : {}),
      }));
      return;
    }

    const compactCommandMarkerKind = readCompactCommandMarkerKind(message);
    if (!compactCommandMarkerKind) return;
    if (compactCommandMarkerKind === 'local-command' && suppressNextLocalCommandCompactStart) {
      suppressNextLocalCommandCompactStart = false;
      return;
    }
    suppressNextLocalCommandCompactStart = false;
    if (activeCompactionLifecycleId !== null) return;
    activeCompactionLifecycleId = nextCompactionLifecycleId();
    params.session.client.sendSessionEvent(buildClaudeCompactionStartedEvent({
      lifecycleId: activeCompactionLifecycleId,
    }));
  };

  return {
    observe(message) {
      maybeAdoptEffectiveModel(message);
      maybeProjectWorkState(message);
      maybeEmitCompactionEvents(message);
      const rateLimitDetails = mapClaudeRateLimitEventToUsageDetails(message);
      if (rateLimitDetails) surfaceRateLimit(rateLimitDetails);
      if (isClaudeInternalTranscriptMessage(message)) {
        return;
      }
      const bridged = turnDiffBridge.observe(message);
      if (bridged) {
        params.session.client.sendClaudeSessionMessage(bridged);
        turnDiffBridge.flushAfterForwardIfNeeded();
      }
    },
    // Raw transcript channel (plan H7): the scanner forwards every parsed JSONL
    // value here BEFORE its visible-transcript filtering, so `attachment`
    // (`goal_status`) and `system` (`slash_commands`) records — dropped from
    // `observe` — reach the goal source. `routeClaudeAttachment` + the source
    // already tolerate raw objects. This NEVER emits to the visible transcript.
    observeRaw(value) {
      goalWorkStateSource.observeTranscriptMessage(value);
      // The Claude workflow ACTIVITY source rides the SAME raw transcript channel as the goal source
      // (workflow `task_started`/`task_progress`/`task_completed` rows). One wiring, one channel.
      workflowActivitySource?.observeTranscriptMessage(value);
    },
    clearGoalWorkState() {
      goalWorkStateSource.clearGoalWorkState();
    },
    recordGoalSetIntent() {
      goalWorkStateSource.recordGoalSetIntent();
    },
    async flushWorkflowActivity() {
      if (!workflowActivitySource) return;
      try {
        await workflowActivitySource.flush();
      } catch (error) {
        logger.debug(`${params.logPrefix}: failed to flush Claude workflow activity (non-fatal)`, error);
      }
    },
    reset() {
      turnDiffBridge.reset();
      // Stop scheduling pending workflow-activity writes on session teardown/reset.
      workflowActivitySource?.dispose();
    },
  };
}
