import {
  resolveStartupReconcileTargets,
  type WorkflowStartupReconcileCandidate,
} from './workflowActivityStartupReconcile';
import {
  type SessionWorkflowActivityHeadlineV1,
  type SessionWorkflowRunSnapshotV1,
} from '@happier-dev/protocol';

import {
  createCoalescedWorkflowActivityPublisher,
} from '@/session/systemRecords/activity/coalescedWorkflowActivityPublisher';
import {
  createWorkflowActivityPublisher,
} from '@/session/systemRecords/activity/publishWorkflowActivitySnapshot';
import { logger } from '@/ui/logger';

import type { ClaudeProviderTaskActivity } from '../providerActivity/createClaudeProviderActivityLedger';
import { createClaudeWorkflowActivityTracker } from './claudeWorkflowActivityTracker';
import {
  createClaudeWorkflowJournalFollower,
  type ClaudeWorkflowJournalFollower,
} from './claudeWorkflowJournalFollower';
import type { ClaudeWorkflowTaskReference } from './claudeWorkflowTaskReference';

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
  observeTranscriptMessage(
    message: unknown,
    observation?: Readonly<{ historicalReplay?: boolean }>,
  ): void;
  /** Workflow-owned subagent/agent tool-use ids — the CWF4 hook to suppress duplicate work-state rows. */
  getWorkflowOwnedAgentToolUseIds(): ReadonlySet<string>;
  /** True when the native provider task id is owned by Dynamic Workflow. */
  isWorkflowOwnedProviderTaskId(taskId: string): boolean;
  /** True when a task-notification task/tool reference is owned by Dynamic Workflow. */
  isWorkflowOwnedTaskReference(reference: ClaudeWorkflowTaskReference): boolean;
  /** Drain pending writes immediately (terminal flush / stream close / session finalization). */
  flush(): Promise<void>;
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
  /** Durable readback used to continue record revisions across source restarts. */
  readCommittedRunSnapshot?: (runId: string) => Promise<SessionWorkflowRunSnapshotV1 | null>;
  /** Headline metadata best-effort write (rides the normal session metadata path). */
  writeHeadline: (headline: SessionWorkflowActivityHeadlineV1) => Promise<void> | void;
  /** Exact live provider-task facts consumed by Claude's single Runtime Activity adapter. */
  onProviderTaskActivity?: (activity: ClaudeProviderTaskActivity) => Promise<void> | void;
  debounceMs?: number;
  logPrefix?: string;
}>): ClaudeWorkflowActivitySource {
  const logPrefix = params.logPrefix ?? '[claude-workflow-source]';

  const tracker = createClaudeWorkflowActivityTracker({
    backendId: params.backendId,
    ...(params.agentId ? { agentId: params.agentId } : {}),
    getCurrentClaudeSessionId: params.getCurrentClaudeSessionId,
  });

  const publisher = createWorkflowActivityPublisher({
    backendId: params.backendId,
    ...(params.agentId ? { agentId: params.agentId } : {}),
    ...(params.readCommittedRunSnapshot
      ? { readCommittedRunSnapshot: params.readCommittedRunSnapshot }
      : {}),
    commitRecord: async (snapshot) => {
      await params.commitRecord(snapshot);
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
  let providerTaskActivityTail: Promise<void> = Promise.resolve();

  const publishProviderTaskActivities = (
    activities: readonly ClaudeProviderTaskActivity[] | undefined,
  ): void => {
    if (!params.onProviderTaskActivity || !activities?.length) return;
    for (const activity of activities) {
      const publish = async (): Promise<void> => {
        try {
          await params.onProviderTaskActivity?.(activity);
        } catch (error) {
          logger.debug(`${logPrefix}: exact workflow provider-task activity failed (non-fatal)`, error);
        }
      };
      providerTaskActivityTail = providerTaskActivityTail.then(publish, publish);
    }
  };

  const reconcileStartupInterruptedRuns = async (
    candidates: readonly WorkflowStartupReconcileCandidate[],
  ): Promise<void> => {
    const observedRunIds = tracker.getLiveObservedRunIds();
    const targets = resolveStartupReconcileTargets(candidates, observedRunIds);
    if (targets.length === 0) return;
    const updatedAt = Date.now();
    for (const target of targets) {
      const observation = tracker.reconcileInterruptedRunFromHeadline(target, { updatedAt });
      if (observation.changedRunIds.length === 0) continue;
      logger.debug(`${logPrefix}: reconciling interrupted workflow run ${target.runId} (stopped/interrupted)`);
      coalesced.notify(observation);
    }
    await coalesced.flush();
  };

  const observeTrackerValue = (
    message: unknown,
    observationContext?: Readonly<{ historicalReplay?: boolean }>,
  ): void => {
    const observation = tracker.observe(message, {
      updatedAt: Date.now(),
      live: observationContext?.historicalReplay !== true,
    });
    if (observationContext?.historicalReplay !== true) {
      publishProviderTaskActivities(observation.providerTaskActivities);
    }
    if (observation.changedRunIds.length === 0) return;
    if (observationContext?.historicalReplay === true) return;
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
    observeTranscriptMessage(message, observationContext) {
      observeTrackerValue(message, observationContext);
      if (observationContext?.historicalReplay !== true) {
        journalFollower.observeTranscriptMessage(message);
      }
    },
    getWorkflowOwnedAgentToolUseIds() {
      return tracker.getWorkflowOwnedAgentToolUseIds();
    },
    isWorkflowOwnedProviderTaskId(taskId) {
      return tracker.isWorkflowOwnedProviderTaskId(taskId);
    },
    isWorkflowOwnedTaskReference(reference) {
      return tracker.isWorkflowOwnedTaskReference(reference);
    },
    async flush() {
      await journalFollower?.syncAll();
      await coalesced.flush();
      await providerTaskActivityTail;
    },
    reconcileStartupInterruptedRuns,
    dispose() {
      journalFollower?.dispose();
      coalesced.dispose();
    },
  };
}
