import { getConnectedServiceRuntimeAuthAdapter } from '@/backends/catalog';
import type { CatalogAgentId } from '@/backends/types';
import type { ConnectedServiceProviderRuntimeAuthAdapter } from '../runtimeAuth/types';
import type {
  ConnectedServiceAccountAdoptionVerificationInput,
  ConnectedServiceAccountTransitionVerificationResult,
} from './connectedServiceAccountTransition';

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function selectionHasMaterializedEnv(selection: unknown): boolean {
  const record = readRecord(selection);
  return Boolean(
    readRecord(record?.targetMaterializedEnv)
    ?? readRecord(record?.materializedEnv)
    ?? readRecord(record?.env),
  );
}

function attachPredecessorRuntimeLocationIfMissing(
  input: ConnectedServiceAccountAdoptionVerificationInput,
  selection: unknown,
): unknown {
  if (input.runtimeAuthSelection !== null && input.runtimeAuthSelection !== undefined) {
    return selection;
  }
  const env = input.tracked.spawnOptions?.environmentVariables;
  const record = readRecord(selection);
  if (!record || !env || selectionHasMaterializedEnv(record)) return selection;
  // A predecessor transition without a materialized current selection may need its
  // launch environment to locate the runtime. This is location input only; current
  // transitions must carry their own materialized target and the provider probe owns proof.
  return {
    ...record,
    targetMaterializedEnv: env,
  };
}

export function createSessionConnectedServiceAccountAdoptionVerifier(deps?: Readonly<{
  resolveRuntimeAuthAdapter?: (agentId: CatalogAgentId) => Promise<ConnectedServiceProviderRuntimeAuthAdapter | null>;
}>) {
  const resolveRuntimeAuthAdapter = deps?.resolveRuntimeAuthAdapter
    ?? (async (agentId: CatalogAgentId) => await getConnectedServiceRuntimeAuthAdapter(agentId));

  return async function verifySessionConnectedServiceAccountAdoption(
    input: ConnectedServiceAccountAdoptionVerificationInput,
  ): Promise<ConnectedServiceAccountTransitionVerificationResult> {
    const adapter = await resolveRuntimeAuthAdapter(input.agentId);
    if (!adapter?.verifyActiveAccount) {
      return {
        status: 'unavailable',
        retryable: false,
        reason: adapter
          ? 'provider_active_account_verification_missing'
          : 'provider_runtime_auth_adapter_missing',
      };
    }

    return await adapter.verifyActiveAccount({
      target: { agentId: input.agentId },
      selection: attachPredecessorRuntimeLocationIfMissing(
        input,
        input.runtimeAuthSelection ?? {
          serviceId: input.serviceId,
          binding: input.normalizedBindings.bindingsByServiceId[input.serviceId],
          profileId: input.target.profileId,
          groupId: input.target.groupId,
        },
      ),
    });
  };
}
