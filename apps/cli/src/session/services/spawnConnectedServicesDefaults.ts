import { AGENTS_CORE, type AgentId } from '@happier-dev/agents';
import {
  ConnectedServicesDefaultAuthByAgentIdV1Schema,
  ConnectedServiceBindingsV1Schema,
  type ConnectedServiceBindingSelectionV1,
  type ConnectedServiceBindingsV1,
  type ConnectedServiceId,
} from '@happier-dev/protocol';

export function agentSupportsSpawnConnectedServicesDefaults(agentId: AgentId): boolean {
  return (AGENTS_CORE[agentId].connectedServices?.supportedServiceIds.length ?? 0) > 0;
}

function normalizeBindingForSpawn(
  binding: ConnectedServiceBindingSelectionV1 | undefined,
): ConnectedServiceBindingSelectionV1 {
  if (binding?.source !== 'connected') return { source: 'native' };
  if (binding.selection === 'group') {
    return {
      source: 'connected',
      selection: 'group',
      groupId: binding.groupId,
    };
  }
  return {
    source: 'connected',
    selection: 'profile',
    profileId: binding.profileId,
  };
}

/**
 * Pure LITERAL resolver for spawn/run connected-services defaulting (R4-2, user-ruled canonical):
 * selection semantics are literal — a configured default PROFILE resolves to that exact profile
 * binding, a GROUP resolves to that group. The resolver never second-guesses its inputs: it does not
 * silently upgrade a profile default to an autoSwitch pool at resolution time. Migration of intent
 * (e.g. "you have a pool, want to rotate?") happens ONLY through a visible suggestion that updates the
 * STORED default setting, never through a silent rewrite here.
 *
 * `serviceIds` (optional) scopes resolution to a specific subset of the agent's supported services — the
 * canonical owner for resolving a bare per-service default token (`"<serviceId>"`) to that service's
 * stored default only, WITHOUT broadening to every service the agent supports. Omit it to resolve the
 * whole supported set (the spawn/run account-default behavior).
 */
export function resolveSpawnConnectedServicesDefaults(params: Readonly<{
  accountSettings: unknown;
  agentId: AgentId;
  serviceIds?: readonly ConnectedServiceId[];
}>): ConnectedServiceBindingsV1 | null {
  const supportedServiceIds = AGENTS_CORE[params.agentId].connectedServices?.supportedServiceIds ?? [];
  if (supportedServiceIds.length === 0) return null;
  const targetServiceIds = params.serviceIds
    ? supportedServiceIds.filter((serviceId) => params.serviceIds!.includes(serviceId))
    : supportedServiceIds;
  if (targetServiceIds.length === 0) return null;

  const settingsRecord = params.accountSettings && typeof params.accountSettings === 'object' && !Array.isArray(params.accountSettings)
    ? params.accountSettings as { connectedServicesDefaultAuthByAgentIdV1?: unknown }
    : {};
  const parsedDefaults = ConnectedServicesDefaultAuthByAgentIdV1Schema.safeParse(
    settingsRecord.connectedServicesDefaultAuthByAgentIdV1,
  );
  if (!parsedDefaults.success) return null;

  const configuredBindings = parsedDefaults.data.bindingsByAgentId[params.agentId]?.bindingsByServiceId ?? {};
  const bindingsByServiceId: Record<string, ConnectedServiceBindingSelectionV1> = {};
  let hasConnectedBinding = false;

  for (const serviceId of targetServiceIds) {
    const binding = normalizeBindingForSpawn(configuredBindings[serviceId]);
    bindingsByServiceId[serviceId] = binding;
    if (binding.source === 'connected') {
      hasConnectedBinding = true;
    }
  }

  if (!hasConnectedBinding) return null;
  return ConnectedServiceBindingsV1Schema.parse({
    v: 1,
    bindingsByServiceId,
  });
}
