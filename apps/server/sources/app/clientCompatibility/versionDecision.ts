import type {
    ClientKind,
    ClientVersionCheckResponseV1,
} from '@happier-dev/protocol';
import * as semver from 'semver';

import type { SessionSyncCompatibilityPolicy } from './policy';

export interface ClientVersionDecisionInput {
    readonly clientKind: ClientKind;
    readonly appVersion: string;
    readonly policy: SessionSyncCompatibilityPolicy;
    readonly distributionSupportedRange?: string;
    readonly distributionUpdateUrl?: string | null;
}

function readDistributionMinimum(range: string | undefined): string | null {
    if (range === undefined) return null;
    const minimum = semver.minVersion(range)?.version;
    if (minimum === undefined) {
        throw new Error(`Invalid configured app version range: ${range}`);
    }
    return minimum;
}

function resolveEffectiveMinimum(
    policyMinimum: string | undefined,
    distributionMinimum: string | null,
): string | null {
    if (policyMinimum === undefined) return distributionMinimum;
    if (distributionMinimum === null || semver.gt(policyMinimum, distributionMinimum)) return policyMinimum;
    return distributionMinimum;
}

export function isAppVersionAtLeastMinimum(appVersion: string, minimumVersion: string): boolean {
    const declared = semver.valid(appVersion);
    const minimum = semver.valid(minimumVersion);
    return declared !== null && minimum !== null && semver.gte(declared, minimum);
}

export function resolveClientVersionDecision(
    input: ClientVersionDecisionInput,
): ClientVersionCheckResponseV1 {
    const distributionMinimum = readDistributionMinimum(input.distributionSupportedRange);
    const policyMinimum = input.policy.requirements.minimumVersionsByClientKind?.[input.clientKind];
    const effectiveMinimum = resolveEffectiveMinimum(policyMinimum, distributionMinimum);
    const validAppVersion = semver.valid(input.appVersion);
    const satisfiesDistribution = input.distributionSupportedRange === undefined
        || (validAppVersion !== null && semver.satisfies(validAppVersion, input.distributionSupportedRange));
    const satisfiesMinimum = effectiveMinimum === null
        || isAppVersionAtLeastMinimum(input.appVersion, effectiveMinimum);

    if (satisfiesDistribution && satisfiesMinimum) {
        return { v: 1, status: 'current' };
    }

    // A configured distribution range or policy minimum is required for a
    // truthful upgrade response. Native callers always supply a range; a
    // malformed unversioned request cannot fabricate an upgrade floor.
    if (effectiveMinimum === null) {
        return { v: 1, status: 'current' };
    }

    return {
        v: 1,
        status: 'upgrade-required',
        minimumAppVersion: effectiveMinimum,
        updateUrl: input.policy.requirements.upgradeUrlsByClientKind?.[input.clientKind]
            ?? input.distributionUpdateUrl
            ?? null,
    };
}
