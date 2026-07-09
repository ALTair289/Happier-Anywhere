import { describe, expect, it } from 'vitest';

import {
  buildProviderAccountUsageRecordId,
  type ConnectedServiceAuthGroupV1,
  type ProviderAccountUsageRecordKeyV1,
  type ProviderAccountUsageSnapshotV1,
} from '@happier-dev/protocol';

import { DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1 } from '../selection/selectConnectedServiceAuthGroupCandidate';
import { buildConnectedServiceAuthGroupSwitchStateFromAccountUsage } from './buildConnectedServiceAuthGroupSwitchStateFromAccountUsage';

function createGroup(): ConnectedServiceAuthGroupV1 {
  return {
    v: 1,
    serviceId: 'openai-codex',
    groupId: 'team',
    displayName: 'Team',
    activeProfileId: 'exhausted',
    generation: 4,
    state: {},
    createdAt: 1,
    updatedAt: 2,
    policy: {
      ...DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1,
      autoSwitch: true,
      switchOn: {
        ...DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1.switchOn,
        usageLimit: true,
        authExpired: true,
        accountChanged: true,
        refreshFailure: true,
      },
    },
    members: [
      {
        v: 1,
        serviceId: 'openai-codex',
        groupId: 'team',
        profileId: 'exhausted',
        enabled: true,
        priority: 1,
        createdAt: 1,
        updatedAt: 1,
        state: { credentialHealthStatus: 'connected' },
      },
      {
        v: 1,
        serviceId: 'openai-codex',
        groupId: 'team',
        profileId: 'fresh',
        enabled: true,
        priority: 2,
        createdAt: 2,
        updatedAt: 2,
        state: { credentialHealthStatus: 'connected' },
      },
    ],
  };
}

function createSnapshot(profileId: string, remainingPct: number): ProviderAccountUsageSnapshotV1 {
  const recordKey: ProviderAccountUsageRecordKeyV1 = {
    providerId: 'codex',
    accountSubjectId: `acct_${profileId}`,
    subjectKind: 'account',
    quotaScope: 'account',
  };
  return {
    v: 1,
    recordId: buildProviderAccountUsageRecordId(recordKey),
    recordKey,
    providerId: 'codex',
    accountSubject: { kind: 'providerSubject', id: recordKey.accountSubjectId },
    observedAtMs: 1_000,
    fetchedAtMs: 1_000,
    staleAfterMs: 300_000,
    source: 'runtimeSignal',
    confidence: 'confirmed',
    state: 'loaded_data',
    meters: [{
      meterId: 'weekly',
      label: 'Weekly',
      used: 100 - remainingPct,
      limit: 100,
      remaining: remainingPct,
      remainingPct,
      usedPct: 100 - remainingPct,
      utilizationPct: 100 - remainingPct,
      resetsAt: 10_000,
      resetAtMs: 10_000,
      unit: 'credits',
      status: 'ok',
      limitScope: 'account',
      confidence: 'exact',
      details: { limitCategory: 'usage_limit' },
    }],
  };
}

describe('buildConnectedServiceAuthGroupSwitchStateFromAccountUsage', () => {
  it('builds group member runtime state from source-backed provider usage using the active group generation', () => {
    const group = createGroup();
    const exhausted = createSnapshot('exhausted', 0);
    const fresh = createSnapshot('fresh', 90);
    const accountUsageStore = {
      resolveBySource: (source: { profileId: string; groupGeneration?: number }) => {
        if (source.groupGeneration !== 4) return null;
        if (source.profileId === 'exhausted') return exhausted;
        if (source.profileId === 'fresh') return fresh;
        return null;
      },
    };

    const result = buildConnectedServiceAuthGroupSwitchStateFromAccountUsage({
      group,
      accountUsageStore,
    });

    expect(result?.state.memberStatesByProfileId.get('exhausted')).toEqual(expect.objectContaining({
      credentialHealthStatus: 'connected',
      quotaSnapshot: expect.objectContaining({
        exhausted: true,
        effectiveRemainingPercent: 0,
      }),
    }));
    expect(result?.state.memberStatesByProfileId.get('fresh')?.quotaSnapshot?.effectiveRemainingPercent).toBe(90);
    expect(result?.sourceRefsByProfileId.get('fresh')).toEqual(expect.objectContaining({
      recordId: fresh.recordId,
      source: {
        serviceId: 'openai-codex',
        profileId: 'fresh',
        bindingKind: 'group_member',
        groupId: 'team',
        groupGeneration: 4,
      },
    }));
  });

  it('returns a provisional persisted-member state when the account-usage store has no source-backed records', () => {
    const group = createGroup();
    const accountUsageStore = {
      resolveBySource: () => null,
    };

    const result = buildConnectedServiceAuthGroupSwitchStateFromAccountUsage({
      group,
      accountUsageStore,
    });

    expect(result).toMatchObject({
      kind: 'provisional',
      state: expect.objectContaining({
        serviceId: 'openai-codex',
        groupId: 'team',
        activeProfileId: 'exhausted',
        generation: 4,
      }),
    });
    expect(result?.state.memberStatesByProfileId.get('exhausted')).toEqual(expect.objectContaining({
      credentialHealthStatus: 'connected',
    }));
    expect(result?.state.memberStatesByProfileId.get('fresh')).toEqual(expect.objectContaining({
      credentialHealthStatus: 'connected',
    }));
    expect(result?.sourceRefsByProfileId.size).toBe(0);
  });
});
