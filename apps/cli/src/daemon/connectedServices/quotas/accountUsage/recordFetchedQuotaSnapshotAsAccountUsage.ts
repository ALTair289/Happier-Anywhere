import type {
  ConnectedServiceId,
  ConnectedServiceUsageSourceV1,
  ConnectedServiceQuotaSnapshotV1,
  ProviderAccountUsageSnapshotV1,
} from '@happier-dev/protocol';

import type { ProviderAccountUsagePersistenceScheduler } from '../../accountUsage/persistence';
import { buildProviderAccountUsageSnapshotFromConnectedServiceQuotaObservation } from '../../accountUsage/fromConnectedServiceQuotaObservation';
import { authorizeProviderAccountUsageObservation } from '../../accountUsage/record';
import { computeProviderAccountUsageSnapshotFingerprint } from '../../accountUsage/fingerprint';
import type {
  AccountUsageStoreForQuotaPolicy,
  ActiveGroupQuotaSwitchTarget,
  ConnectedServiceQuotaGroupContext,
  ResolvedQuotaStorageMode,
} from '../coordinator/support';

type RecordFetchedQuotaSnapshotContext = Readonly<{
  accountUsageStore: AccountUsageStoreForQuotaPolicy | null;
  accountUsagePersistence: Pick<ProviderAccountUsagePersistenceScheduler, 'recordInBandSnapshot'> | null;
  quotaFingerprintHmacKey: Uint8Array;
  persistQuotaSnapshotWithServerWork(input: Readonly<{
    accountMode?: 'e2ee' | 'plain';
    serviceId: ConnectedServiceId;
    profileId: string;
    snapshot: ConnectedServiceQuotaSnapshotV1;
    materialFingerprint?: string;
    sourceProviderAccountId?: string | null;
  }>): Promise<void>;
  handleAccountUsageChanged(input: Readonly<{
    sessionId: string;
    serviceId: ConnectedServiceId;
    profileId: string;
    groupId: string;
    groupGeneration: number;
    recordId: string;
    snapshot: ProviderAccountUsageSnapshotV1;
  }>): Promise<void>;
}>;

