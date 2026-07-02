import { describe, expect, it, vi } from 'vitest';
import {
  buildProviderAccountUsageRecordId,
  type ConnectedServiceAuthGroupV1,
  type ProviderAccountUsageRecordKeyV1,
  type ProviderAccountUsageSnapshotV1,
} from '@happier-dev/protocol';

import { ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore } from '../accountGroups/quotas/ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore';
import { DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1 } from '../accountGroups/selection/selectConnectedServiceAuthGroupCandidate';
import { createDaemonConnectedServiceAuthGroupSwitchCoordinator } from './createDaemonConnectedServiceAuthGroupSwitchCoordinator';

function group(activeProfileId: string, generation: number): ConnectedServiceAuthGroupV1 {
  return {
    v: 1 as const,
    serviceId: 'openai-codex',
    groupId: 'main',
    displayName: null,
    policy: { ...DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1, autoSwitch: true },
    activeProfileId,
    generation,
    state: { v: 1 as const },
    members: [
      {
        v: 1 as const,
        serviceId: 'openai-codex',
        groupId: 'main',
        profileId: 'primary',
        enabled: true,
        priority: 1,
        state: { v: 1 as const },
        createdAt: 1,
        updatedAt: 1,
      },
      {
        v: 1 as const,
        serviceId: 'openai-codex',
        groupId: 'main',
        profileId: 'backup',
        enabled: true,
        priority: 2,
        state: { v: 1 as const },
        createdAt: 2,
        updatedAt: 2,
      },
    ],
    createdAt: 1,
    updatedAt: 1,
  };
}

