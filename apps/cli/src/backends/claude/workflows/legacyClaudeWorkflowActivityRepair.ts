import {
  isTerminalWorkflowRunStatus,
  resolvePrimaryWorkflowRunId,
  SessionWorkflowActivityHeadlineV1Schema,
  type SessionWorkflowRunHeadlineV1,
} from '@happier-dev/protocol';

import type { Metadata } from '@/api/types';

/**
 * TECH DEBT (Claude-specific, W-6): this narrow metadata-scrub for legacy async-agent workflow
 * ghosts predates the general startup reconciliation added for W-1
 * (`workflowActivityStartupReconcile.ts` + `wireClaudeWorkflowActivitySource`). Startup
 * reconciliation now terminates ANY stale non-terminal run — a strict superset of these ghosts —
 * by synthesizing a `stopped`/`interrupted` transition through the one-writer tracker path. Keep
 * this repair only until reconciliation has soaked in production, then delete it (it is the sole
 * remaining provider-name branch — `backendId !== 'claude'` — in the shared workflow pipeline).
 */
const LEGACY_AGENT_WORKFLOW_GHOST_MIN_COUNT = 2;
const LEGACY_AGENT_WORKFLOW_GHOST_TITLE = 'Workflow';

function isLegacyAsyncAgentWorkflowGhost(run: SessionWorkflowRunHeadlineV1): boolean {
  return (
    !isTerminalWorkflowRunStatus(run.status)
    && run.title === LEGACY_AGENT_WORKFLOW_GHOST_TITLE
    && run.totalAgents === 0
    && run.completedAgents === 0
    && run.runId.startsWith('toolu_')
    && run.workflowToolUseId === run.runId
  );
}

export function hasLegacyClaudeAsyncAgentWorkflowGhosts(metadata: Metadata | null | undefined): boolean {
  const parsed = SessionWorkflowActivityHeadlineV1Schema.safeParse(metadata?.sessionWorkflowActivityHeadlineV1);
  if (!parsed.success || parsed.data.backendId !== 'claude') return false;
  return parsed.data.activeRuns.filter(isLegacyAsyncAgentWorkflowGhost).length >= LEGACY_AGENT_WORKFLOW_GHOST_MIN_COUNT;
}

export function pruneLegacyClaudeAsyncAgentWorkflowGhostsFromMetadata(
  metadata: Metadata,
  now: () => number = Date.now,
): Metadata {
  const parsed = SessionWorkflowActivityHeadlineV1Schema.safeParse(metadata.sessionWorkflowActivityHeadlineV1);
  if (!parsed.success || parsed.data.backendId !== 'claude') return metadata;

  const activeRuns = parsed.data.activeRuns.filter((run) => !isLegacyAsyncAgentWorkflowGhost(run));
  if (activeRuns.length === parsed.data.activeRuns.length) return metadata;
  if ((parsed.data.activeRuns.length - activeRuns.length) < LEGACY_AGENT_WORKFLOW_GHOST_MIN_COUNT) return metadata;

  return {
    ...metadata,
    sessionWorkflowActivityHeadlineV1: {
      ...parsed.data,
      updatedAt: now(),
      primaryRunId: resolvePrimaryWorkflowRunId(activeRuns),
      activeRuns,
    },
  };
}