export async function recordFetchedQuotaSnapshotAsAccountUsage(
  context: RecordFetchedQuotaSnapshotContext,
  input: Readonly<{
    serviceId: ConnectedServiceId;
    profileId: string;
    snapshot: ConnectedServiceQuotaSnapshotV1;
    now: number;
    accountMode?: ResolvedQuotaStorageMode | null;
    sourceProviderAccountId?: string | null;
    groupId?: string | null;
    groupContexts?: ReadonlyArray<ConnectedServiceQuotaGroupContext> | null;
    groupTargets?: ReadonlyArray<ActiveGroupQuotaSwitchTarget> | null;
    persistDurably?: boolean;
  }>,
): Promise<ProviderAccountUsageSnapshotV1 | null> {
    const store = context.accountUsageStore;

    const groupGenerationsById = new Map<string, Set<number>>();
    const displayOnlyGroupIds = new Set<string>();
    const explicitGroupId = typeof input.groupId === 'string' ? input.groupId.trim() : '';
    if (explicitGroupId) displayOnlyGroupIds.add(explicitGroupId);
    for (const context of input.groupContexts ?? []) {
      const contextGroupId = context.groupId.trim();
      if (!contextGroupId) continue;
      if (context.groupGeneration === null) {
        displayOnlyGroupIds.add(contextGroupId);
        continue;
      }
      const existing = groupGenerationsById.get(contextGroupId) ?? new Set<number>();
      existing.add(context.groupGeneration);
      groupGenerationsById.set(contextGroupId, existing);
    }
    for (const target of input.groupTargets ?? []) {
      const targetGroupId = target.groupId.trim();
      if (!targetGroupId) continue;
      if (target.groupGeneration === null) {
        displayOnlyGroupIds.add(targetGroupId);
        continue;
      }
      const existing = groupGenerationsById.get(targetGroupId) ?? new Set<number>();
      existing.add(target.groupGeneration);
      groupGenerationsById.set(targetGroupId, existing);
    }

    let latest: ProviderAccountUsageSnapshotV1 | null = null;
    const persistenceSourcesByKey = new Map<string, ConnectedServiceUsageSourceV1>();
    const rememberPersistenceSources = (sources: readonly ConnectedServiceUsageSourceV1[]): void => {
      for (const source of sources) {
        const key = source.bindingKind === 'group_member'
          ? JSON.stringify(['group_member', source.serviceId, source.profileId, source.groupId ?? '', source.groupGeneration ?? null])
          : JSON.stringify(['profile', source.serviceId, source.profileId]);
        persistenceSourcesByKey.set(key, source);
      }
    };
    const profileSnapshot = buildProviderAccountUsageSnapshotFromConnectedServiceQuotaObservation({
      snapshot: input.snapshot,
      observedAtMs: input.now,
      sourceProviderAccountId: input.sourceProviderAccountId,
    });
    const profileObservation = {
      sources: [{
        serviceId: input.serviceId,
        profileId: input.profileId,
        bindingKind: 'profile' as const,
      }],
    };
    const authorizedProfileObservation = authorizeProviderAccountUsageObservation({
      snapshot: profileSnapshot,
      observation: profileObservation,
      sourceProviderAccountId: input.sourceProviderAccountId,
    });
    if (authorizedProfileObservation?.sources?.length) rememberPersistenceSources(authorizedProfileObservation.sources);
    if (store) {
      const profileRecord = store.recordSnapshot(profileSnapshot, authorizedProfileObservation);
      latest = store.resolveRecordId(profileRecord.recordId) ?? profileSnapshot;
    } else {
      latest = profileSnapshot;
    }

    for (const groupId of displayOnlyGroupIds) {
      const groupSnapshot = buildProviderAccountUsageSnapshotFromConnectedServiceQuotaObservation({
        snapshot: input.snapshot,
        observedAtMs: input.now,
        sourceProviderAccountId: input.sourceProviderAccountId,
      });
      const groupObservation = {
        sources: [{
          serviceId: input.serviceId,
          profileId: input.profileId,
          bindingKind: 'group_member' as const,
          groupId,
        }],
      };
      const authorizedGroupObservation = authorizeProviderAccountUsageObservation({
        snapshot: groupSnapshot,
        observation: groupObservation,
        sourceProviderAccountId: input.sourceProviderAccountId,
      });
      if (authorizedGroupObservation?.sources?.length) rememberPersistenceSources(authorizedGroupObservation.sources);
      if (store) {
        const groupRecord = store.recordSnapshot(groupSnapshot, authorizedGroupObservation);
        latest = store.resolveRecordId(groupRecord.recordId) ?? groupSnapshot;
      } else {
        latest = groupSnapshot;
      }
    }
    for (const [groupId, groupGenerations] of groupGenerationsById.entries()) {
      for (const groupGeneration of groupGenerations) {
        const groupSnapshot = buildProviderAccountUsageSnapshotFromConnectedServiceQuotaObservation({
          snapshot: input.snapshot,
          observedAtMs: input.now,
          sourceProviderAccountId: input.sourceProviderAccountId,
        });
        const groupObservation = {
          sources: [{
            serviceId: input.serviceId,
            profileId: input.profileId,
            bindingKind: 'group_member' as const,
            groupId,
            groupGeneration,
          }],
        };
        const authorizedGroupObservation = authorizeProviderAccountUsageObservation({
          snapshot: groupSnapshot,
          observation: groupObservation,
          sourceProviderAccountId: input.sourceProviderAccountId,
        });
        if (authorizedGroupObservation?.sources?.length) rememberPersistenceSources(authorizedGroupObservation.sources);
        if (store) {
          const groupRecord = store.recordSnapshot(groupSnapshot, authorizedGroupObservation);
          latest = store.resolveRecordId(groupRecord.recordId) ?? groupSnapshot;
        } else {
          latest = groupSnapshot;
        }
      }
    }

    if (latest && input.persistDurably !== false) {
      if (context.accountUsagePersistence) {
        await context.accountUsagePersistence.recordInBandSnapshot(latest, {
          sources: [...persistenceSourcesByKey.values()],
        }).catch(() => null);
      } else if (input.accountMode === 'plain' || input.accountMode === 'e2ee') {
        await context.persistQuotaSnapshotWithServerWork({
          accountMode: input.accountMode,
          serviceId: input.serviceId,
          profileId: input.profileId,
          snapshot: input.snapshot,
          ...(input.sourceProviderAccountId ? { sourceProviderAccountId: input.sourceProviderAccountId } : {}),
          materialFingerprint: computeProviderAccountUsageSnapshotFingerprint(latest, context.quotaFingerprintHmacKey),
        }).catch(() => null);
      }
    }

    if (latest) {
      const notifiedTargets = new Set<string>();
      for (const target of input.groupTargets ?? []) {
        if (target.groupGeneration === null) continue;
        const key = `${target.sessionId}\u0000${target.serviceId}\u0000${target.groupId}\u0000${target.groupGeneration}`;
        if (notifiedTargets.has(key)) continue;
        notifiedTargets.add(key);
        await context.handleAccountUsageChanged({
          sessionId: target.sessionId,
          serviceId: target.serviceId,
          groupId: target.groupId,
          profileId: input.profileId,
          groupGeneration: target.groupGeneration,
          recordId: latest.recordId,
          snapshot: latest,
        });
      }
    }

    return latest;
  }

