import { describe, expect, it } from 'vitest';

import {
  SESSION_WORKFLOW_RUN_SNAPSHOT_PROJECTION_VERSION,
  type SessionWorkflowRunSnapshotV1,
} from '@happier-dev/protocol';

import {
  decryptSessionPayload,
  type SessionEncryptionContext,
} from '@/session/transport/encryption/sessionEncryptionContext';

function buildSnapshot(overrides: Partial<SessionWorkflowRunSnapshotV1> = {}): SessionWorkflowRunSnapshotV1 {
  return {
    v: 1,
    projectionVersion: SESSION_WORKFLOW_RUN_SNAPSHOT_PROJECTION_VERSION,
    runId: 'wf_1',
    backendId: 'claude',
    title: 'ship-feature',
    status: 'active',
    recordRevision: '1',
    updatedAt: 1000,
    totalAgents: 2,
    completedAgents: 1,
    phases: [{ id: 'phase:1', title: 'Research', order: 1, agentIds: ['agent_1', 'agent_2'] }],
    agents: [
      { id: 'agent_1', title: 'web_search', status: 'complete', updatedAt: 1000 },
      { id: 'agent_2', title: 'doc_reader', status: 'active', updatedAt: 1000 },
    ],
    ...overrides,
  };
}

describe('activity system record helpers', () => {
  it('builds deterministic activity localIds and exposes the activity namespace/kind', async () => {
    const {
      ACTIVITY_SYSTEM_RECORD_NAMESPACE,
      ACTIVITY_SYSTEM_RECORD_KINDS,
      buildWorkflowRunSystemRecordLocalId,
    } = await import('./activitySystemRecords');

    expect(ACTIVITY_SYSTEM_RECORD_NAMESPACE).toBe('activity');
    expect(ACTIVITY_SYSTEM_RECORD_KINDS.workflowRun).toBe('workflow_run.v1');
    expect(buildWorkflowRunSystemRecordLocalId({ runId: 'wf_1' })).toBe('activity:workflow_run:v1:wf_1');
  });

  it('seals and opens plaintext workflow run snapshots', async () => {
    const {
      ACTIVITY_SYSTEM_RECORD_NAMESPACE,
      openWorkflowRunSystemRecordPayload,
      sealWorkflowRunSystemRecordPayload,
    } = await import('./activitySystemRecords');

    const payload = buildSnapshot();
    const content = sealWorkflowRunSystemRecordPayload({ mode: 'plain', payload });

    expect(content).toEqual({ t: 'plain', v: payload });
    expect(openWorkflowRunSystemRecordPayload({
      namespace: ACTIVITY_SYSTEM_RECORD_NAMESPACE,
      content,
    })).toEqual(payload);
  });

  it('seals encrypted workflow run snapshots and opens them with the session encryption context', async () => {
    const {
      openWorkflowRunSystemRecordPayload,
      sealWorkflowRunSystemRecordPayload,
    } = await import('./activitySystemRecords');

    const key = new Uint8Array(32).fill(9);
    const ctx: SessionEncryptionContext = { encryptionKey: key, encryptionVariant: 'legacy' };
    const payload = buildSnapshot({ runId: 'wf_enc', status: 'complete' });

    const content = sealWorkflowRunSystemRecordPayload({ mode: 'e2ee', ctx, payload });

    expect(content.t).toBe('encrypted');
    if (content.t !== 'encrypted') return;
    expect(decryptSessionPayload({ ctx, ciphertextBase64: content.c })).toEqual(payload);
    expect(openWorkflowRunSystemRecordPayload({ content, ctx })).toEqual(payload);
  });

  it('rejects an invalid snapshot at seal time', async () => {
    const { sealWorkflowRunSystemRecordPayload } = await import('./activitySystemRecords');
    expect(() => sealWorkflowRunSystemRecordPayload({
      mode: 'plain',
      // @ts-expect-error intentionally malformed payload for the rejection path
      payload: { v: 1, runId: '', backendId: 'claude' },
    })).toThrow();
  });

  it('rejects stale pre-projection-version workflow snapshots at seal/open time', async () => {
    const { openWorkflowRunSystemRecordPayload, sealWorkflowRunSystemRecordPayload } = await import('./activitySystemRecords');
    const stale: Record<string, unknown> = { ...buildSnapshot() };
    delete stale.projectionVersion;

    expect(() => sealWorkflowRunSystemRecordPayload({
      mode: 'plain',
      // @ts-expect-error intentionally stale pre-version payload for the rejection path
      payload: stale,
    })).toThrow();
    expect(openWorkflowRunSystemRecordPayload({ content: { t: 'plain', v: stale } })).toBeNull();
  });

  it('requires the encryption context for encrypted seal/open', async () => {
    const { openWorkflowRunSystemRecordPayload, sealWorkflowRunSystemRecordPayload } = await import('./activitySystemRecords');
    expect(() => sealWorkflowRunSystemRecordPayload({ mode: 'e2ee', payload: buildSnapshot() })).toThrow();
    // Opening an encrypted envelope without a ctx fails soft (null), it does not throw.
    expect(openWorkflowRunSystemRecordPayload({ content: { t: 'encrypted', c: 'x' } })).toBeNull();
  });

  it('returns null when opening a record from a foreign namespace', async () => {
    const { openWorkflowRunSystemRecordPayload, sealWorkflowRunSystemRecordPayload } = await import('./activitySystemRecords');
    const content = sealWorkflowRunSystemRecordPayload({ mode: 'plain', payload: buildSnapshot() });
    expect(openWorkflowRunSystemRecordPayload({ namespace: 'memory', content })).toBeNull();
  });
});
