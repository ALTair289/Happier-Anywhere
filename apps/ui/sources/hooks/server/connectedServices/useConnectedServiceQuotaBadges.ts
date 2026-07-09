import * as React from 'react';

import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { computeConnectedServiceQuotaSummaryBadges } from '@/sync/domains/connectedServices/connectedServiceQuotaBadges';
import { connectedServiceProfileKey } from '@/sync/domains/connectedServices/connectedServiceProfilePreferences';
import { shouldHideQuotaForCredentialStatus } from '@/sync/domains/connectedServices/shouldHideQuotaForCredentialStatus';
import { useSettings } from '@/sync/store/hooks';

import {
    ConnectedServiceIdSchema,
    type ConnectedServiceId,
} from '@happier-dev/protocol';

import {
    useConnectedServiceQuotaSnapshots,
    type ConnectedServiceQuotaSnapshotsFetchPolicy,
} from './useConnectedServiceQuotaSnapshots';

type ProfileRef = Readonly<{ serviceId: string; profileId: string; credentialHealthStatus?: unknown }>;
type NormalizedProfileRef = Readonly<{
    key: string;
    serviceId: ConnectedServiceId;
    profileId: string;
    credentialHealthStatus?: unknown;
    credentialHealthUsable: boolean;
}>;

type UseConnectedServiceQuotaBadgesOptions = Readonly<{
    fetchPolicy?: ConnectedServiceQuotaSnapshotsFetchPolicy;
}>;

function normalizeProfileRefs(profiles: ReadonlyArray<ProfileRef>): NormalizedProfileRef[] {
    const next: NormalizedProfileRef[] = [];
    const seenKeys = new Set<string>();
    for (const profile of profiles) {
        const serviceIdRaw = String(profile.serviceId ?? '').trim();
        const serviceIdParsed = ConnectedServiceIdSchema.safeParse(serviceIdRaw);
        const profileId = String(profile.profileId ?? '').trim();
        if (!serviceIdParsed.success || !profileId) continue;

        const serviceId = serviceIdParsed.data;
        const key = connectedServiceProfileKey({ serviceId, profileId });
        if (seenKeys.has(key)) continue;
        seenKeys.add(key);
        // Usage DISPLAY gate: fail OPEN via the single shared predicate (same owner
        // as the single/plural hooks + AccountBlock). Only an EXPLICIT needs_reauth
        // blanks badges; absent/unknown/'' show usage — no independent derivation.
        next.push({
            key,
            serviceId,
            profileId,
            ...(profile.credentialHealthStatus !== undefined ? { credentialHealthStatus: profile.credentialHealthStatus } : {}),
            credentialHealthUsable: !shouldHideQuotaForCredentialStatus(profile.credentialHealthStatus),
        });
    }
    return next;
}

export function useConnectedServiceQuotaBadges(
    profiles: ReadonlyArray<ProfileRef>,
    options: UseConnectedServiceQuotaBadgesOptions = {},
): Record<string, Array<{ meterId: string; text: string }>> {
    const settings = useSettings();
    const quotasEnabled = useFeatureEnabled('connectedServices.quotas');

    const pinnedByKey = settings.connectedServicesQuotaPinnedMeterIdsByKey;
    const strategyByKey = settings.connectedServicesQuotaSummaryStrategyByKey;

    const normalizedProfiles = React.useMemo(() => normalizeProfileRefs(profiles), [profiles]);

    const fetchPolicy = options.fetchPolicy ?? 'poll';
    const { snapshotsByKey } = useConnectedServiceQuotaSnapshots(normalizedProfiles, { fetchPolicy });

    return React.useMemo(() => {
        const badgesByKey: Record<string, Array<{ meterId: string; text: string }>> = {};
        if (!quotasEnabled) return badgesByKey;

        for (const profile of normalizedProfiles) {
            const key = profile.key;
            if (!profile.credentialHealthUsable) {
                badgesByKey[key] = [];
                continue;
            }
            const pinnedMeterIds = pinnedByKey[key] ?? [];
            const snapshot = snapshotsByKey[key] ?? null;
            if (fetchPolicy === 'cache_only' && !snapshot) {
                badgesByKey[key] = [];
                continue;
            }

            const rawStrategy = strategyByKey[key];
            const strategy = rawStrategy === 'primary' && pinnedMeterIds.length > 0 ? 'primary' : 'min_remaining';
            badgesByKey[key] = computeConnectedServiceQuotaSummaryBadges({
                snapshot,
                pinnedMeterIds,
                strategy,
            });
        }

        return badgesByKey;
    }, [
        fetchPolicy,
        normalizedProfiles,
        pinnedByKey,
        quotasEnabled,
        snapshotsByKey,
        strategyByKey,
    ]);
}
