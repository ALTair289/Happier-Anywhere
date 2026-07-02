import type { PendingQueueDeliveryBlockedReason } from '@/api/session/pendingQueueV2Transport';

import type { NormalizedProviderUsageLimitDetailsV1 } from '../connectedServices/mapClaudeRateLimitEventToUsageDetails';
import { isClaudeUnifiedTerminalInjectionFailureError } from './terminalInjectionFailureError';

export type ClaudeUnifiedPendingDeliveryBlock = Readonly<{
  localIds: readonly string[];
  reason: PendingQueueDeliveryBlockedReason;
}>;

export type ClaudeUnifiedProviderUnavailablePromptDeliveryWindow = Readonly<{
  unavailableUntilMs: number;
}>;

function readFutureTimestampMs(value: unknown, nowMs: number): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const timestampMs = Math.trunc(value);
  return timestampMs > nowMs ? timestampMs : null;
}

function readPositiveDurationMs(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const durationMs = Math.trunc(value);
  return durationMs > 0 ? durationMs : null;
}

export function resolveClaudeUnifiedProviderUnavailableUntilMs(
  details: NormalizedProviderUsageLimitDetailsV1,
  observedAtMs: number,
): number | null {
  const candidates = [
    readFutureTimestampMs(details.resetAtMs, observedAtMs),
    readFutureTimestampMs(details.overage?.resetAtMs, observedAtMs),
  ];
  const retryAfterMs = readPositiveDurationMs(details.retryAfterMs);
  if (retryAfterMs !== null) {
    candidates.push(observedAtMs + retryAfterMs);
  }

  const futureCandidates = candidates.filter((candidate): candidate is number => candidate !== null);
  return futureCandidates.length > 0 ? Math.max(...futureCandidates) : null;
}

export function isClaudeUnifiedProviderUnavailablePromptDeliveryWindowActive(
  window: ClaudeUnifiedProviderUnavailablePromptDeliveryWindow | null,
  nowMs: number,
): window is ClaudeUnifiedProviderUnavailablePromptDeliveryWindow {
  return window !== null && nowMs < window.unavailableUntilMs;
}

export function promoteClaudeUnifiedProviderAcceptanceTimeoutBlockForUnavailableProvider(
  block: ClaudeUnifiedPendingDeliveryBlock | null,
  providerUnavailableWindow: ClaudeUnifiedProviderUnavailablePromptDeliveryWindow | null,
  nowMs: number,
): ClaudeUnifiedPendingDeliveryBlock | null {
  if (
    block?.reason !== 'provider_acceptance_timeout'
    || !isClaudeUnifiedProviderUnavailablePromptDeliveryWindowActive(providerUnavailableWindow, nowMs)
  ) {
    return block;
  }

  return {
    ...block,
    reason: 'provider_unavailable_before_acceptance',
  };
}

function readUserMessageLocalIds(error: unknown): string[] {
  const raw = (error as { userMessageLocalIds?: unknown }).userMessageLocalIds;
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const localIds: string[] = [];
  for (const value of raw) {
    const localId = typeof value === 'string' ? value.trim() : '';
    if (!localId || seen.has(localId)) continue;
    seen.add(localId);
    localIds.push(localId);
  }
  return localIds;
}

export function resolveClaudeUnifiedPendingDeliveryBlock(
  error: unknown,
): ClaudeUnifiedPendingDeliveryBlock | null {
  if (!isClaudeUnifiedTerminalInjectionFailureError(error)) return null;

  const localIds = readUserMessageLocalIds(error);
  if (localIds.length === 0) return null;

  if (
    (error as { failureState?: unknown }).failureState === 'failed_terminal'
    && (error as { reason?: unknown }).reason === 'payload_too_large'
    && (error as { phase?: unknown }).phase === 'before_write'
    && (error as { duplicateRisk?: unknown }).duplicateRisk === 'none'
  ) {
    return {
      localIds,
      reason: 'payload_too_large',
    };
  }

  const failureState = (error as { failureState?: unknown }).failureState;
  const reason = (error as { reason?: unknown }).reason;
  const phase = (error as { phase?: unknown }).phase;
  const duplicateRisk = (error as { duplicateRisk?: unknown }).duplicateRisk;
  const recoverable = (error as { recoverable?: unknown }).recoverable;

  if (
    failureState === 'failed_ambiguous'
    && reason === 'timeout'
    && phase === 'after_enter_unknown'
    && duplicateRisk !== 'none'
    && recoverable === true
  ) {
    return {
      localIds,
      reason: 'provider_acceptance_timeout',
    };
  }

  if (
    failureState === 'failed_ambiguous'
    && reason === 'host_unreachable'
    && phase === 'after_enter_unknown'
    && duplicateRisk !== 'none'
    && recoverable === true
  ) {
    return {
      localIds,
      reason: 'ambiguous_terminal_delivery',
    };
  }

  if (
    failureState === 'failed_terminal'
    && reason === 'host_unreachable'
    && phase === 'after_write_before_enter'
    && duplicateRisk !== 'none'
    && recoverable === true
  ) {
    return {
      localIds,
      reason: 'terminal_host_unreachable',
    };
  }

  return null;
}
