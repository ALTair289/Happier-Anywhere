import { describe, expect, it } from 'vitest';

import {
  decideConnectedServiceRecovery,
  isTemporaryRetryOwnedConnectedServiceRuntimeFailure,
} from './ConnectedServiceRecoveryPolicy';

const baseIssue = {
  serviceId: 'openai-codex',
  profileId: 'primary',
  groupId: 'main',
  resetsAtMs: null,
  retryAfterMs: null,
  planType: null,
  rateLimits: null,
  source: 'structured_provider_error' as const,
} as const;

describe('ConnectedServiceRecoveryPolicy', () => {
  it('exposes the temporary-retry ownership predicate used by intake routers', () => {
    expect(isTemporaryRetryOwnedConnectedServiceRuntimeFailure({
      kind: 'temporary_throttle',
      ...baseIssue,
    })).toBe(true);
    expect(isTemporaryRetryOwnedConnectedServiceRuntimeFailure({
      kind: 'capacity',
      ...baseIssue,
      quotaScope: 'provider',
    })).toBe(true);
    expect(isTemporaryRetryOwnedConnectedServiceRuntimeFailure({
      kind: 'capacity',
      ...baseIssue,
      quotaScope: 'account',
    })).toBe(false);
    expect(isTemporaryRetryOwnedConnectedServiceRuntimeFailure({
      kind: 'usage_limit',
      ...baseIssue,
    })).toBe(false);
  });

  it('routes temporary throttles to bounded temporary retry recovery', () => {
    expect(decideConnectedServiceRecovery({
      actor: 'automatic',
      issue: {
        kind: 'temporary_throttle',
        ...baseIssue,
        resetsAtMs: 90_000,
        retryAfterMs: 45_000,
      },
      selection: {
        kind: 'group',
        serviceId: 'openai-codex',
        groupId: 'main',
        activeProfileId: 'primary',
      },
    })).toEqual({
      action: 'temporary_retry',
      serviceId: 'openai-codex',
      profileId: 'primary',
      groupId: 'main',
      resetAtMs: 90_000,
      retryAfterMs: 45_000,
    });
  });

  it('routes provider capacity (overloaded) to bounded temporary retry instead of account switching', () => {
    // Incident 2026-06-12 (lane TRANSIENT): "API Error: Overloaded" / 529 is server-side and
    // account-independent. Switching profiles or restarting the session is never the right
    // recovery — retry the SAME session with backoff, like temporary throttles.
    expect(decideConnectedServiceRecovery({
      actor: 'automatic',
      issue: {
        kind: 'capacity',
        ...baseIssue,
      },
      selection: {
        kind: 'group',
        serviceId: 'openai-codex',
        groupId: 'main',
        activeProfileId: 'primary',
      },
    })).toEqual({
      action: 'temporary_retry',
      serviceId: 'openai-codex',
      profileId: 'primary',
      groupId: 'main',
      resetAtMs: null,
      retryAfterMs: null,
    });
  });

  it('delegates account-scoped capacity failures to group switching', () => {
    expect(decideConnectedServiceRecovery({
      actor: 'automatic',
      issue: {
        kind: 'capacity',
        ...baseIssue,
        quotaScope: 'account',
        limitCategory: 'capacity',
      },
      selection: {
        kind: 'group',
        serviceId: 'openai-codex',
        groupId: 'main',
        activeProfileId: 'primary',
      },
    })).toEqual({
      action: 'switch_account',
      mode: 'delegate_to_group_switch',
      serviceId: 'openai-codex',
      groupId: 'main',
      fromProfileId: 'primary',
      toProfileId: null,
      reason: 'capacity',
      actor: 'automatic',
    });
  });

  it('returns reconnect-required for manual selection of a cached unhealthy profile', () => {
    expect(decideConnectedServiceRecovery({
      actor: 'manual',
      issue: {
        kind: 'auth_expired',
        ...baseIssue,
      },
      selection: {
        kind: 'profile',
        serviceId: 'openai-codex',
        profileId: 'primary',
      },
      credentialHealth: {
        cachedStatus: 'needs_reauth',
      },
    })).toEqual({
      action: 'reconnect_required',
      serviceId: 'openai-codex',
      profileId: 'primary',
      groupId: 'main',
      reason: 'auth_expired',
      actor: 'manual',
    });
  });

  it('prefers refresh first, then switches a group away from a member with live auth failure', () => {
    expect(decideConnectedServiceRecovery({
      actor: 'automatic',
      issue: {
        kind: 'auth_expired',
        ...baseIssue,
      },
      selection: {
        kind: 'group',
        serviceId: 'openai-codex',
        groupId: 'main',
        activeProfileId: 'primary',
      },
      credentialRefresh: {
        status: 'refreshable',
      },
    })).toEqual({
      action: 'refresh',
      serviceId: 'openai-codex',
      profileId: 'primary',
      reason: 'auth_expired',
    });

    expect(decideConnectedServiceRecovery({
      actor: 'automatic',
      issue: {
        kind: 'auth_expired',
        ...baseIssue,
      },
      selection: {
        kind: 'group',
        serviceId: 'openai-codex',
        groupId: 'main',
        activeProfileId: 'primary',
      },
      credentialRefresh: {
        status: 'refreshable',
      },
      credentialHealth: {
        liveEvidence: 'auth_failed',
      },
      groupCandidate: {
        status: 'selected',
        profileId: 'backup',
        applyMode: 'restart_rematerialize',
      },
    })).toEqual({
      action: 'switch_account',
      mode: 'restart_rematerialize',
      serviceId: 'openai-codex',
      groupId: 'main',
      fromProfileId: 'primary',
      toProfileId: 'backup',
      reason: 'auth_expired',
      actor: 'automatic',
    });
  });

  it('routes account-changed evidence to binding re-resolution instead of refresh or group switching', () => {
    expect(decideConnectedServiceRecovery({
      actor: 'automatic',
      issue: {
        kind: 'account_changed',
        ...baseIssue,
      },
      selection: {
        kind: 'group',
        serviceId: 'openai-codex',
        groupId: 'main',
        activeProfileId: 'primary',
      },
      credentialRefresh: {
        status: 'refreshable',
      },
      groupCandidate: {
        status: 'selected',
        profileId: 'backup',
        applyMode: 'restart_rematerialize',
      },
    })).toEqual({
      action: 're_resolve_binding',
      serviceId: 'openai-codex',
      profileId: 'primary',
      groupId: 'main',
      reason: 'account_changed',
      actor: 'automatic',
    });
  });

  it('waits for an in-progress group switch and requires re-evaluation afterward', () => {
    expect(decideConnectedServiceRecovery({
      actor: 'automatic',
      issue: {
        kind: 'usage_limit',
        ...baseIssue,
      },
      selection: {
        kind: 'group',
        serviceId: 'openai-codex',
        groupId: 'main',
        activeProfileId: 'primary',
      },
      groupSwitch: {
        status: 'in_progress',
      },
    })).toEqual({
      action: 'wait_for_group_switch',
      serviceId: 'openai-codex',
      groupId: 'main',
      reEvaluateAfterObservedResult: true,
    });
  });

  it('lets live successful provider evidence override cached needs-reauth health for the immediate decision', () => {
    expect(decideConnectedServiceRecovery({
      actor: 'automatic',
      issue: {
        kind: 'auth_expired',
        ...baseIssue,
      },
      selection: {
        kind: 'profile',
        serviceId: 'openai-codex',
        profileId: 'primary',
      },
      credentialHealth: {
        cachedStatus: 'needs_reauth',
        liveEvidence: 'accepted',
      },
    })).toEqual({
      action: 'no_op',
      reason: 'live_provider_evidence_supersedes_cached_health',
      healthConvergence: {
        serviceId: 'openai-codex',
        profileId: 'primary',
        status: 'connected',
      },
    });
  });

  it('does not block a turn for soft-limit switching when no safe better candidate exists', () => {
    expect(decideConnectedServiceRecovery({
      actor: 'automatic',
      issue: {
        kind: 'soft_limit',
        ...baseIssue,
      },
      selection: {
        kind: 'group',
        serviceId: 'openai-codex',
        groupId: 'main',
        activeProfileId: 'primary',
      },
      groupCandidate: {
        status: 'none',
        reason: 'no_safe_better_candidate',
      },
    })).toEqual({
      action: 'no_op',
      reason: 'soft_limit_no_safe_candidate',
    });
  });

  it('waits until reset for quota exhaustion when group selection has no eligible candidate', () => {
    expect(decideConnectedServiceRecovery({
      actor: 'automatic',
      issue: {
        kind: 'usage_limit',
        ...baseIssue,
        resetsAtMs: 90_000,
      },
      selection: {
        kind: 'group',
        serviceId: 'openai-codex',
        groupId: 'main',
        activeProfileId: 'primary',
      },
      groupCandidate: {
        status: 'none',
        reason: 'no_eligible_members',
        retryAtMs: 90_000,
      },
    })).toEqual({
      action: 'wait_until_reset',
      serviceId: 'openai-codex',
      profileId: 'primary',
      groupId: 'main',
      retryAtMs: 90_000,
    });
  });

  it('prefers same-group rotation over provider shared-state recovery actions for switchable group failures', () => {
    expect(decideConnectedServiceRecovery({
      actor: 'automatic',
      issue: {
        kind: 'usage_limit',
        ...baseIssue,
        recoveryAction: { kind: 'provider_state_sharing_required' as const },
      },
      selection: {
        kind: 'group',
        serviceId: 'openai-codex',
        groupId: 'main',
        activeProfileId: 'primary',
      },
      groupCandidate: {
        status: 'selected',
        profileId: 'backup',
        applyMode: 'restart_rematerialize',
      },
    })).toEqual({
      action: 'switch_account',
      mode: 'restart_rematerialize',
      serviceId: 'openai-codex',
      groupId: 'main',
      fromProfileId: 'primary',
      toProfileId: 'backup',
      reason: 'usage_limit',
      actor: 'automatic',
    });
  });

  it('chooses hot-apply switch for usage limits when a safe group candidate supports hot apply', () => {
    expect(decideConnectedServiceRecovery({
      actor: 'automatic',
      issue: {
        kind: 'usage_limit',
        ...baseIssue,
      },
      selection: {
        kind: 'group',
        serviceId: 'openai-codex',
        groupId: 'main',
        activeProfileId: 'primary',
      },
      groupCandidate: {
        status: 'selected',
        profileId: 'backup',
        applyMode: 'hot_apply',
      },
    })).toEqual({
      action: 'switch_account',
      mode: 'hot_apply',
      serviceId: 'openai-codex',
      groupId: 'main',
      fromProfileId: 'primary',
      toProfileId: 'backup',
      reason: 'usage_limit',
      actor: 'automatic',
    });
  });

  it('treats dependency failures as switchable for group selections when a safe candidate exists', () => {
    expect(decideConnectedServiceRecovery({
      actor: 'automatic',
      issue: {
        kind: 'dependency_failure',
        ...baseIssue,
      },
      selection: {
        kind: 'group',
        serviceId: 'openai-codex',
        groupId: 'main',
        activeProfileId: 'primary',
      },
      groupCandidate: {
        status: 'selected',
        profileId: 'backup',
        applyMode: 'restart_rematerialize',
      },
    })).toEqual({
      action: 'switch_account',
      mode: 'restart_rematerialize',
      serviceId: 'openai-codex',
      groupId: 'main',
      fromProfileId: 'primary',
      toProfileId: 'backup',
      reason: 'dependency_failure',
      actor: 'automatic',
    });
  });

  it('delegates dependency failures to group-switch coordination when no safe candidate is preselected', () => {
    expect(decideConnectedServiceRecovery({
      actor: 'automatic',
      issue: {
        kind: 'dependency_failure',
        ...baseIssue,
      },
      selection: {
        kind: 'group',
        serviceId: 'openai-codex',
        groupId: 'main',
        activeProfileId: 'primary',
      },
    })).toEqual({
      action: 'switch_account',
      mode: 'delegate_to_group_switch',
      serviceId: 'openai-codex',
      groupId: 'main',
      fromProfileId: 'primary',
      toProfileId: null,
      reason: 'dependency_failure',
      actor: 'automatic',
    });
  });
});
