import type { ConnectedServiceId } from '@happier-dev/agents';
import {
  buildConnectedServiceAccountGroupOptionsByServiceId,
  buildConnectedServiceProfileOptionsByServiceId as buildCoreConnectedServiceProfileOptionsByServiceId,
  buildConnectedServicesBindingsPayload,
  isConnectedServiceProfileOptionSelectable,
  isConnectedServiceProfileStatusSelectable,
  resolveAgentSupportedConnectedServiceIds,
  resolveConnectedServiceAccountGroupViableProfileId,
  type ConnectedServiceSessionProjection,
  type ConnectedServicesAccountGroupOption,
  type ConnectedServicesAccountGroupOptionsByServiceId,
  type ConnectedServicesAccountGroupReadiness,
  type ConnectedServicesProfileOption as CoreConnectedServicesProfileOption,
  type ConnectedServicesProfileOptionsByServiceId as CoreConnectedServicesProfileOptionsByServiceId,
  type ConnectedServicesSessionAgentCore,
} from '@happier-dev/agents';

import { getConnectedServiceRegistryEntry } from '@/sync/domains/connectedServices/connectedServiceRegistry';

export {
  buildConnectedServiceAccountGroupOptionsByServiceId,
  buildConnectedServicesBindingsPayload,
  isConnectedServiceProfileOptionSelectable,
  isConnectedServiceProfileStatusSelectable,
  resolveAgentSupportedConnectedServiceIds,
  resolveConnectedServiceAccountGroupViableProfileId,
};

export type ConnectedServicesProfileOption = CoreConnectedServicesProfileOption & Readonly<{
  unsupportedSubtitleKey?:
    | 'connectedServices.defaultAuth.warning.connected_service_unsupported'
    | 'connectedServices.detail.connectSetupTokenSubtitle';
}>;

export type ConnectedServicesProfileOptionsByServiceId = Readonly<Record<string, ConnectedServicesProfileOption[]>>;
export type {
  ConnectedServicesAccountGroupOption,
  ConnectedServicesAccountGroupOptionsByServiceId,
  ConnectedServicesAccountGroupReadiness,
};

export type NewSessionConnectedServicesAgentCore = ConnectedServicesSessionAgentCore;
export type NewSessionConnectedServiceProjection = ConnectedServiceSessionProjection;

function resolveUnsupportedProfileSubtitleKey(serviceId: ConnectedServiceId):
  | 'connectedServices.defaultAuth.warning.connected_service_unsupported'
  | 'connectedServices.detail.connectSetupTokenSubtitle' {
  const entry = getConnectedServiceRegistryEntry(serviceId);
  return entry.supportsToken && entry.tokenKind === 'setup-token'
    ? 'connectedServices.detail.connectSetupTokenSubtitle'
    : 'connectedServices.defaultAuth.warning.connected_service_unsupported';
}

export function buildConnectedServiceProfileOptionsByServiceId(
  params: Parameters<typeof buildCoreConnectedServiceProfileOptionsByServiceId>[0],
): ConnectedServicesProfileOptionsByServiceId {
  const coreOptions = buildCoreConnectedServiceProfileOptionsByServiceId(params) as CoreConnectedServicesProfileOptionsByServiceId;
  const out: Record<string, ConnectedServicesProfileOption[]> = {};

  for (const [serviceId, options] of Object.entries(coreOptions)) {
    out[serviceId] = options.map((option) => option.status === 'unsupported_kind'
      ? {
          ...option,
          unsupportedSubtitleKey: resolveUnsupportedProfileSubtitleKey(serviceId as ConnectedServiceId),
        }
      : option);
  }

  return out;
}
