import {
  buildProviderAccountUsageRecordId,
  type ConnectedServiceUsageSourceV1,
  type ProviderAccountUsageRecordKeyV1,
  type ProviderAccountUsageSnapshotV1,
} from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';

type ProviderAccountUsageStore = Readonly<{
  recordSnapshot(
    snapshot: ProviderAccountUsageSnapshotV1,
    observation?: Readonly<{
      sources?: readonly ConnectedServiceUsageSourceV1[];
    }>,
  ): Readonly<{ status: 'recorded'; recordId: string }>;
  resolveRecordId(recordId: string): ProviderAccountUsageSnapshotV1 | null;
  resolveBySource(source: ConnectedServiceUsageSourceV1): ProviderAccountUsageSnapshotV1 | null;
  listSnapshots(): readonly ProviderAccountUsageSnapshotV1[];
}>;

type StoreModule = Readonly<{
  createProviderAccountUsageStore(): ProviderAccountUsageStore;
}>;

async function loadStoreModule(): Promise<StoreModule | null> {
  return await import('./store').catch(() => null) as StoreModule | null;
}

function createKey(accountSubjectId: string): ProviderAccountUsageRecordKeyV1 {
  return {
    providerId: 'claude',
    accountSubjectId,
    subjectKind: accountSubjectId.startsWith('provisional:') ? 'unknown' : 'subscription',
    quotaScope: 'account',
  };
}

function createSnapshot(overrides: Partial<ProviderAccountUsageSnapshotV1> = {}): ProviderAccountUsageSnapshotV1 {
  const recordKey = overrides.recordKey ?? createKey('sub_stable_1');
  return {
    v: 1,
    recordId: buildProviderAccountUsageRecordId(recordKey),
    recordKey,
    providerId: recordKey.providerId,
    accountSubject: {
      kind: recordKey.accountSubjectId.startsWith('provisional:')
        ? 'provisionalLocalSubject'
        : 'providerSubject',
      id: recordKey.accountSubjectId,
    },
    observedAtMs: 1_000,
    fetchedAtMs: 1_000,
    staleAfterMs: 300_000,
    source: 'runtimeSignal',
    confidence: 'confirmed',
    state: 'loaded_data',
    planLabel: 'Team',
    accountLabel: 'same visible label',
    meters: [],
    ...overrides,
  };
}

describe('provider account usage store', () => {
  it('records one stable provider-subject snapshot and resolves explicit sources without exposing alias lookup', async () => {
    const module = await loadStoreModule();
    expect(module).not.toBeNull();
    const store = module!.createProviderAccountUsageStore();
    const stableSnapshot = createSnapshot();
    const firstProvisionalKey = createKey('provisional:native');
    const secondProvisionalKey = createKey('provisional:connected');

    expect(store.recordSnapshot(stableSnapshot, {
      sources: [{
        serviceId: 'anthropic',
        profileId: 'work',
        bindingKind: 'profile',
      }],
    })).toEqual({
      status: 'recorded',
      recordId: stableSnapshot.recordId,
    });
    store.recordSnapshot(createSnapshot({
      recordKey: firstProvisionalKey,
      recordId: buildProviderAccountUsageRecordId(firstProvisionalKey),
      accountSubject: { kind: 'provisionalLocalSubject', id: firstProvisionalKey.accountSubjectId },
      accountLabel: 'same@example.com',
    }));
    store.recordSnapshot(createSnapshot({
      recordKey: secondProvisionalKey,
      recordId: buildProviderAccountUsageRecordId(secondProvisionalKey),
      accountSubject: { kind: 'provisionalLocalSubject', id: secondProvisionalKey.accountSubjectId },
      accountLabel: 'same@example.com',
    }));

    expect('resolveByAlias' in store).toBe(false);
    expect(store.resolveBySource({
      serviceId: 'anthropic',
      profileId: 'work',
      bindingKind: 'profile',
    })?.recordId).toBe(stableSnapshot.recordId);
    expect(store.listSnapshots().map((snapshot) => snapshot.recordKey.accountSubjectId).sort()).toEqual([
      'provisional:connected',
      'provisional:native',
      'sub_stable_1',
    ]);
  });

  it('uses connected-service group generation when resolving group-member sources for policy', async () => {
    const module = await loadStoreModule();
    expect(module).not.toBeNull();
    const store = module!.createProviderAccountUsageStore();
    const snapshot = createSnapshot();
    store.recordSnapshot(snapshot, {
      sources: [{
        serviceId: 'anthropic',
        profileId: 'work',
        bindingKind: 'group_member',
        groupId: 'team',
        groupGeneration: 7,
      }],
    });

    expect(store.resolveBySource({
      serviceId: 'anthropic',
      profileId: 'work',
      bindingKind: 'group_member',
      groupId: 'team',
      groupGeneration: 7,
    })?.recordId).toBe(snapshot.recordId);
    expect(store.resolveBySource({
      serviceId: 'anthropic',
      profileId: 'work',
      bindingKind: 'group_member',
      groupId: 'team',
      groupGeneration: 6,
    })).toBeNull();
  });

  it('does not derive source lookup authority without an explicit source link', async () => {
    const module = await loadStoreModule();
    expect(module).not.toBeNull();
    const store = module!.createProviderAccountUsageStore();
    const snapshot = createSnapshot();

    store.recordSnapshot(snapshot);

    expect(store.resolveBySource({
      serviceId: 'anthropic',
      profileId: 'alias-only',
      bindingKind: 'profile',
    })).toBeNull();
  });

});
