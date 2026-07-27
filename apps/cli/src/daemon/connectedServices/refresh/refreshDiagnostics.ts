import type { ConnectedServiceCredentialHealthV1 } from '@happier-dev/protocol';

import type { ApiClient } from '@/api/api';
import { serializeAxiosErrorForLog } from '@/api/client/serializeAxiosErrorForLog';
import { logger } from '@/ui/logger';
import { resolveConnectedAccountPostRefreshCredentialHealth } from '../descriptors/connectedAccountDescriptors';
import type { ConnectedServicesMaterializationDiagnostic } from '../materialize/providerMaterializerTypes';
import type {
  ConnectedServiceRefreshFailureCategory,
  ConnectedServiceRefreshReason,
} from '@/daemon/connectedServices/credentials/lifecycleTypes';
import type {
  BoundProfile,
  ConnectedServiceCredentialRefreshDiagnostic,
  ConnectedServiceCredentialRefreshResult,
  ConnectedServiceCredentialRefreshStatus,
  RematerializedTargetFailure,
} from './refreshTypes';

export function providerHttpStatusForHealth(status: number | null | undefined): number | undefined {
  if (typeof status !== 'number' || !Number.isInteger(status)) return undefined;
  return status >= 100 && status <= 599 ? status : undefined;
}

export function providerErrorCodeForHealth(code: string | null | undefined): string | undefined {
  const trimmed = typeof code === 'string' ? code.trim() : '';
  return trimmed.length > 0 ? trimmed.slice(0, 128) : undefined;
}

function readConnectedServiceRefreshFailureCategory(
  value: unknown,
): ConnectedServiceRefreshFailureCategory | null {
  switch (value) {
    case 'invalid_grant':
    case 'invalid_client':
    case 'provider_401':
    case 'provider_403':
    case 'network_error':
    case 'malformed_response':
    case 'missing_access_token':
    case 'missing_refresh_token':
    case 'unknown':
      return value;
    default:
      return null;
  }
}

export type ConnectedServiceMaterializationCredentialRefreshClassification = Readonly<{
  category: ConnectedServiceRefreshFailureCategory;
  providerStatus?: number;
  providerErrorCode?: string;
}>;

export function classifyConnectedServiceMaterializationDiagnosticForCredentialRefresh(
  diagnostic: ConnectedServicesMaterializationDiagnostic,
): ConnectedServiceMaterializationCredentialRefreshClassification {
  const refreshFailure = diagnostic.credentialRefreshFailure;
  const category = readConnectedServiceRefreshFailureCategory(refreshFailure?.category) ?? 'unknown';
  const providerStatus = providerHttpStatusForHealth(refreshFailure?.providerStatus);
  const providerErrorCode = providerErrorCodeForHealth(refreshFailure?.providerErrorCode)
    ?? providerErrorCodeForHealth(diagnostic.code);

  return {
    category,
    ...(providerStatus !== undefined ? { providerStatus } : {}),
    ...(providerErrorCode !== undefined ? { providerErrorCode } : {}),
  };
}

export function buildRefreshDiagnostic(params: Readonly<{
  binding: BoundProfile;
  reason: ConnectedServiceRefreshReason;
  status: ConnectedServiceCredentialRefreshStatus;
  category?: ConnectedServiceRefreshFailureCategory;
  providerStatus?: number | null;
  providerErrorCode?: string | null;
  expiresAt?: number | null;
  now: number;
  refreshWindowMs: number;
}>): ConnectedServiceCredentialRefreshDiagnostic {
  const expiresAt = params.expiresAt ?? null;
  return {
    serviceId: params.binding.serviceId,
    profileId: params.binding.profileId,
    reason: params.reason,
    status: params.status,
    ...(params.category ? { category: params.category } : {}),
    ...(params.providerStatus !== undefined ? { providerStatus: params.providerStatus } : {}),
    ...(params.providerErrorCode !== undefined ? { providerErrorCode: params.providerErrorCode } : {}),
    expiresAt,
    expiryAgeMs: typeof expiresAt === 'number' && Number.isFinite(expiresAt) ? params.now - expiresAt : null,
    refreshWindowMs: params.refreshWindowMs,
  };
}

export function isReauthRequiredFailure(category: ConnectedServiceRefreshFailureCategory): boolean {
  return category === 'invalid_grant'
    || category === 'invalid_client'
    || category === 'provider_401'
    || category === 'provider_403'
    || category === 'missing_refresh_token';
}

export function buildFailureCredentialHealth(
  diagnostic: ConnectedServiceCredentialRefreshDiagnostic,
  now: number,
): ConnectedServiceCredentialHealthV1 {
  const category = diagnostic.category ?? 'unknown';
  return {
    v: 1,
    status: isReauthRequiredFailure(category) ? 'needs_reauth' : 'refresh_failed_retryable',
    reconnectRequired: isReauthRequiredFailure(category),
    lastRefreshAttemptAt: now,
    lastRefreshFailureAt: now,
    lastRefreshFailureKind: category,
    ...(providerHttpStatusForHealth(diagnostic.providerStatus) !== undefined
      ? { providerHttpStatus: providerHttpStatusForHealth(diagnostic.providerStatus) }
      : {}),
    ...(providerErrorCodeForHealth(diagnostic.providerErrorCode) !== undefined
      ? { providerErrorCode: providerErrorCodeForHealth(diagnostic.providerErrorCode) }
      : {}),
  };
}

