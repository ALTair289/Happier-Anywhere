import { describe, expect, it, vi } from 'vitest';

import {
  buildProviderAccountUsageRecordId,
  ProviderAccountUsageSnapshotV1Schema,
  writeProviderAccountUsageRecordIdToMetadata,
  type ConnectedServiceUsageSourceV1,
  type ProviderAccountUsageSnapshotV1,
} from '@happier-dev/protocol';

import type { Credentials } from '@/persistence';

import {
  hydrateProviderAccountUsageStoreFromCurrentSources,
  hydrateProviderAccountUsageStoreFromSessionMetadata,
} from './hydration';
import { createProviderAccountUsageStore } from './store';

function createUsageSnapshot(): ProviderAccountUsageSnapshotV1 {
  const recordKey = {
    providerId: 'codex',
    accountSubjectId: 'acct-work',
    subjectKind: 'account' as const,
    quotaScope: 'account' as const,
  };
  return ProviderAccountUsageSnapshotV1Schema.parse({
    v: 1,
    recordId: buildProviderAccountUsageRecordId(recordKey),
    recordKey,
    providerId: 'codex',
    accountSubject: { kind: 'providerSubject', id: 'acct-work' },
    observedAtMs: 1_700_000_000_000,
    fetchedAtMs: 1_700_000_000_000,
    staleAfterMs: 60_000,
    source: 'runtimeSignal',
    confidence: 'confirmed',
    state: 'loaded_data',
    planLabel: 'Pro',
    accountLabel: 'work@example.com',
    meters: [],
  });
}

function createCredentials(): Credentials {
  return {
    token: 'happy-token',
    encryption: { type: 'legacy', secret: new Uint8Array(32).fill(7) },
  };
}

describe('hydrateProviderAccountUsageStoreFromSessionMetadata', () => {
  it('hydrates canonical usage records and durable connected-service sources referenced by session metadata', async () => {
    const snapshot = createUsageSnapshot();
    const source: ConnectedServiceUsageSourceV1 = {
      serviceId: 'openai-codex',
      profileId: 'work',
      bindingKind: 'group_member',
      groupId: 'team',
      groupGeneration: 4,
    };
    const metadata = writeProviderAccountUsageRecordIdToMetadata({}, {
      recordId: snapshot.recordId,
      updatedAtMs: snapshot.fetchedAtMs,
    });
    const store = createProviderAccountUsageStore();
    const getProviderAccountUsageSnapshotPlain = vi.fn(async () => ({
      content: { t: 'plain' as const, v: snapshot },
      sources: [source],
    }));

    const result = await hydrateProviderAccountUsageStoreFromSessionMetadata({
      trackedSessions: [{
        happySessionId: 'session-1',
        happySessionMetadataFromLocalWebhook: metadata,
      }],
      api: {
        getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
        getProviderAccountUsageSnapshotPlain,
      },
      credentials: createCredentials(),
      store,
    });

    expect(result.hydratedRecordIds).toEqual([snapshot.recordId]);
    expect(getProviderAccountUsageSnapshotPlain).toHaveBeenCalledWith({ recordId: snapshot.recordId });
    expect(store.resolveRecordId(snapshot.recordId)?.accountLabel).toBe('work@example.com');
    expect(store.resolveBySource(source)?.recordId).toBe(snapshot.recordId);
  });
});

describe('hydrateProviderAccountUsageStoreFromCurrentSources', () => {
  const source = {
    serviceId: 'openai-codex',
    profileId: 'work',
    bindingKind: 'group_member',
    groupId: 'team',
    groupGeneration: 4,
  } as const satisfies ConnectedServiceUsageSourceV1;

  it('passively hydrates a fresh canonical record only after exact current-source proof', async () => {
    const snapshot = createUsageSnapshot();
    const store = createProviderAccountUsageStore();
    const resolveRecordIdForSource = vi.fn(async () => ({ recordId: snapshot.recordId }));

    const result = await hydrateProviderAccountUsageStoreFromCurrentSources({
      sources: [source, source],
      resolveRecordIdForSource,
      api: {
        getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
        getProviderAccountUsageSnapshotPlain: vi.fn(async () => ({
          content: { t: 'plain' as const, v: snapshot },
          sources: [source],
        })),
      },
      credentials: createCredentials(),
      store,
      nowMs: snapshot.fetchedAtMs + 1,
    });

    expect(resolveRecordIdForSource).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      hydratedRecordIds: [snapshot.recordId],
      dispositions: [{ source, status: 'hydrated_fresh', recordId: snapshot.recordId }],
      refreshSources: [],
    });
    expect(store.resolveBySource(source)?.recordId).toBe(snapshot.recordId);
  });

  it('does not adopt a record when the authoritative response omits the exact source proof', async () => {
    const snapshot = createUsageSnapshot();
    const store = createProviderAccountUsageStore();
    const mismatchedGeneration = { ...source, groupGeneration: 3 };

    const result = await hydrateProviderAccountUsageStoreFromCurrentSources({
      sources: [source],
      resolveRecordIdForSource: async () => ({ recordId: snapshot.recordId }),
      api: {
        getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
        getProviderAccountUsageSnapshotPlain: vi.fn(async () => ({
          content: { t: 'plain' as const, v: snapshot },
          sources: [mismatchedGeneration],
        })),
      },
      credentials: createCredentials(),
      store,
      nowMs: snapshot.fetchedAtMs + 1,
    });

    expect(result.dispositions).toEqual([{ source, status: 'ownership_unproven' }]);
    expect(result.refreshSources).toEqual([source]);
    expect(store.listSnapshots()).toEqual([]);
  });

  it('hydrates stale evidence for passive display but returns it for bounded refresh scheduling', async () => {
    const snapshot = createUsageSnapshot();
    const store = createProviderAccountUsageStore();

    const result = await hydrateProviderAccountUsageStoreFromCurrentSources({
      sources: [source],
      resolveRecordIdForSource: async () => ({ recordId: snapshot.recordId }),
      api: {
        getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
        getProviderAccountUsageSnapshotPlain: vi.fn(async () => ({
          content: { t: 'plain' as const, v: snapshot },
          sources: [source],
        })),
      },
      credentials: createCredentials(),
      store,
      nowMs: snapshot.fetchedAtMs + snapshot.staleAfterMs,
    });

    expect(result.dispositions).toEqual([{
      source,
      status: 'hydrated_stale',
      recordId: snapshot.recordId,
    }]);
    expect(result.refreshSources).toEqual([source]);
    expect(store.resolveBySource(source)?.recordId).toBe(snapshot.recordId);
  });

  it('returns missing current sources for refresh without mutating the store', async () => {
    const store = createProviderAccountUsageStore();

    const result = await hydrateProviderAccountUsageStoreFromCurrentSources({
      sources: [source],
      resolveRecordIdForSource: async () => null,
      api: {},
      credentials: createCredentials(),
      store,
      nowMs: 1_700_000_000_000,
    });

    expect(result.dispositions).toEqual([{ source, status: 'missing' }]);
    expect(result.refreshSources).toEqual([source]);
    expect(store.listSnapshots()).toEqual([]);
  });
});
