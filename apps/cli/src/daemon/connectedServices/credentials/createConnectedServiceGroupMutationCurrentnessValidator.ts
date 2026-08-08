import type {
  ConnectedServiceCredentialRevisionV1,
  ConnectedServiceId,
} from '@happier-dev/protocol';

import type { ApiClient } from '@/api/api';
import type { Credentials } from '@/persistence';

import { resolveConnectedServiceCredentialsWithRevisions } from '@/cloud/connectedServices/resolveConnectedServiceCredentials';
import type { ConnectedServiceSharedGenerationMutationCurrentness } from './lifecycleTypes';

export type ConnectedServiceGroupMutationTarget = Readonly<{
  serviceId: ConnectedServiceId;
  groupId: string;
  profileId: string;
  generation: number;
  credentialRevision: ConnectedServiceCredentialRevisionV1 | null;
}>;

/**
 * One authoritative currentness reader for every revisioned group-home mutation. Providers invoke
 * it inside their existing destination lock immediately before writing bytes; callers do not
 * maintain a parallel projection or compare spawn-time identity.
 */
export function createConnectedServiceGroupMutationCurrentnessValidator(deps: Readonly<{
  api: ApiClient;
  credentials: Credentials;
}>): (input: ConnectedServiceGroupMutationTarget) => Promise<ConnectedServiceSharedGenerationMutationCurrentness> {
  return async (input) => {
    const currentGroup = await deps.api.getConnectedServiceAuthGroup({
      serviceId: input.serviceId,
      groupId: input.groupId,
    }).catch(() => null);
    if (!currentGroup?.activeProfileId) return { current: false };
    const currentResolved = await resolveConnectedServiceCredentialsWithRevisions({
      credentials: deps.credentials,
      api: deps.api,
      bindings: [{ serviceId: input.serviceId, profileId: currentGroup.activeProfileId }],
    }).then((byServiceId) => byServiceId.get(input.serviceId) ?? null).catch(() => null);
    const authoritativeTarget = currentResolved
      ? {
          profileId: currentGroup.activeProfileId,
          generation: currentGroup.generation,
          credentialRevision: currentResolved.credentialRevision,
        }
      : undefined;
    return currentGroup.activeProfileId === input.profileId
      && currentGroup.generation === input.generation
      && currentResolved?.credentialRevision === input.credentialRevision
      ? { current: true }
      : {
          current: false,
          ...(authoritativeTarget ? { authoritativeTarget } : {}),
        };
  };
}