export function buildSuccessCredentialHealth(
  result: ConnectedServiceCredentialRefreshResult,
  now: number,
): ConnectedServiceCredentialHealthV1 {
  const providerHealth = result.credential
    ? resolveConnectedAccountPostRefreshCredentialHealth({ credential: result.credential, now })
    : null;
  if (providerHealth) return providerHealth;

  return {
    v: 1,
    status: 'connected',
    reconnectRequired: false,
    lastRefreshAttemptAt: now,
    lastRefreshSuccessAt: now,
  };
}

export async function persistCredentialHealthForRefreshResult(input: Readonly<{
  api: ApiClient;
  result: ConnectedServiceCredentialRefreshResult;
  now: number;
}>): Promise<boolean> {
  const { api, result, now } = input;
  if (result.status !== 'refreshed' && result.status !== 'refresh_failed') return false;
  const updateHealth = api.updateConnectedServiceCredentialHealth;
  if (typeof updateHealth !== 'function') return false;

  const diagnostic = result.diagnostic;
  const health = result.status === 'refreshed'
    ? buildSuccessCredentialHealth(result, now)
    : buildFailureCredentialHealth(diagnostic, now);

  try {
    const settlement = await updateHealth.call(api, {
      serviceId: diagnostic.serviceId,
      profileId: diagnostic.profileId,
      health,
      ...(result.credentialRevision ? { expectedCredentialRevision: result.credentialRevision } : {}),
    });
    if (settlement && 'error' in settlement) return false;
    return true;
  } catch (error) {
    logger.warn('[DAEMON RUN] Failed to update connected-service credential health after refresh', {
      serviceId: diagnostic.serviceId,
      profileId: diagnostic.profileId,
      status: diagnostic.status,
      category: diagnostic.category ?? null,
      error: serializeAxiosErrorForLog(error),
    });
    return false;
  }
}

export async function persistCredentialHealthForMaterializationFailure(input: Readonly<{
  api: ApiClient;
  binding: BoundProfile;
  diagnostic: ConnectedServicesMaterializationDiagnostic;
  now: number;
}>): Promise<void> {
  const updateHealth = input.api.updateConnectedServiceCredentialHealth;
  if (typeof updateHealth !== 'function') return;

  const classification = classifyConnectedServiceMaterializationDiagnosticForCredentialRefresh(input.diagnostic);
  const health: ConnectedServiceCredentialHealthV1 = {
    v: 1,
    status: isReauthRequiredFailure(classification.category) ? 'needs_reauth' : 'refresh_failed_retryable',
    reconnectRequired: isReauthRequiredFailure(classification.category),
    lastRefreshAttemptAt: input.now,
    lastRefreshFailureAt: input.now,
    lastRefreshFailureKind: classification.category,
    ...(providerHttpStatusForHealth(classification.providerStatus) !== undefined
      ? { providerHttpStatus: providerHttpStatusForHealth(classification.providerStatus) }
      : {}),
    ...(classification.providerErrorCode ? { providerErrorCode: classification.providerErrorCode } : {}),
  };

  try {
    await updateHealth.call(input.api, {
      serviceId: input.binding.serviceId,
      profileId: input.binding.profileId,
      health,
    });
  } catch (error) {
    logger.warn('[DAEMON RUN] Failed to update connected-service credential health after materialization failure', {
      serviceId: input.binding.serviceId,
      profileId: input.binding.profileId,
      materializationCode: input.diagnostic.code,
      reason: input.diagnostic.reason ?? null,
      error: serializeAxiosErrorForLog(error),
    });
  }
}

export function buildMaterializationFailureRefreshResult(input: Readonly<{
  sourceResult: ConnectedServiceCredentialRefreshResult;
  failure: RematerializedTargetFailure;
  now: number;
  refreshWindowMs: number;
}>): ConnectedServiceCredentialRefreshResult {
  const classification = classifyConnectedServiceMaterializationDiagnosticForCredentialRefresh(input.failure.diagnostic);
  return {
    status: 'refresh_failed',
    credential: input.sourceResult.credential,
    diagnostic: buildRefreshDiagnostic({
      binding: input.failure.binding,
      reason: 'runtime_auth_failure',
      status: 'refresh_failed',
      category: classification.category,
      providerStatus: classification.providerStatus,
      providerErrorCode: classification.providerErrorCode ?? 'materialization_failed',
      expiresAt: input.sourceResult.diagnostic.expiresAt ?? input.sourceResult.credential?.expiresAt ?? null,
      now: input.now,
      refreshWindowMs: input.refreshWindowMs,
    }),
  };
}

export function buildMissingRuntimeAuthTargetRefreshResult(input: Readonly<{
  binding: BoundProfile;
  sourceResult: ConnectedServiceCredentialRefreshResult;
  now: number;
  refreshWindowMs: number;
}>): ConnectedServiceCredentialRefreshResult {
  return {
    status: 'refresh_failed',
    credential: input.sourceResult.credential,
    diagnostic: buildRefreshDiagnostic({
      binding: input.binding,
      reason: 'runtime_auth_failure',
      status: 'refresh_failed',
      category: 'unknown',
      providerErrorCode: 'runtime_auth_target_not_registered',
      expiresAt: input.sourceResult.diagnostic.expiresAt ?? input.sourceResult.credential?.expiresAt ?? null,
      now: input.now,
      refreshWindowMs: input.refreshWindowMs,
    }),
  };
}
