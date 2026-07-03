import { describe, expect, it } from 'vitest';

import {
  DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1,
  hasConnectedServiceAuthGroupCandidateEvidenceForSwitchReason,
  isConnectedServiceAuthGroupSoftSwitchCandidateMeaningfullyBetter,
  reconcileMemberRuntimeStateWithFreshQuotaEvidence,
  selectConnectedServiceAuthGroupCandidate,
  type ConnectedServiceAuthGroupMemberRuntimeState,
} from './selectConnectedServiceAuthGroupCandidate';

const basePolicy = DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1;

function member(profileId: string, priority: number, createdAtMs: number) {
  return {
    profileId,
    priority,
    createdAtMs,
    enabled: true,
  };
}

describe('selectConnectedServiceAuthGroupCandidate', () => {
  it('does not treat the active profile as a meaningfully better soft-switch target', () => {
    expect(isConnectedServiceAuthGroupSoftSwitchCandidateMeaningfullyBetter({
      activeProfileId: 'active',
      candidate: {
        ...member('active', 1, 1),
        leastLimitedScore: 95,
      },
      policy: {
        ...basePolicy,
        softSwitchRemainingPercent: 20,
      },
    })).toBe(false);
  });

  it('selects the next eligible member by priority', () => {
    const result = selectConnectedServiceAuthGroupCandidate({
      nowMs: 1_000,
      quotaFreshnessMs: 60_000,
      activeProfileId: 'active',
      policy: { ...basePolicy, strategy: 'priority' },
      members: [
        member('active', 1, 1),
        member('backup-b', 20, 2),
        member('backup-a', 10, 3),
      ],
      memberStatesByProfileId: new Map(),
    });

    expect(result.selected?.profileId).toBe('backup-a');
  });

  it('tie-breaks priority candidates by creation time and profile id', () => {
    const result = selectConnectedServiceAuthGroupCandidate({
      nowMs: 1_000,
      quotaFreshnessMs: 60_000,
      activeProfileId: 'active',
      policy: { ...basePolicy, strategy: 'priority' },
      members: [
        member('delta', 10, 10),
        member('bravo', 10, 5),
        member('alpha', 10, 5),
      ],
      memberStatesByProfileId: new Map(),
    });

    expect(result.selected?.profileId).toBe('alpha');
  });

  it('ranks least-limited candidates by normalized quota headroom', () => {
    const states = new Map<string, ConnectedServiceAuthGroupMemberRuntimeState>([
      ['low', { quotaSnapshot: { capturedAtMs: 900, effectiveMeterId: 'daily', effectiveRemainingPercent: 25 } }],
      ['high', { quotaSnapshot: { capturedAtMs: 900, effectiveMeterId: 'weekly', effectiveRemainingPercent: 75 } }],
      ['medium', { quotaSnapshot: { capturedAtMs: 900, effectiveMeterId: 'model:gpt-5', effectiveRemainingPercent: 60 } }],
    ]);

    const result = selectConnectedServiceAuthGroupCandidate({
      nowMs: 1_000,
      quotaFreshnessMs: 60_000,
      activeProfileId: 'active',
      policy: { ...basePolicy, strategy: 'least_limited' },
      members: [
        member('low', 1, 1),
        member('medium', 1, 2),
        member('high', 1, 3),
      ],
      memberStatesByProfileId: states,
    });

    expect(result.selected?.profileId).toBe('high');
  });

  it('ranks least-limited candidates by generic effective meter headroom', () => {
    const states = new Map<string, ConnectedServiceAuthGroupMemberRuntimeState>([
      ['gemini-daily', { quotaSnapshot: { capturedAtMs: 900, effectiveMeterId: 'daily', effectiveRemainingPercent: 30 } }],
      ['future-model', { quotaSnapshot: { capturedAtMs: 900, effectiveMeterId: 'model:gpt-6', effectiveRemainingPercent: 65 } }],
      ['weekly', { quotaSnapshot: { capturedAtMs: 900, effectiveMeterId: 'weekly', effectiveRemainingPercent: 5 } }],
    ]);

    const result = selectConnectedServiceAuthGroupCandidate({
      nowMs: 1_000,
      quotaFreshnessMs: 60_000,
      activeProfileId: 'active',
      policy: { ...basePolicy, strategy: 'least_limited' },
      members: [
        member('weekly', 1, 1),
        member('gemini-daily', 1, 2),
        member('future-model', 1, 3),
      ],
      memberStatesByProfileId: states,
    });

    expect(result.selected?.profileId).toBe('future-model');
  });

  it('honors provider reset timestamps as cooldown floors', () => {
    const result = selectConnectedServiceAuthGroupCandidate({
      nowMs: 1_000,
      quotaFreshnessMs: 60_000,
      activeProfileId: 'active',
      policy: {
        ...basePolicy,
        strategy: 'priority',
        cooldownMs: 100,
        honorProviderResetsAt: true,
      },
      members: [
        member('reset-later', 1, 1),
        member('ready', 2, 2),
      ],
      memberStatesByProfileId: new Map([
        ['reset-later', { cooldownStartedAtMs: 500, providerResetsAtMs: 2_000 }],
      ]),
    });

    expect(result.selected?.profileId).toBe('ready');
    expect(result.excluded).toContainEqual({
      profileId: 'reset-later',
      reason: 'cooldown',
      retryAtMs: 2_000,
    });
  });

  it('does not treat provider reset timestamps as cooldowns without a blocking state', () => {
    const result = selectConnectedServiceAuthGroupCandidate({
      nowMs: 1_000,
      quotaFreshnessMs: 60_000,
      activeProfileId: 'active',
      policy: {
        ...basePolicy,
        strategy: 'priority',
        honorProviderResetsAt: true,
      },
      members: [
        member('active', 1, 1),
        member('healthy-backup', 2, 2),
      ],
      memberStatesByProfileId: new Map([
        ['healthy-backup', {
          providerResetsAtMs: 2_000,
          quotaSnapshot: {
            capturedAtMs: 900,
            effectiveMeterId: 'weekly',
            effectiveRemainingPercent: 88,
          },
        }],
      ]),
    });

    expect(result.selected?.profileId).toBe('healthy-backup');
    expect(result.excluded).not.toContainEqual(expect.objectContaining({
      profileId: 'healthy-backup',
      reason: 'cooldown',
    }));
  });

  it('clears stale cooldown blockers when fresh usable quota evidence proves the member is healthy', () => {
    const result = selectConnectedServiceAuthGroupCandidate({
      nowMs: 1_000,
      quotaFreshnessMs: 60_000,
      activeProfileId: 'active',
      allowCurrentProfileRetry: true,
      policy: {
        ...basePolicy,
        strategy: 'least_limited',
        cooldownMs: 30_000,
        honorProviderResetsAt: true,
        softSwitchRemainingPercent: 15,
      },
      members: [
        member('active', 1, 1),
        member('backup', 2, 2),
      ],
      memberStatesByProfileId: new Map([
        ['active', {
          cooldownStartedAtMs: 900,
          cooldownUntilMs: 60_000,
          providerResetsAtMs: 60_000,
          quotaSnapshot: {
            capturedAtMs: 950,
            effectiveMeterId: 'weekly',
            effectiveRemainingPercent: 52,
          },
        }],
        ['backup', {
          quotaSnapshot: {
            capturedAtMs: 950,
            effectiveMeterId: 'weekly',
            effectiveRemainingPercent: 90,
          },
        }],
      ]),
    });

    expect(result.selected?.profileId).toBe('active');
    expect(result.excluded).not.toContainEqual(expect.objectContaining({
      profileId: 'active',
      reason: 'cooldown',
    }));
  });

  it('removes generic cooldown fields from reconciled runtime state when fresh quota is usable', () => {
    const reconciled = reconcileMemberRuntimeStateWithFreshQuotaEvidence({
      nowMs: 1_000,
      policy: {
        ...basePolicy,
        cooldownMs: 30_000,
        honorProviderResetsAt: true,
      },
      state: {
        cooldownStartedAtMs: 900,
        cooldownUntilMs: 60_000,
        exhaustedUntilMs: 60_000,
        providerResetsAtMs: 60_000,
      },
      quotaSnapshot: {
        capturedAtMs: 950,
        effectiveMeterId: 'weekly',
        effectiveRemainingPercent: 52,
      },
    });

    expect(reconciled).toEqual({
      providerResetsAtMs: 60_000,
    });
  });

  it('starts on the current low-quota member when no safe better candidate exists', () => {
    const result = selectConnectedServiceAuthGroupCandidate({
      nowMs: 1_000,
      quotaFreshnessMs: 60_000,
      activeProfileId: 'active',
      allowCurrentProfileRetry: true,
      policy: { ...basePolicy, strategy: 'least_limited', softSwitchRemainingPercent: 15 },
      members: [
        member('active', 1, 1),
        member('backup', 2, 2),
      ],
      memberStatesByProfileId: new Map([
        ['active', { quotaSnapshot: { capturedAtMs: 900, effectiveMeterId: 'daily', effectiveRemainingPercent: 10 } }],
        ['backup', { quotaSnapshot: { capturedAtMs: 900, exhausted: true }, providerResetsAtMs: 5_000 }],
      ]),
    });

    expect(result.selected?.profileId).toBe('active');
    expect(result.excluded).toContainEqual({
      profileId: 'backup',
      reason: 'quota_exhausted',
      retryAtMs: 5_000,
    });
  });

  it('switches from a low-quota current member only when a safe better candidate exists', () => {
    const result = selectConnectedServiceAuthGroupCandidate({
      nowMs: 1_000,
      quotaFreshnessMs: 60_000,
      activeProfileId: 'active',
      allowCurrentProfileRetry: true,
      policy: { ...basePolicy, strategy: 'least_limited', softSwitchRemainingPercent: 15 },
      members: [
        member('active', 1, 1),
        member('backup', 2, 2),
      ],
      memberStatesByProfileId: new Map([
        ['active', { quotaSnapshot: { capturedAtMs: 900, effectiveMeterId: 'daily', effectiveRemainingPercent: 10 } }],
        ['backup', { quotaSnapshot: { capturedAtMs: 900, effectiveMeterId: 'weekly', effectiveRemainingPercent: 75 } }],
      ]),
    });

    expect(result.selected?.profileId).toBe('backup');
  });

  it('soft-switches from a low-quota current member under priority strategy when a safer candidate exists', () => {
    const result = selectConnectedServiceAuthGroupCandidate({
      nowMs: 1_000,
      quotaFreshnessMs: 60_000,
      activeProfileId: 'active',
      allowCurrentProfileRetry: true,
      policy: { ...basePolicy, strategy: 'priority', softSwitchRemainingPercent: 15 },
      members: [
        member('active', 1, 1),
        member('backup', 2, 2),
      ],
      memberStatesByProfileId: new Map([
        ['active', { quotaSnapshot: { capturedAtMs: 900, effectiveMeterId: 'daily', effectiveRemainingPercent: 10 } }],
        ['backup', { quotaSnapshot: { capturedAtMs: 900, effectiveMeterId: 'weekly', effectiveRemainingPercent: 75 } }],
      ]),
    });

    expect(result.selected?.profileId).toBe('backup');
  });

  it('keeps the current member when it is above the soft-switch threshold', () => {
    const result = selectConnectedServiceAuthGroupCandidate({
      nowMs: 1_000,
      quotaFreshnessMs: 60_000,
      activeProfileId: 'active',
      allowCurrentProfileRetry: true,
      policy: { ...basePolicy, strategy: 'least_limited', softSwitchRemainingPercent: 15 },
      members: [
        member('active', 1, 1),
        member('backup', 2, 2),
      ],
      memberStatesByProfileId: new Map([
        ['active', { quotaSnapshot: { capturedAtMs: 900, effectiveMeterId: 'daily', effectiveRemainingPercent: 50 } }],
        ['backup', { quotaSnapshot: { capturedAtMs: 900, effectiveMeterId: 'weekly', effectiveRemainingPercent: 90 } }],
      ]),
    });

    expect(result.selected?.profileId).toBe('active');
  });

  it('keeps the current member below threshold when candidates are not better', () => {
    const result = selectConnectedServiceAuthGroupCandidate({
      nowMs: 1_000,
      quotaFreshnessMs: 60_000,
      activeProfileId: 'active',
      allowCurrentProfileRetry: true,
      policy: { ...basePolicy, strategy: 'least_limited', softSwitchRemainingPercent: 15 },
      members: [
        member('active', 1, 1),
        member('backup', 2, 2),
      ],
      memberStatesByProfileId: new Map([
        ['active', { quotaSnapshot: { capturedAtMs: 900, effectiveMeterId: 'daily', effectiveRemainingPercent: 10 } }],
        ['backup', { quotaSnapshot: { capturedAtMs: 900, effectiveMeterId: 'weekly', effectiveRemainingPercent: 5 } }],
      ]),
    });

    expect(result.selected?.profileId).toBe('active');
  });

  it('separates capacity backoff from account quota exhaustion', () => {
    const result = selectConnectedServiceAuthGroupCandidate({
      nowMs: 1_000,
      quotaFreshnessMs: 60_000,
      activeProfileId: 'active',
      policy: { ...basePolicy, strategy: 'priority' },
      members: [
        member('active', 1, 1),
        member('capacity-limited', 2, 2),
      ],
      memberStatesByProfileId: new Map([
        ['capacity-limited', { capacityLimitedUntilMs: 5_000 }],
      ]),
    });

    expect(result.selected).toBeNull();
    expect(result.excluded).toContainEqual({
      profileId: 'capacity-limited',
      reason: 'capacity_limited',
      retryAtMs: 5_000,
    });
    expect(result.excluded).not.toContainEqual(expect.objectContaining({
      profileId: 'capacity-limited',
      reason: 'quota_exhausted',
    }));
  });

  it('excludes persisted quota and rate exhaustion from selector ranking after restart', () => {
    const result = selectConnectedServiceAuthGroupCandidate({
      nowMs: 1_000,
      quotaFreshnessMs: 60_000,
      activeProfileId: 'active',
      policy: { ...basePolicy, strategy: 'least_limited' },
      members: [
        member('quota-exhausted', 1, 1),
        member('rate-limited', 2, 2),
        member('healthy', 3, 3),
      ],
      memberStatesByProfileId: new Map([
        ['quota-exhausted', { quotaExhaustedUntilMs: 5_000 }],
        ['rate-limited', { rateLimitedUntilMs: 4_000 }],
        ['healthy', { quotaSnapshot: { capturedAtMs: 900, effectiveMeterId: 'daily', effectiveRemainingPercent: 30 } }],
      ]),
    });

    expect(result.selected?.profileId).toBe('healthy');
    expect(result.excluded).toEqual(expect.arrayContaining([
      { profileId: 'quota-exhausted', reason: 'quota_exhausted', retryAtMs: 5_000 },
      { profileId: 'rate-limited', reason: 'quota_exhausted', retryAtMs: 4_000 },
    ]));
  });

  it('uses fresh usable quota evidence to ignore stale future quota blockers in the same selection pass', () => {
    const result = selectConnectedServiceAuthGroupCandidate({
      nowMs: 1_000,
      quotaFreshnessMs: 60_000,
      activeProfileId: 'active',
      policy: { ...basePolicy, strategy: 'priority', cooldownMs: 500 },
      members: [
        member('blocked-but-usable', 1, 1),
        member('fallback', 2, 2),
      ],
      memberStatesByProfileId: new Map([
        ['blocked-but-usable', {
          quotaExhaustedUntilMs: 10_000,
          lastFailureKind: 'usage_limit',
          lastObservedAtMs: 500,
          providerResetsAtMs: 10_000,
          quotaSnapshot: {
            capturedAtMs: 900,
            effectiveMeterId: 'weekly',
            effectiveRemainingPercent: 75,
            meters: [{
              meterId: 'weekly',
              limitCategory: 'usage_limit',
              remainingPct: 75,
              resetAtMs: 4_000,
              providerLimitId: 'weekly',
            }],
          },
        }],
        ['fallback', { quotaSnapshot: { capturedAtMs: 900, effectiveMeterId: 'weekly', effectiveRemainingPercent: 30 } }],
      ]),
    });

    expect(result.selected?.profileId).toBe('blocked-but-usable');
    expect(result.excluded).not.toContainEqual(expect.objectContaining({
      profileId: 'blocked-but-usable',
    }));
  });

  it('keeps a true fresh secondary quota blocker and uses its fresh reset instead of stale persisted reset', () => {
    const result = selectConnectedServiceAuthGroupCandidate({
      nowMs: 1_000,
      quotaFreshnessMs: 60_000,
      activeProfileId: 'active',
      policy: { ...basePolicy, strategy: 'priority', cooldownMs: 500 },
      members: [
        member('weekly-exhausted', 1, 1),
        member('fallback', 2, 2),
      ],
      memberStatesByProfileId: new Map([
        ['weekly-exhausted', {
          quotaExhaustedUntilMs: 10_000,
          lastFailureKind: 'usage_limit',
          lastObservedAtMs: 500,
          providerResetsAtMs: 4_000,
          quotaSnapshot: {
            capturedAtMs: 900,
            effectiveMeterId: 'primary',
            effectiveRemainingPercent: 80,
            exhausted: true,
            meters: [
              {
                meterId: 'primary',
                limitCategory: 'usage_limit',
                remainingPct: 80,
                resetAtMs: 2_000,
                providerLimitId: 'primary',
              },
              {
                meterId: 'weekly',
                limitCategory: 'usage_limit',
                remainingPct: 0,
                resetAtMs: 4_000,
                providerLimitId: 'weekly',
              },
            ],
          },
        }],
        ['fallback', { quotaSnapshot: { capturedAtMs: 900, effectiveMeterId: 'weekly', effectiveRemainingPercent: 30 } }],
      ]),
    });

    expect(result.selected?.profileId).toBe('fallback');
    expect(result.excluded).toContainEqual({
      profileId: 'weekly-exhausted',
      reason: 'quota_exhausted',
      retryAtMs: 4_000,
    });
  });

  it('uses newer fresh usable quota evidence to clear a same-category blocker during the recent failure cooldown', () => {
    const result = selectConnectedServiceAuthGroupCandidate({
      nowMs: 1_100,
      quotaFreshnessMs: 60_000,
      activeProfileId: 'active',
      policy: { ...basePolicy, strategy: 'priority', cooldownMs: 500 },
      members: [
        member('just-proven-usable', 1, 1),
        member('fallback', 2, 2),
      ],
      memberStatesByProfileId: new Map([
        ['just-proven-usable', {
          quotaExhaustedUntilMs: 10_000,
          lastFailureKind: 'usage_limit',
          lastObservedAtMs: 1_050,
          quotaSnapshot: {
            capturedAtMs: 1_060,
            effectiveMeterId: 'weekly',
            effectiveRemainingPercent: 90,
            meters: [{
              meterId: 'weekly',
              limitCategory: 'usage_limit',
              remainingPct: 90,
              resetAtMs: 4_000,
              providerLimitId: 'weekly',
            }],
          },
        }],
        ['fallback', { quotaSnapshot: { capturedAtMs: 1_060, effectiveMeterId: 'weekly', effectiveRemainingPercent: 30 } }],
      ]),
    });

    expect(result.selected?.profileId).toBe('just-proven-usable');
    expect(result.excluded).not.toContainEqual(expect.objectContaining({
      profileId: 'just-proven-usable',
    }));
  });

  it('does not clear a same-category quota blocker from stale evidence after a newer provider failure', () => {
    const result = selectConnectedServiceAuthGroupCandidate({
      nowMs: 1_100,
      quotaFreshnessMs: 60_000,
      activeProfileId: 'active',
      policy: { ...basePolicy, strategy: 'priority', cooldownMs: 500 },
      members: [
        member('just-failed', 1, 1),
        member('fallback', 2, 2),
      ],
      memberStatesByProfileId: new Map([
        ['just-failed', {
          quotaExhaustedUntilMs: 10_000,
          lastFailureKind: 'usage_limit',
          lastObservedAtMs: 1_050,
          quotaSnapshot: {
            capturedAtMs: 1_040,
            effectiveMeterId: 'weekly',
            effectiveRemainingPercent: 90,
            meters: [{
              meterId: 'weekly',
              limitCategory: 'usage_limit',
              remainingPct: 90,
              resetAtMs: 4_000,
              providerLimitId: 'weekly',
            }],
          },
        }],
        ['fallback', { quotaSnapshot: { capturedAtMs: 1_060, effectiveMeterId: 'weekly', effectiveRemainingPercent: 30 } }],
      ]),
    });

    expect(result.selected?.profileId).toBe('fallback');
    expect(result.excluded).toContainEqual({
      profileId: 'just-failed',
      reason: 'quota_exhausted',
      retryAtMs: 1_550,
    });
  });

  it('emits candidate-level decision traces when stale source quota blocks automatic selection', () => {
    const result = selectConnectedServiceAuthGroupCandidate({
      nowMs: 61_100,
      quotaFreshnessMs: 60_000,
      activeProfileId: 'active',
      policy: { ...basePolicy, strategy: 'least_limited', softSwitchRemainingPercent: 15 },
      members: [
        member('active', 1, 1),
        member('backup', 2, 2),
      ],
      memberStatesByProfileId: new Map([
        ['active', {
          quotaSnapshot: {
            capturedAtMs: 1,
            effectiveMeterId: 'weekly',
            effectiveRemainingPercent: 2,
          },
        }],
        ['backup', {
          quotaSnapshot: {
            capturedAtMs: 61_090,
            effectiveMeterId: 'weekly',
            effectiveRemainingPercent: 80,
          },
        }],
      ]),
      allowCurrentProfileRetry: true,
    });

    expect(result.selected?.profileId).toBe('active');
    expect(result).toMatchObject({
      decisionTrace: expect.objectContaining({
        activeProfileId: 'active',
        reason: 'selected',
        candidates: expect.arrayContaining([
          expect.objectContaining({
            profileId: 'active',
            decision: 'selected',
            quotaEvidence: expect.objectContaining({
              status: 'stale_or_missing',
            }),
          }),
          expect.objectContaining({
            profileId: 'backup',
            decision: 'eligible',
            quotaEvidence: expect.objectContaining({
              status: 'fresh',
              remainingPercent: 80,
            }),
          }),
        ]),
      }),
    });
  });

  it('allows quota-unknown targets only for hard usage-limit recovery', () => {
    const emptyStates = new Map<string, ConnectedServiceAuthGroupMemberRuntimeState>();

    expect(hasConnectedServiceAuthGroupCandidateEvidenceForSwitchReason({
      reason: 'usage_limit',
      profileId: 'fallback',
      nowMs: 1_000,
      quotaFreshnessMs: 60_000,
      memberStatesByProfileId: emptyStates,
    })).toBe(true);
    expect(hasConnectedServiceAuthGroupCandidateEvidenceForSwitchReason({
      reason: 'same_provider_account_exhausted',
      profileId: 'fallback',
      nowMs: 1_000,
      quotaFreshnessMs: 60_000,
      memberStatesByProfileId: emptyStates,
    })).toBe(true);
    expect(hasConnectedServiceAuthGroupCandidateEvidenceForSwitchReason({
      reason: 'soft_threshold',
      profileId: 'fallback',
      nowMs: 1_000,
      quotaFreshnessMs: 60_000,
      memberStatesByProfileId: emptyStates,
    })).toBe(false);
    expect(hasConnectedServiceAuthGroupCandidateEvidenceForSwitchReason({
      reason: 'same_provider_account_exhausted',
      profileId: 'fallback',
      nowMs: 1_000,
      quotaFreshnessMs: 60_000,
      memberStatesByProfileId: new Map([
        ['fallback', {
          quotaSnapshot: {
            capturedAtMs: 900,
            effectiveMeterId: 'weekly',
            effectiveRemainingPercent: 0,
          },
        }],
      ]),
    })).toBe(false);
    expect(hasConnectedServiceAuthGroupCandidateEvidenceForSwitchReason({
      reason: 'usage_limit',
      profileId: 'fallback',
      nowMs: 1_000,
      quotaFreshnessMs: 60_000,
      memberStatesByProfileId: new Map([
        ['fallback', {
          quotaSnapshot: {
            capturedAtMs: 900,
            effectiveMeterId: 'weekly',
            effectiveRemainingPercent: 0,
          },
        }],
      ]),
    })).toBe(false);
  });

  it('applies policy fallback cooldowns to recent rate-limit and capacity failures without provider timing', () => {
    const result = selectConnectedServiceAuthGroupCandidate({
      nowMs: 1_000,
      quotaFreshnessMs: 60_000,
      activeProfileId: 'active',
      policy: { ...basePolicy, strategy: 'priority', cooldownMs: 500 },
      members: [
        member('rate-limited', 1, 1),
        member('capacity-limited', 2, 2),
        member('fallback', 3, 3),
      ],
      memberStatesByProfileId: new Map([
        ['rate-limited', {
          lastFailureKind: 'rate_limit',
          lastObservedAtMs: 750,
        }],
        ['capacity-limited', {
          lastFailureKind: 'capacity',
          lastObservedAtMs: 750,
        }],
      ]),
    });

    expect(result.selected?.profileId).toBe('fallback');
    expect(result.excluded).toEqual(expect.arrayContaining([
      { profileId: 'rate-limited', reason: 'quota_exhausted', retryAtMs: 1_250 },
      { profileId: 'capacity-limited', reason: 'capacity_limited', retryAtMs: 1_250 },
    ]));
  });

  it('temporarily excludes recently observed usage-limit failures when no reset timestamp was available', () => {
    const result = selectConnectedServiceAuthGroupCandidate({
      nowMs: 1_000,
      quotaFreshnessMs: 60_000,
      activeProfileId: 'active',
      policy: { ...basePolicy, strategy: 'least_limited', cooldownMs: 500 },
      members: [
        member('recently-limited', 1, 1),
        member('healthy', 2, 2),
      ],
      memberStatesByProfileId: new Map([
        ['recently-limited', {
          lastFailureKind: 'usage_limit',
          lastObservedAtMs: 750,
        }],
        ['healthy', { quotaSnapshot: { capturedAtMs: 900, effectiveMeterId: 'daily', effectiveRemainingPercent: 30 } }],
      ]),
    });

    expect(result.selected?.profileId).toBe('healthy');
    expect(result.excluded).toContainEqual({
      profileId: 'recently-limited',
      reason: 'quota_exhausted',
      retryAtMs: 1_250,
    });
  });

  it('does not let unknown quota outrank known healthy quota', () => {
    const result = selectConnectedServiceAuthGroupCandidate({
      nowMs: 1_000,
      quotaFreshnessMs: 60_000,
      activeProfileId: 'active',
      policy: { ...basePolicy, strategy: 'least_limited' },
      members: [
        member('unknown', 1, 1),
        member('healthy', 2, 2),
      ],
      memberStatesByProfileId: new Map([
        ['healthy', { quotaSnapshot: { capturedAtMs: 900, effectiveMeterId: 'daily', effectiveRemainingPercent: 60 } }],
      ]),
    });

    expect(result.selected?.profileId).toBe('healthy');
  });

  it('excludes auth, plan, and validation blockers from quota ranking', () => {
    const result = selectConnectedServiceAuthGroupCandidate({
      nowMs: 1_000,
      quotaFreshnessMs: 60_000,
      activeProfileId: 'active',
      policy: { ...basePolicy, strategy: 'least_limited' },
      members: [
        member('auth-blocked', 1, 1),
        member('plan-blocked', 2, 2),
        member('validation-blocked', 3, 3),
        member('healthy', 4, 4),
      ],
      memberStatesByProfileId: new Map([
        ['auth-blocked', { authInvalidUntilMs: 5_000 }],
        ['plan-blocked', { planUnavailableUntilMs: 5_000 }],
        ['validation-blocked', { validationBlockedUntilMs: 5_000 }],
        ['healthy', { quotaSnapshot: { capturedAtMs: 900, effectiveMeterId: 'daily', effectiveRemainingPercent: 40 } }],
      ]),
    });

    expect(result.selected?.profileId).toBe('healthy');
    expect(result.excluded).toEqual(expect.arrayContaining([
      { profileId: 'auth-blocked', reason: 'auth_invalid', retryAtMs: 5_000 },
      { profileId: 'plan-blocked', reason: 'plan_unavailable', retryAtMs: 5_000 },
      { profileId: 'validation-blocked', reason: 'validation_blocked', retryAtMs: 5_000 },
    ]));
  });

  it('excludes reconnect-required credential health from automatic selection', () => {
    const result = selectConnectedServiceAuthGroupCandidate({
      nowMs: 1_000,
      quotaFreshnessMs: 60_000,
      activeProfileId: 'active',
      policy: { ...basePolicy, strategy: 'priority' },
      members: [
        member('reauth', 1, 1),
        member('healthy', 2, 2),
      ],
      memberStatesByProfileId: new Map([
        ['reauth', { credentialHealthStatus: 'needs_reauth' } as ConnectedServiceAuthGroupMemberRuntimeState],
      ]),
    });

    expect(result.selected?.profileId).toBe('healthy');
    expect(result.excluded).toContainEqual({
      profileId: 'reauth',
      reason: 'auth_invalid',
    });
  });

  it('keeps retryable credential-health states selectable while excluding reconnect-required health', () => {
    const result = selectConnectedServiceAuthGroupCandidate({
      nowMs: 1_000,
      quotaFreshnessMs: 60_000,
      activeProfileId: 'active',
      policy: { ...basePolicy, strategy: 'priority' },
      members: [
        member('refreshing', 1, 1),
        member('retryable-refresh-failed', 2, 2),
        member('reauth', 3, 3),
        member('healthy', 4, 4),
      ],
      memberStatesByProfileId: new Map([
        ['refreshing', { credentialHealthStatus: 'refreshing' }],
        ['retryable-refresh-failed', { credentialHealthStatus: 'refresh_failed_retryable' }],
        ['reauth', { credentialHealthStatus: 'needs_reauth' }],
        ['healthy', { credentialHealthStatus: 'connected' }],
      ]),
    });

    expect(result.selected?.profileId).toBe('refreshing');
    expect(result.excluded).toEqual(expect.arrayContaining([
      { profileId: 'reauth', reason: 'auth_invalid' },
    ]));
    expect(result.excluded).not.toEqual(expect.arrayContaining([
      { profileId: 'refreshing', reason: 'auth_invalid' },
      { profileId: 'retryable-refresh-failed', reason: 'auth_invalid' },
    ]));
  });

  it('excludes snapshot-level eligibility blockers from candidate selection', () => {
    const result = selectConnectedServiceAuthGroupCandidate({
      nowMs: 1_000,
      quotaFreshnessMs: 60_000,
      activeProfileId: 'active',
      policy: { ...basePolicy, strategy: 'priority' },
      members: [
        member('active', 1, 1),
        member('plan-blocked', 2, 2),
        member('capacity-limited', 3, 3),
        member('healthy', 4, 4),
      ],
      memberStatesByProfileId: new Map([
        ['plan-blocked', {
          quotaSnapshot: {
            capturedAtMs: 900,
            meters: [{
              meterId: 'plan',
              limitCategory: 'plan_invalid',
              remainingPct: null,
              resetAtMs: null,
              providerLimitId: 'plan',
            }],
          },
        }],
        ['capacity-limited', {
          quotaSnapshot: {
            capturedAtMs: 900,
            meters: [{
              meterId: 'capacity',
              limitCategory: 'capacity',
              remainingPct: null,
              resetAtMs: 5_000,
              providerLimitId: 'capacity',
            }],
          },
        }],
        ['healthy', { quotaSnapshot: { capturedAtMs: 900, effectiveMeterId: 'daily', effectiveRemainingPercent: 40 } }],
      ]),
    });

    expect(result.selected?.profileId).toBe('healthy');
    expect(result.excluded).toEqual(expect.arrayContaining([
      { profileId: 'plan-blocked', reason: 'plan_unavailable' },
      { profileId: 'capacity-limited', reason: 'capacity_limited', retryAtMs: 5_000 },
    ]));
  });

  it('does not treat non-quota snapshot unavailability as quota exhaustion', () => {
    const result = selectConnectedServiceAuthGroupCandidate({
      nowMs: 1_000,
      quotaFreshnessMs: 60_000,
      activeProfileId: 'active',
      allowCurrentProfileRetry: true,
      policy: { ...basePolicy, strategy: 'least_limited' },
      members: [
        member('active', 1, 1),
        member('backup', 2, 2),
      ],
      memberStatesByProfileId: new Map([
        ['active', { quotaSnapshot: { capturedAtMs: 900, planUnavailable: true } }],
        ['backup', { quotaSnapshot: { capturedAtMs: 900, effectiveMeterId: 'daily', effectiveRemainingPercent: 20 } }],
      ]),
    });

    expect(result.selected?.profileId).toBe('active');
    expect(result.excluded).not.toContainEqual(expect.objectContaining({
      profileId: 'active',
      reason: 'quota_exhausted',
    }));
  });

  it('never auto-selects for manual strategy', () => {
    const result = selectConnectedServiceAuthGroupCandidate({
      nowMs: 1_000,
      quotaFreshnessMs: 60_000,
      activeProfileId: 'active',
      policy: { ...basePolicy, strategy: 'manual' },
      members: [member('backup', 1, 1)],
      memberStatesByProfileId: new Map(),
    });

    expect(result.selected).toBeNull();
    expect(result.reason).toBe('manual_strategy');
  });
});
