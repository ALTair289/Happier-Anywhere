import { describe, expect, it, vi } from 'vitest';

import {
  SESSION_WORKFLOW_RUN_SNAPSHOT_PROJECTION_VERSION,
  type SessionSystemRecordUpsertRequest,
  type SessionWorkflowRunSnapshotV1,
} from '@happier-dev/protocol';

import { commitWorkflowActivitySystemRecord } from './commitWorkflowActivitySystemRecords';

function snapshot(): SessionWorkflowRunSnapshotV1 {
  return {
    v: 1,
    projectionVersion: SESSION_WORKFLOW_RUN_SNAPSHOT_PROJECTION_VERSION,
    runId: 'toolu_wf',
    backendId: 'claude',
    title: 'ship-feature',
    status: 'active',
    recordRevision: '2',
    updatedAt: 1000,
    totalAgents: 1,
    completedAgents: 0,
    phases: [],
    agents: [{ id: 'a1', title: 'agent', status: 'active', updatedAt: 1000 }],
  };
}

describe('commitWorkflowActivitySystemRecord', () => {
  it('upserts under the activity namespace + workflow_run.v1 kind with a stable local id (plain)', async () => {
    const upsert = vi.fn(async (_request: SessionSystemRecordUpsertRequest) => {});
    await commitWorkflowActivitySystemRecord({
      sessionId: 'sess',
      mode: 'plain',
      snapshot: snapshot(),
      upsertSystemRecord: upsert,
    });

    expect(upsert).toHaveBeenCalledTimes(1);
    const call = upsert.mock.calls[0]?.[0];
    expect(call).toMatchObject({
      namespace: 'activity',
      kind: 'workflow_run.v1',
      localId: 'activity:workflow_run:v1:toolu_wf',
    });
    expect(call?.content).toEqual({ t: 'plain', v: expect.objectContaining({ runId: 'toolu_wf' }) });
  });

  it('seals an encrypted envelope for e2ee sessions (never plaintext)', async () => {
    const upsert = vi.fn(async (_request: SessionSystemRecordUpsertRequest) => {});
    await commitWorkflowActivitySystemRecord({
      sessionId: 'sess',
      mode: 'e2ee',
      ctx: { encryptionKey: new Uint8Array(32), encryptionVariant: 'dataKey' },
      snapshot: snapshot(),
      upsertSystemRecord: upsert,
    });
    const content = upsert.mock.calls[0]?.[0].content;
    expect(content).toHaveProperty('t', 'encrypted');
    expect(content).not.toHaveProperty('v');
  });
});
