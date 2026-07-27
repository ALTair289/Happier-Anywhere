import { describe, expect, it } from 'vitest';

import { resolveCodexUsageLimitSwitchProgress } from './resolveCodexUsageLimitSwitchProgress';

describe('resolveCodexUsageLimitSwitchProgress', () => {
  it('does not treat a different selected profile as progress without provider verification', () => {
    const result = resolveCodexUsageLimitSwitchProgress({
      switchAttemptStatus: 'switched',
      exhaustedProfileId: 'work',
      selectedProfileId: 'backup',
      verificationStatus: null,
      resetAtMs: 5_000,
      nowMs: 1_000,
    });

    expect(result).toEqual({ kind: 'wait_until_reset', nextCheckAtMs: 5_000 });
  });

  it('treats a verified switch as ready to try without claiming provider recovery', () => {
    const result = resolveCodexUsageLimitSwitchProgress({
      switchAttemptStatus: 'switched',
      exhaustedProfileId: 'work',
      selectedProfileId: 'backup',
      verificationStatus: 'verified',
      resetAtMs: 5_000,
      nowMs: 1_000,
    });

    expect(result).toEqual({ kind: 'ready_to_try' });
  });

  it('does NOT treat a switch to the same exhausted profile as progress (live loop fix)', () => {
    const result = resolveCodexUsageLimitSwitchProgress({
      switchAttemptStatus: 'switched',
      exhaustedProfileId: 'work',
      selectedProfileId: 'work',
      verificationStatus: null,
      resetAtMs: 5_000,
      nowMs: 1_000,
    });

    // Must NOT be an immediate retry; must wait until the provider reset time.
    expect(result).toEqual({ kind: 'wait_until_reset', nextCheckAtMs: 5_000 });
  });

  it('waits using a fallback time when a same-profile switch has no known reset time', () => {
    const result = resolveCodexUsageLimitSwitchProgress({
      switchAttemptStatus: 'switched',
      exhaustedProfileId: 'work',
      selectedProfileId: 'work',
      verificationStatus: null,
      resetAtMs: null,
      nowMs: 1_000,
      fallbackNextCheckAtMs: 9_000,
    });

    expect(result).toEqual({ kind: 'wait_until_reset', nextCheckAtMs: 9_000 });
  });

  it('waits until reset when the group has no eligible member but reset timing is known', () => {
    const result = resolveCodexUsageLimitSwitchProgress({
      switchAttemptStatus: 'no_eligible_member',
      exhaustedProfileId: 'work',
      selectedProfileId: null,
      verificationStatus: null,
      resetAtMs: 5_000,
      nowMs: 1_000,
    });

    expect(result).toEqual({ kind: 'wait_until_reset', nextCheckAtMs: 5_000 });
  });

  it('reports terminal when the group has no eligible member and no reset timing is known', () => {
    const result = resolveCodexUsageLimitSwitchProgress({
      switchAttemptStatus: 'no_eligible_member',
      exhaustedProfileId: 'work',
      selectedProfileId: null,
      verificationStatus: null,
      resetAtMs: null,
      nowMs: 1_000,
    });

    expect(result).toEqual({ kind: 'exhausted', reason: 'connected_service_group_no_eligible_member' });
  });

  it('reports generation apply failure as exhausted with a reason', () => {
    const result = resolveCodexUsageLimitSwitchProgress({
      switchAttemptStatus: 'generation_apply_failed',
      exhaustedProfileId: 'work',
      selectedProfileId: null,
      verificationStatus: null,
      errorCode: 'apply_blew_up',
      resetAtMs: 5_000,
      nowMs: 1_000,
    });

    expect(result).toEqual({
      kind: 'exhausted',
      reason: 'connected_service_generation_apply_failed:apply_blew_up',
    });
  });

  it('waits until reset when the group reports manual strategy or switch limit', () => {
    expect(resolveCodexUsageLimitSwitchProgress({
      switchAttemptStatus: 'manual_strategy',
      exhaustedProfileId: 'work',
      selectedProfileId: null,
      verificationStatus: null,
      resetAtMs: 5_000,
      nowMs: 1_000,
    })).toEqual({ kind: 'wait_until_reset', nextCheckAtMs: 5_000 });

    expect(resolveCodexUsageLimitSwitchProgress({
      switchAttemptStatus: 'switch_limit_reached',
      exhaustedProfileId: 'work',
      selectedProfileId: null,
      verificationStatus: null,
      resetAtMs: 5_000,
      nowMs: 1_000,
    })).toEqual({ kind: 'wait_until_reset', nextCheckAtMs: 5_000 });
  });

  it('treats an observed generation as progress only when provider verification is present', () => {
    expect(resolveCodexUsageLimitSwitchProgress({
      switchAttemptStatus: 'observed_generation',
      exhaustedProfileId: 'work',
      selectedProfileId: 'backup',
      verificationStatus: null,
      resetAtMs: 5_000,
      nowMs: 1_000,
    })).toEqual({ kind: 'wait_until_reset', nextCheckAtMs: 5_000 });

    expect(resolveCodexUsageLimitSwitchProgress({
      switchAttemptStatus: 'observed_generation',
      exhaustedProfileId: 'work',
      selectedProfileId: 'backup',
      verificationStatus: 'verified',
      resetAtMs: 5_000,
      nowMs: 1_000,
    })).toEqual({ kind: 'ready_to_try' });
  });
});
