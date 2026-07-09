import type { ConnectedServiceId } from '@happier-dev/protocol';

import type { RuntimeAccountIdentityEntry } from './runtimeAccountIdentityTypes';

type RuntimeAccountIdentityProviderAccountReader = Readonly<{
  listRuntimeIdentitiesByProviderAccount(input: Readonly<{
    serviceId: ConnectedServiceId;
    providerAccountId: string;
    groupId?: string | null;
    excludeSessionId?: string | null;
    currentGroupGenerationBySessionId?: ReadonlyMap<string, number | null>;
  }>): RuntimeAccountIdentityEntry[];
}>;

export function resolveSessionsSharingProviderAccount(
  registry: RuntimeAccountIdentityProviderAccountReader,
  input: Readonly<{
    serviceId: ConnectedServiceId;
    providerAccountId: string;
    groupId?: string | null;
    excludeSessionId?: string | null;
    currentGroupGenerationBySessionId?: ReadonlyMap<string, number | null>;
  }>,
): RuntimeAccountIdentityEntry[] {
  return registry.listRuntimeIdentitiesByProviderAccount(input);
}
