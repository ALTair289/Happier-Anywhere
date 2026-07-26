import { describe, expect, it, vi } from 'vitest';

import {
  SESSION_WORKFLOW_RUN_SNAPSHOT_PROJECTION_VERSION,
  type SessionWorkflowActivityHeadlineV1,
  type SessionWorkflowRunSnapshotV1,
} from '@happier-dev/protocol';

import { createWorkflowActivityPublisher } from './publishWorkflowActivitySnapshot';

type CommitRecord = (snapshot: SessionWorkflowRunSnapshotV1) => Promise<void>;
type WriteHeadline = (headline: SessionWorkflowActivityHeadlineV1) => Promise<void>;

function runSnapshot(params: Readonly<{
  runId: string;
  status?: SessionWorkflowRunSnapshotV1['status'];
  recordRevision?: string;
  updatedAt?: number;
  totalAgents?: number;
  completedAgents?: number;
}>): SessionWorkflowRunSnapshotV1 {
  return {
    v: 1,
    projectionVersion: SESSION_WORKFLOW_RUN_SNAPSHOT_PROJECTION_VERSION,
    runId: params.runId,
    backendId: 'claude',
    title: `Run ${params.runId}`,
    status: params.status ?? 'active',
    recordRevision: params.recordRevision ?? '1',
    updatedAt: params.updatedAt ?? 1000,
    totalAgents: params.totalAgents ?? 1,
    completedAgents: params.completedAgents ?? 0,
    phases: [],
    agents: [],
  };
}