function accountUsageSnapshot(profileId: string, remainingPct: number): ProviderAccountUsageSnapshotV1 {
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

describe('createDaemonConnectedServiceAuthGroupSwitchCoordinator', () => {
  it('loads group state, commits the selected member, and requests a session restart for rematerialization', async () => {
    const api = {
      getConnectedServiceAuthGroup: vi.fn(async () => group('primary', 1)),
      updateConnectedServiceAuthGroupActiveProfile: vi.fn(async () => group('backup', 2)),
      updateConnectedServiceAuthGroupRuntimeState: vi.fn(async () => group('primary', 1)),
    };
    const restartSession = vi.fn(async () => {});
    const coordinator = createDaemonConnectedServiceAuthGroupSwitchCoordinator({
      api,
      runtimeQuotaSnapshots: new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore(),
      quotaFreshnessMs: 60_000,
      nowMs: () => 1_000,
      restartSession,
    });

    await expect(coordinator.switchAfterClassifiedFailure({
      serviceId: 'openai-codex',
      groupId: 'main',
      reason: 'usage_limit',
      switchesThisTurn: 0,
    })).resolves.toMatchObject({
      status: 'switched',
      activeProfileId: 'backup',
      generation: 2,
      providerApplication: 'applied',
    });

    expect(api.updateConnectedServiceAuthGroupActiveProfile).toHaveBeenCalledWith({
      serviceId: 'openai-codex',
      groupId: 'main',
      activeProfileId: 'backup',
      expectedGeneration: 1,
      overrideRuntimeCooldown: true,
    });
    expect(restartSession).toHaveBeenCalledWith({
      serviceId: 'openai-codex',
      groupId: 'main',
      activeProfileId: 'backup',
      generation: 2,
      reason: 'usage_limit',
    });
  });

  it('marks metadata-only generation updates as observed rather than provider-applied', async () => {
    const api = {
      getConnectedServiceAuthGroup: vi.fn(async () => group('primary', 1)),
      updateConnectedServiceAuthGroupActiveProfile: vi.fn(async () => group('backup', 2)),
      updateConnectedServiceAuthGroupRuntimeState: vi.fn(async () => group('primary', 1)),
    };
    const restartSession = vi.fn(async () => {});
    const applyConnectedServiceAuthGeneration = vi.fn(async () => ({
      ok: true as const,
      action: 'metadata_updated' as const,
    }));
    const coordinator = createDaemonConnectedServiceAuthGroupSwitchCoordinator({
      api,
      runtimeQuotaSnapshots: new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore(),
      quotaFreshnessMs: 60_000,
      nowMs: () => 1_000,
      restartSession,
      applyConnectedServiceAuthGeneration,
    });

    await expect(coordinator.switchAfterClassifiedFailure({
      sessionId: 'sess_1',
      serviceId: 'openai-codex',
      groupId: 'main',
      reason: 'usage_limit',
      switchesThisTurn: 0,
    })).resolves.toMatchObject({
      status: 'switched',
      activeProfileId: 'backup',
      generation: 2,
      mode: 'spawn_next_turn',
      providerApplication: 'observed',
    });
    expect(restartSession).not.toHaveBeenCalled();
  });

  it('surfaces the FSM-proven continuity context on the switched result for switch telemetry (INC-6)', async () => {
    const api = {
      getConnectedServiceAuthGroup: vi.fn(async () => group('primary', 1)),
      updateConnectedServiceAuthGroupActiveProfile: vi.fn(async () => group('backup', 2)),
      updateConnectedServiceAuthGroupRuntimeState: vi.fn(async () => group('primary', 1)),
    };
    const continuity = {
      materializationIdentityId: 'csm_abc',
      targetMaterializedRoot: '/home/user/.happier/csm/csm_abc',
      vendorResumeId: 'resume-123',
      candidatePersistedSessionFile: '/home/user/.codex/sessions/rollout.jsonl',
      requestedStateMode: 'shared',
      effectiveStateMode: 'shared',
    };
    const applyConnectedServiceAuthGeneration = vi.fn(async () => ({
      ok: true as const,
      action: 'metadata_updated' as const,
      diagnostics: { continuity },
    }));
    const coordinator = createDaemonConnectedServiceAuthGroupSwitchCoordinator({
      api,
      runtimeQuotaSnapshots: new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore(),
      quotaFreshnessMs: 60_000,
      nowMs: () => 1_000,
      restartSession: vi.fn(async () => {}),
      applyConnectedServiceAuthGeneration,
    });

    // The proven continuity context from the session FSM must reach the coordinator result —
    // reactive switch-attempt telemetry reads `result.diagnostics.continuity`, and dropping it
    // here is what left vendorResumeId/targetMaterializedRoot/effectiveStateMode all-null in
    // the Jun-10 incident telemetry (INC-6).
    await expect(coordinator.switchAfterClassifiedFailure({
      sessionId: 'sess_1',
      serviceId: 'openai-codex',
      groupId: 'main',
      reason: 'usage_limit',
      switchesThisTurn: 0,
    })).resolves.toMatchObject({
      status: 'switched',
      activeProfileId: 'backup',
      generation: 2,
      mode: 'spawn_next_turn',
      diagnostics: { continuity },
    });
  });

  it('does not claim a restart or provider application when the FSM reports the binding unchanged (RD-SW-5)', async () => {
    const api = {
      getConnectedServiceAuthGroup: vi.fn(async () => group('primary', 1)),
      updateConnectedServiceAuthGroupActiveProfile: vi.fn(async () => group('backup', 2)),
      updateConnectedServiceAuthGroupRuntimeState: vi.fn(async () => group('primary', 1)),
    };
    const restartSession = vi.fn(async () => {});
    const applyConnectedServiceAuthGeneration = vi.fn(async () => ({
      ok: true as const,
      action: 'unchanged' as const,
    }));
    const coordinator = createDaemonConnectedServiceAuthGroupSwitchCoordinator({
      api,
      runtimeQuotaSnapshots: new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore(),
      quotaFreshnessMs: 60_000,
      nowMs: () => 1_000,
      restartSession,
      applyConnectedServiceAuthGeneration,
    });

    const result = await coordinator.switchAfterClassifiedFailure({
      sessionId: 'sess_1',
      serviceId: 'openai-codex',
      groupId: 'main',
      reason: 'usage_limit',
      switchesThisTurn: 0,
    });

    expect(result).toMatchObject({
      status: 'switched',
      activeProfileId: 'backup',
      generation: 2,
    });
    // An `unchanged` apply performed no restart and no provider application — the diagnostic
    // mode/providerApplication must not fabricate a `restart_resume`/`applied` transition.
    expect(result).not.toHaveProperty('mode');
    expect(result).not.toHaveProperty('providerApplication');
    expect(restartSession).not.toHaveBeenCalled();
  });

  it('retries a transient auth-group load failure with backoff before switching', async () => {
    const getConnectedServiceAuthGroup = vi.fn<() => Promise<ConnectedServiceAuthGroupV1 | null>>()
      .mockRejectedValueOnce(new Error('Failed to get connected service auth group: timeout of 5000ms exceeded'))
      .mockResolvedValue(group('primary', 1));
    const api = {
      getConnectedServiceAuthGroup,
      updateConnectedServiceAuthGroupActiveProfile: vi.fn(async () => group('backup', 2)),
      updateConnectedServiceAuthGroupRuntimeState: vi.fn(async () => group('primary', 1)),
    };
    const restartSession = vi.fn(async () => {});
    const sleepMs = vi.fn(async () => {});
    const coordinator = createDaemonConnectedServiceAuthGroupSwitchCoordinator({
      api,
      runtimeQuotaSnapshots: new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore(),
      quotaFreshnessMs: 60_000,
      nowMs: () => 1_000,
      restartSession,
      sleepMs,
    });

    await expect(coordinator.switchAfterClassifiedFailure({
      serviceId: 'openai-codex',
      groupId: 'main',
      reason: 'usage_limit',
      switchesThisTurn: 0,
    })).resolves.toMatchObject({ status: 'switched', activeProfileId: 'backup', generation: 2 });

    // The first GET timed out (a transient local-server blip); the recovery retried with one
    // backoff rather than throwing at the first step and being swallowed as
    // recovery_handler_failed. The switch resolving (above) + exactly one backoff prove it.
    expect(sleepMs).toHaveBeenCalledTimes(1);
  });

  it('does not let a slow quota probe block reactive recovery indefinitely', async () => {
    vi.useFakeTimers();
    try {
      const api = {
        getConnectedServiceAuthGroup: vi.fn(async () => group('primary', 1)),
        updateConnectedServiceAuthGroupActiveProfile: vi.fn(async () => group('backup', 2)),
        updateConnectedServiceAuthGroupRuntimeState: vi.fn(async () => group('primary', 1)),
      };
      const restartSession = vi.fn(async () => {});
      const probeQuotaSnapshotsForGroup = vi.fn(async () => {
        await new Promise<void>(() => {});
      });
      const coordinator = createDaemonConnectedServiceAuthGroupSwitchCoordinator({
        api,
        runtimeQuotaSnapshots: new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore(),
        quotaFreshnessMs: 60_000,
        nowMs: () => 1_000,
        restartSession,
        probeQuotaSnapshotsForGroup,
        quotaProbeTimeoutMs: 25,
      });

      const result = coordinator.switchAfterClassifiedFailure({
        serviceId: 'openai-codex',
        groupId: 'main',
        reason: 'usage_limit',
        switchesThisTurn: 0,
      });

      await vi.advanceTimersByTimeAsync(25);

      await expect(result).resolves.toMatchObject({
        status: 'switched',
        activeProfileId: 'backup',
        generation: 2,
      });
      expect(probeQuotaSnapshotsForGroup).toHaveBeenCalledWith({
        serviceId: 'openai-codex',
        groupId: 'main',
        profileIds: ['backup'],
        reason: 'usage_limit',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('applies committed generations through the shared auth primitive when a session id is present', async () => {
    const api = {
      getConnectedServiceAuthGroup: vi.fn(async () => group('primary', 1)),
      updateConnectedServiceAuthGroupActiveProfile: vi.fn(async () => group('backup', 2)),
      updateConnectedServiceAuthGroupRuntimeState: vi.fn(async () => group('primary', 1)),
    };
    const restartSession = vi.fn(async () => {});
    const applyConnectedServiceAuthGeneration = vi.fn(async () => ({
      ok: true as const,
      action: 'hot_applied' as const,
    }));
    const params = {
      api,
      runtimeQuotaSnapshots: new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore(),
      quotaFreshnessMs: 60_000,
      nowMs: () => 1_000,
      restartSession,
      applyConnectedServiceAuthGeneration,
    } satisfies Parameters<typeof createDaemonConnectedServiceAuthGroupSwitchCoordinator>[0] & Readonly<{
      applyConnectedServiceAuthGeneration: typeof applyConnectedServiceAuthGeneration;
    }>;
    const coordinator = createDaemonConnectedServiceAuthGroupSwitchCoordinator(params);

    await expect(coordinator.switchAfterClassifiedFailure({
      sessionId: 'sess_1',
      serviceId: 'openai-codex',
      groupId: 'main',
      reason: 'usage_limit',
      switchesThisTurn: 0,
    })).resolves.toMatchObject({
      status: 'switched',
      activeProfileId: 'backup',
      generation: 2,
      mode: 'hot_apply',
    });

    expect(applyConnectedServiceAuthGeneration).toHaveBeenCalledWith({
      sessionId: 'sess_1',
      serviceId: 'openai-codex',
      groupId: 'main',
      activeProfileId: 'backup',
      generation: 2,
      reason: 'usage_limit',
      switchReason: 'automatic_runtime_failure',
      // Pre-switch active member, threaded so the transcript "from" is the real member, not null.
      fromProfileId: 'primary',
    });
    expect(restartSession).not.toHaveBeenCalled();
  });

  it('notifies committed group switches before post-commit generation apply work', async () => {
    const events: string[] = [];
    const api = {
      getConnectedServiceAuthGroup: vi.fn(async () => group('primary', 1)),
      updateConnectedServiceAuthGroupActiveProfile: vi.fn(async () => group('backup', 2)),
      updateConnectedServiceAuthGroupRuntimeState: vi.fn(async () => group('primary', 1)),
    };
    const restartSession = vi.fn(async () => {});
    const onCommittedSwitch = vi.fn(async () => {
      events.push('committed');
    });
    const applyConnectedServiceAuthGeneration = vi.fn(async () => {
      events.push('apply');
      expect(events).toEqual(['committed', 'apply']);
      return {
        ok: true as const,
        action: 'hot_applied' as const,
      };
    });
    const params = {
      api,
      runtimeQuotaSnapshots: new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore(),
      quotaFreshnessMs: 60_000,
      nowMs: () => 1_000,
      restartSession,
      applyConnectedServiceAuthGeneration,
      onCommittedSwitch,
    } satisfies Parameters<typeof createDaemonConnectedServiceAuthGroupSwitchCoordinator>[0] & Readonly<{
      applyConnectedServiceAuthGeneration: typeof applyConnectedServiceAuthGeneration;
      onCommittedSwitch: typeof onCommittedSwitch;
    }>;
    const coordinator = createDaemonConnectedServiceAuthGroupSwitchCoordinator(params);

    await expect(coordinator.switchAfterClassifiedFailure({
      sessionId: 'sess_1',
      serviceId: 'openai-codex',
      groupId: 'main',
      reason: 'usage_limit',
      switchesThisTurn: 0,
    })).resolves.toMatchObject({
      status: 'switched',
      activeProfileId: 'backup',
      generation: 2,
      mode: 'hot_apply',
    });

    expect(onCommittedSwitch).toHaveBeenCalledWith({
      serviceId: 'openai-codex',
      groupId: 'main',
      activeProfileId: 'backup',
      generation: 2,
      expectedGeneration: 1,
    });
  });

  it('returns typed apply failures from the shared auth primitive without collapsing to a thrown hook error', async () => {
    const api = {
      getConnectedServiceAuthGroup: vi.fn(async () => group('primary', 1)),
      updateConnectedServiceAuthGroupActiveProfile: vi.fn(async () => group('backup', 2)),
      updateConnectedServiceAuthGroupRuntimeState: vi.fn(async () => group('primary', 1)),
    };
    const restartSession = vi.fn(async () => {});
    const applyConnectedServiceAuthGeneration = vi.fn(async () => ({
      ok: false as const,
      errorCode: 'provider_session_state_unavailable_for_resume',
    }));
    const coordinator = createDaemonConnectedServiceAuthGroupSwitchCoordinator({
      api,
      runtimeQuotaSnapshots: new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore(),
      quotaFreshnessMs: 60_000,
      nowMs: () => 1_000,
      restartSession,
      applyConnectedServiceAuthGeneration,
    });

    await expect(coordinator.switchAfterClassifiedFailure({
      sessionId: 'sess_1',
      serviceId: 'openai-codex',
      groupId: 'main',
      reason: 'usage_limit',
      switchesThisTurn: 0,
    })).resolves.toEqual({
      status: 'generation_apply_failed',
      activeProfileId: 'backup',
      generation: 2,
      errorCode: 'provider_session_state_unavailable_for_resume',
    });

    expect(restartSession).not.toHaveBeenCalled();
  });

  it('emits a failed group-switch result when post-switch owner verification still observes the old profile', async () => {
    const api = {
      getConnectedServiceAuthGroup: vi.fn(async () => group('codex3', 1)),
      updateConnectedServiceAuthGroupActiveProfile: vi.fn(async () => group('bot', 2)),
      updateConnectedServiceAuthGroupRuntimeState: vi.fn(async () => group('codex3', 1)),
    };
    const emitEvent = vi.fn();
    const applyConnectedServiceAuthGeneration = vi.fn(async () => ({
      ok: false as const,
      errorCode: 'provider_account_adoption_mismatch',
      diagnostics: {
        failurePhase: 'post_switch_verification',
        retryable: true,
        verification: {
          expectedProviderAccountId: 'acct_bot',
          actualProviderAccountId: 'acct_codex3',
        },
      },
    }));
    const coordinator = createDaemonConnectedServiceAuthGroupSwitchCoordinator({
      api,
      runtimeQuotaSnapshots: new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore(),
      quotaFreshnessMs: 60_000,
      nowMs: () => 1_000,
      restartSession: vi.fn(async () => {}),
      applyConnectedServiceAuthGeneration,
      emitEvent,
    });

    await expect(coordinator.switchAfterClassifiedFailure({
      sessionId: 'sess_1',
      serviceId: 'openai-codex',
      groupId: 'main',
      reason: 'usage_limit',
      switchesThisTurn: 0,
    })).resolves.toEqual({
      status: 'generation_apply_failed',
      activeProfileId: 'bot',
      generation: 2,
      errorCode: 'provider_account_adoption_mismatch',
      diagnostics: {
        failurePhase: 'post_switch_verification',
        retryable: true,
        verification: {
          expectedProviderAccountId: 'acct_bot',
          actualProviderAccountId: 'acct_codex3',
        },
      },
    });

    expect(emitEvent).toHaveBeenCalledWith(expect.objectContaining({
      resultStatus: 'generation_apply_failed',
      success: false,
      toProfileId: 'bot',
    }));
  });

  it('uses persisted member runtime state from the auth-group API before selecting a candidate', async () => {
    const initial = group('primary', 1);
    const groupWithPersistedCooldown: ConnectedServiceAuthGroupV1 = {
      ...initial,
      members: [
        initial.members[0]!,
        {
          ...initial.members[1]!,
          state: {
            v: 1,
            cooldownUntilMs: 5_000,
          },
        },
        {
          v: 1,
          serviceId: 'openai-codex',
          groupId: 'main',
          profileId: 'tertiary',
          enabled: true,
          priority: 3,
          state: { v: 1 },
          createdAt: 3,
          updatedAt: 3,
        },
      ],
    };
    const api = {
      getConnectedServiceAuthGroup: vi.fn(async () => groupWithPersistedCooldown),
      updateConnectedServiceAuthGroupRuntimeState: vi.fn(async () => groupWithPersistedCooldown),
      updateConnectedServiceAuthGroupActiveProfile: vi.fn(async ({ activeProfileId }: { activeProfileId: string }) => ({
        ...groupWithPersistedCooldown,
        activeProfileId,
        generation: 2,
      })),
    };
    const coordinator = createDaemonConnectedServiceAuthGroupSwitchCoordinator({
      api,
      runtimeQuotaSnapshots: new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore(),
      quotaFreshnessMs: 60_000,
      nowMs: () => 1_000,
      restartSession: async () => {},
    });

    await expect(coordinator.switchAfterClassifiedFailure({
      serviceId: 'openai-codex',
      groupId: 'main',
      reason: 'usage_limit',
    })).resolves.toMatchObject({ status: 'switched', activeProfileId: 'tertiary' });

    expect(api.updateConnectedServiceAuthGroupActiveProfile).toHaveBeenCalledWith(expect.objectContaining({
      activeProfileId: 'tertiary',
    }));
  });

  it('uses persisted quota exhaustion from the auth-group API after daemon restart', async () => {
    const initial = group('primary', 1);
    const groupWithPersistedExhaustion: ConnectedServiceAuthGroupV1 = {
      ...initial,
      members: [
        initial.members[0]!,
        {
          ...initial.members[1]!,
          state: {
            v: 1,
            quotaExhaustedUntilMs: 5_000,
          },
        },
        {
          v: 1,
          serviceId: 'openai-codex',
          groupId: 'main',
          profileId: 'tertiary',
          enabled: true,
          priority: 3,
          state: { v: 1 },
          createdAt: 3,
          updatedAt: 3,
        },
      ],
    };
    const api = {
      getConnectedServiceAuthGroup: vi.fn(async () => groupWithPersistedExhaustion),
      updateConnectedServiceAuthGroupRuntimeState: vi.fn(async () => groupWithPersistedExhaustion),
      updateConnectedServiceAuthGroupActiveProfile: vi.fn(async ({ activeProfileId }: { activeProfileId: string }) => ({
        ...groupWithPersistedExhaustion,
        activeProfileId,
        generation: 2,
      })),
    };
    const coordinator = createDaemonConnectedServiceAuthGroupSwitchCoordinator({
      api,
      runtimeQuotaSnapshots: new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore(),
      quotaFreshnessMs: 60_000,
      nowMs: () => 1_000,
      restartSession: async () => {},
    });

    await expect(coordinator.switchAfterClassifiedFailure({
      serviceId: 'openai-codex',
      groupId: 'main',
      reason: 'usage_limit',
    })).resolves.toMatchObject({ status: 'switched', activeProfileId: 'tertiary' });

    expect(api.updateConnectedServiceAuthGroupActiveProfile).toHaveBeenCalledWith(expect.objectContaining({
      activeProfileId: 'tertiary',
    }));
  });

  it('does not use runtime quota snapshots to clear persisted target limiter state without source-backed account usage', async () => {
    const initial = group('primary', 1);
    const groupWithStaleBackupLimiter: ConnectedServiceAuthGroupV1 = {
      ...initial,
      members: [
        initial.members[0]!,
        {
          ...initial.members[1]!,
          state: {
            v: 1,
            quotaExhaustedUntilMs: 20_000,
            lastFailureKind: 'usage_limit',
            lastObservedAtMs: 900,
          },
        },
      ],
    };
    const runtimeQuotaSnapshots = new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore();
    runtimeQuotaSnapshots.recordSnapshot({
      serviceId: 'openai-codex',
      groupId: 'main',
      profileId: 'backup',
      snapshot: {
        v: 1,
        serviceId: 'openai-codex',
        profileId: 'backup',
        fetchedAt: 1_000,
        staleAfterMs: 60_000,
        planLabel: null,
        accountLabel: null,
        meters: [{
          meterId: 'weekly',
          label: 'Weekly',
          used: null,
          limit: null,
          unit: 'unknown',
          utilizationPct: 30,
          remainingPct: 70,
          resetsAt: null,
          status: 'ok',
          details: {},
        }],
      },
    });
    const api = {
      getConnectedServiceAuthGroup: vi.fn(async () => groupWithStaleBackupLimiter),
      updateConnectedServiceAuthGroupRuntimeState: vi.fn(async () => groupWithStaleBackupLimiter),
      updateConnectedServiceAuthGroupActiveProfile: vi.fn(async ({
        activeProfileId,
        overrideRuntimeCooldown,
      }: {
        activeProfileId: string;
        overrideRuntimeCooldown?: boolean;
      }) => {
        if (overrideRuntimeCooldown !== true) {
          throw new Error('expected automated runtime-cooldown override');
        }
        return {
          ...groupWithStaleBackupLimiter,
          activeProfileId,
          generation: 2,
        };
      }),
    };
    const coordinator = createDaemonConnectedServiceAuthGroupSwitchCoordinator({
      api,
      runtimeQuotaSnapshots,
      quotaFreshnessMs: 60_000,
      nowMs: () => 1_000,
      restartSession: async () => {},
    });

    await expect(coordinator.switchAfterClassifiedFailure({
      serviceId: 'openai-codex',
      groupId: 'main',
      reason: 'usage_limit',
      observedProfileId: 'primary',
    })).resolves.toMatchObject({ status: 'no_eligible_member' });

    expect(api.updateConnectedServiceAuthGroupActiveProfile).not.toHaveBeenCalled();
  });

  it('does not hydrate persisted quota snapshots for group members before pre-turn selection', async () => {
    const runtimeQuotaSnapshots = new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore();
    const api = {
      getConnectedServiceAuthGroup: vi.fn(async () => group('primary', 1)),
      updateConnectedServiceAuthGroupRuntimeState: vi.fn(async () => group('primary', 1)),
      updateConnectedServiceAuthGroupActiveProfile: vi.fn(async ({ activeProfileId }: { activeProfileId: string }) => ({
        ...group(activeProfileId, 2),
        activeProfileId,
        generation: 2,
      })),
    };
    const hydratePersistedQuotaSnapshotsForGroup = vi.fn(async () => {
      runtimeQuotaSnapshots.recordProfileSnapshot({
        serviceId: 'openai-codex',
        profileId: 'primary',
        snapshot: {
          v: 1,
          serviceId: 'openai-codex',
          profileId: 'primary',
          fetchedAt: 900,
          staleAfterMs: 60_000,
          planLabel: null,
          accountLabel: null,
          meters: [{
            meterId: 'weekly',
            label: 'Weekly',
            used: null,
            limit: null,
            unit: 'unknown',
            utilizationPct: 100,
            resetsAt: null,
            status: 'ok',
            details: {},
          }],
        },
      });
      runtimeQuotaSnapshots.recordProfileSnapshot({
        serviceId: 'openai-codex',
        profileId: 'backup',
        snapshot: {
          v: 1,
          serviceId: 'openai-codex',
          profileId: 'backup',
          fetchedAt: 900,
          staleAfterMs: 60_000,
          planLabel: null,
          accountLabel: null,
          meters: [{
            meterId: 'weekly',
            label: 'Weekly',
            used: null,
            limit: null,
            unit: 'unknown',
            utilizationPct: 20,
            resetsAt: null,
            status: 'ok',
            details: {},
          }],
        },
      });
    });
    const params = {
      api,
      runtimeQuotaSnapshots,
      quotaFreshnessMs: 60_000,
      nowMs: () => 1_000,
      restartSession: async () => {},
      hydratePersistedQuotaSnapshotsForGroup,
    } satisfies Parameters<typeof createDaemonConnectedServiceAuthGroupSwitchCoordinator>[0] & Readonly<{
      hydratePersistedQuotaSnapshotsForGroup: typeof hydratePersistedQuotaSnapshotsForGroup;
    }>;
    const coordinator = createDaemonConnectedServiceAuthGroupSwitchCoordinator(params);

    await expect(coordinator.switchBeforeTurn({
      serviceId: 'openai-codex',
      groupId: 'main',
      reason: 'soft_threshold',
    })).resolves.toMatchObject({ status: 'observed_generation', activeProfileId: 'primary' });

    expect(hydratePersistedQuotaSnapshotsForGroup).not.toHaveBeenCalled();
    expect(api.updateConnectedServiceAuthGroupActiveProfile).not.toHaveBeenCalled();
  });

  it('drives pre-turn soft switching from source-backed provider account usage without runtime quota snapshots', async () => {
    const primary = accountUsageSnapshot('primary', 0);
    const backup = accountUsageSnapshot('backup', 90);
    const api = {
      getConnectedServiceAuthGroup: vi.fn(async () => group('primary', 1)),
      updateConnectedServiceAuthGroupRuntimeState: vi.fn(async () => group('primary', 1)),
      updateConnectedServiceAuthGroupActiveProfile: vi.fn(async ({ activeProfileId }: { activeProfileId: string }) => ({
        ...group(activeProfileId, 2),
        activeProfileId,
        generation: 2,
      })),
    };
    const accountUsageStore = {
      resolveBySource: vi.fn((source: { profileId: string; groupGeneration?: number }) => {
        if (source.groupGeneration !== 1) return null;
        if (source.profileId === 'primary') return primary;
        if (source.profileId === 'backup') return backup;
        return null;
      }),
    };
    const coordinator = createDaemonConnectedServiceAuthGroupSwitchCoordinator({
      api,
      runtimeQuotaSnapshots: new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore(),
      accountUsageStore,
      quotaFreshnessMs: 60_000,
      nowMs: () => 1_000,
      restartSession: async () => {},
    } as Parameters<typeof createDaemonConnectedServiceAuthGroupSwitchCoordinator>[0] & Readonly<{
      accountUsageStore: typeof accountUsageStore;
    }>);

    await expect(coordinator.switchBeforeTurn({
      serviceId: 'openai-codex',
      groupId: 'main',
      reason: 'soft_threshold',
    })).resolves.toMatchObject({ status: 'switched', activeProfileId: 'backup' });

    expect(api.updateConnectedServiceAuthGroupActiveProfile).toHaveBeenCalledWith(expect.objectContaining({
      activeProfileId: 'backup',
      expectedGeneration: 1,
    }));
  });

  it('persists observed quota failure state before relying on selector state', async () => {
    const api = {
      getConnectedServiceAuthGroup: vi.fn(async () => group('primary', 1)),
      updateConnectedServiceAuthGroupRuntimeState: vi.fn(async () => group('primary', 1)),
      updateConnectedServiceAuthGroupActiveProfile: vi.fn(async () => group('backup', 2)),
    };
    const coordinator = createDaemonConnectedServiceAuthGroupSwitchCoordinator({
      api,
      runtimeQuotaSnapshots: new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore(),
      quotaFreshnessMs: 60_000,
      nowMs: () => 1_000,
      restartSession: async () => {},
    });

    await coordinator.switchAfterClassifiedFailure({
      serviceId: 'openai-codex',
      groupId: 'main',
      reason: 'usage_limit',
      observedProfileId: 'primary',
      retryAfterMs: 5_000,
      planType: 'team',
    });

    expect(api.updateConnectedServiceAuthGroupRuntimeState).toHaveBeenCalledWith({
      serviceId: 'openai-codex',
      groupId: 'main',
      expectedGeneration: 1,
      memberStates: [{
        profileId: 'primary',
          state: expect.objectContaining({
          quotaExhaustedUntilMs: 6_000,
          lastFailureKind: 'usage_limit',
          lastObservedPlanType: 'team',
          lastObservedAtMs: 1_000,
        }),
      }],
    });
  });

  it('uses the group cooldown as a usage-limit exhaustion fallback when provider timing is missing', async () => {
    const api = {
      getConnectedServiceAuthGroup: vi.fn(async () => ({
        ...group('primary', 1),
        policy: {
          ...DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1,
          autoSwitch: true,
          cooldownMs: 45_000,
        },
      })),
      updateConnectedServiceAuthGroupRuntimeState: vi.fn(async () => group('primary', 1)),
      updateConnectedServiceAuthGroupActiveProfile: vi.fn(async () => group('backup', 2)),
    };
    const coordinator = createDaemonConnectedServiceAuthGroupSwitchCoordinator({
      api,
      runtimeQuotaSnapshots: new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore(),
      quotaFreshnessMs: 60_000,
      nowMs: () => 1_000,
      restartSession: async () => {},
    });

    await coordinator.switchAfterClassifiedFailure({
      serviceId: 'openai-codex',
      groupId: 'main',
      reason: 'usage_limit',
      observedProfileId: 'primary',
      planType: null,
    });

    expect(api.updateConnectedServiceAuthGroupRuntimeState).toHaveBeenCalledWith(expect.objectContaining({
      memberStates: [{
        profileId: 'primary',
        state: expect.objectContaining({
          quotaExhaustedUntilMs: 46_000,
          lastFailureKind: 'usage_limit',
          lastObservedAtMs: 1_000,
        }),
      }],
    }));
  });

  it('uses the group cooldown as a rate-limit and capacity fallback when provider timing is missing', async () => {
    const loadedGroup = {
      ...group('primary', 1),
      policy: {
        ...DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1,
        autoSwitch: true,
        cooldownMs: 45_000,
      },
    };
    const api = {
      getConnectedServiceAuthGroup: vi.fn(async () => loadedGroup),
      updateConnectedServiceAuthGroupRuntimeState: vi.fn(async () => loadedGroup),
      updateConnectedServiceAuthGroupActiveProfile: vi.fn(async () => group('backup', 2)),
    };
    const coordinator = createDaemonConnectedServiceAuthGroupSwitchCoordinator({
      api,
      runtimeQuotaSnapshots: new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore(),
      quotaFreshnessMs: 60_000,
      nowMs: () => 1_000,
      restartSession: async () => {},
    });

    await coordinator.switchAfterClassifiedFailure({
      serviceId: 'openai-codex',
      groupId: 'main',
      reason: 'rate_limit',
      observedProfileId: 'primary',
      planType: null,
    });
    await coordinator.switchAfterClassifiedFailure({
      serviceId: 'openai-codex',
      groupId: 'main',
      reason: 'capacity',
      observedProfileId: 'primary',
      planType: null,
    });

    expect(api.updateConnectedServiceAuthGroupRuntimeState).toHaveBeenNthCalledWith(1, expect.objectContaining({
      memberStates: [{
        profileId: 'primary',
        state: expect.objectContaining({
          rateLimitedUntilMs: 46_000,
          lastFailureKind: 'rate_limit',
          lastObservedAtMs: 1_000,
        }),
      }],
    }));
    expect(api.updateConnectedServiceAuthGroupRuntimeState).toHaveBeenNthCalledWith(2, expect.objectContaining({
      memberStates: [{
        profileId: 'primary',
        state: expect.objectContaining({
          capacityLimitedUntilMs: 46_000,
          lastFailureKind: 'capacity',
          lastObservedAtMs: 1_000,
        }),
      }],
    }));
  });

  it('switches away from disabled accounts using auth policy', async () => {
    const api = {
      getConnectedServiceAuthGroup: vi.fn(async () => group('primary', 1)),
      updateConnectedServiceAuthGroupRuntimeState: vi.fn(async () => group('primary', 1)),
      updateConnectedServiceAuthGroupActiveProfile: vi.fn(async () => group('backup', 2)),
    };
    const coordinator = createDaemonConnectedServiceAuthGroupSwitchCoordinator({
      api,
      runtimeQuotaSnapshots: new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore(),
      quotaFreshnessMs: 60_000,
      nowMs: () => 1_000,
      restartSession: async () => {},
    });

    await expect(coordinator.switchAfterClassifiedFailure({
      serviceId: 'openai-codex',
      groupId: 'main',
      reason: 'account_disabled',
      observedProfileId: 'primary',
      retryAfterMs: 5_000,
    })).resolves.toMatchObject({ status: 'switched', activeProfileId: 'backup' });
  });

  it('treats API generation conflicts as observed cross-daemon switches', async () => {
    let loadCount = 0;
    const restartSession = vi.fn(async () => {});
    const generationConflict = Object.assign(
      new Error('connected_service_auth_group_generation_conflict'),
      { generation: 2 },
    );
    const runtimeQuotaSnapshots = new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore();
    runtimeQuotaSnapshots.recordSnapshot({
      serviceId: 'openai-codex',
      groupId: 'main',
      profileId: 'backup',
      snapshot: {
        v: 1,
        serviceId: 'openai-codex',
        profileId: 'backup',
        fetchedAt: 1_000,
        staleAfterMs: 60_000,
        planLabel: null,
        accountLabel: null,
        meters: [{
          meterId: 'daily',
          label: 'Daily',
          used: null,
          limit: null,
          unit: 'unknown',
          utilizationPct: 20,
          remainingPct: 80,
          resetsAt: null,
          status: 'ok',
          details: {},
        }],
      },
    });
    const api = {
      getConnectedServiceAuthGroup: vi.fn(async () => {
        loadCount += 1;
        return loadCount <= 2 ? group('primary', 1) : group('backup', 2);
      }),
      updateConnectedServiceAuthGroupRuntimeState: vi.fn(async () => group('primary', 1)),
      updateConnectedServiceAuthGroupActiveProfile: vi.fn(async () => {
        throw generationConflict;
      }),
    };
    const coordinator = createDaemonConnectedServiceAuthGroupSwitchCoordinator({
      api,
      runtimeQuotaSnapshots,
      quotaFreshnessMs: 60_000,
      nowMs: () => 1_000,
      restartSession,
    });

    await expect(coordinator.switchAfterClassifiedFailure({
      serviceId: 'openai-codex',
      groupId: 'main',
      reason: 'usage_limit',
      observedProfileId: 'primary',
    })).resolves.toEqual({
      status: 'observed_generation',
      activeProfileId: 'backup',
      generation: 2,
      mode: 'restart_resume',
      providerApplication: 'applied',
    });
    expect(api.updateConnectedServiceAuthGroupActiveProfile).toHaveBeenCalledTimes(1);
    expect(restartSession).toHaveBeenCalledWith({
      serviceId: 'openai-codex',
      groupId: 'main',
      activeProfileId: 'backup',
      generation: 2,
      reason: 'usage_limit',
    });
  });

  it('retries observed-failure runtime-state patches after generation conflicts before selecting a candidate', async () => {
    let loadCount = 0;
    const generationConflict = Object.assign(
      new Error('connected_service_auth_group_generation_conflict'),
      { generation: 2 },
    );
    const api = {
      getConnectedServiceAuthGroup: vi.fn(async () => {
        loadCount += 1;
        return loadCount === 1 ? group('primary', 1) : group('primary', 2);
      }),
      updateConnectedServiceAuthGroupRuntimeState: vi.fn(async ({ expectedGeneration }: { expectedGeneration?: number }) => {
        if (expectedGeneration === 1) {
          throw generationConflict;
        }
        return group('primary', 2);
      }),
      updateConnectedServiceAuthGroupActiveProfile: vi.fn(async ({ activeProfileId, expectedGeneration }: { activeProfileId: string; expectedGeneration?: number }) => ({
        ...group(activeProfileId, 3),
        generation: expectedGeneration === 2 ? 3 : 999,
      })),
    };
    const restartSession = vi.fn(async () => {});
    const coordinator = createDaemonConnectedServiceAuthGroupSwitchCoordinator({
      api,
      runtimeQuotaSnapshots: new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore(),
      quotaFreshnessMs: 60_000,
      nowMs: () => 1_000,
      restartSession,
    });

    await expect(coordinator.switchAfterClassifiedFailure({
      serviceId: 'openai-codex',
      groupId: 'main',
      reason: 'usage_limit',
      observedProfileId: 'primary',
    })).resolves.toEqual({
      status: 'switched',
      activeProfileId: 'backup',
      generation: 3,
      mode: 'restart_resume',
      providerApplication: 'applied',
    });

    expect(api.updateConnectedServiceAuthGroupRuntimeState).toHaveBeenCalledTimes(2);
    expect(api.updateConnectedServiceAuthGroupRuntimeState).toHaveBeenNthCalledWith(1, expect.objectContaining({
      expectedGeneration: 1,
    }));
    expect(api.updateConnectedServiceAuthGroupRuntimeState).toHaveBeenNthCalledWith(2, expect.objectContaining({
      expectedGeneration: 2,
    }));
    expect(api.updateConnectedServiceAuthGroupActiveProfile).toHaveBeenCalledWith(expect.objectContaining({
      activeProfileId: 'backup',
      expectedGeneration: 2,
    }));
    expect(restartSession).toHaveBeenCalledWith({
      serviceId: 'openai-codex',
      groupId: 'main',
      activeProfileId: 'backup',
      generation: 3,
      reason: 'usage_limit',
    });
  });

  it('persists disabled account failures as auth blockers', async () => {
    const api = {
      getConnectedServiceAuthGroup: vi.fn(async () => group('primary', 1)),
      updateConnectedServiceAuthGroupRuntimeState: vi.fn(async () => group('primary', 1)),
      updateConnectedServiceAuthGroupActiveProfile: vi.fn(async () => group('backup', 2)),
    };
    const coordinator = createDaemonConnectedServiceAuthGroupSwitchCoordinator({
      api,
      runtimeQuotaSnapshots: new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore(),
      quotaFreshnessMs: 60_000,
      nowMs: () => 1_000,
      restartSession: async () => {},
    });

    await coordinator.switchAfterClassifiedFailure({
      serviceId: 'openai-codex',
      groupId: 'main',
      reason: 'account_disabled',
      observedProfileId: 'primary',
      retryAfterMs: 5_000,
    });

    expect(api.updateConnectedServiceAuthGroupRuntimeState).toHaveBeenCalledWith(expect.objectContaining({
      memberStates: [{
        profileId: 'primary',
        state: expect.objectContaining({
          authInvalidUntilMs: 6_000,
          lastFailureKind: 'account_disabled',
          lastObservedAtMs: 1_000,
        }),
      }],
    }));
  });

  it('persists auth-expired failures without provider retry metadata as bounded auth blockers', async () => {
    const api = {
      getConnectedServiceAuthGroup: vi.fn(async () => group('primary', 1)),
      updateConnectedServiceAuthGroupRuntimeState: vi.fn(async () => group('primary', 1)),
      updateConnectedServiceAuthGroupActiveProfile: vi.fn(async () => group('backup', 2)),
    };
    const coordinator = createDaemonConnectedServiceAuthGroupSwitchCoordinator({
      api,
      runtimeQuotaSnapshots: new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore(),
      quotaFreshnessMs: 60_000,
      nowMs: () => 1_000,
      restartSession: async () => {},
    });

    await coordinator.switchAfterClassifiedFailure({
      serviceId: 'openai-codex',
      groupId: 'main',
      reason: 'auth_expired',
      observedProfileId: 'primary',
    });

    expect(api.updateConnectedServiceAuthGroupRuntimeState).toHaveBeenCalledWith(expect.objectContaining({
      memberStates: [{
        profileId: 'primary',
        state: expect.objectContaining({
          authInvalidUntilMs: 31_000,
          lastFailureKind: 'auth_expired',
          lastObservedAtMs: 1_000,
        }),
      }],
    }));
  });

  it('forwards structured switch events from the daemon factory', async () => {
    const events: unknown[] = [];
    const coordinator = createDaemonConnectedServiceAuthGroupSwitchCoordinator({
      api: {
        getConnectedServiceAuthGroup: vi.fn(async () => group('primary', 1)),
        updateConnectedServiceAuthGroupRuntimeState: vi.fn(async () => group('primary', 1)),
        updateConnectedServiceAuthGroupActiveProfile: vi.fn(async () => group('backup', 2)),
      },
      runtimeQuotaSnapshots: new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore(),
      quotaFreshnessMs: 60_000,
      nowMs: () => 1_000,
      restartSession: async () => {},
      emitEvent: (event) => events.push(event),
    });

    await coordinator.switchAfterClassifiedFailure({
      sessionId: 'session-1',
      serviceId: 'openai-codex',
      groupId: 'main',
      reason: 'usage_limit',
      observedProfileId: 'primary',
    });

    expect(events).toEqual([
      expect.objectContaining({
        type: 'connected_service_auth_group_switch',
        serviceId: 'openai-codex',
        groupId: 'main',
        fromProfileId: 'primary',
        toProfileId: 'backup',
        success: true,
      }),
    ]);
  });
});
