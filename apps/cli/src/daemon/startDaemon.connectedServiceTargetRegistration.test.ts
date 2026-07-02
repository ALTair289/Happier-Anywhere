import { describe, expect, it, vi } from 'vitest';

import {
  buildProviderAccountUsageRecordId,
  SESSION_CONTINUATION_RECOVERY_METADATA_KEY,
  sealProviderAccountUsageSnapshotCiphertext,
  writeProviderAccountUsageRecordIdToMetadata,
  type ProviderAccountUsageRecordKeyV1,
  type ProviderAccountUsageSnapshotV1,
  type SessionContinuationRecoveryV1,
} from '@happier-dev/protocol';

import { HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY } from './connectedServices/connectedServiceChildEnvironment';
import { createProviderAccountUsageStore } from './connectedServices/accountUsage/store';
import { ConnectedServiceRuntimeRegistry } from './connectedServices/runtimeRegistry/registry';
import {
  hydrateProviderAccountUsageStoreForDaemon,
  registerConnectedServiceTrackedSessionTargetsForDaemon,
  replayExactPendingConnectedServiceContinuationsForDaemon,
} from './startDaemon';
import type { TrackedSession } from './types';

function createProviderAccountUsageSnapshot(accountSubjectId = 'acct_live_codex'): ProviderAccountUsageSnapshotV1 {
  const recordKey: ProviderAccountUsageRecordKeyV1 = {
    providerId: 'codex',
    accountSubjectId,
    subjectKind: 'account',
    quotaScope: 'account',
  };
  return {
    v: 1,
    recordId: buildProviderAccountUsageRecordId(recordKey),
    recordKey,
    providerId: 'codex',
    accountSubject: { kind: 'providerSubject', id: accountSubjectId },
    observedAtMs: 1_000,
    fetchedAtMs: 1_000,
    staleAfterMs: 300_000,
    source: 'runtimeSignal',
    confidence: 'confirmed',
    state: 'loaded_data',
    planLabel: 'Pro',
    accountLabel: 'codex@example.com',
    meters: [{
      meterId: 'weekly',
      label: 'Weekly',
      used: null,
      limit: null,
      unit: 'unknown',
      utilizationPct: 25,
      remainingPct: 75,
      resetsAt: 600_000,
      status: 'ok',
      details: { limitCategory: 'usage_limit' },
    }],
  };
}

describe('registerConnectedServiceTrackedSessionTargetsForDaemon', () => {
  it('registers a reattached connected-service session directly with the runtime registry', () => {
    const connectedServiceSelectionsEnv = {
      [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{
        kind: 'group',
        serviceId: 'openai-codex',
        groupId: 'team',
        activeProfileId: 'codex1',
        fallbackProfileId: 'codex2',
        generation: 7,
      }]),
    };
    const tracked: TrackedSession = {
      pid: 6510,
      startedBy: 'daemon',
      happySessionId: 'sess-reattached-connected-service',
      reattachedFromDiskMarker: true,
      spawnOptions: {
        directory: '/tmp/reattached-workspace',
        backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
        connectedServiceMaterializationIdentityV1: {
          v: 1,
          id: 'csm_reattached_connected_service',
          createdAtMs: 1_000,
        },
        connectedServices: {
          v: 1,
          bindingsByServiceId: {
            'openai-codex': {
              source: 'connected',
              selection: 'group',
              groupId: 'team',
              profileId: 'codex1',
            },
          },
        },
        environmentVariables: connectedServiceSelectionsEnv,
      },
    };
    const runtimeRegistry = new ConnectedServiceRuntimeRegistry();

    registerConnectedServiceTrackedSessionTargetsForDaemon({
      tracked,
      runtimeRegistry,
    });

    expect(runtimeRegistry.getByPid(6510)).toMatchObject({
      pid: 6510,
      agentId: 'codex',
      sessionId: 'sess-reattached-connected-service',
      materializationKey: 'csm_reattached_connected_service',
      connectedServiceMaterializationIdentityV1: {
        v: 1,
        id: 'csm_reattached_connected_service',
        createdAtMs: 1_000,
      },
      sessionDirectory: '/tmp/reattached-workspace',
      connectedServicesBindingsRaw: tracked.spawnOptions?.connectedServices,
      connectedServiceSelectionsEnv,
    });
    expect(runtimeRegistry.getBySessionId('sess-reattached-connected-service')?.pid).toBe(6510);
    expect(runtimeRegistry.listRefreshTargets()).toHaveLength(1);
    expect(runtimeRegistry.listQuotaTargets()).toHaveLength(1);
  });
});

