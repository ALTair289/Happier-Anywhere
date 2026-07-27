import { describe, expect, it } from 'vitest';

import type { ConnectedServiceProviderRuntimeAuthAdapter } from '../runtimeAuth/types';
import type { ConnectedServiceAccountAdoptionVerificationInput } from './connectedServiceAccountTransition';
import { createSessionConnectedServiceAccountAdoptionVerifier } from './createSessionConnectedServiceAccountAdoptionVerifier';

function baseInput(): ConnectedServiceAccountAdoptionVerificationInput {
  return {
    tracked: {
      startedBy: 'daemon',
      happySessionId: 'sess_1',
      pid: 1,
      spawnOptions: { directory: '/tmp/project' },
    },
    sessionId: 'sess_1',
    agentId: 'codex',
    serviceId: 'openai-codex',
    target: {
      serviceId: 'openai-codex',
      profileId: 'profile_target',
      groupId: null,
    },
    normalizedBindings: {
      v: 1,
      bindingsByServiceId: {
        'openai-codex': { source: 'connected', selection: 'profile', profileId: 'profile_target' },
      },
    },
    action: 'hot_applied' as const,
  };
}

describe('createSessionConnectedServiceAccountAdoptionVerifier', () => {
  it('fails closed when a provider has no explicit active-account verification policy', async () => {
    const adapterWithoutVerifier = {
      classifyRuntimeAuthFailure: () => null,
      materializeActiveProfile: async () => ({ supported: true }),
      canHotApply: () => ({ supported: true }),
      hotApply: async () => ({ applied: true }),
      recoverAfterRuntimeAuthSwitch: async () => ({ recovered: true }),
      probeQuota: async () => ({ status: 'unsupported' }),
      refreshActiveProfile: async () => ({ status: 'unsupported' }),
    } as ConnectedServiceProviderRuntimeAuthAdapter;
    const verify = createSessionConnectedServiceAccountAdoptionVerifier({
      resolveRuntimeAuthAdapter: async () => adapterWithoutVerifier,
    });

    await expect(verify(baseInput())).resolves.toEqual({
      status: 'unavailable',
      retryable: false,
      reason: 'provider_active_account_verification_missing',
    });
  });

  it('does not inject stale tracked launch environment into a current runtime selection', async () => {
    let observedSelection: unknown;
    const adapter = {
      classifyRuntimeAuthFailure: () => null,
      materializeActiveProfile: async () => ({ supported: true }),
      canHotApply: () => ({ supported: false }),
      hotApply: async () => ({ applied: false }),
      recoverAfterRuntimeAuthSwitch: async () => ({ recovered: false }),
      verifyActiveAccount: async (input) => {
        observedSelection = input.selection;
        return { status: 'verified' as const, reason: 'ok' };
      },
      probeQuota: async () => ({ status: 'unsupported' }),
      refreshActiveProfile: async () => ({ status: 'unsupported' }),
    } satisfies ConnectedServiceProviderRuntimeAuthAdapter;
    const verify = createSessionConnectedServiceAccountAdoptionVerifier({
      resolveRuntimeAuthAdapter: async () => adapter,
    });

    await expect(verify({
      ...baseInput(),
      agentId: 'claude',
      serviceId: 'claude-subscription',
      runtimeAuthSelection: {
        serviceId: 'claude-subscription',
        profileId: 'profile_target',
        record: { serviceId: 'claude-subscription' },
      },
      tracked: {
        startedBy: 'daemon',
        happySessionId: 'sess_1',
        pid: 1,
        spawnOptions: {
          directory: '/tmp/project',
          environmentVariables: {
            CLAUDE_CONFIG_DIR: '/tmp/materialized-claude-config',
          },
        },
      },
      normalizedBindings: {
        v: 1,
        bindingsByServiceId: {
          'claude-subscription': { source: 'connected', selection: 'profile', profileId: 'profile_target' },
        },
      },
    })).resolves.toEqual({ status: 'verified', reason: 'ok' });

    expect(observedSelection).toMatchObject({
      serviceId: 'claude-subscription',
      profileId: 'profile_target',
    });
    expect(observedSelection).not.toHaveProperty('targetMaterializedEnv');
  });
});
