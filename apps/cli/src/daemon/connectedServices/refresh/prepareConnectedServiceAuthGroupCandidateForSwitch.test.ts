import { describe, expect, it, vi } from 'vitest';

import { prepareConnectedServiceAuthGroupCandidateForSwitch } from './prepareConnectedServiceAuthGroupCandidateForSwitch';

function result(input: Readonly<{
  status: 'refreshed' | 'not_needed' | 'not_oauth' | 'lease_not_acquired' | 'credential_missing' | 'blocked_by_credential_health' | 'refresh_failed';
  category?: 'invalid_grant' | 'network_error';
}>) {
  return {
    status: input.status,
    credential: null,
    diagnostic: {
      serviceId: 'claude-subscription' as const,
      profileId: 'backup',
      reason: 'spawn_preflight' as const,
      status: input.status,
      ...(input.category ? { category: input.category } : {}),
      expiresAt: null,
      expiryAgeMs: null,
      refreshWindowMs: 60_000,
    },
  };
}

describe('prepareConnectedServiceAuthGroupCandidateForSwitch', () => {
  it('force-validates auth-recovery candidates and excludes permanent refresh failures', async () => {
    const refreshConnectedServiceCredentialForSpawnPreflight = vi.fn(async () => result({
      status: 'refresh_failed',
      category: 'invalid_grant',
    }));

    await expect(prepareConnectedServiceAuthGroupCandidateForSwitch({
      serviceId: 'claude-subscription',
      profileId: 'backup',
      reason: 'auth_expired',
      refreshService: { refreshConnectedServiceCredentialForSpawnPreflight },
    })).resolves.toEqual({
      status: 'ineligible',
      memberState: { credentialHealthStatus: 'needs_reauth' },
    });
    expect(refreshConnectedServiceCredentialForSpawnPreflight).toHaveBeenCalledWith({
      serviceId: 'claude-subscription',
      profileId: 'backup',
      force: true,
    });
  });

  it('keeps transient candidate failures operation-local and lets the selector try another member', async () => {
    const refreshConnectedServiceCredentialForSpawnPreflight = vi.fn(async () => result({
      status: 'refresh_failed',
      category: 'network_error',
    }));

    await expect(prepareConnectedServiceAuthGroupCandidateForSwitch({
      serviceId: 'claude-subscription',
      profileId: 'backup',
      reason: 'refresh_failed',
      refreshService: { refreshConnectedServiceCredentialForSpawnPreflight },
    })).resolves.toEqual({
      status: 'ineligible',
      memberState: { credentialHealthStatus: 'refresh_failed_retryable' },
    });
  });

  it('uses ordinary preflight to reject an unusable quota candidate without adding a second selector', async () => {
    const refreshConnectedServiceCredentialForSpawnPreflight = vi.fn(async () => result({
      status: 'refresh_failed',
      category: 'invalid_grant',
    }));

    await expect(prepareConnectedServiceAuthGroupCandidateForSwitch({
      serviceId: 'claude-subscription',
      profileId: 'backup',
      reason: 'usage_limit',
      refreshService: { refreshConnectedServiceCredentialForSpawnPreflight },
    })).resolves.toEqual({
      status: 'ineligible',
      memberState: { credentialHealthStatus: 'needs_reauth' },
    });
    expect(refreshConnectedServiceCredentialForSpawnPreflight).toHaveBeenCalledWith({
      serviceId: 'claude-subscription',
      profileId: 'backup',
      force: false,
    });
  });
});
