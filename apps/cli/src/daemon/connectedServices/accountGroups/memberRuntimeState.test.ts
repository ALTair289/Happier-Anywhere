import type {
  ConnectedServiceAuthGroupMemberStateV1,
  ConnectedServiceAuthGroupV1,
  ConnectedServiceId,
} from '@happier-dev/protocol';
import { describe, expect, it, vi } from 'vitest';

import { DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1 } from './selection/selectConnectedServiceAuthGroupCandidate';
import {
  persistMemberRuntimeStateWithPositiveEvidence,
  reconcileMemberRuntimeStateWithPositiveEvidence,
  type ConnectedServiceAuthGroupPositiveEvidence,
} from './memberRuntimeState';

function group(state: ConnectedServiceAuthGroupMemberStateV1): ConnectedServiceAuthGroupV1 {
  return {
    v: 1,
    serviceId: 'openai-codex' as ConnectedServiceId,
    groupId: 'group-1',
    displayName: 'Group 1',
    activeProfileId: 'primary',
    generation: 7,
    state: { v: 1 },
    policy: DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1,
    members: [
      {
        v: 1,
        serviceId: 'openai-codex' as ConnectedServiceId,
        groupId: 'group-1',
        profileId: 'primary',
        priority: 1,
        enabled: true,
        createdAt: 1,
        updatedAt: 1,
        state,
      },
      {
        v: 1,
        serviceId: 'openai-codex' as ConnectedServiceId,
        groupId: 'group-1',
        profileId: 'backup',
        priority: 2,
        enabled: true,
        createdAt: 2,
        updatedAt: 2,
        state: { v: 1 },
      },
    ],
    createdAt: 1,
    updatedAt: 1,
  };
}

describe('persistMemberRuntimeStateWithPositiveEvidence', () => {
  it('clears matching member runtime-state with newer positive evidence and expected generation', async () => {
    const persisted = group({
      v: 1,
      authInvalidUntilMs: 10_000,
      credentialHealthStatus: 'needs_reauth',
      lastFailureKind: 'auth_failed',
      lastObservedAtMs: 1_000,
    });
    const api = {
      getConnectedServiceAuthGroup: vi.fn(async () => persisted),
      updateConnectedServiceAuthGroupRuntimeState: vi.fn(async () => persisted),
    };

    await persistMemberRuntimeStateWithPositiveEvidence({
      api,
      serviceId: 'openai-codex' as ConnectedServiceId,
      groupId: 'group-1',
      profileId: 'primary',
      generation: 7,
      evidence: { kind: 'successful_turn', observedAtMs: 2_000 },
      normalizePolicy: () => DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1,
    });

    expect(api.updateConnectedServiceAuthGroupRuntimeState).toHaveBeenCalledWith({
      serviceId: 'openai-codex',
      groupId: 'group-1',
      expectedGeneration: 7,
      memberStates: [{ profileId: 'primary', state: { v: 1 } }],
    });
  });

  it('logs the cleared-blocker kinds at the clear point without emitting any state VALUES (QA2-F01/RR-8)', async () => {
    const persisted = group({
      v: 1,
      authInvalidUntilMs: 987_654,
      credentialHealthStatus: 'needs_reauth',
      lastFailureKind: 'auth_failed',
      lastObservedAtMs: 1_000,
    });
    const api = {
      getConnectedServiceAuthGroup: vi.fn(async () => persisted),
      updateConnectedServiceAuthGroupRuntimeState: vi.fn(async () => persisted),
    };
    const info = vi.fn();

    const cleared = await persistMemberRuntimeStateWithPositiveEvidence({
      api,
      serviceId: 'openai-codex' as ConnectedServiceId,
      groupId: 'group-1',
      profileId: 'primary',
      generation: 7,
      evidence: { kind: 'successful_turn', observedAtMs: 2_000 },
      normalizePolicy: () => DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1,
      logger: { info },
    });

    expect(cleared).toBe(true);
    expect(info).toHaveBeenCalledTimes(1);
    expect(info.mock.calls[0]?.[1]).toMatchObject({
      serviceId: 'openai-codex',
      groupId: 'group-1',
      profileId: 'primary',
      evidenceKind: 'successful_turn',
    });
    const clearedKinds = (info.mock.calls[0]?.[1] as { clearedBlockerKinds: string[] }).clearedBlockerKinds;
    expect(clearedKinds).toEqual(
      expect.arrayContaining(['authInvalidUntilMs', 'credentialHealthStatus', 'lastFailureKind', 'lastObservedAtMs']),
    );
    // Values-never-logged: the blocker VALUE (the reauth deadline) must never appear in diagnostics.
    expect(JSON.stringify(info.mock.calls)).not.toContain('987654');
  });

  it('does not log when nothing is cleared (no positive-evidence change)', async () => {
    const persisted = group({ v: 1, lastObservedAtMs: 5_000 });
    const api = {
      getConnectedServiceAuthGroup: vi.fn(async () => persisted),
      updateConnectedServiceAuthGroupRuntimeState: vi.fn(async () => persisted),
    };
    const info = vi.fn();

    await persistMemberRuntimeStateWithPositiveEvidence({
      api,
      serviceId: 'openai-codex' as ConnectedServiceId,
      groupId: 'group-1',
      profileId: 'primary',
      generation: 7,
      // Evidence not newer than the last observation → no clear, no persist, no log.
      evidence: { kind: 'successful_turn', observedAtMs: 4_000 },
      normalizePolicy: () => DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1,
      logger: { info },
    });

    expect(api.updateConnectedServiceAuthGroupRuntimeState).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
  });

  it('does not clear stale generations', async () => {
    const persisted = group({
      v: 1,
      authInvalidUntilMs: 10_000,
      credentialHealthStatus: 'needs_reauth',
      lastFailureKind: 'auth_failed',
      lastObservedAtMs: 1_000,
    });
    const api = {
      getConnectedServiceAuthGroup: vi.fn(async () => persisted),
      updateConnectedServiceAuthGroupRuntimeState: vi.fn(async () => persisted),
    };

    await persistMemberRuntimeStateWithPositiveEvidence({
      api,
      serviceId: 'openai-codex' as ConnectedServiceId,
      groupId: 'group-1',
      profileId: 'primary',
      generation: 6,
      evidence: { kind: 'successful_turn', observedAtMs: 2_000 },
      normalizePolicy: () => DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1,
    });

    expect(api.updateConnectedServiceAuthGroupRuntimeState).not.toHaveBeenCalled();
  });
});

