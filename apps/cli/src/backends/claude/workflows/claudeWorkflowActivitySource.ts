import {
  isTerminalWorkflowRunStatus,
  type SessionWorkflowActivityHeadlineV1,
  type SessionWorkflowRunSnapshotV1,
} from '@happier-dev/protocol';

import {
  resolveStartupReconcileTargets,
  type WorkflowStartupReconcileCandidate,
} from './workflowActivityStartupReconcile';

import {
  createCoalescedWorkflowActivityPublisher,
} from '@/session/systemRecords/activity/coalescedWorkflowActivityPublisher';
import {
  createWorkflowActivityPublisher,
} from '@/session/systemRecords/activity/publishWorkflowActivitySnapshot';
import { logger } from '@/ui/logger';

import type { ClaudeProviderRuntimeActivityPublisher } from '../providerActivity/createClaudeProviderActivityLedger';
import {
  buildClaudeProviderTaskRuntimeActivitySourceId,
  CLAUDE_PROVIDER_TASK_RUNTIME_ACTIVITY_SOURCE_CLASS,
  CLAUDE_RUNTIME_ACTIVITY_PROVIDER_ID,
} from '../providerActivity/createClaudeProviderActivityLedger';
import { createClaudeWorkflowActivityTracker } from './claudeWorkflowActivityTracker';
import {
  createClaudeWorkflowJournalFollower,
  type ClaudeWorkflowJournalFollower,
} from './claudeWorkflowJournalFollower';

/**
 * Centralized Claude Dynamic Workflow ACTIVITY source (CWF2/CWF3/CWF4).
 *
 * The ONE place that turns raw Claude transcript values into durable provider-agnostic workflow
 * activity. It mirrors `createClaudeGoalWorkStateSource`: every Claude launcher wires the SAME raw
 * transcript channel (`observeRaw`) here, so there is one normalizer observing one channel rather
 * than per-launcher routing.
 *
 * Pipeline:
 *   raw transcript value
 *     -> tracker.observe (CWF2: per-run Map, parent_tool_use_id routing, explicit-wins, phases[])
 *     -> coalesced publisher (CWF3: record-first/headline-second, per-run debounce + immediate flush)
 *
 * Boundary functions (`commitRecord`/`writeHeadline`) are injected so this source stays Claude-clean
 * and unit-testable; the launcher/projector binds them to the session's credentials/encryption mode
 * + the metadata best-effort writer.
 */
export type ClaudeWorkflowActivitySource = Readonly<{
  /** Observe one raw transcript value (same raw channel as the goal source). Non-workflow noise is ignored. */
  observeTranscriptMessage(message: unknown): void;
  /** Workflow-owned subagent/agent tool-use ids — the CWF4 hook to suppress duplicate work-state rows. */
  getWorkflowOwnedAgentToolUseIds(): ReadonlySet<string>;
  /** Drain pending writes immediately (terminal flush / stream close / session finalization). */
  flush(): Promise<void>;
  /**
   * Startup reconciliation (W-1): given the stale non-terminal runs read from the persisted
   * headline, synthetically terminate to `stopped`/`interrupted` any that this fresh source has NOT
   * re-observed live. Flows through the normal tracker -> coalesced-publisher path (one writer).
   */
  reconcileStartupInterruptedRuns(candidates: readonly WorkflowStartupReconcileCandidate[]): Promise<void>;
  /** Stop scheduling. */
  dispose(): void;
}>;

