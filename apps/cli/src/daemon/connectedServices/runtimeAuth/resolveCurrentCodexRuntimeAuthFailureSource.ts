import {
  ConnectedServiceCredentialRevisionV1Schema,
  ConnectedServiceIdSchema,
  type ConnectedServiceCredentialRecordV1,
  type ConnectedServiceId,
} from '@happier-dev/protocol';

import type { ConnectedServiceRuntimeFailureClassification } from './types';
import type { RuntimeAccountIdentityProbeResult } from '../quotas/identity/runtimeAccountIdentityTypes';
import {
  computeConnectedServiceAccessTokenFingerprint,
  normalizeConnectedServiceAccessTokenFingerprint,
} from '../refresh/credentialFreshness/tokenFingerprint';

type CurrentCredential = Readonly<{
  record: ConnectedServiceCredentialRecordV1;
  credentialRevision: string;
}>;

function readNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readGeneration(value: unknown): number | null {
  return typeof value === 'number'
    && Number.isInteger(value)
    && value >= 0
    ? value
    : null;
}

export type CurrentRuntimeAuthFailureSource = Readonly<{
  serviceId: ConnectedServiceId;
  groupId: string;
  profileId: string;
  generation: number;
  credentialRevision: string;
}>;

/**
 * Resolves the provider-qualified exact current Codex runtime binding without deciding whether
 * that binding still matches the report. A modern binding takes its opaque revision only from the
 * live runtime. A predecessor report is accepted only when its provider account and failing-token
 * fingerprint both match the canonical current credential and the exact live runtime binding.
 */
export async function resolveCurrentCodexRuntimeAuthFailureSource(input: Readonly<{
  classification: ConnectedServiceRuntimeFailureClassification;
  readRuntimeIdentity: (request: Readonly<{
    serviceId: ConnectedServiceId;
    groupId: string;
    profileId: string;
    generation: number;
    credentialRevision: string | null;
  }>) => Promise<RuntimeAccountIdentityProbeResult | null>;
  resolveCurrentCredential: (
    serviceId: ConnectedServiceId,
    profileId: string,
  ) => Promise<CurrentCredential | null>;
}>): Promise<CurrentRuntimeAuthFailureSource | null> {
  const serviceId = ConnectedServiceIdSchema.safeParse(input.classification.serviceId);
  const groupId = readNonEmptyString(input.classification.groupId);
  const profileId = readNonEmptyString(input.classification.profileId);
  const generation = readGeneration(input.classification.groupGeneration);
  const reportedRevision = ConnectedServiceCredentialRevisionV1Schema.safeParse(
    input.classification.credentialRevision,
  );
  if (!serviceId.success || !groupId || !profileId || generation === null) return null;

  const liveIdentity = await input.readRuntimeIdentity({
    serviceId: serviceId.data,
    groupId,
    profileId,
    generation,
    credentialRevision: reportedRevision.success ? reportedRevision.data : null,
  });
  if (liveIdentity?.status === 'unavailable') {
    throw new Error(
      liveIdentity.reason?.trim()
        || 'connected-service runtime identity temporarily unavailable',
    );
  }
  if (
    !liveIdentity
    || liveIdentity.status !== 'verified'
    || liveIdentity.proofStrength !== 'exact'
  ) {
    throw new Error('connected-service runtime identity temporarily unavailable');
  }
  const liveGroupId = readNonEmptyString(liveIdentity.groupId);
  const liveProfileId = readNonEmptyString(liveIdentity.profileId);
  const liveGeneration = readGeneration(liveIdentity.groupGeneration);
  if (!liveGroupId || !liveProfileId || liveGeneration === null) {
    throw new Error('connected-service exact live runtime source tuple temporarily unavailable');
  }

  if (reportedRevision.success) {
    const liveRevision = ConnectedServiceCredentialRevisionV1Schema.safeParse(
      liveIdentity.credentialRevision,
    );
    if (!liveRevision.success) {
      throw new Error('connected-service runtime identity credential revision temporarily unavailable');
    }
    return {
      serviceId: serviceId.data,
      groupId: liveGroupId,
      profileId: liveProfileId,
      generation: liveGeneration,
      credentialRevision: liveRevision.data,
    };
  }

  if (liveGroupId !== groupId || liveProfileId !== profileId) return null;

  // Only predecessor compatibility for reports that omitted the revision needs a
  // credential-store read. Modern reports take their revision solely from exact live runtime
  // identity; an older probe omitting the revision cannot transfer authority to mutable server
  // credential truth without matching provider-account and failing-token evidence.
  const currentCredential = await input.resolveCurrentCredential(serviceId.data, profileId);
  if (!currentCredential) return null;
  const currentRevision = currentCredential.credentialRevision;
  if (
    liveIdentity.credentialRevision !== null
    && liveIdentity.credentialRevision !== undefined
    && liveIdentity.credentialRevision !== currentRevision
  ) return null;
  const reportedProviderAccountId = readNonEmptyString(input.classification.sourceProviderAccountId);
  const reportedFingerprint = normalizeConnectedServiceAccessTokenFingerprint(
    input.classification.failingAccessTokenFingerprint,
  );
  if (
    !reportedProviderAccountId
    || !reportedFingerprint
    || liveIdentity.providerAccountId !== reportedProviderAccountId
    || currentCredential.record.kind !== 'oauth'
    || currentCredential.record.oauth.providerAccountId !== reportedProviderAccountId
    || computeConnectedServiceAccessTokenFingerprint(currentCredential.record.oauth.accessToken) !== reportedFingerprint
  ) return null;

  return {
    serviceId: serviceId.data,
    groupId: liveGroupId,
    profileId: liveProfileId,
    generation: liveGeneration,
    credentialRevision: currentRevision,
  };
}