describe('hydrateProviderAccountUsageStoreForDaemon', () => {
  it('opens durable provider-account-usage record ids from passive reconstruction metadata into the local store', async () => {
    const snapshot = createProviderAccountUsageSnapshot();
    const store = createProviderAccountUsageStore();
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      getProviderAccountUsageSnapshotPlain: vi.fn(async ({ recordId }: { recordId: string }) => (
        recordId === snapshot.recordId
          ? {
              content: { t: 'plain' as const, v: snapshot },
              metadata: { fetchedAt: snapshot.fetchedAtMs, staleAfterMs: snapshot.staleAfterMs, status: 'ok' as const },
            }
          : null
      )),
      getProviderAccountUsageSnapshotSealed: vi.fn(async () => null),
    };

    await expect(hydrateProviderAccountUsageStoreForDaemon({
      trackedSessions: [{
        happySessionId: 'sess-reattached-connected-service',
        spawnOptions: { directory: '/tmp/reattached-workspace' },
      }],
      resolvePersistedSessionMetadata: async () => writeProviderAccountUsageRecordIdToMetadata({}, {
        recordId: snapshot.recordId,
        updatedAtMs: 2_000,
      }),
      api,
      credentials: {
        token: 'happy-token',
        encryption: { type: 'legacy', secret: new Uint8Array(32).fill(7) },
      },
      store,
    })).resolves.toEqual({ hydratedRecordIds: [snapshot.recordId] });

    expect(api.getProviderAccountUsageSnapshotPlain).toHaveBeenCalledWith({ recordId: snapshot.recordId });
    expect(store.resolveRecordId(snapshot.recordId)).toEqual(snapshot);
  });

  it('ignores decrypted account-usage records whose id does not match passive reconstruction metadata', async () => {
    const requestedSnapshot = createProviderAccountUsageSnapshot('acct_requested_codex');
    const mismatchedSnapshot = createProviderAccountUsageSnapshot('acct_other_codex');
    const store = createProviderAccountUsageStore();
    const credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(7) },
    };
    const ciphertext = sealProviderAccountUsageSnapshotCiphertext({
      material: { type: 'legacy', secret: credentials.encryption.secret },
      payload: mismatchedSnapshot,
      randomBytes: (length) => new Uint8Array(length).fill(5),
    });
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'e2ee' as const),
      getProviderAccountUsageSnapshotPlain: vi.fn(async () => null),
      getProviderAccountUsageSnapshotSealed: vi.fn(async ({ recordId }: { recordId: string }) => (
        recordId === requestedSnapshot.recordId
          ? { sealed: { format: 'account_scoped_v1' as const, ciphertext } }
          : null
      )),
    };

    await expect(hydrateProviderAccountUsageStoreForDaemon({
      trackedSessions: [{
        happySessionId: 'sess-reattached-connected-service',
        spawnOptions: { directory: '/tmp/reattached-workspace' },
      }],
      resolvePersistedSessionMetadata: async () => writeProviderAccountUsageRecordIdToMetadata({}, {
        recordId: requestedSnapshot.recordId,
        updatedAtMs: 2_000,
      }),
      api,
      credentials,
      store,
    })).resolves.toEqual({ hydratedRecordIds: [] });

    expect(store.resolveRecordId(requestedSnapshot.recordId)).toBeNull();
    expect(store.resolveRecordId(mismatchedSnapshot.recordId)).toBeNull();
  });
});

describe('replayExactPendingConnectedServiceContinuationsForDaemon', () => {
  const tracked = (sessionId: string): TrackedSession => ({
    pid: 7520,
    startedBy: 'daemon',
    happySessionId: sessionId,
    reattachedFromDiskMarker: true,
    spawnOptions: {
      directory: '/tmp/reattached-workspace',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
    },
  });

  const pendingRecovery: SessionContinuationRecoveryV1 = {
    v: 1,
    attemptsById: {
      'durable-attempt-1': {
        v: 1,
        attemptId: 'durable-attempt-1',
        status: 'pending_provider_context',
        failureAtMs: 1_000,
        updatedAtMs: 1_100,
        resumePromptMode: 'standard',
        replayMode: 'continuation_prompt',
        continuationRequired: true,
      },
    },
  };

  const terminalRecovery: SessionContinuationRecoveryV1 = {
    v: 1,
    attemptsById: {
      'terminal-attempt-1': {
        v: 1,
        attemptId: 'terminal-attempt-1',
        status: 'retry_required',
        failureAtMs: 1_000,
        updatedAtMs: 1_100,
        resumePromptMode: 'standard',
      },
    },
  };

  it('does not resolve replay for passively reattached sessions without pending durable continuation metadata', async () => {
    const resolvePersistedSessionMetadata = vi.fn(async () => ({ path: '/tmp/reattached-workspace' }));
    const resolvePendingContinuation = vi.fn(async () => {});

    await expect(replayExactPendingConnectedServiceContinuationsForDaemon({
      trackedSessions: [tracked('session-without-pending-operation')],
      resolvePersistedSessionMetadata,
      resolvePendingContinuation,
    })).resolves.toEqual({ attemptedSessionIds: [] });

    expect(resolvePersistedSessionMetadata).toHaveBeenCalledTimes(1);
    expect(resolvePendingContinuation).not.toHaveBeenCalled();
  });

  it('resolves replay only for sessions with non-terminal durable continuation attempts', async () => {
    const resolvePersistedSessionMetadata = vi.fn(async ({ sessionId }: { sessionId: string }) => {
      if (sessionId === 'session-with-pending-operation') {
        return { [SESSION_CONTINUATION_RECOVERY_METADATA_KEY]: pendingRecovery };
      }
      return { [SESSION_CONTINUATION_RECOVERY_METADATA_KEY]: terminalRecovery };
    });
    const resolvePendingContinuation = vi.fn(async () => {});

    await expect(replayExactPendingConnectedServiceContinuationsForDaemon({
      trackedSessions: [
        tracked('session-with-pending-operation'),
        tracked('session-with-terminal-operation'),
      ],
      resolvePersistedSessionMetadata,
      resolvePendingContinuation,
    })).resolves.toEqual({ attemptedSessionIds: ['session-with-pending-operation'] });

    expect(resolvePendingContinuation).toHaveBeenCalledTimes(1);
    expect(resolvePendingContinuation).toHaveBeenCalledWith({
      sessionId: 'session-with-pending-operation',
      exactProviderContextAvailable: true,
    });
  });
});