describe('createWorkflowActivityPublisher', () => {
  it('writes the durable record FIRST, then the headline SECOND', async () => {
    const order: string[] = [];
    const commitRecord = vi.fn<CommitRecord>(async () => { order.push('record'); });
    const writeHeadline = vi.fn<WriteHeadline>(async () => { order.push('headline'); });
    const publisher = createWorkflowActivityPublisher({ commitRecord, writeHeadline, backendId: 'claude' });

    await publisher.publish({
      snapshots: new Map([['a', runSnapshot({ runId: 'a' })]]),
      changedRunIds: ['a'],
    });

    expect(order).toEqual(['record', 'headline']);
    expect(commitRecord).toHaveBeenCalledTimes(1);
    expect(writeHeadline).toHaveBeenCalledTimes(1);
  });

  it('owns the durable decimal record revision sequence', async () => {
    const committed: SessionWorkflowRunSnapshotV1[] = [];
    const commitRecord = vi.fn<CommitRecord>(async (snapshot) => { committed.push(snapshot); });
    const writeHeadline = vi.fn<WriteHeadline>(async () => {});
    const publisher = createWorkflowActivityPublisher({ commitRecord, writeHeadline, backendId: 'claude' });

    await publisher.publish({
      snapshots: new Map([['a', runSnapshot({ runId: 'a', recordRevision: '0', updatedAt: 2000 })]]),
      changedRunIds: ['a'],
    });

    expect(committed[0]?.recordRevision).toBe('1');
    expect(writeHeadline.mock.calls[0]?.[0].activeRuns[0]).toMatchObject({ runId: 'a', recordRevision: '1' });

    await publisher.publish({
      snapshots: new Map([['a', runSnapshot({ runId: 'a', recordRevision: '0', completedAgents: 1, updatedAt: 3000 })]]),
      changedRunIds: ['a'],
    });

    expect(committed[1]?.recordRevision).toBe('2');
    expect(writeHeadline.mock.calls[1]?.[0].activeRuns[0]).toMatchObject({ runId: 'a', recordRevision: '2' });
  });

  it('seeds durable revision state from an existing committed record after publisher restart', async () => {
    const committed: SessionWorkflowRunSnapshotV1[] = [];
    const existing = runSnapshot({
      runId: 'a',
      recordRevision: '7',
      completedAgents: 1,
      updatedAt: 1000,
    });
    const commitRecord = vi.fn<CommitRecord>(async (snapshot) => { committed.push(snapshot); });
    const writeHeadline = vi.fn<WriteHeadline>(async () => {});
    const readCommittedRunSnapshot = vi.fn(async (runId: string) => (runId === 'a' ? existing : null));
    const publisher = createWorkflowActivityPublisher({
      commitRecord,
      writeHeadline,
      readCommittedRunSnapshot,
      backendId: 'claude',
    });

    await publisher.publish({
      snapshots: new Map([[
        'a',
        runSnapshot({
          runId: 'a',
          recordRevision: '1',
          completedAgents: 2,
          updatedAt: 2000,
        }),
      ]]),
      changedRunIds: ['a'],
    });

    expect(readCommittedRunSnapshot).toHaveBeenCalledWith('a');
    expect(committed[0]?.recordRevision).toBe('8');
    expect(writeHeadline.mock.calls[0]?.[0].activeRuns[0]).toMatchObject({ runId: 'a', recordRevision: '8' });
  });

  it('builds a headline whose run entry carries the publisher-committed recordRevision', async () => {
    const commitRecord = vi.fn<CommitRecord>(async () => {});
    const writeHeadline = vi.fn<WriteHeadline>(async () => {});
    const publisher = createWorkflowActivityPublisher({ commitRecord, writeHeadline, backendId: 'claude' });

    await publisher.publish({
      snapshots: new Map([['a', runSnapshot({ runId: 'a', recordRevision: '3', updatedAt: 2000 })]]),
      changedRunIds: ['a'],
    });

    const headline = writeHeadline.mock.calls[0]?.[0];
    expect(headline.activeRuns).toHaveLength(1);
    expect(headline.activeRuns[0]).toMatchObject({ runId: 'a', recordRevision: '1', recordUpdatedAt: expect.any(Number) });
    // Headline must be count-only: no phases/agents leak.
    expect(headline.activeRuns[0]).not.toHaveProperty('phases');
    expect(headline.activeRuns[0]).not.toHaveProperty('agents');
  });

  it('isolates failures per run: a failed record for run A does not block run B', async () => {
    const commitRecord = vi.fn<CommitRecord>(async (snapshot) => {
      if (snapshot.runId === 'a') throw new Error('write failed for A');
    });
    const writeHeadline = vi.fn<WriteHeadline>(async () => {});
    const onError = vi.fn();
    const publisher = createWorkflowActivityPublisher({ commitRecord, writeHeadline, backendId: 'claude', onError });

    await publisher.publish({
      snapshots: new Map([
        ['a', runSnapshot({ runId: 'a', recordRevision: '2' })],
        ['b', runSnapshot({ runId: 'b', recordRevision: '5' })],
      ]),
      changedRunIds: ['a', 'b'],
    });

    // B committed and reached the headline; A's failure was surfaced but did not block B.
    expect(onError).toHaveBeenCalledTimes(1);
    const headline = writeHeadline.mock.calls[0]?.[0];
    const runIds = headline.activeRuns.map((r: { runId: string }) => r.runId);
    expect(runIds).toContain('b');
    // A never committed, so it is omitted from the headline (no stale pointer to a missing record).
    expect(runIds).not.toContain('a');
  });

  it('does not advance a run headline revision when that run\'s record write keeps failing', async () => {
    let attempt = 0;
    const commitRecord = vi.fn<CommitRecord>(async (snapshot) => {
      if (snapshot.runId === 'a') {
        attempt += 1;
        if (attempt === 1) throw new Error('first attempt fails');
      }
    });
    const writeHeadline = vi.fn<WriteHeadline>(async () => {});
    const publisher = createWorkflowActivityPublisher({ commitRecord, writeHeadline, backendId: 'claude', onError: () => {} });

    await publisher.publish({ snapshots: new Map([['a', runSnapshot({ runId: 'a', recordRevision: '2' })]]), changedRunIds: ['a'] });
    // First publish: A failed, headline has no A.
    expect(writeHeadline.mock.calls[0]?.[0].activeRuns).toHaveLength(0);

    await publisher.publish({ snapshots: new Map([['a', runSnapshot({ runId: 'a', recordRevision: '2' })]]), changedRunIds: ['a'] });
    // Second publish: A's record write succeeds; now it appears in the headline at the first durable rev.
    expect(writeHeadline.mock.calls[1]?.[0].activeRuns[0]).toMatchObject({ runId: 'a', recordRevision: '1' });
  });

  it('does not ask the scheduler to retry permanent record-write failures', async () => {
    const error = Object.assign(new Error('Session not found'), { code: 'session_not_found' });
    const commitRecord = vi.fn<CommitRecord>(async () => { throw error; });
    const writeHeadline = vi.fn<WriteHeadline>(async () => {});
    const onError = vi.fn();
    const publisher = createWorkflowActivityPublisher({ commitRecord, writeHeadline, backendId: 'claude', onError });

    const result = await publisher.publish({
      snapshots: new Map([['a', runSnapshot({ runId: 'a' })]]),
      changedRunIds: ['a'],
    });

    expect(result.failedRunIds).toEqual([]);
    expect(result.permanentFailedRunIds).toEqual(['a']);
    expect(onError).toHaveBeenCalledWith(error, { runId: 'a', retryable: false });
    expect(writeHeadline.mock.calls[0]?.[0].activeRuns).toHaveLength(0);
  });

  it('partitions terminal runs into recentRuns and keeps active runs in activeRuns', async () => {
    const commitRecord = vi.fn<CommitRecord>(async () => {});
    const writeHeadline = vi.fn<WriteHeadline>(async () => {});
    const publisher = createWorkflowActivityPublisher({ commitRecord, writeHeadline, backendId: 'claude' });

    await publisher.publish({
      snapshots: new Map([
        ['active', runSnapshot({ runId: 'active', status: 'active' })],
        ['done', runSnapshot({ runId: 'done', status: 'complete' })],
      ]),
      changedRunIds: ['active', 'done'],
    });

    const headline = writeHeadline.mock.calls[0]?.[0];
    expect(headline.activeRuns.map((r: { runId: string }) => r.runId)).toEqual(['active']);
    expect((headline.recentRuns ?? []).map((r: { runId: string }) => r.runId)).toEqual(['done']);
    expect(headline.primaryRunId).toBe('active');
  });

  it('only commits records for changed runs but includes all known runs in the headline', async () => {
    const commitRecord = vi.fn<CommitRecord>(async () => {});
    const writeHeadline = vi.fn<WriteHeadline>(async () => {});
    const publisher = createWorkflowActivityPublisher({ commitRecord, writeHeadline, backendId: 'claude' });

    // First publish establishes both runs.
    await publisher.publish({
      snapshots: new Map([
        ['a', runSnapshot({ runId: 'a' })],
        ['b', runSnapshot({ runId: 'b' })],
      ]),
      changedRunIds: ['a', 'b'],
    });
    commitRecord.mockClear();
    writeHeadline.mockClear();

    // Second publish: only A changed; B's record must NOT be re-committed, but B stays in headline.
    await publisher.publish({
        snapshots: new Map([
        ['a', runSnapshot({ runId: 'a', recordRevision: '2', completedAgents: 1, updatedAt: 2000 })],
        ['b', runSnapshot({ runId: 'b' })],
      ]),
      changedRunIds: ['a'],
    });

    expect(commitRecord).toHaveBeenCalledTimes(1);
    expect(commitRecord.mock.calls[0]?.[0].runId).toBe('a');
    const headline = writeHeadline.mock.calls[0]?.[0];
    expect(headline.activeRuns.map((r: { runId: string }) => r.runId).sort()).toEqual(['a', 'b']);
  });
});
