import {
  persistCurrentManagedOpenCodeBrokerActivationProof,
  persistManagedOpenCodeBrokerActivationProof,
  rehydrateCurrentManagedOpenCodeBrokerActivationProof,
  rehydrateManagedOpenCodeBrokerActivationProof,
  type ManagedOpenCodeBrokerActivationExpectation,
  type ManagedOpenCodeBrokerActivationStateDeps,
} from '@/backends/opencode/server/sharedManagedServer';

import {
  isOpenCodeBrokerLoadHandshakeConflicted,
  readOpenCodeBrokerLoadHandshakeObservation,
  type OpenCodeBrokerLoadHandshakeKey,
} from './openCodeBrokerLoadHandshakeRegistry';

/**
 * One readiness decision for both broker children.
 *
 * OpenCode can outlive its daemon independently, so the exact current observation is persisted in
 * and later rehydrated from the existing verified managed-child state. Pi's stdio subprocess cannot
 * be independently adopted; only its current daemon Map observation is valid.
 */
export async function resolveOpenCodeBrokerLoadHandshakeStatus(
  expectation: OpenCodeBrokerLoadHandshakeKey,
  options: Readonly<{
    managedOpenCodeActivationStateDeps?: ManagedOpenCodeBrokerActivationStateDeps;
  }> = {},
): Promise<boolean> {
  if (isOpenCodeBrokerLoadHandshakeConflicted(expectation)) return false;

  const observation = readOpenCodeBrokerLoadHandshakeObservation(expectation);
  if (expectation.runtimeKind === 'pi_rpc_process') {
    return observation !== null;
  }

  const openCodeExpectation: ManagedOpenCodeBrokerActivationExpectation = {
    runtimeKind: 'opencode_managed_server',
    selectionIdentity: expectation.selectionIdentity,
    loadNonce: expectation.loadNonce,
    providers: expectation.providers,
    pluginVersion: expectation.pluginVersion,
  };
  if (options.managedOpenCodeActivationStateDeps) {
    return observation
      ? await persistManagedOpenCodeBrokerActivationProof(
        observation,
        options.managedOpenCodeActivationStateDeps,
      )
      : await rehydrateManagedOpenCodeBrokerActivationProof(
        openCodeExpectation,
        options.managedOpenCodeActivationStateDeps,
      );
  }
  return observation
    ? await persistCurrentManagedOpenCodeBrokerActivationProof(observation)
    : await rehydrateCurrentManagedOpenCodeBrokerActivationProof(openCodeExpectation);
}