export function createClaudeWorkflowActivitySource(params: Readonly<{
  backendId: string;
  agentId?: string;
  /** The Claude transcript session id guard (NOT the Happier session id). Null until learned. */
  getCurrentClaudeSessionId: () => string | null;
  /** Durable per-run record write bound to the session's credentials + encryption mode/ctx. */
  commitRecord: (snapshot: SessionWorkflowRunSnapshotV1) => Promise<void>;
  /** Headline metadata best-effort write (rides the normal session metadata path). */
  writeHeadline: (headline: SessionWorkflowActivityHeadlineV1) => Promise<void> | void;
  /** Optional canonical runtime-activity projection publisher for live workflow liveness. */
  runtimeActivityPublisher?: ClaudeProviderRuntimeActivityPublisher | null;
  debounceMs?: number;
  logPrefix?: string;
}>): ClaudeWorkflowActivitySource {
  const logPrefix = params.logPrefix ?? '[claude-workflow-source]';

  const tracker = createClaudeWorkflowActivityTracker({
    backendId: params.backendId,
    ...(params.agentId ? { agentId: params.agentId } : {}),
    getCurrentClaudeSessionId: params.getCurrentClaudeSessionId,
  });

  // W-4 lease heartbeat: tie runtime-activity liveness to the durable write cadence. Assigned after
  // the runtime-activity helpers below exist; called on EVERY successful durable commit (not only on
  // `changedRunIds` observations) so a long-running workflow with sparse progress never lets the
  // ephemeral "working" lease lapse while its durable record still says active.
  let renewRuntimeLeaseAfterCommit: (snapshot: SessionWorkflowRunSnapshotV1) => void = () => {};

  const publisher = createWorkflowActivityPublisher({
    backendId: params.backendId,
    ...(params.agentId ? { agentId: params.agentId } : {}),
    commitRecord: async (snapshot) => {
      await params.commitRecord(snapshot);
      renewRuntimeLeaseAfterCommit(snapshot);
    },
    writeHeadline: params.writeHeadline,
    onError: (error, ctx) => {
      logger.debug(`${logPrefix}: durable workflow record write failed for run ${ctx.runId} (will retry)`, error);
    },
  });

  const coalesced = createCoalescedWorkflowActivityPublisher({
    publisher,
    getSnapshots: () => tracker.getRunSnapshotMap(),
    ...(params.debounceMs !== undefined ? { debounceMs: params.debounceMs } : {}),
    onError: (error) => {
      logger.debug(`${logPrefix}: workflow activity publish drain failed (non-fatal)`, error);
    },
  });

  let journalFollower: ClaudeWorkflowJournalFollower | null = null;

  const runRuntimeActivityEffect = (
    reason: string,
    effect: () => Promise<void> | void,
  ): void => {
    try {
      void Promise.resolve(effect()).catch((error) => {
        logger.debug(`${logPrefix}: workflow runtime activity ${reason} failed (non-fatal)`, error);
      });
    } catch (error) {
      logger.debug(`${logPrefix}: workflow runtime activity ${reason} failed (non-fatal)`, error);
    }
  };

  const publishedRuntimeSourceIdByRunId = new Map<string, string>();

  const workflowRuntimeSourceId = (runId: string): string | null => {
    const sourceKey = tracker.getRuntimeActivitySourceKeyForRunId(runId) ?? runId;
    return buildClaudeProviderTaskRuntimeActivitySourceId(sourceKey);
  };

  const ensurePublishedRuntimeSourceId = (
    runId: string,
    sourceId: string,
    runtimeActivityPublisher: ClaudeProviderRuntimeActivityPublisher,
  ): boolean => {
    const existing = publishedRuntimeSourceIdByRunId.get(runId);
    if (existing === sourceId) return false;
    if (existing) {
      runRuntimeActivityEffect('source-rekey', () => runtimeActivityPublisher.clearSource(
        existing,
        'claude_workflow_runtime_source_rekeyed',
      ));
    }
    publishedRuntimeSourceIdByRunId.set(runId, sourceId);
    return true;
  };

  const publishRuntimeActivityObservation = (observation: ReturnType<typeof tracker.observe>): void => {
    const runtimeActivityPublisher = params.runtimeActivityPublisher;
    if (!runtimeActivityPublisher) return;

    const terminalRunIds = new Set(observation.terminalRunIds);
    for (const runId of observation.startedRunIds) {
      if (terminalRunIds.has(runId)) continue;
      const sourceId = workflowRuntimeSourceId(runId);
      if (!sourceId) continue;
      ensurePublishedRuntimeSourceId(runId, sourceId, runtimeActivityPublisher);
      runRuntimeActivityEffect('source-active', () => runtimeActivityPublisher.setSourceActive({
        id: sourceId,
        sourceClass: CLAUDE_PROVIDER_TASK_RUNTIME_ACTIVITY_SOURCE_CLASS,
        providerId: CLAUDE_RUNTIME_ACTIVITY_PROVIDER_ID,
      }));
    }
    for (const runId of observation.changedRunIds) {
      if (terminalRunIds.has(runId) || observation.startedRunIds.includes(runId)) continue;
      const sourceId = workflowRuntimeSourceId(runId);
      if (!sourceId) continue;
      if (ensurePublishedRuntimeSourceId(runId, sourceId, runtimeActivityPublisher)) {
        runRuntimeActivityEffect('source-active', () => runtimeActivityPublisher.setSourceActive({
          id: sourceId,
          sourceClass: CLAUDE_PROVIDER_TASK_RUNTIME_ACTIVITY_SOURCE_CLASS,
          providerId: CLAUDE_RUNTIME_ACTIVITY_PROVIDER_ID,
        }));
      } else {
        runRuntimeActivityEffect('source-observed', () => runtimeActivityPublisher.observeSource({
          id: sourceId,
          reason: 'claude_workflow_activity_changed',
        }));
      }
    }
    for (const runId of observation.terminalRunIds) {
      const sourceId = workflowRuntimeSourceId(runId);
      if (!sourceId) continue;
      const existingSourceId = publishedRuntimeSourceIdByRunId.get(runId);
      publishedRuntimeSourceIdByRunId.delete(runId);
      if (existingSourceId && existingSourceId !== sourceId) {
        runRuntimeActivityEffect('source-terminal', () => runtimeActivityPublisher.clearSource(
          existingSourceId,
          'claude_workflow_terminal',
        ));
      }
      runRuntimeActivityEffect('source-terminal', () => runtimeActivityPublisher.clearSource(
        sourceId,
        'claude_workflow_terminal',
      ));
    }
  };

  const clearPublishedRuntimeSources = (reason: string): void => {
    const runtimeActivityPublisher = params.runtimeActivityPublisher;
    if (!runtimeActivityPublisher) {
      publishedRuntimeSourceIdByRunId.clear();
      return;
    }
    const sourceIds = new Set(publishedRuntimeSourceIdByRunId.values());
    publishedRuntimeSourceIdByRunId.clear();
    for (const sourceId of sourceIds) {
      runRuntimeActivityEffect('source-clear', () => runtimeActivityPublisher.clearSource(sourceId, reason));
    }
  };

  renewRuntimeLeaseAfterCommit = (snapshot: SessionWorkflowRunSnapshotV1): void => {
    const runtimeActivityPublisher = params.runtimeActivityPublisher;
    if (!runtimeActivityPublisher) return;
    // Terminal runs clear their source via the observation path; do not renew a lease we are about
    // to (or already did) clear.
    if (isTerminalWorkflowRunStatus(snapshot.status)) return;
    const sourceId = publishedRuntimeSourceIdByRunId.get(snapshot.runId) ?? workflowRuntimeSourceId(snapshot.runId);
    if (!sourceId) return;
    // `observeSource` is a no-op when the source is not active, so an out-of-order commit before the
    // source is announced simply does nothing — safe.
    runRuntimeActivityEffect('commit-heartbeat', () => runtimeActivityPublisher.observeSource({
      id: sourceId,
      reason: 'claude_workflow_durable_commit',
    }));
  };

  const reconcileStartupInterruptedRuns = async (
    candidates: readonly WorkflowStartupReconcileCandidate[],
  ): Promise<void> => {
    if (candidates.length === 0) return;
    // Runs the fresh tracker has already learned were genuinely resumed; exclude them.
    const observedRunIds = new Set(tracker.getRunSnapshotMap().keys());
    const targets = resolveStartupReconcileTargets(candidates, observedRunIds);
    if (targets.length === 0) return;
    const updatedAt = Date.now();
    for (const target of targets) {
      const observation = tracker.reconcileInterruptedRunFromHeadline(target, { updatedAt });
      if (observation.changedRunIds.length === 0) continue;
      logger.debug(`${logPrefix}: reconciling interrupted workflow run ${target.runId} (stopped/interrupted)`);
      publishRuntimeActivityObservation(observation);
      coalesced.notify(observation);
    }
    await coalesced.flush();
  };

  const observeTrackerValue = (message: unknown): void => {
    const observation = tracker.observe(message, { updatedAt: Date.now() });
    if (observation.changedRunIds.length === 0) return;
    publishRuntimeActivityObservation(observation);
    for (const runId of observation.terminalRunIds) {
      journalFollower?.markRunCompleted(runId);
    }
    coalesced.notify(observation);
  };

  journalFollower = createClaudeWorkflowJournalFollower({
    logPrefix,
    onJournalValue: observeTrackerValue,
  });

  return {
    observeTranscriptMessage(message) {
      observeTrackerValue(message);
      journalFollower.observeTranscriptMessage(message);
    },
    getWorkflowOwnedAgentToolUseIds() {
      return tracker.getWorkflowOwnedAgentToolUseIds();
    },
    async flush() {
      await journalFollower?.syncAll();
      await coalesced.flush();
    },
    reconcileStartupInterruptedRuns,
    dispose() {
      clearPublishedRuntimeSources('claude_workflow_source_disposed');
      journalFollower?.dispose();
      coalesced.dispose();
    },
  };
}
