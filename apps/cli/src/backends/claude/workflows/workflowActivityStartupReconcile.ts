import {
  isTerminalWorkflowRunStatus,
  type SessionWorkflowActivityHeadlineV1,
} from '@happier-dev/protocol';

/**
 * Startup reconciliation for stuck Claude workflow runs (W-1 / plan #4).
 *
 * A CLI crash/SIGKILL leaves `active`/`blocked`/`unknown` workflow runs pinned forever in the
 * `sessionWorkflowActivityHeadlineV1` metadata pointer: the graceful `finally`-flush never ran, the
 * restarted process builds a FRESH tracker with no memory of those runs, and the server is a dumb
 * store with no TTL. This module derives which of those stale runs should be synthetically
 * terminated to `stopped` (`statusReason: 'interrupted'`).
 *
 * It is intentionally provider-agnostic and side-effect-free: it only computes descriptors. The
 * caller (`wireClaudeWorkflowActivitySource`) waits a grace period, then feeds each target back
 * through the EXISTING tracker -> coalesced-publisher path (one writer), so a genuinely-resumed run
 * that re-observes live within the grace period is NOT reconciled (it will be in the tracker's
 * observed set and thus excluded).
 */

/** Grace period after startup before a still-unobserved stale run is treated as interrupted. */
export const WORKFLOW_ACTIVITY_STARTUP_RECONCILE_GRACE_MS = 30_000;

/**
 * A stale run from a prior process lifetime, carried enough of its headline detail to rebuild a
 * faithful terminal snapshot (counts are preserved so the interrupted card still reads e.g. "3/17").
 */
export type WorkflowStartupReconcileCandidate = Readonly<{
  runId: string;
  title: string;
  workflowToolUseId?: string;
  totalAgents: number;
  completedAgents: number;
  failedAgents?: number;
  blockedAgents?: number;
}>;

/**
 * Read the non-terminal runs from a persisted headline that are candidates for reconciliation.
 * `activeRuns` already excludes terminal statuses (the builder partitions them into `recentRuns`),
 * but the terminal guard is kept for defence in depth against a hand-written headline.
 */
export function collectStartupReconcileCandidates(
  headline: SessionWorkflowActivityHeadlineV1 | null | undefined,
): WorkflowStartupReconcileCandidate[] {
  if (!headline) return [];
  const candidates: WorkflowStartupReconcileCandidate[] = [];
  for (const run of headline.activeRuns) {
    if (isTerminalWorkflowRunStatus(run.status)) continue;
    candidates.push({
      runId: run.runId,
      title: run.title,
      totalAgents: run.totalAgents,
      completedAgents: run.completedAgents,
      ...(run.workflowToolUseId !== undefined ? { workflowToolUseId: run.workflowToolUseId } : {}),
      ...(run.failedAgents !== undefined ? { failedAgents: run.failedAgents } : {}),
      ...(run.blockedAgents !== undefined ? { blockedAgents: run.blockedAgents } : {}),
    });
  }
  return candidates;
}

/**
 * Given the startup candidates and the set of run ids the fresh tracker has observed live since
 * startup, return the candidates to synthetically terminate — those that were NOT re-observed
 * (crash residue). A candidate the tracker already knows was genuinely resumed and is left alone.
 */
export function resolveStartupReconcileTargets(
  candidates: readonly WorkflowStartupReconcileCandidate[],
  observedRunIds: ReadonlySet<string>,
): WorkflowStartupReconcileCandidate[] {
  return candidates.filter((candidate) => !observedRunIds.has(candidate.runId));
}
