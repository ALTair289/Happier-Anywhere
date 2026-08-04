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
import {
  OPEN_CODE_BROKER_PROVIDERS,
} from './openCodeBrokerPluginEnv';

function resolveManagedOpenCodeBrokerActivationExpectation(
  expectation: OpenCodeBrokerLoadHandshakeKey,
): ManagedOpenCodeBrokerActivationExpectation | null {
  if (expectation.runtimeKind !== 'opencode_managed_server') return null;
  const providers = OPEN_CODE_BROKER_PROVIDERS.filter((provider) =>
    expectation.providers.includes(provider));
  if (providers.length !== expectation.providers.length) return null;
  return {
    runtimeKind: 'opencode_managed_server',
    selectionIdentity: expectation.selectionIdentity,
    loadNonce: expectation.loadNonce,
    providers,
    pluginVersion: expectation.pluginVersion,
  };
}

/**
 * Bind the current daemon's exact OpenCode load observation to the existing managed-child
 * generation owner. The handshake route awaits this boundary before it acknowledges the plugin.
 */
export async function persistOpenCodeBrokerLoadHandshakeObservation(
  expectation: OpenCodeBrokerLoadHandshakeKey,
  options: Readonly<{
    managedOpenCodeActivationStateDeps?: ManagedOpenCodeBrokerActivationStateDeps;
  }> = {},
): Promise<boolean> {
  if (isOpenCodeBrokerLoadHandshakeConflicted(expectation)) return false;
  const openCodeExpectation = resolveManagedOpenCodeBrokerActivationExpectation(expectation);
  if (!openCodeExpectation) return false;
  const observation = readOpenCodeBrokerLoadHandshakeObservation(expectation);
  if (!observation) return false;
  return options.managedOpenCodeActivationStateDeps
    ? await persistManagedOpenCodeBrokerActivationProof(
      observation,
      options.managedOpenCodeActivationStateDeps,
    )
    : await persistCurrentManagedOpenCodeBrokerActivationProof(observation);
}

/**
 * One readiness decision for both broker children.
 *
 * OpenCode can outlive its daemon independently, so readiness consumes only the proof already
 * persisted by the acknowledged handshake. Pi's stdio subprocess cannot be independently adopted;
 * only its current daemon Map observation is valid.
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

  const openCodeExpectation = resolveManagedOpenCodeBrokerActivationExpectation(expectation);
  if (!openCodeExpectation) return false;
  if (options.managedOpenCodeActivationStateDeps) {
    return await rehydrateManagedOpenCodeBrokerActivationProof(
      openCodeExpectation,
      options.managedOpenCodeActivationStateDeps,
    );
  }
  return await rehydrateCurrentManagedOpenCodeBrokerActivationProof(openCodeExpectation);
}
