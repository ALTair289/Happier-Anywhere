import { classifyOpenCodeUsageLimitError } from './classifyOpenCodeUsageLimitError';
import {
  findOpenCodeConnectedServiceSelection,
  readOpenCodeConnectedServiceId,
  resolveOpenCodeConnectedServiceSelectionByPrecedence,
} from './openCodeConnectedServicePrecedence';
import { extractOpenCodeErrorText } from '@/backends/opencode/server/openCodeErrorText';
import { applyBrokerBridgeRuntimeAuthSelection } from '@/daemon/connectedServices/broker/applyBrokerBridgeRuntimeAuthSelection';
import {
  classifyProviderLimitEvidence,
  parseProviderResetAt,
} from '@/daemon/connectedServices/quotas/normalization';
import { mapProviderLimitCategoryToRuntimeAuthFailureKind } from '@/daemon/connectedServices/runtimeAuth/mapProviderLimitCategoryToRuntimeAuthFailureKind';
import type {
  ConnectedServiceProviderRuntimeAuthAdapter,
  ConnectedServiceRuntimeFailureClassification,
} from '@/daemon/connectedServices/runtimeAuth/types';

function readRecord(value: unknown): Record<string, unknown> | null {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Synthetic usage/rate-limit error names are minted from retry-status TEXT heuristics
 * (`buildOpenCodeRetryStatusError` tags them with `code/type: 'opencode_session_retry'`), so
 * classifications derived from them carry message-evidence provenance, not a structured
 * provider error contract (RD-OPI-6).
 */
function isHeuristicRetryStatusError(error: unknown): boolean {
  const record = readRecord(error);
  return readString(record?.code) === 'opencode_session_retry'
    || readString(record?.type) === 'opencode_session_retry';
}

function normalizeOpenCodeErrorEvidence(error: unknown): unknown {
  if (typeof error === 'string') return { message: error };
  const record = readRecord(error);
  if (!record && !(error instanceof Error)) return error;
  const message = extractOpenCodeErrorText(error);
  return {
    ...(error instanceof Error ? { name: error.name, message: error.message } : {}),
    ...(record ?? {}),
    ...(message ? { message } : {}),
  };
}

/**
 * Evidence fallback for provider failures surfaced through OpenCode that carry no structured
 * usage-limit name: underlying-provider auth failures (`ProviderAuthError`, 401/invalid-key
 * text), capacity/overload, plan and validation failures (RD-OPI-6). The structured
 * `ProviderAuthError` name is a stable OpenCode error contract; everything else is classified
 * from normalized message evidence via the shared classifier.
 */
function classifyOpenCodeRuntimeAuthEvidence(params: Readonly<{
  error: unknown;
  selection: Record<string, unknown> | null;
  serviceId: string;
}>): ConnectedServiceRuntimeFailureClassification | null {
  const evidence = normalizeOpenCodeErrorEvidence(params.error);
  const record = readRecord(evidence);
  const structuredAuthError = readString(record?.name) === 'ProviderAuthError';
  const category = structuredAuthError ? 'auth_invalid' : classifyProviderLimitEvidence(evidence);
  const kind = mapProviderLimitCategoryToRuntimeAuthFailureKind(category);
  if (!kind) return null;

  const timing = parseProviderResetAt({
    nowMs: Date.now(),
    body: record ?? { message: evidence },
  });
  return {
    kind,
    limitCategory: category,
    serviceId: params.serviceId,
    profileId: readString(params.selection?.activeProfileId ?? params.selection?.profileId),
    groupId: readString(params.selection?.groupId),
    resetsAtMs: timing.resetAtMs,
    retryAfterMs: timing.retryAfterMs,
    ...(category === 'usage_limit' || category === 'rate_limit' ? { quotaScope: 'account' as const } : {}),
    providerLimitId: null,
    action: null,
    planType: null,
    rateLimits: evidence,
    source: structuredAuthError ? 'structured_provider_error' as const : 'stable_provider_message' as const,
  };
}

export function resolveOpenCodeRuntimeAuthSelection(params: Readonly<{
  selections: readonly unknown[];
  error: unknown;
}>): unknown | null {
  const error = readRecord(params.error);
  const errorServiceId = readOpenCodeConnectedServiceId(error?.serviceId);
  if (errorServiceId) {
    return findOpenCodeConnectedServiceSelection(params.selections, errorServiceId);
  }

  return resolveOpenCodeConnectedServiceSelectionByPrecedence(params.selections);
}

export function createOpenCodeConnectedServiceRuntimeAuthAdapter(): ConnectedServiceProviderRuntimeAuthAdapter {
  return {
    classifyRuntimeAuthFailure(input) {
      const selection = readRecord(input.selection);
      const error = readRecord(input.error);
      const serviceId = readOpenCodeConnectedServiceId(error?.serviceId) ?? readOpenCodeConnectedServiceId(selection?.serviceId);
      if (!serviceId) return null;

      const classified = classifyOpenCodeUsageLimitError({
        providerErrorPath: true,
        error: input.error,
      });
      if (classified) {
        return {
          kind: classified.kind,
          limitCategory: classified.limitCategory,
          serviceId,
          profileId: readString(selection?.activeProfileId ?? selection?.profileId),
          groupId: readString(selection?.groupId),
          resetsAtMs: classified.resetAtMs,
          retryAfterMs: classified.retryAfterMs,
          planType: null,
          providerLimitId: classified.providerLimitId,
          quotaScope: classified.quotaScope,
          action: classified.action,
          rateLimits: classified,
          source: isHeuristicRetryStatusError(input.error)
            ? 'stable_provider_message'
            : 'structured_provider_error',
        };
      }

      return classifyOpenCodeRuntimeAuthEvidence({ error: input.error, selection, serviceId });
    },
    async materializeActiveProfile() {
      return { supported: true };
    },
    canHotApply(input) {
      const selection = readRecord(input.selection);
      return readString(selection?.brokerSelectionIdentity)
        ? { supported: true, recovery: 'provider_owned_broker_selection' }
        : { supported: false, recovery: 'restart_rematerialize' };
    },
    async hotApply(input) {
      return applyBrokerBridgeRuntimeAuthSelection(input.selection);
    },
    async recoverAfterRuntimeAuthSwitch(input) {
      const selection = readRecord(input.selection);
      if (!readString(selection?.brokerSelectionIdentity)) {
        return {
          recovered: false,
          recovery: 'restart_rematerialize',
          detached: false,
          detachedReason: 'broker_selection_identity_missing',
        };
      }

      return {
        recovered: true,
        recovery: 'provider_owned_broker_selection',
        detached: false,
        detachedReason: 'broker_request_time_selection_preserved',
      };
    },
    async verifyActiveAccount() {
      // No live provider probe exists: adoption is structurally implied by spawning into the
      // rematerialized auth env, so the claim is honest-but-weak (never a strong 'verified').
      return {
        status: 'weakly_verified',
        reason: 'provider_restart_rematerialization_authoritative',
      };
    },
    async probeQuota() {
      return { status: 'unsupported' };
    },
    async refreshActiveProfile() {
      return { status: 'unsupported' };
    },
  };
}
