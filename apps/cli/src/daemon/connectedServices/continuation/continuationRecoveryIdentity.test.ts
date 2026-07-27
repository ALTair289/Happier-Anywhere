import { describe, expect, it } from 'vitest';

import {
  buildContinuationRecoveryIdentityFromBindings,
  listProviderActivityRecoveryIdentitiesFromRuntimeBindings,
  listContinuationRecoveryIdentitiesFromBindings,
} from './continuationRecoveryIdentity';

describe('continuation recovery identity', () => {
  it('builds a group identity from a single changed binding', () => {
    expect(buildContinuationRecoveryIdentityFromBindings({
      serviceIds: new Set(['claude-subscription']),
      bindings: {
        v: 1,
        bindingsByServiceId: {
          'claude-subscription': {
            source: 'connected',
            selection: 'group',
            groupId: 'claude',
            profileId: 'leeroy_new',
          },
        },
      },
      failureFingerprint: 'authentication_failed:401',
      targetGenerationByServiceId: { 'claude-subscription': 18 },
    })).toEqual({
      serviceId: 'claude-subscription',
      selectionKind: 'group',
      groupId: 'claude',
      profileId: 'leeroy_new',
      failureFingerprint: 'authentication_failed:401',
      targetGeneration: 18,
    });
  });

  it('builds a profile identity from a single changed binding', () => {
    expect(buildContinuationRecoveryIdentityFromBindings({
      serviceIds: new Set(['openai-codex']),
      bindings: {
        v: 1,
        bindingsByServiceId: {
          'openai-codex': {
            source: 'connected',
            selection: 'profile',
            profileId: 'codex3',
          },
        },
      },
    })).toEqual({
      serviceId: 'openai-codex',
      selectionKind: 'profile',
      profileId: 'codex3',
    });
  });

  it('returns null for native or ambiguous changed bindings', () => {
    expect(buildContinuationRecoveryIdentityFromBindings({
      serviceIds: new Set(['openai-codex']),
      bindings: {
        v: 1,
        bindingsByServiceId: {
          'openai-codex': { source: 'native' },
        },
      },
    })).toBeNull();

    expect(buildContinuationRecoveryIdentityFromBindings({
      serviceIds: new Set(['openai-codex', 'claude-subscription']),
      bindings: {
        v: 1,
        bindingsByServiceId: {},
      },
    })).toBeNull();
  });

  it('lists identities for all connected profile and group bindings', () => {
    expect(listContinuationRecoveryIdentitiesFromBindings({
      v: 1,
      bindingsByServiceId: {
        'openai-codex': {
          source: 'connected',
          selection: 'group',
          groupId: 'codex',
          profileId: 'codex3',
        },
        'claude-subscription': {
          source: 'connected',
          selection: 'profile',
          profileId: 'leeroy_new',
        },
        github: { source: 'native' },
      },
    })).toEqual([
      {
        serviceId: 'openai-codex',
        selectionKind: 'group',
        groupId: 'codex',
        profileId: 'codex3',
      },
      {
        serviceId: 'claude-subscription',
        selectionKind: 'profile',
        profileId: 'leeroy_new',
      },
    ]);
  });

  it('qualifies current bindings with the exact pending recovery attempt and adopted group generation', () => {
    expect(listProviderActivityRecoveryIdentitiesFromRuntimeBindings([{
      serviceId: 'openai-codex',
      groupId: 'codex',
      profileId: 'codex3',
      generation: 18,
      credentialRevision: 'csr_group',
    }, {
      serviceId: 'claude-subscription',
      groupId: null,
      profileId: 'leeroy_new',
      generation: null,
      credentialRevision: 'csr_profile',
    }], [{
      serviceId: 'openai-codex',
      profileId: 'codex-old',
      groupId: 'codex',
      status: 'resumed_awaiting_proof',
      attemptId: 'runtime-auth-attempt:group-1',
      pendingTargetProfileId: 'codex3',
      pendingTargetGeneration: 18,
    }, {
      serviceId: 'claude-subscription',
      profileId: 'leeroy_new',
      groupId: null,
      status: 'waiting',
      attemptId: 'runtime-auth-attempt:profile-1',
      pendingTargetProfileId: null,
      pendingTargetGeneration: null,
    }])).toEqual([
      {
        serviceId: 'openai-codex',
        selectionKind: 'group',
        groupId: 'codex',
        profileId: 'codex3',
        failureFingerprint: 'runtime-auth-attempt:group-1',
        targetGeneration: 18,
      },
      {
        serviceId: 'claude-subscription',
        selectionKind: 'profile',
        profileId: 'leeroy_new',
        failureFingerprint: 'runtime-auth-attempt:profile-1',
      },
    ]);
  });

  it('qualifies refresh-without-switch activity from the exact current binding and rejects stale revision/profile bindings', () => {
    const refreshIntent = {
      serviceId: 'claude-subscription',
      profileId: 'claude-primary',
      groupId: 'claude-pool',
      status: 'resumed_awaiting_proof',
      attemptId: 'runtime-auth-attempt:refresh-1',
      pendingTargetProfileId: null,
      pendingTargetGeneration: null,
      classification: {
        groupGeneration: 7,
        credentialRevision: 'csr_abcdefghijklmnopqrstuv',
      },
    };
    const exactCurrentBinding = {
      serviceId: 'claude-subscription',
      groupId: 'claude-pool',
      profileId: 'claude-primary',
      generation: 7,
      credentialRevision: 'csr_bcdefghijklmnopqrstuvw',
    } as const;

    expect(listProviderActivityRecoveryIdentitiesFromRuntimeBindings(
      [exactCurrentBinding],
      [refreshIntent],
    )).toEqual([{
      serviceId: 'claude-subscription',
      selectionKind: 'group',
      groupId: 'claude-pool',
      profileId: 'claude-primary',
      failureFingerprint: 'runtime-auth-attempt:refresh-1',
      targetGeneration: 7,
    }]);
    expect(listProviderActivityRecoveryIdentitiesFromRuntimeBindings(
      [{ ...exactCurrentBinding, generation: 8 }],
      [refreshIntent],
    )).toEqual([{
      serviceId: 'claude-subscription',
      selectionKind: 'group',
      groupId: 'claude-pool',
      profileId: 'claude-primary',
      failureFingerprint: 'runtime-auth-attempt:refresh-1',
      targetGeneration: 8,
    }]);

    expect(listProviderActivityRecoveryIdentitiesFromRuntimeBindings(
      [{ ...exactCurrentBinding, credentialRevision: 'csr_abcdefghijklmnopqrstuv' }],
      [refreshIntent],
    )).toEqual([]);
    expect(listProviderActivityRecoveryIdentitiesFromRuntimeBindings(
      [{ ...exactCurrentBinding, generation: 6 }],
      [refreshIntent],
    )).toEqual([]);
    expect(listProviderActivityRecoveryIdentitiesFromRuntimeBindings(
      [{ ...exactCurrentBinding, profileId: 'claude-other' }],
      [refreshIntent],
    )).toEqual([]);
  });
});
