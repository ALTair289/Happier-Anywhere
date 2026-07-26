import type {
  ConnectedServiceCredentialRevisionV1,
  ConnectedServiceId,
} from '@happier-dev/protocol';

import type { CatalogAgentId } from '@/backends/types';
import type { ConnectedServiceCredentialLifecycleDescriptor } from '../../credentials/lifecycleTypes';
import type { ConnectedServiceProviderAdoptedGenerationTarget } from '../../sessionAuthSwitch/connectedServiceAuthSwitchOutcome';

export type RuntimeGenerationApplicationProofTarget = Readonly<{
  sessionId: string | null;
  agentId: CatalogAgentId | null;
  connectedServiceSelectionsEnv: Readonly<Record<string, string>>;
  activeBindings: ReadonlyArray<Readonly<{
    serviceId: ConnectedServiceId;
    groupId: string | null;
    profileId: string;
    generation: number | null;
    credentialRevision?: ConnectedServiceCredentialRevisionV1 | null;
    credentialFingerprint?: string | null;
  }>>;
}>;

export async function resolveRuntimeGenerationApplicationProofs(input: Readonly<{
  target: RuntimeGenerationApplicationProofTarget;
  resolveLifecycleDescriptor: (
    agentId: CatalogAgentId,
  ) => Promise<Pick<ConnectedServiceCredentialLifecycleDescriptor, 'verifyGenerationApplication'>>;
  getCurrentGroup: (input: Readonly<{
    serviceId: ConnectedServiceId;
    groupId: string;
  }>) => Promise<Readonly<{
    serviceId: ConnectedServiceId;
    groupId: string;
    activeProfileId: string | null;
    generation: number;
  }> | null>;
  isCurrent: (binding: RuntimeGenerationApplicationProofTarget['activeBindings'][number]) => boolean;
}>): Promise<ConnectedServiceProviderAdoptedGenerationTarget[]> {
  const sessionId = input.target.sessionId?.trim() ?? '';
  const agentId = input.target.agentId;
  if (!sessionId || !agentId) return [];
  const descriptor = await input.resolveLifecycleDescriptor(agentId);
  const verify = descriptor.verifyGenerationApplication;
  if (!verify) return [];

  const proofs: ConnectedServiceProviderAdoptedGenerationTarget[] = [];
  for (const binding of input.target.activeBindings) {
    if (!binding.groupId || binding.generation === null || !input.isCurrent(binding)) continue;
    const currentGroup = await input.getCurrentGroup({
      serviceId: binding.serviceId,
      groupId: binding.groupId,
    });
    if (
      !input.isCurrent(binding)
      || !currentGroup
      || currentGroup.activeProfileId !== binding.profileId
      || currentGroup.generation !== binding.generation
    ) continue;
    const proof = await verify({
      serviceId: binding.serviceId,
      groupId: binding.groupId,
      profileId: binding.profileId,
      generation: binding.generation,
      credentialRevision: binding.credentialRevision ?? null,
      credentialFingerprint: binding.credentialFingerprint ?? null,
      environmentVariables: input.target.connectedServiceSelectionsEnv,
    });
    if (proof.status !== 'verified' || !input.isCurrent(binding)) continue;
    const providerAdoptedTarget: ConnectedServiceProviderAdoptedGenerationTarget = {
      serviceId: binding.serviceId,
      groupId: binding.groupId,
      profileId: binding.profileId,
      generation: binding.generation,
      credentialRevision: binding.credentialRevision ?? null,
      proof: {
        status: 'verified',
        source: proof.source,
        sharedAuthSurfaceId: proof.sharedAuthSurfaceId,
        credentialRevision: proof.credentialRevision,
        credentialFingerprint: proof.credentialFingerprint,
      },
    };
    proofs.push(providerAdoptedTarget);
  }
  return proofs;
}
