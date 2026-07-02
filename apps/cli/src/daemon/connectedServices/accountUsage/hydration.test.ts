import { describe, expect, it, vi } from 'vitest';

import {
  buildProviderAccountUsageRecordId,
  ProviderAccountUsageSnapshotV1Schema,
  writeProviderAccountUsageRecordIdToMetadata,
  type ConnectedServiceUsageSourceV1,
  type ProviderAccountUsageSnapshotV1,
} from '@happier-dev/protocol';

import type { Credentials } from '@/persistence';

import { hydrateProviderAccountUsageStoreFromSessionMetadata } from './hydration';
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
