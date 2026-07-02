import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AxiosError, AxiosHeaders } from 'axios';

const fetchChanges = vi.fn();

vi.mock('../changes', () => ({ fetchChanges }));

function createChangesCursorStore(initialCursor = 0): {
  readChangesCursor: (accountId: string) => Promise<number>;
  writeChangesCursor: (accountId: string, cursor: number) => Promise<void>;
} {
  let cursor = initialCursor;
  return {
    readChangesCursor: vi.fn(async () => cursor),
    writeChangesCursor: vi.fn(async (_accountId, nextCursor) => {
      cursor = nextCursor;
    }),
  };
}

describe('runSessionChangesSyncOnConnect', () => {
  beforeEach(() => {
    fetchChanges.mockReset();
  });

  it('applies pending count/version hints from relevant /v2/changes session entries', async () => {
    const { runSessionChangesSyncOnConnect } = await import('./sessionChangesSyncOnConnect');
    const changesCursor = createChangesCursorStore();
    const applyPendingQueueState = vi.fn();
    const syncSessionSnapshotFromServer = vi.fn(async () => {});

    fetchChanges.mockResolvedValueOnce({
      status: 'ok',
      response: {
        changes: [
          {
            cursor: 1,
            kind: 'session',
            entityId: 's1',
            changedAt: 100,
            hint: { pendingCount: 4, pendingVersion: 12 },
          },
        ],
        nextCursor: 1,
      },
    });

    await runSessionChangesSyncOnConnect({
      reason: 'connect',
      token: 'tok',
      sessionId: 's1',
      lastObservedMessageSeq: 0,
      getAccountId: async () => 'account-1',
      ...changesCursor,
      catchUpSessionMessages: async () => {},
      syncSessionSnapshotFromServer,
      applyPendingQueueState,
      onDebug: () => {},
    } satisfies Parameters<typeof runSessionChangesSyncOnConnect>[0]);

    expect(applyPendingQueueState).toHaveBeenCalledWith({
      known: true,
      pendingCount: 4,
      pendingBlockedCount: 0,
      pendingVersion: 12,
    });
    expect(syncSessionSnapshotFromServer).not.toHaveBeenCalled();
    expect(changesCursor.writeChangesCursor).toHaveBeenCalledWith('account-1', 1);
  });

  it('uses /v2/changes as the stale-socket safety path without forcing a session snapshot', async () => {
    const { runSessionChangesSyncOnConnect } = await import('./sessionChangesSyncOnConnect');
    const changesCursor = createChangesCursorStore();
    const applyPendingQueueState = vi.fn();
    const catchUpSessionMessages = vi.fn(async () => {});
    const syncSessionSnapshotFromServer = vi.fn(async () => {});

    fetchChanges.mockResolvedValueOnce({
      status: 'ok',
      response: {
        changes: [
          {
            cursor: 4,
            kind: 'session',
            entityId: 's1',
            changedAt: 400,
            hint: { pendingCount: 3, pendingVersion: 7 },
          },
        ],
        nextCursor: 4,
      },
    });

    await runSessionChangesSyncOnConnect({
      reason: 'socket-stale-safety-tick',
      token: 'tok',
      sessionId: 's1',
      lastObservedMessageSeq: 9,
      getAccountId: async () => 'account-1',
      ...changesCursor,
      catchUpSessionMessages,
      syncSessionSnapshotFromServer,
      applyPendingQueueState,
      onDebug: () => {},
    } satisfies Parameters<typeof runSessionChangesSyncOnConnect>[0]);

    expect(applyPendingQueueState).toHaveBeenCalledWith({
      known: true,
      pendingCount: 3,
      pendingBlockedCount: 0,
      pendingVersion: 7,
    });
    expect(catchUpSessionMessages).not.toHaveBeenCalled();
    expect(syncSessionSnapshotFromServer).not.toHaveBeenCalled();
    expect(changesCursor.writeChangesCursor).toHaveBeenCalledWith('account-1', 4);
  });

  it('falls back to a degraded snapshot when stale-socket changes are relevant but not self-sufficient', async () => {
    const { runSessionChangesSyncOnConnect } = await import('./sessionChangesSyncOnConnect');
    const changesCursor = createChangesCursorStore();
    const applyPendingQueueState = vi.fn();
    const catchUpSessionMessages = vi.fn(async () => {});
    const syncSessionSnapshotFromServer = vi.fn(async () => {});

    fetchChanges.mockResolvedValueOnce({
      status: 'ok',
      response: {
        changes: [
          {
            cursor: 5,
            kind: 'session',
            entityId: 's1',
            changedAt: 500,
            hint: null,
          },
        ],
        nextCursor: 5,
      },
    });

    await runSessionChangesSyncOnConnect({
      reason: 'socket-stale-safety-tick',
      token: 'tok',
      sessionId: 's1',
      lastObservedMessageSeq: 9,
      getAccountId: async () => 'account-1',
      ...changesCursor,
      catchUpSessionMessages,
      syncSessionSnapshotFromServer,
      applyPendingQueueState,
      onDebug: () => {},
    } satisfies Parameters<typeof runSessionChangesSyncOnConnect>[0]);

    expect(applyPendingQueueState).not.toHaveBeenCalled();
    expect(catchUpSessionMessages).not.toHaveBeenCalled();
    expect(syncSessionSnapshotFromServer).toHaveBeenCalledWith({ reason: 'degraded-socket' });
    expect(changesCursor.writeChangesCursor).toHaveBeenCalledWith('account-1', 5);
  });

  it('does not advance the changes cursor when stale-socket transcript catch-up fails', async () => {
    const { runSessionChangesSyncOnConnect } = await import('./sessionChangesSyncOnConnect');
    const changesCursor = createChangesCursorStore();
    const catchUpSessionMessages = vi.fn(async () => {
      throw new Error('transient message catch-up failure');
    });
    const syncSessionSnapshotFromServer = vi.fn(async () => {});

    fetchChanges.mockResolvedValueOnce({
      status: 'ok',
      response: {
        changes: [
          {
            cursor: 6,
            kind: 'session',
            entityId: 's1',
            changedAt: 600,
            hint: { lastMessageSeq: 10 },
          },
        ],
        nextCursor: 6,
      },
    });

    await runSessionChangesSyncOnConnect({
      reason: 'socket-stale-safety-tick',
      token: 'tok',
      sessionId: 's1',
      lastObservedMessageSeq: 9,
      getAccountId: async () => 'account-1',
      ...changesCursor,
      catchUpSessionMessages,
      syncSessionSnapshotFromServer,
      onDebug: () => {},
    } satisfies Parameters<typeof runSessionChangesSyncOnConnect>[0]);

    expect(catchUpSessionMessages).toHaveBeenCalledWith(9);
    expect(syncSessionSnapshotFromServer).not.toHaveBeenCalled();
    expect(changesCursor.writeChangesCursor).not.toHaveBeenCalled();
  });

  it('does not let one live session advance another live session past its pending hint', async () => {
    const { runSessionChangesSyncOnConnect } = await import('./sessionChangesSyncOnConnect');
    const firstSessionCursor = createChangesCursorStore();
    const secondSessionCursor = createChangesCursorStore();
    fetchChanges.mockImplementation(async ({ after }: { after: number }) => ({
      status: 'ok',
      response: {
        changes: after < 9
          ? [
              {
                cursor: 9,
                kind: 'session',
                entityId: 's2',
                changedAt: 900,
                hint: { pendingCount: 1, pendingVersion: 4 },
              },
            ]
          : [],
        nextCursor: 9,
      },
    }));

    await runSessionChangesSyncOnConnect({
      reason: 'socket-stale-safety-tick',
      token: 'tok',
      sessionId: 's1',
      lastObservedMessageSeq: 0,
      getAccountId: async () => 'account-1',
      ...firstSessionCursor,
      catchUpSessionMessages: async () => {},
      syncSessionSnapshotFromServer: async () => {},
      applyPendingQueueState: vi.fn(),
      onDebug: () => {},
    } satisfies Parameters<typeof runSessionChangesSyncOnConnect>[0]);

    const applyPendingQueueStateForSecondSession = vi.fn();
    await runSessionChangesSyncOnConnect({
      reason: 'socket-stale-safety-tick',
      token: 'tok',
      sessionId: 's2',
      lastObservedMessageSeq: 0,
      getAccountId: async () => 'account-1',
      ...secondSessionCursor,
      catchUpSessionMessages: async () => {},
      syncSessionSnapshotFromServer: async () => {},
      applyPendingQueueState: applyPendingQueueStateForSecondSession,
      onDebug: () => {},
    } satisfies Parameters<typeof runSessionChangesSyncOnConnect>[0]);

    expect(applyPendingQueueStateForSecondSession).toHaveBeenCalledWith({
      known: true,
      pendingCount: 1,
      pendingBlockedCount: 0,
      pendingVersion: 4,
    });
  });

  it('redacts reconnect catch-up diagnostics', async () => {
    const { runSessionChangesSyncOnConnect } = await import('./sessionChangesSyncOnConnect');
    const onDebug = vi.fn();

    fetchChanges.mockResolvedValueOnce({
      status: 'cursor-gone',
      currentCursor: 8,
    });

    await runSessionChangesSyncOnConnect({
      reason: 'reconnect',
      token: 'tok',
      sessionId: 's1',
      lastObservedMessageSeq: 0,
      getAccountId: async () => 'account-1',
      ...createChangesCursorStore(),
      catchUpSessionMessages: async () => {
        throw new AxiosError('Request failed with Authorization: Bearer MESSAGE_SECRET', 'ERR_BAD_RESPONSE', {
          method: 'get',
          url: 'https://api.example.test/v1/sessions/s1/messages?token=QUERY_SECRET',
          headers: new AxiosHeaders({ Authorization: 'Bearer HEADER_SECRET' }),
          data: { access_token: 'BODY_SECRET' },
        });
      },
      syncSessionSnapshotFromServer: vi.fn(async () => {}),
      onDebug,
    } satisfies Parameters<typeof runSessionChangesSyncOnConnect>[0]);

    const payload = JSON.stringify(onDebug.mock.calls.at(-1)?.[1]);
    expect(payload).toContain('https://api.example.test/v1/sessions/s1/messages');
    expect(payload).not.toContain('MESSAGE_SECRET');
    expect(payload).not.toContain('QUERY_SECRET');
    expect(payload).not.toContain('HEADER_SECRET');
    expect(payload).not.toContain('BODY_SECRET');
    expect(payload).not.toContain('"headers"');
    expect(payload).not.toContain('"data"');
  });
});
