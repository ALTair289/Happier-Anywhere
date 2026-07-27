import {
  isTerminalWorkflowRunStatus,
  type SessionWorkflowActivityHeadlineV1,
} from '@happier-dev/protocol';

export const WORKFLOW_ACTIVITY_STARTUP_RECONCILE_GRACE_MS = 30_000;

export type WorkflowStartupReconcileCandidate = Readonly<{
  runId: string;
  title: string;
  workflowToolUseId?: string;
  totalAgents: number;
  completedAgents: number;
  failedAgents?: number;
  blockedAgents?: number;
}>;

export function collectStartupReconcileCandidates(
  headline: SessionWorkflowActivityHeadlineV1 | null | undefined,
): WorkflowStartupReconcileCandidate[] {
  if (!headline) return [];
  return headline.activeRuns
    .filter((run) => !isTerminalWorkflowRunStatus(run.status))
    .map((run) => ({
      runId: run.runId,
      title: run.title,
      totalAgents: run.totalAgents,
      completedAgents: run.completedAgents,
      ...(run.workflowToolUseId !== undefined ? { workflowToolUseId: run.workflowToolUseId } : {}),
      ...(run.failedAgents !== undefined ? { failedAgents: run.failedAgents } : {}),
      ...(run.blockedAgents !== undefined ? { blockedAgents: run.blockedAgents } : {}),
    }));
}

export function resolveStartupReconcileTargets(
  candidates: readonly WorkflowStartupReconcileCandidate[],
  observedRunIds: ReadonlySet<string>,
): WorkflowStartupReconcileCandidate[] {
  return candidates.filter((candidate) => !observedRunIds.has(candidate.runId));
}
