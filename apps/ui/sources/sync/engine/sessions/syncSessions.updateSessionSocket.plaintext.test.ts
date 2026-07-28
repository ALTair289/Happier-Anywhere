import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Session } from '@/sync/domains/state/storageTypes';
import { syncPerformanceTelemetry } from '@/sync/runtime/syncPerformanceTelemetry';
import {
  buildUpdatedSessionFromSocketUpdate,
  buildUpdatedSessionProjectionFromSocketUpdate,
} from './syncSessions';

function createSession(params: { sessionId: string; encryptionMode: 'plain' | 'e2ee' }): Session {
  const now = 1_700_000_000_000;
  return {
    id: params.sessionId,
    seq: 1,
    encryptionMode: params.encryptionMode,
    createdAt: now,
    updatedAt: now,
    active: true,
    activeAt: now,
    metadata: { path: '/tmp', host: 'localhost' },
    metadataVersion: 1,
    agentState: {},
    agentStateVersion: 1,
    thinking: false,
    thinkingAt: 0,
    presence: 'online',
    optimisticThinkingAt: null,
  };
}

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('buildUpdatedSessionFromSocketUpdate (plaintext)', () => {
  afterEach(() => {
    syncPerformanceTelemetry.configure({ enabled: false });
    syncPerformanceTelemetry.reset();
  });

  it('parses plaintext metadata and agentState when session encryptionMode is plain', async () => {
    const base = createSession({ sessionId: 's1', encryptionMode: 'plain' });

    const updateBody = {
      metadata: { version: 2, value: JSON.stringify({ path: '/work', host: 'devbox' }) },
      agentState: { version: 3, value: JSON.stringify({ controlledByUser: true }) },
    };

    const { nextSession } = await buildUpdatedSessionFromSocketUpdate({
      session: base,
      updateBody,
      updateSeq: 10,
      updateCreatedAt: 1234,
      sessionEncryption: {
        decryptAgentState: async () => {
          throw new Error('decryptAgentState should not be called for plaintext sessions');
        },
        decryptMetadata: async () => {
          throw new Error('decryptMetadata should not be called for plaintext sessions');
        },
      },
    });

    expect(nextSession.encryptionMode).toBe('plain');
    expect(nextSession.metadataVersion).toBe(2);
    expect(nextSession.metadata).toEqual({ path: '/work', host: 'devbox' });
    expect(nextSession.agentStateVersion).toBe(3);
    const agentState = nextSession.agentState as unknown as { controlledByUser?: unknown };
    expect(agentState.controlledByUser).toBe(true);
  });

  it('applies archivedAt from update-session payloads', async () => {
    const base = createSession({ sessionId: 's1', encryptionMode: 'plain' });

    const { nextSession } = await buildUpdatedSessionFromSocketUpdate({
      session: base,
      updateBody: {
        archivedAt: 123,
      },
      updateSeq: 10,
      updateCreatedAt: 456,
      sessionEncryption: null,
    });

    expect(nextSession.archivedAt).toBe(123);
    expect(nextSession.updatedAt).toBe(456);
  });

  it('applies terminal primary turn projections without encrypted state payloads', async () => {
    const base = {
      ...createSession({ sessionId: 's1', encryptionMode: 'plain' }),
      latestTurnStatus: 'in_progress' as const,
      lastRuntimeIssue: {
        v: 1,
        scope: 'primary_session',
        status: 'failed',
        code: 'old_error',
        source: 'unknown',
        occurredAt: 111,
      } as const,
    };

    const { nextSession } = await buildUpdatedSessionFromSocketUpdate({
      session: base,
      updateBody: {
        latestTurnStatus: 'completed',
        lastRuntimeIssue: null,
      },
      updateSeq: 10,
      updateCreatedAt: 456,
      sessionEncryption: null,
    });

    expect(nextSession.latestTurnStatus).toBe('completed');
    expect(nextSession.lastRuntimeIssue).toBeNull();
    expect(nextSession.agentStateVersion).toBe(base.agentStateVersion);
    expect(nextSession.metadataVersion).toBe(base.metadataVersion);
  });

  it('applies primary turn projection observed timestamps from update-session payloads', async () => {
    const base = createSession({ sessionId: 's1', encryptionMode: 'plain' });

    const { nextSession } = await buildUpdatedSessionFromSocketUpdate({
      session: base,
      updateBody: {
        latestTurnId: 'turn-1',
        latestTurnStatus: 'in_progress',
        latestTurnStatusObservedAt: 123_456,
      },
      updateSeq: 10,
      updateCreatedAt: 456,
      sessionEncryption: null,
    });

    expect(nextSession.latestTurnId).toBe('turn-1');
    expect(nextSession.latestTurnStatus).toBe('in_progress');
    expect(nextSession.latestTurnStatusObservedAt).toBe(123_456);
  });

  it('applies a complete canonical runtime activity update', async () => {
    const base = createSession({ sessionId: 's1', encryptionMode: 'plain' });

    const { nextSession } = await buildUpdatedSessionFromSocketUpdate({
      session: base,
      updateBody: {
        runtimeActivityState: 'active',
        runtimeActivityActiveCount: 2,
        runtimeActivityObservedAt: 123_456,
        runtimeActivityRevision: 4,
      },
      updateSeq: 10,
      updateCreatedAt: 456,
      sessionEncryption: null,
    });

    expect(nextSession.runtimeActivityActiveCount).toBe(2);
    expect(nextSession.runtimeActivityState).toBe('active');
    expect(nextSession.runtimeActivityObservedAt).toBe(123_456);
    expect(nextSession.runtimeActivityRevision).toBe(4);
  });

  it('atomically replaces the Runtime Activity tuple when activity becomes idle', async () => {
    const base = {
      ...createSession({ sessionId: 's1', encryptionMode: 'plain' }),
      runtimeActivityState: 'active' as const,
      runtimeActivityActiveCount: 1,
      runtimeActivityObservedAt: 100,
      runtimeActivityRevision: 3,
    };

    const { nextSession } = await buildUpdatedSessionFromSocketUpdate({
      session: base,
      updateBody: {
        runtimeActivityState: 'idle',
        runtimeActivityActiveCount: 0,
        runtimeActivityObservedAt: 200,
        runtimeActivityRevision: 4,
      },
      updateSeq: 10,
      updateCreatedAt: 456,
      sessionEncryption: null,
    });

    expect(nextSession.runtimeActivityActiveCount).toBe(0);
    expect(nextSession.runtimeActivityObservedAt).toBe(200);
    expect(nextSession.runtimeActivityRevision).toBe(4);
  });

  it.each(['projection-only', 'hydrated'] as const)(
    'applies runtime activity patches monotonically through the %s socket branch',
    async (branch) => {
      const base = {
        ...createSession({ sessionId: `s_runtime_activity_${branch}`, encryptionMode: 'plain' }),
        runtimeActivityState: 'active' as const,
        runtimeActivityActiveCount: 2,
        runtimeActivityObservedAt: 500,
        runtimeActivityRevision: 5,
      };

      const applyUpdate = async (session: Session, updateBody: Record<string, unknown>): Promise<Session> => {
        const common = {
          session,
          updateBody,
          updateSeq: 10,
          updateCreatedAt: 600,
        };
        if (branch === 'projection-only') {
          return buildUpdatedSessionProjectionFromSocketUpdate(common);
        }
        return (await buildUpdatedSessionFromSocketUpdate({
          ...common,
          updateBody: {
            ...updateBody,
            metadata: {
              version: (session.metadataVersion ?? 0) + 1,
              value: JSON.stringify(session.metadata),
            },
          },
          sessionEncryption: null,
        })).nextSession;
      };

      const expectActivity = (session: Session, expected: {
        state: 'active' | 'idle' | 'unknown';
        activeCount: number;
        observedAt: number | null;
        revision: number;
      }) => {
        expect({
          state: session.runtimeActivityState,
          activeCount: session.runtimeActivityActiveCount,
          observedAt: session.runtimeActivityObservedAt,
          revision: session.runtimeActivityRevision,
        }).toEqual(expected);
      };

      const unrelated = await applyUpdate(base, { activeAt: 550 });
      expectActivity(unrelated, {
        state: 'active',
        activeCount: 2,
        observedAt: 500,
        revision: 5,
      });

      for (const revision of [5, 4]) {
        const outOfOrder = await applyUpdate(base, {
          runtimeActivityState: 'idle',
          runtimeActivityActiveCount: 0,
          runtimeActivityObservedAt: 550,
          runtimeActivityRevision: revision,
        });
        expectActivity(outOfOrder, {
          state: 'active',
          activeCount: 2,
          observedAt: 500,
          revision: 5,
        });
      }

      const newer = await applyUpdate(base, {
        runtimeActivityState: 'active',
        runtimeActivityActiveCount: 1,
        runtimeActivityObservedAt: 575,
        runtimeActivityRevision: 6,
      });
      expectActivity(newer, {
        state: 'active',
        activeCount: 1,
        observedAt: 575,
        revision: 6,
      });

      const malformedButOrdered = await applyUpdate(newer, {
        runtimeActivityState: 'active',
        runtimeActivityActiveCount: 0,
        runtimeActivityObservedAt: 590,
        runtimeActivityRevision: 7,
      });
      expectActivity(malformedButOrdered, {
        state: 'active',
        activeCount: 1,
        observedAt: 575,
        revision: 6,
      });
    },
  );

  it('applies runtime activity projection fields from update-session payloads', async () => {
    const base = {
      ...createSession({ sessionId: 's1', encryptionMode: 'plain' }),
      active: true,
      activeAt: 100,
      thinking: true,
      thinkingAt: 100,
    };

    const { nextSession } = await buildUpdatedSessionFromSocketUpdate({
      session: base,
      updateBody: {
        active: false,
        activeAt: 123_456,
      },
      updateSeq: 10,
      updateCreatedAt: 456,
      sessionEncryption: null,
    });

    expect(nextSession.active).toBe(false);
    expect(nextSession.activeAt).toBe(123_456);
    expect(nextSession.thinking).toBe(false);
    expect(nextSession.thinkingAt).toBe(123_456);
  });

  it('clears latest turn id from update-session payloads', async () => {
    const base = {
      ...createSession({ sessionId: 's1', encryptionMode: 'plain' }),
      latestTurnId: 'turn-1',
    };

    const { nextSession } = await buildUpdatedSessionFromSocketUpdate({
      session: base,
      updateBody: {
        latestTurnId: null,
      },
      updateSeq: 10,
      updateCreatedAt: 456,
      sessionEncryption: null,
    });

    expect(nextSession.latestTurnId).toBeNull();
  });

  it('applies flattened rollback eligibility from update-session payloads', async () => {
    const base = createSession({ sessionId: 's1', encryptionMode: 'plain' });

    const { nextSession } = await buildUpdatedSessionFromSocketUpdate({
      session: base,
      updateBody: {
        rollbackEligibleTurnStarts: [1, 3],
      },
      updateSeq: 10,
      updateCreatedAt: 456,
      sessionEncryption: null,
    });

    expect(nextSession.rollbackEligibleTurnStarts).toEqual([1, 3]);
  });

  it('decrypts encrypted metadata and agent-state socket updates in one batch when available', async () => {
    const base = createSession({ sessionId: 's1', encryptionMode: 'e2ee' });
    syncPerformanceTelemetry.configure({ enabled: true, slowThresholdMs: 1_000_000, flushIntervalMs: 60_000 });
    syncPerformanceTelemetry.reset();
    const decryptMetadata = vi.fn(async () => ({ path: '/fallback', host: 'fallback' }));
    const decryptAgentState = vi.fn(async () => ({ controlledByUser: false }));
    const decryptSessionSnapshotState = vi.fn(async () => ({
      metadata: { path: '/work', host: 'devbox' },
      agentState: { controlledByUser: true },
    }));

    const { nextSession } = await buildUpdatedSessionFromSocketUpdate({
      session: base,
      updateBody: {
        metadata: { version: 2, value: 'enc-meta' },
        agentState: { version: 3, value: 'enc-state' },
      },
      updateSeq: 10,
      updateCreatedAt: 1234,
      sessionEncryption: { decryptMetadata, decryptAgentState, decryptSessionSnapshotState },
    });

    expect(decryptSessionSnapshotState).toHaveBeenCalledWith(2, 'enc-meta', 3, 'enc-state');
    expect(decryptMetadata).not.toHaveBeenCalled();
    expect(decryptAgentState).not.toHaveBeenCalled();
    expect(nextSession.metadataVersion).toBe(2);
    expect(nextSession.agentStateVersion).toBe(3);
    expect(nextSession.metadata).toEqual({ path: '/work', host: 'devbox' });
    expect(nextSession.agentState).toEqual({ controlledByUser: true });
    expect(syncPerformanceTelemetry.snapshot().events).toContainEqual(expect.objectContaining({
      name: 'sync.sessions.socket.updateSession.decryptState',
      count: 1,
      fields: expect.objectContaining({
        encrypted: 1,
        metadata: 1,
        agentState: 1,
        batched: 1,
      }),
    }));
  });
});
