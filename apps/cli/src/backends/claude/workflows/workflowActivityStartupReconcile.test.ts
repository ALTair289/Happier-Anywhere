import { buildSessionWorkflowActivityHeadline, type SessionWorkflowRunHeadlineV1 } from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';

import {
  WORKFLOW_ACTIVITY_STARTUP_RECONCILE_GRACE_MS,
  collectStartupReconcileCandidates,
  resolveStartupReconcileTargets,
} from './workflowActivityStartupReconcile';

function headlineRun(overrides: Partial<SessionWorkflowRunHeadlineV1> & { runId: string }): SessionWorkflowRunHeadlineV1 {
  return {
    title: `run ${overrides.runId}`,
    status: 'active',
    updatedAt: 1000,
    recordRevision: '1',
    recordUpdatedAt: 1000,
    totalAgents: 17,
    completedAgents: 3,
    ...overrides,
  };
}

describe('workflowActivityStartupReconcile', () => {
  it('exposes a positive grace constant', () => {
    expect(WORKFLOW_ACTIVITY_STARTUP_RECONCILE_GRACE_MS).toBeGreaterThan(0);
  });

  it('collects non-terminal active runs from the headline, preserving counts + ids', () => {
    const headline = buildSessionWorkflowActivityHeadline({
      backendId: 'claude',
      updatedAt: 2000,
      runs: [
        headlineRun({ runId: 'wf_active', workflowToolUseId: 'toolu_active', totalAgents: 17, completedAgents: 3, blockedAgents: 1 }),
        headlineRun({ runId: 'wf_done', status: 'complete' }),
      ],
    });

    const candidates = collectStartupReconcileCandidates(headline);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toEqual({
      runId: 'wf_active',
      title: 'run wf_active',
      workflowToolUseId: 'toolu_active',
      totalAgents: 17,
      completedAgents: 3,
      blockedAgents: 1,
    });
  });

  it('returns no candidates for a missing/empty headline', () => {
    expect(collectStartupReconcileCandidates(null)).toEqual([]);
    expect(collectStartupReconcileCandidates(undefined)).toEqual([]);
  });

  it('reconciles crash-residue runs the fresh tracker never re-observed', () => {
    const candidates = collectStartupReconcileCandidates(buildSessionWorkflowActivityHeadline({
      backendId: 'claude',
      updatedAt: 2000,
      runs: [headlineRun({ runId: 'wf_crashed' })],
    }));
    const targets = resolveStartupReconcileTargets(candidates, new Set());
    expect(targets.map((t) => t.runId)).toEqual(['wf_crashed']);
  });

  it('does NOT reconcile a run that was genuinely resumed (re-observed within grace)', () => {
    const candidates = collectStartupReconcileCandidates(buildSessionWorkflowActivityHeadline({
      backendId: 'claude',
      updatedAt: 2000,
      runs: [
        headlineRun({ runId: 'wf_resumed' }),
        headlineRun({ runId: 'wf_crashed' }),
      ],
    }));
    const targets = resolveStartupReconcileTargets(candidates, new Set(['wf_resumed']));
    expect(targets.map((t) => t.runId)).toEqual(['wf_crashed']);
  });
});
