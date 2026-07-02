import {
  AGENTS_CORE,
  buildConnectedServiceAccountGroupOptionsByServiceId,
  buildConnectedServiceProfileOptionsByServiceId,
  resolveAgentIdFromFlavor,
  resolveAgentSupportedConnectedServiceIds,
  resolveConnectedServiceDefaultProfileId,
  type AgentCore,
  type ConnectedServiceId,
} from '@happier-dev/agents';
import type { AccountProfileResponse, AccountSettings } from '@happier-dev/protocol';

import { normalizeActionOptionLimit } from './actionOptionInputNormalization';

export type SpawnConnectedServiceOptionItem = Readonly<{
  value: string;
  label: string;
  serviceId: ConnectedServiceId;
  profiles: ReturnType<typeof buildConnectedServiceProfileOptionsByServiceId>[string];
  accountGroups: ReturnType<typeof buildConnectedServiceAccountGroupOptionsByServiceId>[string];
  defaultProfileId?: string;
}>;

function readStringRecord(value: unknown): Record<string, string | undefined> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: Record<string, string | undefined> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw === 'string') out[key] = raw;
  }
  return out;
}

function resolveAgentCore(agentId: unknown): AgentCore {
  const resolved = resolveAgentIdFromFlavor(agentId) ?? 'claude';
  return AGENTS_CORE[resolved];
}

export function listSpawnConnectedServiceItems(params: Readonly<{
  accountSettings: AccountSettings | Readonly<Record<string, unknown>>;
  accountProfile: AccountProfileResponse;
  agentId?: string | null;
  connectedServicesFeatureEnabled: boolean;
  accountGroupsFeatureEnabled: boolean;
  includeUnavailable?: boolean;
  limit?: unknown;
}>): Readonly<{ items: readonly SpawnConnectedServiceOptionItem[] }> {
  const settingsRecord = params.accountSettings as Readonly<Record<string, unknown>>;
  const agentCore = resolveAgentCore(params.agentId);
  const supportedConnectedServiceIds = resolveAgentSupportedConnectedServiceIds({
    connectedServicesFeatureEnabled: params.connectedServicesFeatureEnabled,
    agentCore,
  });
  const profileOptionsByServiceId = buildConnectedServiceProfileOptionsByServiceId({
    accountProfileConnectedServicesV2: params.accountProfile.connectedServicesV2,
    agentCore,
    supportedConnectedServiceIds,
    labelsByKey: readStringRecord(settingsRecord.connectedServicesProfileLabelByKey),
  });
  const accountGroupOptionsByServiceId = buildConnectedServiceAccountGroupOptionsByServiceId({
    accountGroupsFeatureEnabled: params.accountGroupsFeatureEnabled,
    accountProfileConnectedServicesV2: params.accountProfile.connectedServicesV2,
    supportedConnectedServiceIds,
  });
  const defaultProfileByServiceId = readStringRecord(settingsRecord.connectedServicesDefaultProfileByServiceId);

  const items: SpawnConnectedServiceOptionItem[] = [];
  for (const serviceId of supportedConnectedServiceIds) {
    const profiles = profileOptionsByServiceId[serviceId] ?? [];
    const accountGroups = params.accountGroupsFeatureEnabled && agentCore.connectedServices?.sessionAuthSwitch
      ? accountGroupOptionsByServiceId[serviceId] ?? []
      : [];
    if (params.includeUnavailable !== true && profiles.length === 0 && accountGroups.length === 0) {
      continue;
    }
    const connectedProfileIds = profiles
      .filter((profile) => profile.status === 'connected')
      .map((profile) => profile.profileId);
    const defaultProfileId = resolveConnectedServiceDefaultProfileId({
      serviceId,
      connectedProfileIds,
      defaultProfileByServiceId,
    });
    items.push({
      value: serviceId,
      label: serviceId,
      serviceId,
      profiles,
      accountGroups,
      ...(defaultProfileId ? { defaultProfileId } : {}),
    });
  }

  const explicitLimit = normalizeActionOptionLimit(params.limit);
  const sorted = items.sort((left, right) => left.serviceId.localeCompare(right.serviceId));
  const limited = explicitLimit ? sorted.slice(0, explicitLimit) : sorted;
  return { items: limited };
}
