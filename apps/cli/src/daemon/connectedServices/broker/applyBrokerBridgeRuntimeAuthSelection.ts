import { ConnectedServiceIdSchema } from '@happier-dev/protocol';

import { updateBrokerBridgeEffectiveSelection } from './brokerBridgeEffectiveSelectionRegistry';
import { computeConnectedServiceAccessTokenFingerprint } from '../refresh/credentialFreshness/tokenFingerprint';

function readRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

export function applyBrokerBridgeRuntimeAuthSelection(selection: unknown): Readonly<Record<string, unknown>> {
  const record = readRecord(selection);
  const brokerSelectionIdentity = readString(record?.brokerSelectionIdentity);
  const serviceIdParsed = ConnectedServiceIdSchema.safeParse(record?.serviceId);
  if (!record || !brokerSelectionIdentity || !serviceIdParsed.success) {
    return { applied: false, reason: 'hot_apply_unsupported', recovery: 'restart_resume' };
  }

  const profileId = readString(record.activeProfileId ?? record.profileId);
  if (!profileId) {
    return { applied: false, reason: 'hot_apply_unsupported', recovery: 'restart_resume' };
  }

  const groupId = readString(record.groupId);
  const generation = readNumber(record.generation ?? record.groupGeneration);
  const credentialRevision = readString(record.credentialRevision);
  const credentialRecord = readRecord(record.record);
  const oauth = readRecord(credentialRecord?.oauth);
  const token = readRecord(credentialRecord?.token);
  const credentialSecret = readString(oauth?.accessToken) ?? readString(token?.token);
  const providerAccountId = readString(oauth?.providerAccountId) ?? readString(token?.providerAccountId);
  const credentialFingerprint = credentialSecret
    ? computeConnectedServiceAccessTokenFingerprint(credentialSecret)
    : null;
  if (groupId && (generation === null || !credentialRevision || !credentialFingerprint || !providerAccountId)) {
    return { applied: false, reason: 'exact_broker_application_proof_unavailable', recovery: 'restart_resume' };
  }
  const effectiveSelection = groupId && generation !== null
    ? {
        kind: 'group' as const,
        serviceId: serviceIdParsed.data,
        groupId,
        activeProfileId: profileId,
        fallbackProfileId: readString(record.fallbackProfileId) ?? profileId,
        generation,
        credentialRevision: credentialRevision!,
        credentialFingerprint: credentialFingerprint!,
      }
    : {
        kind: 'profile' as const,
        serviceId: serviceIdParsed.data,
        profileId,
      };

  updateBrokerBridgeEffectiveSelection({
    selectionIdentity: brokerSelectionIdentity,
    serviceId: serviceIdParsed.data,
    selection: effectiveSelection,
  });

  return {
    applied: true,
    recovery: 'provider_owned_broker_selection',
    verification: {
      status: groupId ? 'verified' : 'weakly_verified',
      proofStrength: groupId ? 'exact' : 'weak',
      ...(providerAccountId ? { providerAccountId } : {}),
      sharedAuthSurfaceId: brokerSelectionIdentity,
      source: 'broker_selection_indirection',
      reason: 'daemon_broker_selection_epoch_bumped',
      ...(groupId && generation !== null && credentialRevision && credentialFingerprint
        ? {
            credentialRevision,
            credentialFingerprint,
            generationApplication: {
              serviceId: serviceIdParsed.data,
              groupId,
              profileId,
              generation,
              credentialRevision,
              credentialFingerprint,
            },
          }
        : {}),
    },
  };
}
