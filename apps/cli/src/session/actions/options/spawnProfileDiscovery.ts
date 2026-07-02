import {
  DEFAULT_BUILT_IN_BACKEND_PROFILES,
  parseBackendTargetKey,
  type AccountSettings,
  type BackendTargetRefV1,
} from '@happier-dev/protocol';

import { normalizeActionOptionLimit, normalizeActionOptionString } from './actionOptionInputNormalization';
import { readProfilesFromAccountSettings } from '@/settings/profiles/readProfilesFromAccountSettings';
import {
  filterProfilesForSpawnOptions,
  mapProfileToSpawnOptionItem,
  type SpawnProfileOptionItem,
} from '@/settings/profiles/profileListProjection';

function parseOptionalBackendTargetKey(value: unknown): BackendTargetRefV1 | null {
  const backendTargetKey = normalizeActionOptionString(value);
  if (!backendTargetKey) return null;
  try {
    return parseBackendTargetKey(backendTargetKey);
  } catch {
    return null;
  }
}

export function listSpawnProfileItems(params: Readonly<{
  accountSettings: AccountSettings | Readonly<Record<string, unknown>>;
  agentId?: string | null;
  backendTargetKey?: string | null;
  includeDisabled?: boolean;
  limit?: unknown;
}>): Readonly<{ items: readonly SpawnProfileOptionItem[] }> {
  const { customProfiles } = readProfilesFromAccountSettings(params.accountSettings as Readonly<Record<string, unknown>>);
  const backendTarget = parseOptionalBackendTargetKey(params.backendTargetKey);
  const agentId = normalizeActionOptionString(params.agentId);
  const profiles = filterProfilesForSpawnOptions({
    profiles: [...DEFAULT_BUILT_IN_BACKEND_PROFILES, ...customProfiles],
    ...(agentId ? { agentId } : {}),
    ...(backendTarget ? { backendTarget } : {}),
    includeDisabled: params.includeDisabled === true,
  });
  const items = profiles
    .map(mapProfileToSpawnOptionItem)
    .sort((left, right) => left.name.localeCompare(right.name));
  const limit = normalizeActionOptionLimit(params.limit);
  return { items: limit ? items.slice(0, limit) : items };
}
