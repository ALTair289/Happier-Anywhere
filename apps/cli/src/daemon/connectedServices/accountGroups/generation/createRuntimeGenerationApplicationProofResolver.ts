import type { ConnectedServiceId } from '@happier-dev/protocol';

import type { CatalogAgentId } from '@/backends/types';
import type { ConnectedServiceCredentialLifecycleDescriptor } from '../../credentials/lifecycleTypes';
import type { ConnectedServiceProviderAdoptedGenerationTarget } from '../../sessionAuthSwitch/connectedServiceAuthSwitchOutcome';
import {
  resolveRuntimeGenerationApplicationProofs,
  type RuntimeGenerationApplicationProofTarget,
} from './resolveRuntimeGenerationApplicationProofs';

/**
 * Production composition owner for runtime generation-application proof. Keeping this assembly in a
 * tested factory prevents daemon wiring from silently dropping catalog, canonical group, provider,
 * dependencies while the proof policy remains centralized in the resolver.
 */
export function createRuntimeGenerationApplicationProofResolver(input: Readonly<{
  resolveLifecycleDescriptor: (
    agentId: CatalogAgentId,
  ) => Promise<Pick<ConnectedServiceCredentialLifecycleDescriptor, 'verifyGenerationApplication'>>;
  getCurrentGroup: (group: Readonly<{
    serviceId: ConnectedServiceId;
    groupId: string;
  }>) => Promise<Readonly<{
    serviceId: ConnectedServiceId;
    groupId: string;
    activeProfileId: string | null;
    generation: number;
  }> | null>;
}>): (
  target: RuntimeGenerationApplicationProofTarget,
  options: Readonly<{
    isCurrent: (binding: RuntimeGenerationApplicationProofTarget['activeBindings'][number]) => boolean;
  }>,
) => Promise<ConnectedServiceProviderAdoptedGenerationTarget[]> {
  return async (target, options) => await resolveRuntimeGenerationApplicationProofs({
    target,
    resolveLifecycleDescriptor: input.resolveLifecycleDescriptor,
    getCurrentGroup: input.getCurrentGroup,
    isCurrent: options.isCurrent,
  });
}
