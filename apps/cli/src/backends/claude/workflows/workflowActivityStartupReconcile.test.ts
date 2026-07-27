import { buildSessionWorkflowActivityHeadline, type SessionWorkflowRunHeadlineV1 } from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';

import {
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
  it('selects only non-terminal runs not re-observed by the restarted process', () => {
    const candidates = collectStartupReconcileCandidates(buildSessionWorkflowActivityHeadline({
      backendId: 'claude',
      updatedAt: 2000,
      runs: [
        headlineRun({ runId: 'wf_resumed' }),
        headlineRun({ runId: 'wf_crashed', workflowToolUseId: 'toolu_crashed' }),
        headlineRun({ runId: 'wf_done', status: 'complete' }),
      ],
    }));

    expect(resolveStartupReconcileTargets(candidates, new Set(['wf_resumed']))).toEqual([{
      runId: 'wf_crashed',
      title: 'run wf_crashed',
      workflowToolUseId: 'toolu_crashed',
      totalAgents: 17,
      completedAgents: 3,
    }]);
  });
});
