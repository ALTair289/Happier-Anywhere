import { describe, expect, it, vi } from 'vitest';

import {
  isConnectedServiceCredentialMutationSupersededError,
  refreshConnectedServiceProfileAfterSupersededMutation,
} from './connectedServiceSettingsErrors';

describe('connected-service settings errors', () => {
  it('recognizes a stale guarded credential mutation', () => {
    expect(isConnectedServiceCredentialMutationSupersededError({
      code: 'connect_credential_mutation_superseded',
      status: 409,
    })).toBe(true);
    expect(isConnectedServiceCredentialMutationSupersededError({
      code: 'connect_credential_referenced_by_group',
      status: 409,
    })).toBe(false);
  });

  it('refreshes authoritative profile state only for a stale credential mutation', async () => {
    const refreshProfile = vi.fn(async () => {});

    await refreshConnectedServiceProfileAfterSupersededMutation({
      code: 'connect_credential_mutation_superseded',
      status: 409,
    }, refreshProfile);
    await refreshConnectedServiceProfileAfterSupersededMutation({
      code: 'connect_credential_request_failed',
      status: 500,
    }, refreshProfile);

    expect(refreshProfile).toHaveBeenCalledTimes(1);
  });
});
