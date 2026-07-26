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

  it('refreshes an account settings hint before advancing the reconnect cursor', async () => {
    const { runSessionChangesSyncOnConnect } = await import('./sessionChangesSyncOnConnect');
    const events: string[] = [];
    const refreshAccountSettingsForMinimumVersion = vi.fn(async (settingsVersion: number | null) => {
      events.push(`settings:${settingsVersion ?? 'force'}`);
    });

    fetchChanges.mockResolvedValueOnce({
      status: 'ok',
      response: {
        changes: [
          {
            cursor: 1,
            kind: 'account',
            entityId: 'self',
            changedAt: 100,
            hint: { settingsVersion: 5 },
          },
          {
            cursor: 2,
            kind: 'session',
            entityId: 's1',
            changedAt: 101,
            hint: { pendingCount: 1, pendingVersion: 2 },
          },
        ],
        nextCursor: 2,
      },
    });

    await runSessionChangesSyncOnConnect({
      reason: 'reconnect',
      token: 'tok',
      sessionId: 's1',
      lastObservedMessageSeq: 0,
      getAccountId: async () => 'account-1',
      readChangesCursor: async () => 0,
      writeChangesCursor: async (_accountId, cursor) => {
        events.push(`cursor:${cursor}`);
      },
      catchUpSessionMessages: async () => {},
      syncSessionSnapshotFromServer: async () => true,
      applyPendingQueueState: () => {
        events.push('pending');
      },
      refreshAccountSettingsForMinimumVersion,
      onDebug: () => {},
    } satisfies Parameters<typeof runSessionChangesSyncOnConnect>[0]);

    expect(refreshAccountSettingsForMinimumVersion).toHaveBeenCalledWith(5);
    expect(events).toEqual(['settings:5', 'pending', 'cursor:2']);
  });

  it('performs one authoritative settings refresh on reconnect even when no broadcast hint survived', async () => {
    const { runSessionChangesSyncOnConnect } = await import('./sessionChangesSyncOnConnect');
    const events: string[] = [];

    fetchChanges.mockResolvedValueOnce({
      status: 'ok',
      response: { changes: [], nextCursor: 1 },
    });

    await runSessionChangesSyncOnConnect({
      reason: 'reconnect',
      token: 'tok',
      sessionId: 's1',
      lastObservedMessageSeq: 0,
      getAccountId: async () => 'account-1',
      readChangesCursor: async () => 0,
      writeChangesCursor: async (_accountId, cursor) => {
        events.push(`cursor:${cursor}`);
      },
      catchUpSessionMessages: async () => {},
      syncSessionSnapshotFromServer: async () => true,
      refreshAccountSettingsForMinimumVersion: async (settingsVersion) => {
        events.push(`settings:${settingsVersion ?? 'force'}`);
      },
      onDebug: () => {},
    } satisfies Parameters<typeof runSessionChangesSyncOnConnect>[0]);

    expect(events).toEqual(['settings:force', 'cursor:1']);
  });

  it('does not advance the changes cursor past a failed required settings refresh', async () => {
    const { runSessionChangesSyncOnConnect } = await import('./sessionChangesSyncOnConnect');
    const changesCursor = createChangesCursorStore();

    fetchChanges.mockResolvedValueOnce({
      status: 'ok',
      response: {
        changes: [{
          cursor: 1,
          kind: 'account',
          entityId: 'self',
          changedAt: 100,
          hint: { settingsVersion: 5 },
        }],
        nextCursor: 1,
      },
    });

    await expect(runSessionChangesSyncOnConnect({
      reason: 'reconnect',
      token: 'tok',
      sessionId: 's1',
      lastObservedMessageSeq: 0,
      getAccountId: async () => 'account-1',
      ...changesCursor,
      catchUpSessionMessages: async () => {},
      syncSessionSnapshotFromServer: async () => true,
      refreshAccountSettingsForMinimumVersion: async () => {
        throw new Error('settings refresh unavailable');
      },
      onDebug: () => {},
    } satisfies Parameters<typeof runSessionChangesSyncOnConnect>[0])).rejects.toThrow('settings refresh unavailable');

    expect(changesCursor.writeChangesCursor).not.toHaveBeenCalled();
  });

  it('applies pending count/version hints from relevant /v2/changes session entries', async () => {
    const { runSessionChangesSyncOnConnect } = await import('./sessionChangesSyncOnConnect');
    const changesCursor = createChangesCursorStore();
    const applyPendingQueueState = vi.fn();
    const syncSessionSnapshotFromServer = vi.fn(async () => true);

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

  it('does not advance a reconnect cursor until the authoritative session snapshot succeeds', async () => {
    const { runSessionChangesSyncOnConnect } = await import('./sessionChangesSyncOnConnect');
    const changesCursor = createChangesCursorStore();
    let resolveSnapshot!: () => void;
    const snapshotCompleted = new Promise<void>((resolve) => {
      resolveSnapshot = resolve;
    });
    const syncSessionSnapshotFromServer = vi.fn(async () => {
      await snapshotCompleted;
      return true;
    });

    fetchChanges.mockResolvedValueOnce({
      status: 'ok',
      response: {
        changes: [
          {
            cursor: 7,
            kind: 'session',
            entityId: 's1',
            changedAt: 700,
            hint: { pendingCount: 0, pendingVersion: 8 },
          },
        ],
        nextCursor: 7,
      },
    });

    const run = runSessionChangesSyncOnConnect({
      reason: 'reconnect',
      token: 'tok',
      sessionId: 's1',
      lastObservedMessageSeq: 5,
      getAccountId: async () => 'account-1',
      ...changesCursor,
      catchUpSessionMessages: async () => {},
      syncSessionSnapshotFromServer,
      applyPendingQueueState: vi.fn(),
      onDebug: () => {},
    } satisfies Parameters<typeof runSessionChangesSyncOnConnect>[0]);

    await vi.waitFor(() => {
      expect(syncSessionSnapshotFromServer).toHaveBeenCalledWith({ reason: 'socket-reconnect-catchup' });
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(changesCursor.writeChangesCursor).not.toHaveBeenCalled();

    resolveSnapshot();
    await run;
    expect(changesCursor.writeChangesCursor).toHaveBeenCalledWith('account-1', 7);
  });

  it('does not replace a cursor-gone cursor until the recovery snapshot succeeds', async () => {
    const { runSessionChangesSyncOnConnect } = await import('./sessionChangesSyncOnConnect');
    const changesCursor = createChangesCursorStore(3);
    const syncSessionSnapshotFromServer = vi.fn(async () => {
      throw new Error('snapshot unavailable');
    });
    const refreshAccountSettingsForMinimumVersion = vi.fn(async () => {});

    fetchChanges.mockResolvedValueOnce({
      status: 'cursor-gone',
      currentCursor: 8,
    });

    await expect(runSessionChangesSyncOnConnect({
      reason: 'reconnect',
      token: 'tok',
      sessionId: 's1',
      lastObservedMessageSeq: 5,
      getAccountId: async () => 'account-1',
      ...changesCursor,
      catchUpSessionMessages: async () => {},
      syncSessionSnapshotFromServer,
      refreshAccountSettingsForMinimumVersion,
      onDebug: () => {},
    } satisfies Parameters<typeof runSessionChangesSyncOnConnect>[0])).rejects.toThrow('snapshot unavailable');

    expect(refreshAccountSettingsForMinimumVersion).toHaveBeenCalledWith(null);
    expect(syncSessionSnapshotFromServer).toHaveBeenCalledWith({ reason: 'socket-reconnect-catchup' });
    expect(changesCursor.writeChangesCursor).not.toHaveBeenCalled();
  });

  it('does not replace a cursor-gone cursor when reconnect transcript catch-up fails', async () => {
    const { runSessionChangesSyncOnConnect } = await import('./sessionChangesSyncOnConnect');
    const changesCursor = createChangesCursorStore(3);
    const syncSessionSnapshotFromServer = vi.fn(async () => true);

    fetchChanges.mockResolvedValueOnce({
      status: 'cursor-gone',
      currentCursor: 8,
    });

    await runSessionChangesSyncOnConnect({
      reason: 'reconnect',
      token: 'tok',
      sessionId: 's1',
      lastObservedMessageSeq: 5,
      getAccountId: async () => 'account-1',
      ...changesCursor,
      catchUpSessionMessages: async () => {
        throw new Error('transcript catch-up unavailable');
      },
      syncSessionSnapshotFromServer,
      onDebug: () => {},
    } satisfies Parameters<typeof runSessionChangesSyncOnConnect>[0]);

    expect(syncSessionSnapshotFromServer).toHaveBeenCalledWith({ reason: 'socket-reconnect-catchup' });
    expect(changesCursor.writeChangesCursor).not.toHaveBeenCalled();
  });

  it('does not advance a full-page cursor until the fallback snapshot succeeds', async () => {
    const { runSessionChangesSyncOnConnect } = await import('./sessionChangesSyncOnConnect');
    const changesCursor = createChangesCursorStore();
    const syncSessionSnapshotFromServer = vi.fn(async () => {
      throw new Error('snapshot unavailable');
    });
    const refreshAccountSettingsForMinimumVersion = vi.fn(async () => {});

    fetchChanges.mockResolvedValueOnce({
      status: 'ok',
      response: {
        changes: Array.from({ length: 200 }, (_, index) => ({
          cursor: index + 1,
          kind: 'machine',
          entityId: `m${index + 1}`,
          changedAt: index + 1,
          hint: null,
        })),
        nextCursor: 200,
      },
    });

    await expect(runSessionChangesSyncOnConnect({
      reason: 'connect',
      token: 'tok',
      sessionId: 's1',
      lastObservedMessageSeq: 5,
      getAccountId: async () => 'account-1',
      ...changesCursor,
      catchUpSessionMessages: async () => {},
      syncSessionSnapshotFromServer,
      refreshAccountSettingsForMinimumVersion,
      onDebug: () => {},
    } satisfies Parameters<typeof runSessionChangesSyncOnConnect>[0])).rejects.toThrow('snapshot unavailable');

    expect(refreshAccountSettingsForMinimumVersion).toHaveBeenCalledWith(null);
    expect(syncSessionSnapshotFromServer).toHaveBeenCalledWith({ reason: 'socket-connect-catchup' });
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
      reason: 'connect',
      token: 'tok',
      sessionId: 's1',
      lastObservedMessageSeq: 0,
      getAccountId: async () => 'account-1',
      ...firstSessionCursor,
      catchUpSessionMessages: async () => {},
      syncSessionSnapshotFromServer: async () => true,
      applyPendingQueueState: vi.fn(),
      onDebug: () => {},
    } satisfies Parameters<typeof runSessionChangesSyncOnConnect>[0]);

    const applyPendingQueueStateForSecondSession = vi.fn();
    await runSessionChangesSyncOnConnect({
      reason: 'connect',
      token: 'tok',
      sessionId: 's2',
      lastObservedMessageSeq: 0,
      getAccountId: async () => 'account-1',
      ...secondSessionCursor,
      catchUpSessionMessages: async () => {},
      syncSessionSnapshotFromServer: async () => true,
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
      syncSessionSnapshotFromServer: vi.fn(async () => true),
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