describe('reconcileMemberRuntimeStateWithPositiveEvidence', () => {
  it.each([
    ['successful_spawn', { kind: 'successful_spawn', observedAtMs: 2_000 }],
    ['successful_turn', { kind: 'successful_turn', observedAtMs: 2_000 }],
    ['credential_refresh', { kind: 'credential_refresh', observedAtMs: 2_000 }],
    ['oauth_token_callback', { kind: 'oauth_token_callback', observedAtMs: 2_000 }],
    ['account_adoption', { kind: 'account_adoption', observedAtMs: 2_000 }],
    ['quota_headroom', {
      kind: 'quota_headroom',
      observedAtMs: 2_000,
      quotaSnapshot: {
        capturedAtMs: 2_000,
        effectiveMeterId: 'daily',
        effectiveRemainingPercent: 80,
        meters: [{ meterId: 'daily', limitCategory: 'usage_limit', remainingPct: 80, resetAtMs: null, providerLimitId: 'daily' }],
      },
    }],
  ] satisfies ReadonlyArray<readonly [string, ConnectedServiceAuthGroupPositiveEvidence]>)(
    'clears stale runtime blockers with newer %s evidence',
    (_label, evidence) => {
      const reconciled = reconcileMemberRuntimeStateWithPositiveEvidence({
        state: {
          authInvalidUntilMs: 10_000,
          capacityLimitedUntilMs: 10_000,
          cooldownStartedAtMs: 1_000,
          cooldownUntilMs: 10_000,
          credentialHealthStatus: 'needs_reauth',
          exhaustedUntilMs: 10_000,
          lastFailureKind: 'auth_failed',
          lastObservedAtMs: 1_000,
          planUnavailableUntilMs: 10_000,
          quotaExhaustedUntilMs: 10_000,
          rateLimitedUntilMs: 10_000,
          validationBlockedUntilMs: 10_000,
        },
        evidence,
        policy: DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1,
        nowMs: 2_000,
      });

      expect(reconciled).toEqual({});
    },
  );
});
