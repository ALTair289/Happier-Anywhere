import * as React from 'react';

import { useAuth } from '@/auth/context/AuthContext';
import { resolveAuthCredentialsScopeKey } from '@/auth/storage/resolveAuthCredentialsScopeKey';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { connectedServiceProfileKey } from '@/sync/domains/connectedServices/connectedServiceProfilePreferences';

import type { ConnectedServiceQuotaSnapshotV1 } from '@happier-dev/protocol';
import { ConnectedServiceIdSchema, type ConnectedServiceId } from '@happier-dev/protocol';
import { useCredentialScopedAccountModeResolver } from './useCredentialScopedAccountModeResolver';
import {
  buildQuotaSnapshotScopeKey,
  getQuotaSnapshotEntry,
  retainQuotaSnapshotPolling,
  subscribeQuotaSnapshotEntry,
  type QuotaSnapshotLoadContext,
} from './connectedServiceQuotaSnapshotStore';

export type ConnectedServiceQuotaProfileRef = Readonly<{ serviceId: string; profileId: string }>;
type NormalizedProfileRef = Readonly<{
  key: string;
  serviceId: ConnectedServiceId;
  profileId: string;
}>;

export type ConnectedServiceQuotaSnapshotsResult = Readonly<{
  snapshotsByKey: Readonly<Record<string, ConnectedServiceQuotaSnapshotV1 | null>>;
  loadingByKey: Readonly<Record<string, boolean>>;
}>;

export type ConnectedServiceQuotaSnapshotsFetchPolicy = 'poll' | 'cache_only';

function normalizeProfile(profile: ConnectedServiceQuotaProfileRef): NormalizedProfileRef | null {
  const serviceIdRaw = String(profile.serviceId ?? '').trim();
  const serviceIdParsed = ConnectedServiceIdSchema.safeParse(serviceIdRaw);
  const profileId = String(profile.profileId ?? '').trim();
  if (!serviceIdParsed.success || !profileId) return null;
  const serviceId = serviceIdParsed.data;
  return {
    key: connectedServiceProfileKey({ serviceId, profileId }),
    serviceId,
    profileId,
  };
}

function normalizeProfiles(profiles: ReadonlyArray<ConnectedServiceQuotaProfileRef>): NormalizedProfileRef[] {
  const seenKeys = new Set<string>();
  const normalizedProfiles: NormalizedProfileRef[] = [];
  for (const profile of profiles) {
    const normalized = normalizeProfile(profile);
    if (!normalized || seenKeys.has(normalized.key)) continue;
    seenKeys.add(normalized.key);
    normalizedProfiles.push(normalized);
  }
  return normalizedProfiles.sort((a, b) => a.key.localeCompare(b.key));
}

function buildProfilesSignature(profiles: ReadonlyArray<ConnectedServiceQuotaProfileRef>): string {
  return normalizeProfiles(profiles)
    .map((profile) => `${profile.key}\u0000${profile.serviceId}\u0000${profile.profileId}`)
    .join('\u0001');
}

export function useConnectedServiceQuotaSnapshots(
  profiles: ReadonlyArray<ConnectedServiceQuotaProfileRef>,
  options: Readonly<{ fetchPolicy?: ConnectedServiceQuotaSnapshotsFetchPolicy }> = {},
): ConnectedServiceQuotaSnapshotsResult {
  const auth = useAuth();
  const credentials = auth.credentials;
  const quotasEnabled = useFeatureEnabled('connectedServices.quotas');
  const credentialScope = quotasEnabled && credentials ? resolveAuthCredentialsScopeKey(credentials) : '';
  const fetchPolicy = options.fetchPolicy ?? 'poll';
  const resolveAccountMode = useCredentialScopedAccountModeResolver({ credentials, credentialScope });

  const profilesSignature = React.useMemo(() => buildProfilesSignature(profiles), [profiles]);
  const normalizedProfiles = React.useMemo(() => normalizeProfiles(profiles), [profilesSignature]);
  const loadContexts = React.useMemo(() => {
    if (!quotasEnabled || !credentials) return [] as ReadonlyArray<Readonly<{
      key: string;
      profileKey: string;
      loadContext: QuotaSnapshotLoadContext;
    }>>;
    return normalizedProfiles.map((profile) => ({
      key: buildQuotaSnapshotScopeKey(credentialScope, profile.serviceId, profile.profileId),
      profileKey: profile.key,
      loadContext: {
        credentials,
        credentialScope,
        serviceId: profile.serviceId,
        profileId: profile.profileId,
        resolveAccountMode,
      },
    }));
  }, [credentialScope, credentials, normalizedProfiles, quotasEnabled, resolveAccountMode]);
  const [version, bumpVersion] = React.useReducer((value: number) => value + 1, 0);

  React.useEffect(() => {
    if (loadContexts.length === 0) return;
    const unsubs = loadContexts.map(({ key }) => subscribeQuotaSnapshotEntry(key, bumpVersion));
    return () => {
      for (const unsub of unsubs) unsub();
    };
  }, [loadContexts]);

  React.useEffect(() => {
    if (fetchPolicy === 'cache_only') return;
    const releases = loadContexts.map(({ key, loadContext }) => retainQuotaSnapshotPolling(key, loadContext));
    return () => {
      for (const release of releases) release();
    }
  }, [fetchPolicy, loadContexts]);

  return React.useMemo(() => {
    const snapshotsByKey: Record<string, ConnectedServiceQuotaSnapshotV1 | null> = {};
    const loadingByKey: Record<string, boolean> = {};
    if (!quotasEnabled) {
      return { snapshotsByKey, loadingByKey } satisfies ConnectedServiceQuotaSnapshotsResult;
    }

    void version;
    for (const { key, profileKey } of loadContexts) {
      const entry = getQuotaSnapshotEntry(key);
      snapshotsByKey[profileKey] = entry.snapshot;
      loadingByKey[profileKey] = entry.loading;
    }

    return { snapshotsByKey, loadingByKey } satisfies ConnectedServiceQuotaSnapshotsResult;
  }, [loadContexts, quotasEnabled, version]);
}
