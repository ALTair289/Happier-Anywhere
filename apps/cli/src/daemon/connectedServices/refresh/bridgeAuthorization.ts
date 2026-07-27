import type { ConnectedServiceId } from '@happier-dev/protocol';
import type { ConnectedServiceChildSelection } from '../connectedServiceChildEnvironment';
import type { ConnectedServiceRuntimeTarget } from '../runtimeRegistry/registry';

/**
 * Wire shape a bridge caller (SDK callback / broker plugin) may send. It is retained for schema
 * compatibility ONLY: the daemon no longer trusts it for identity. The authoritative selection is
 * always re-resolved daemon-side from the CURRENT live runtime binding (see
 * `resolveCurrentBridgeSelectionForTarget`), so a caller's captured generation/profile can never
 * authorize a refresh nor pick which credential is rotated (R3-3 / R3-6).
 */
export type BridgeRefreshSelection =
  | Readonly<{
    serviceId: ConnectedServiceId;
    kind: 'profile';
    profileId: string;
  }>
  | Readonly<{
    serviceId: ConnectedServiceId;
    kind: 'group';
    groupId: string;
    activeProfileId: string;
    generation: number;
  }>;

export const CONNECTED_SERVICE_BRIDGE_SELECTION_NOT_AUTHORIZED =
  'connected_service_bridge_selection_not_authorized';

export class ConnectedServiceBridgeSelectionAuthorizationError extends Error {
  constructor() {
    super(CONNECTED_SERVICE_BRIDGE_SELECTION_NOT_AUTHORIZED);
    this.name = 'ConnectedServiceBridgeSelectionAuthorizationError';
  }
}

export function isConnectedServiceBridgeSelectionAuthorizationError(
  error: unknown,
): boolean {
  return error instanceof Error
    && error.message === CONNECTED_SERVICE_BRIDGE_SELECTION_NOT_AUTHORIZED;
}

/**
 * Resolve the CURRENT canonical connected-service selection for a live runtime target and service.
 *
 * This is the single bridge-authz choke point: an access-token bridge is authorized iff the caller's
 * proven identity (a live session id, or a live broker selection identity) maps to a runtime target
 * that is actually bound to `serviceId` right now — and the returned selection is the target's CURRENT
 * binding (current active profile + current group generation), never the caller's captured snapshot.
 *
 * Prefers the richer child-selection (carries `fallbackProfileId` + `generation` for group bindings)
 * and falls back to the parsed active binding for plain profile bindings. Returns null when the target
 * is not bound to `serviceId` (the caller is then rejected, fail-closed).
 */
export function resolveCurrentBridgeSelectionForTarget(
  target: ConnectedServiceRuntimeTarget,
  serviceId: ConnectedServiceId,
): ConnectedServiceChildSelection | null {
  const fromSelections = target.connectedServiceSelections.find(
    (selection) => selection.serviceId === serviceId,
  );
  if (fromSelections) return fromSelections;

  const binding = target.activeBindings.find((entry) => entry.serviceId === serviceId);
  if (!binding) return null;
  if (binding.groupId) {
    return {
      kind: 'group',
      serviceId,
      groupId: binding.groupId,
      activeProfileId: binding.profileId,
      fallbackProfileId: binding.profileId,
      generation: binding.generation ?? 0,
      credentialRevision: null,
    };
  }
  return { kind: 'profile', serviceId, profileId: binding.profileId, credentialRevision: null };
}
