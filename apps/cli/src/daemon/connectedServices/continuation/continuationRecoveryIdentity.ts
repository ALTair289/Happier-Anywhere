import type {
  ConnectedServiceBindingSelectionV1,
  ConnectedServiceBindingsV1,
  SessionContinuationRecoveryIdentityV1,
} from '@happier-dev/protocol';

import type { ConnectedServiceRuntimeBindingIdentity } from '../runtimeRegistry/target';

type ProviderActivityRecoveryIntentIdentity = Readonly<{
  serviceId: string;
  profileId: string | null;
  groupId: string | null;
  status: string;
  attemptId?: string;
  pendingTargetProfileId?: string | null;
  pendingTargetGeneration?: number | null;
  classification?: Readonly<{
    groupGeneration?: number | null;
    credentialRevision?: string | null;
  }>;
}>;

function normalizeNonEmpty(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function readConnectedBindingIdentity(input: Readonly<{
  serviceId: string;
  binding: ConnectedServiceBindingSelectionV1 | undefined;
  failureFingerprint?: string | null;
  targetGeneration?: number | null;
}>): SessionContinuationRecoveryIdentityV1 | null {
  const serviceId = normalizeNonEmpty(input.serviceId);
  if (!serviceId) return null;
  const binding = input.binding;
  if (!binding || binding.source !== 'connected') return null;

  const profileId = normalizeNonEmpty((binding as { profileId?: unknown }).profileId);
  const failureFingerprint = normalizeNonEmpty(input.failureFingerprint);
  const targetGeneration = typeof input.targetGeneration === 'number' && Number.isFinite(input.targetGeneration)
    ? Math.max(0, Math.trunc(input.targetGeneration))
    : null;

  if (binding.selection === 'group') {
    const groupId = normalizeNonEmpty((binding as { groupId?: unknown }).groupId);
    if (!groupId) return null;
    return {
      serviceId,
      selectionKind: 'group',
      groupId,
      ...(profileId ? { profileId } : {}),
      ...(failureFingerprint ? { failureFingerprint } : {}),
      ...(targetGeneration === null ? {} : { targetGeneration }),
    };
  }

  if (!profileId) return null;
  return {
    serviceId,
    selectionKind: 'profile',
    profileId,
    ...(failureFingerprint ? { failureFingerprint } : {}),
    ...(targetGeneration === null ? {} : { targetGeneration }),
  };
}

export function buildContinuationRecoveryIdentityFromBindings(input: Readonly<{
  serviceIds: ReadonlySet<string>;
  bindings: ConnectedServiceBindingsV1;
  failureFingerprint?: string | null;
  targetGenerationByServiceId?: Readonly<Record<string, number | null | undefined>> | null;
}>): SessionContinuationRecoveryIdentityV1 | null {
  if (input.serviceIds.size !== 1) return null;
  const serviceId = [...input.serviceIds][0];
  if (!serviceId) return null;
  return readConnectedBindingIdentity({
    serviceId,
    binding: input.bindings.bindingsByServiceId[serviceId],
    failureFingerprint: input.failureFingerprint,
    targetGeneration: input.targetGenerationByServiceId?.[serviceId] ?? null,
  });
}

export function listContinuationRecoveryIdentitiesFromBindings(
  bindings: ConnectedServiceBindingsV1,
): SessionContinuationRecoveryIdentityV1[] {
  const identities: SessionContinuationRecoveryIdentityV1[] = [];
  for (const [serviceId, binding] of Object.entries(bindings.bindingsByServiceId)) {
    const identity = readConnectedBindingIdentity({ serviceId, binding });
    if (identity) identities.push(identity);
  }
  return identities;
}

function isPendingProviderActivityRecoveryIntent(intent: ProviderActivityRecoveryIntentIdentity): boolean {
  return intent.status === 'waiting'
    || intent.status === 'checking'
    || intent.status === 'resumed_awaiting_proof';
}

function normalizeGeneration(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
    ? value
    : null;
}

function matchesGroupProviderActivityRecoveryIntent(
  intent: ProviderActivityRecoveryIntentIdentity,
  binding: ConnectedServiceRuntimeBindingIdentity,
): boolean {
  if (intent.groupId !== binding.groupId) return false;
  const bindingGeneration = normalizeGeneration(binding.generation);
  if (bindingGeneration === null) return false;

  const pendingTargetProfileId = normalizeNonEmpty(intent.pendingTargetProfileId);
  const pendingTargetGeneration = normalizeGeneration(intent.pendingTargetGeneration);
  if (pendingTargetProfileId || pendingTargetGeneration !== null) {
    return pendingTargetProfileId === binding.profileId
      && pendingTargetGeneration === bindingGeneration;
  }

  // A refresh-without-switch does not mint a pending target. The live registry
  // binding is exact proof only when it preserves the failed selection while
  // exposing a credential revision different from the frozen failure boundary.
  // A sibling may have advanced the authoritative group generation in the
  // meantime, so only generations older than the failure boundary are stale.
  if (intent.status !== 'resumed_awaiting_proof') return false;
  if (intent.profileId !== binding.profileId) return false;
  const failedGeneration = normalizeGeneration(intent.classification?.groupGeneration);
  if (failedGeneration === null || bindingGeneration < failedGeneration) return false;
  const failedCredentialRevision = normalizeNonEmpty(intent.classification?.credentialRevision);
  const currentCredentialRevision = normalizeNonEmpty(binding.credentialRevision);
  return failedCredentialRevision !== null
    && currentCredentialRevision !== null
    && currentCredentialRevision !== failedCredentialRevision;
}

/**
 * Builds the explicit provider-outcome identities used by the daemon turn lifecycle.
 * The runtime registry supplies the exact currently adopted binding while the recovery
 * intent supplies the frozen failure boundary and, for groups, the applied generation.
 * Missing or mismatched dimensions produce no proof identity.
 */
export function listProviderActivityRecoveryIdentitiesFromRuntimeBindings(
  bindings: ReadonlyArray<ConnectedServiceRuntimeBindingIdentity>,
  intents: ReadonlyArray<ProviderActivityRecoveryIntentIdentity>,
): SessionContinuationRecoveryIdentityV1[] {
  const identities: SessionContinuationRecoveryIdentityV1[] = [];
  for (const binding of bindings) {
    const matchingIntent = intents.find((intent) => {
      if (!isPendingProviderActivityRecoveryIntent(intent)) return false;
      if (intent.serviceId !== binding.serviceId) return false;
      const attemptId = normalizeNonEmpty(intent.attemptId);
      if (!attemptId) return false;
      if (binding.groupId) {
        return matchesGroupProviderActivityRecoveryIntent(intent, binding);
      }
      return intent.groupId === null && intent.profileId === binding.profileId;
    });
    const failureFingerprint = normalizeNonEmpty(matchingIntent?.attemptId);
    if (!matchingIntent || !failureFingerprint) continue;
    if (binding.groupId) {
      identities.push({
        serviceId: binding.serviceId,
        selectionKind: 'group',
        groupId: binding.groupId,
        profileId: binding.profileId,
        failureFingerprint,
        targetGeneration: binding.generation!,
      });
      continue;
    }
    identities.push({
      serviceId: binding.serviceId,
      selectionKind: 'profile',
      profileId: binding.profileId,
      failureFingerprint,
    });
  }
  return identities;
}
