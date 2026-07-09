import type { ConnectedServiceRefreshReason } from '@/daemon/connectedServices/credentials/lifecycleTypes';
import type { ApiClient } from '@/api/api';
import { serializeAxiosErrorForLog } from '@/api/client/serializeAxiosErrorForLog';
import { logger } from '@/ui/logger';
import type { BoundProfile } from './refreshTypes';

export type CredentialHealthReprobeState = Readonly<{
  failureCount: number;
  nextProbeAt: number;
}>;

const CREDENTIAL_HEALTH_REPROBE_BACKOFF_MS = [
  60_000,
  5 * 60_000,
  15 * 60_000,
  60 * 60_000,
] as const;

export function isReconnectRequiredProfileStatus(status: unknown): boolean {
  return status === 'needs_reauth';
}

export function shouldBlockRefreshForCredentialHealth(reason: ConnectedServiceRefreshReason): boolean {
  return reason === 'scheduled'
    || reason === 'spawn_preflight'
    || reason === 'runtime_auth_failure'
    || reason === 'quota_bridge';
}

export function canReprobeCredentialHealth(
  reason: ConnectedServiceRefreshReason,
  options: Readonly<{ force: boolean }>,
): boolean {
  if (options.force) return true;
  return reason === 'scheduled' || reason === 'quota_bridge';
}

export function credentialHealthReprobeDelayMs(failureCount: number): number {
  const index = Math.max(0, Math.min(
    CREDENTIAL_HEALTH_REPROBE_BACKOFF_MS.length - 1,
    Math.trunc(failureCount),
  ));
  return CREDENTIAL_HEALTH_REPROBE_BACKOFF_MS[index]!;
}

export async function readCredentialHealthStatusForRefresh(input: Readonly<{
  api: ApiClient;
  binding: BoundProfile;
}>): Promise<unknown> {
  const listProfiles = input.api.listConnectedServiceProfiles;
  if (typeof listProfiles !== 'function') return null;
  try {
    const result = await listProfiles.call(input.api, { serviceId: input.binding.serviceId });
    const profile = result.profiles.find((candidate) => candidate.profileId === input.binding.profileId);
    return profile?.status ?? null;
  } catch (error) {
    logger.warn('[DAEMON RUN] Failed to read connected-service profile health before refresh', {
      serviceId: input.binding.serviceId,
      profileId: input.binding.profileId,
      error: serializeAxiosErrorForLog(error),
    });
    return null;
  }
}
