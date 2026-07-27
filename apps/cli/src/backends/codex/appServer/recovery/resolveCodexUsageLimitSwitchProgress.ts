/**
 * Decide whether a connected-service group switch attempt represents genuine usage-limit
 * recovery progress for Codex.
 *
 * Live bug being fixed: when the rate-limit probe sees exhausted quota and the group recovery
 * reports `switched`, the runtime previously returned an immediate retry
 * (`nextCheckAtMs: Date.now()`). If the "switch" landed on the same selected profile, that
 * produced a tight immediate-retry storm.
 *
 * Deterministic-proof principle: this helper must not treat profile-id change as provider
 * account proof. Exact provider-account identity is owned by the daemon quota identity index /
 * fanout path and post-switch verification. Without that proof, wait until reset instead of
 * immediately retrying on a merely different selected profile.
 *
 * Seam for wave-3: this helper proves a fresh CANDIDATE was selected. Full provider-outcome
 * proof (the provider actually accepting the new account and producing activity) is left to the
 * shared provider-outcome proof gate (`provider_activity`).
 */

export type CodexUsageLimitSwitchAttemptStatus =
  | 'switched'
  | 'observed_generation'
  | 'generation_apply_failed'
  | 'no_eligible_member'
  | 'manual_strategy'
  | 'auto_switch_disabled'
  | 'switch_reason_disabled'
  | 'switch_limit_reached';

export type CodexUsageLimitSwitchProgress =
  | Readonly<{ kind: 'ready_to_try' }>
  | Readonly<{ kind: 'wait_until_reset'; nextCheckAtMs: number }>
  | Readonly<{ kind: 'exhausted'; reason: string }>;

function normalizeProfileId(value: string | null | undefined): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function resolveWaitTime(input: Readonly<{
  resetAtMs: number | null;
  nowMs: number;
  fallbackNextCheckAtMs?: number | null;
}>): number {
  if (typeof input.resetAtMs === 'number' && Number.isFinite(input.resetAtMs)) {
    return Math.trunc(input.resetAtMs);
  }
  if (typeof input.fallbackNextCheckAtMs === 'number' && Number.isFinite(input.fallbackNextCheckAtMs)) {
    return Math.trunc(input.fallbackNextCheckAtMs);
  }
  // Last-resort: never an immediate retry. Push out by a minute to avoid a storm.
  return input.nowMs + 60_000;
}

export function resolveCodexUsageLimitSwitchProgress(input: Readonly<{
  switchAttemptStatus: CodexUsageLimitSwitchAttemptStatus | null;
  exhaustedProfileId: string | null;
  selectedProfileId: string | null;
  verificationStatus: 'verified' | 'weakly_verified' | null;
  resetAtMs: number | null;
  nowMs: number;
  fallbackNextCheckAtMs?: number | null;
  errorCode?: string | null;
}>): CodexUsageLimitSwitchProgress {
  const waitUntilReset = (): CodexUsageLimitSwitchProgress => ({
    kind: 'wait_until_reset',
    nextCheckAtMs: resolveWaitTime(input),
  });

  switch (input.switchAttemptStatus) {
    case 'generation_apply_failed':
      return {
        kind: 'exhausted',
        reason: `connected_service_generation_apply_failed:${normalizeProfileId(input.errorCode) ?? 'unknown'}`,
      };
    case 'no_eligible_member':
      if (
        (typeof input.resetAtMs === 'number' && Number.isFinite(input.resetAtMs))
        || (typeof input.fallbackNextCheckAtMs === 'number' && Number.isFinite(input.fallbackNextCheckAtMs))
      ) {
        return waitUntilReset();
      }
      return { kind: 'exhausted', reason: 'connected_service_group_no_eligible_member' };
    case 'manual_strategy':
    case 'auto_switch_disabled':
    case 'switch_reason_disabled':
    case 'switch_limit_reached':
      // A real switch is not available right now; wait for the provider reset rather than loop.
      return waitUntilReset();
    case 'switched':
    case 'observed_generation': {
      // Codex requires exact live provider account proof before treating the switch as fresh
      // quota. `weakly_verified` is sufficient for auth-surface providers, not for Codex.
      if (input.verificationStatus === 'verified') {
        return { kind: 'ready_to_try' };
      }
      return waitUntilReset();
    }
    default:
      return waitUntilReset();
  }
}
