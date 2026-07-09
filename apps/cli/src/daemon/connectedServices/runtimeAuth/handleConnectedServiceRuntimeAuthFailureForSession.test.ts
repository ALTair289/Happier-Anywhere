import { describe, expect, it, vi } from 'vitest';

import { DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1 } from '../accountGroups/selection/selectConnectedServiceAuthGroupCandidate';
import {
  ConnectedServiceAuthGroupSwitchCoordinator,
  InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry,
} from '../accountGroups/switching/ConnectedServiceAuthGroupSwitchCoordinator';
import { buildConnectedServiceCredentialRecord } from '@happier-dev/protocol';
import type { TrackedSession } from '@/daemon/types';
import { handleConnectedServiceRuntimeAuthFailureForSession } from './handleConnectedServiceRuntimeAuthFailureForSession';
import { ConnectedServiceRuntimeAuthSwitchAttemptTracker } from './ConnectedServiceRuntimeAuthSwitchAttemptTracker';
import type {
  ConnectedServiceSessionAuthSwitchCore,
  ConnectedServiceSessionAuthSwitchReason,
} from './connectedServiceSessionAuthSwitchCore';
import type { RuntimeAuthRecoveryIntent } from './RuntimeAuthRecoveryScheduler';
import type { ConnectedServiceRuntimeFailureClassification } from './types';

function createTemporaryThrottleClassification(
  overrides?: Partial<ConnectedServiceRuntimeFailureClassification>,
): ConnectedServiceRuntimeFailureClassification {
  return {
    // The runtime-auth wire contract is being extended to carry this explicit recovery kind.
    kind: 'temporary_throttle' as ConnectedServiceRuntimeFailureClassification['kind'],
    limitCategory: 'rate_limit',
    serviceId: 'openai-codex',
    profileId: 'primary',
    groupId: 'main',
    resetsAtMs: null,
    retryAfterMs: 45_000,
    planType: null,
    rateLimits: null,
    source: 'structured_provider_error',
    ...overrides,
  };
}

describe('handleConnectedServiceRuntimeAuthFailureForSession', () => {
  it('leaves group-switch transcript event emission to the switch coordinator', async () => {
    const emitSessionEvent = vi.fn();
    const switchAfterClassifiedFailure = vi.fn(async () => ({
      status: 'switched' as const,
      activeProfileId: 'backup',
      generation: 2,
      mode: 'hot_apply' as const,
    }));

    await expect(handleConnectedServiceRuntimeAuthFailureForSession({
      getChildren: () => [{
        startedBy: 'daemon',
        happySessionId: 'sess_1',
        pid: 123,
        spawnOptions: {
          directory: '/tmp/project',
          connectedServices: {
            v: 1,
            bindingsByServiceId: {
              'openai-codex': {
                source: 'connected',
                selection: 'group',
                profileId: 'primary',
                groupId: 'main',
              },
            },
          },
        },
      }],
      switchCoordinator: { switchAfterClassifiedFailure },
      emitSessionEvent,
      sessionId: 'sess_1',
      switchesThisTurn: 0,
      classification: {
        kind: 'usage_limit',
        serviceId: 'openai-codex',
        profileId: 'primary',
        groupId: 'main',
        resetsAtMs: null,
        retryAfterMs: null,
        planType: null,
        rateLimits: null,
        source: 'structured_provider_error',
      },
    })).resolves.toMatchObject({
      status: 'switch_attempted',
      result: { status: 'switched', activeProfileId: 'backup', generation: 2 },
    });

    expect(emitSessionEvent).not.toHaveBeenCalled();
  });

  it('commits a classified group fallback switch for inactive sessions without tracked children', async () => {
    const emitSessionEvent = vi.fn();
    const restartSession = vi.fn();
    const continueAfterRuntimeAuthSwitch = vi.fn();
    const switchAfterClassifiedFailure = vi.fn(async (input: Readonly<{ sessionId?: string }>) => (
      input.sessionId
        ? {
            status: 'generation_apply_failed' as const,
            activeProfileId: 'backup',
            generation: 2,
            errorCode: 'session_not_found',
          }
        : {
            status: 'switched' as const,
            activeProfileId: 'backup',
            generation: 2,
            mode: 'restart_resume' as const,
          }
    ));
    const switchAttemptTracker = {
      resolveSwitchesThisTurn: vi.fn(() => 0),
      recordSwitchResult: vi.fn(),
      countRecordedSwitchesInWindow: vi.fn(() => 0),
      hasFreshCredentialRefreshAttempt: vi.fn(() => false),
      recordCredentialRefreshAttempt: vi.fn(),
      clearSession: vi.fn(),
    };
    const switchCore: ConnectedServiceSessionAuthSwitchCore = {
      run: async (params) => params.execute(),
      clearSession: vi.fn(),
    };

    await expect(handleConnectedServiceRuntimeAuthFailureForSession({
      getChildren: () => [],
      switchCoordinator: { switchAfterClassifiedFailure },
      switchAttemptTracker,
      switchCore,
      emitSessionEvent,
      restartSession,
      continueAfterRuntimeAuthSwitch,
      sessionId: 'sess_1',
      switchesThisTurn: 0,
      classification: {
        kind: 'usage_limit',
        limitCategory: 'usage_limit',
        serviceId: 'openai-codex',
        profileId: 'primary',
        groupId: 'main',
        resetsAtMs: null,
        retryAfterMs: 30_000,
        quotaScope: 'account',
        providerLimitId: 'weekly',
        action: { kind: 'open_url', url: 'https://chatgpt.com/codex/settings/usage' },
        planType: null,
        rateLimits: null,
        source: 'structured_provider_error',
      },
    })).resolves.toMatchObject({
      status: 'switch_attempted',
      result: {
        status: 'switched',
        activeProfileId: 'backup',
        generation: 2,
      },
    });

    expect(switchAfterClassifiedFailure).toHaveBeenCalledWith({
      serviceId: 'openai-codex',
      groupId: 'main',
      reason: 'usage_limit',
      observedProfileId: 'primary',
      retryAfterMs: 30_000,
      resetsAtMs: null,
      limitCategory: 'usage_limit',
      quotaScope: 'account',
      providerLimitId: 'weekly',
      action: { kind: 'open_url', url: 'https://chatgpt.com/codex/settings/usage' },
      planType: null,
      switchesThisTurn: 0,
      sessionSwitchesThisHour: 0,
    });
    expect(emitSessionEvent).not.toHaveBeenCalled();
    expect(switchAttemptTracker.recordSwitchResult).toHaveBeenCalledWith({
      sessionId: 'sess_1',
      serviceId: 'openai-codex',
      groupId: 'main',
      resultStatus: 'switched',
    });
    expect(switchAttemptTracker.clearSession).not.toHaveBeenCalled();
    expect(switchCore.clearSession).not.toHaveBeenCalled();
    expect(restartSession).not.toHaveBeenCalled();
    expect(continueAfterRuntimeAuthSwitch).not.toHaveBeenCalled();
  });

  it('reconstructs an untracked failed session from durable metadata and schedules restart continuation', async () => {
    const reconstructedTracked: TrackedSession = {
      startedBy: 'daemon' as const,
      happySessionId: 'sess_1',
      pid: 0,
      vendorResumeId: 'codex-session-1',
      happySessionMetadataFromLocalWebhook: {
        path: '/tmp/project',
        homeDir: '/tmp/home',
        happyHomeDir: '/tmp/home/.happier',
        happyLibDir: '/tmp/home/.happier/lib',
        happyToolsDir: '/tmp/home/.happier/tools',
        host: 'test-host',
        flavor: 'codex',
        connectedServices: {
          v: 1 as const,
          bindingsByServiceId: {
            'openai-codex': {
              source: 'connected' as const,
              selection: 'group' as const,
              profileId: 'primary',
              groupId: 'main',
            },
          },
        },
        connectedServiceMaterializationIdentityV1: {
          v: 1,
          id: 'csm_codex_1',
          createdAtMs: 1_000,
        },
        agentRuntimeDescriptorV1: {
          v: 1,
          providerId: 'codex',
          provider: {
            resumeStrategy: 'vendorSessionId',
            vendorSessionId: 'codex-session-1',
          },
        },
      },
      spawnOptions: {
        directory: '/tmp/project',
        backendTarget: { kind: 'builtInAgent' as const, agentId: 'codex' as const },
        resume: 'codex-session-1',
        connectedServices: {
          v: 1 as const,
          bindingsByServiceId: {
            'openai-codex': {
              source: 'connected' as const,
              selection: 'group' as const,
              profileId: 'primary',
              groupId: 'main',
            },
          },
        },
        connectedServiceMaterializationIdentityV1: {
          v: 1,
          id: 'csm_codex_1',
          createdAtMs: 1_000,
        },
      },
    };
    const resolveDurableSessionForRuntimeAuthRecovery = vi.fn(async () => reconstructedTracked);
    const restartSession = vi.fn(async () => {});
    const continueAfterRuntimeAuthSwitch = vi.fn(async () => {});
    const switchAfterClassifiedFailure = vi.fn(async (input: Readonly<{ sessionId?: string }>) => {
      if (!input.sessionId) {
        return {
          status: 'generation_apply_failed' as const,
          activeProfileId: 'backup',
          generation: 2,
          errorCode: 'session_not_found',
        };
      }
      return {
        status: 'switched' as const,
        activeProfileId: 'backup',
        generation: 2,
        mode: 'spawn_next_turn' as const,
      };
    });

    await expect(handleConnectedServiceRuntimeAuthFailureForSession({
      getChildren: () => [],
      resolveDurableSessionForRuntimeAuthRecovery,
      switchCoordinator: { switchAfterClassifiedFailure },
      restartSession,
      continueAfterRuntimeAuthSwitch,
      sessionId: 'sess_1',
      switchesThisTurn: 0,
      recoveryInvocationSource: 'scheduler_retry',
      classification: {
        kind: 'usage_limit',
        limitCategory: 'usage_limit',
        serviceId: 'openai-codex',
        profileId: 'primary',
        groupId: 'main',
        resetsAtMs: null,
        retryAfterMs: 30_000,
        quotaScope: 'account',
        providerLimitId: 'weekly',
        action: null,
        planType: null,
        rateLimits: null,
        source: 'structured_provider_error',
      },
    })).resolves.toMatchObject({
      status: 'switch_attempted',
      result: {
        status: 'switched',
        activeProfileId: 'backup',
        generation: 2,
        mode: 'spawn_next_turn',
      },
    });

    expect(resolveDurableSessionForRuntimeAuthRecovery).toHaveBeenCalledWith({
      sessionId: 'sess_1',
      classification: expect.objectContaining({
        kind: 'usage_limit',
        serviceId: 'openai-codex',
        profileId: 'primary',
        groupId: 'main',
      }),
    });
    expect(switchAfterClassifiedFailure).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'sess_1',
      serviceId: 'openai-codex',
      groupId: 'main',
      observedProfileId: 'primary',
    }));
    expect(restartSession).toHaveBeenCalledWith(reconstructedTracked);
    expect(continueAfterRuntimeAuthSwitch).toHaveBeenCalledWith(expect.objectContaining({
      tracked: reconstructedTracked,
      sessionId: 'sess_1',
      action: 'restart_requested',
      switchReason: 'automatic_runtime_failure',
    }));
  });

  it('requests a session restart when runtime recovery switches a group account for the next turn', async () => {
    const events: string[] = [];
    const onRuntimeAuthRecoverySuccess = vi.fn(async () => {
      events.push('recovery-success');
    });
    const restartSession = vi.fn(async () => {});
    const switchAfterClassifiedFailure = vi.fn(async () => ({
      status: 'switched' as const,
      activeProfileId: 'backup',
      generation: 2,
      mode: 'spawn_next_turn' as const,
    }));

    const input = {
      getChildren: () => [{
        startedBy: 'daemon',
        happySessionId: 'sess_1',
        pid: 123,
        spawnOptions: {
          directory: '/tmp/project',
          connectedServices: {
            v: 1,
            bindingsByServiceId: {
              'openai-codex': {
                source: 'connected' as const,
                selection: 'group' as const,
                profileId: 'primary',
                groupId: 'main',
              },
            },
          },
        },
      }],
      switchCoordinator: { switchAfterClassifiedFailure },
      restartSession,
      onRuntimeAuthRecoverySuccess,
      sessionId: 'sess_1',
      switchesThisTurn: 0,
      classification: {
        kind: 'usage_limit',
        serviceId: 'openai-codex',
        profileId: 'primary',
        groupId: 'main',
        resetsAtMs: null,
        retryAfterMs: null,
        planType: null,
        rateLimits: null,
        source: 'structured_provider_error',
      },
    } satisfies Parameters<typeof handleConnectedServiceRuntimeAuthFailureForSession>[0] & {
      onRuntimeAuthRecoverySuccess: typeof onRuntimeAuthRecoverySuccess;
    };

    await expect(handleConnectedServiceRuntimeAuthFailureForSession(input)).resolves.toMatchObject({
      status: 'switch_attempted',
      result: {
        status: 'switched',
        activeProfileId: 'backup',
        generation: 2,
        mode: 'spawn_next_turn',
      },
    });

    expect(onRuntimeAuthRecoverySuccess).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'sess_1',
      serviceId: 'openai-codex',
      groupId: 'main',
      profileId: 'backup',
      status: 'switched',
      generation: 2,
    }));
    expect(events).toEqual(['recovery-success']);
    expect(restartSession).toHaveBeenCalledOnce();
    expect(restartSession).toHaveBeenCalledWith(expect.objectContaining({
      happySessionId: 'sess_1',
      pid: 123,
    }));
  });

  it('supersedes a scheduler replay whose failing profile is not the profile the live session runs on (stale recovery intent)', async () => {
    // Incident 2026-06-12 (session cmq8y3nlx): a persisted rate-limit recovery intent for a
    // profile the session was NO LONGER running kept replaying through the scheduler. Even with
    // the live restart suppressed, each replay re-ran the full switch pipeline — burning the
    // per-session switch budget and thrashing the shared group generation. A scheduler replay
    // for an inactive profile must be superseded WITHOUT running the switch pipeline at all:
    // the group already moved off the failing profile, so there is nothing left to recover.
    const restartSession = vi.fn(async () => {});
    const continueAfterRuntimeAuthSwitch = vi.fn(async () => {});
    const emitSessionEvent = vi.fn();
    const switchAfterClassifiedFailure = vi.fn(async () => ({
      status: 'switched' as const,
      activeProfileId: 'backup',
      generation: 8,
      mode: 'spawn_next_turn' as const,
    }));

    await expect(handleConnectedServiceRuntimeAuthFailureForSession({
      getChildren: () => [{
        startedBy: 'daemon',
        happySessionId: 'sess_1',
        pid: 123,
        spawnOptions: {
          directory: '/tmp/project',
          environmentVariables: {
            HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON: JSON.stringify([{
              kind: 'group',
              serviceId: 'openai-codex',
              groupId: 'main',
              activeProfileId: 'current',
              fallbackProfileId: 'current',
              generation: 7,
            }]),
          },
        },
      }],
      switchCoordinator: { switchAfterClassifiedFailure },
      restartSession,
      continueAfterRuntimeAuthSwitch,
      emitSessionEvent,
      sessionId: 'sess_1',
      switchesThisTurn: 0,
      recoveryInvocationSource: 'scheduler_retry',
      classification: {
        kind: 'usage_limit',
        serviceId: 'openai-codex',
        profileId: 'stale_member',
        groupId: 'main',
        resetsAtMs: null,
        retryAfterMs: null,
        planType: null,
        rateLimits: null,
        source: 'structured_provider_error',
      },
    })).resolves.toMatchObject({
      status: 'recovery_superseded',
      reason: 'failing_profile_inactive',
      failingProfileId: 'stale_member',
      activeProfileId: 'current',
    });

    expect(switchAfterClassifiedFailure).not.toHaveBeenCalled();
    expect(restartSession).not.toHaveBeenCalled();
    expect(continueAfterRuntimeAuthSwitch).not.toHaveBeenCalled();
    expect(emitSessionEvent).not.toHaveBeenCalled();
  });

  it('does not restart a live session when an in-band report attributes the failure to an inactive profile', async () => {
    // In-band (daemon_report) failures still run the switch pipeline — fresh evidence must
    // commit group bookkeeping — but the live session keeps running: the committed switch
    // applies on the next natural spawn, never via a live restart.
    const restartSession = vi.fn(async () => {});
    const continueAfterRuntimeAuthSwitch = vi.fn(async () => {});
    const switchAfterClassifiedFailure = vi.fn(async () => ({
      status: 'switched' as const,
      activeProfileId: 'backup',
      generation: 8,
      mode: 'spawn_next_turn' as const,
    }));

    await expect(handleConnectedServiceRuntimeAuthFailureForSession({
      getChildren: () => [{
        startedBy: 'daemon',
        happySessionId: 'sess_1',
        pid: 123,
        spawnOptions: {
          directory: '/tmp/project',
          environmentVariables: {
            HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON: JSON.stringify([{
              kind: 'group',
              serviceId: 'openai-codex',
              groupId: 'main',
              activeProfileId: 'current',
              fallbackProfileId: 'current',
              generation: 7,
            }]),
          },
        },
      }],
      switchCoordinator: { switchAfterClassifiedFailure },
      restartSession,
      continueAfterRuntimeAuthSwitch,
      sessionId: 'sess_1',
      switchesThisTurn: 0,
      classification: {
        kind: 'usage_limit',
        serviceId: 'openai-codex',
        profileId: 'stale_member',
        groupId: 'main',
        resetsAtMs: null,
        retryAfterMs: null,
        planType: null,
        rateLimits: null,
        source: 'structured_provider_error',
      },
    })).resolves.toMatchObject({
      status: 'switch_attempted',
      result: { status: 'switched', activeProfileId: 'backup' },
    });

    expect(switchAfterClassifiedFailure).toHaveBeenCalledOnce();
    expect(restartSession).not.toHaveBeenCalled();
    expect(continueAfterRuntimeAuthSwitch).not.toHaveBeenCalled();
  });

  it('still runs the switch pipeline for a scheduler replay when the failing profile IS the live profile', async () => {
    // A session still running the failing profile is genuinely blocked: scheduler replays
    // must keep recovering it (switch + restart), exactly like an in-band report.
    const restartSession = vi.fn(async () => {});
    const switchAfterClassifiedFailure = vi.fn(async () => ({
      status: 'switched' as const,
      activeProfileId: 'backup',
      generation: 8,
      mode: 'spawn_next_turn' as const,
    }));

    await expect(handleConnectedServiceRuntimeAuthFailureForSession({
      getChildren: () => [{
        startedBy: 'daemon',
        happySessionId: 'sess_1',
        pid: 123,
        spawnOptions: {
          directory: '/tmp/project',
          environmentVariables: {
            HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON: JSON.stringify([{
              kind: 'group',
              serviceId: 'openai-codex',
              groupId: 'main',
              activeProfileId: 'current',
              fallbackProfileId: 'current',
              generation: 7,
            }]),
          },
        },
      }],
      switchCoordinator: { switchAfterClassifiedFailure },
      restartSession,
      sessionId: 'sess_1',
      switchesThisTurn: 0,
      recoveryInvocationSource: 'scheduler_retry',
      classification: {
        kind: 'usage_limit',
        serviceId: 'openai-codex',
        profileId: 'current',
        groupId: 'main',
        resetsAtMs: null,
        retryAfterMs: null,
        planType: null,
        rateLimits: null,
        source: 'structured_provider_error',
      },
    })).resolves.toMatchObject({
      status: 'switch_attempted',
      result: { status: 'switched', activeProfileId: 'backup' },
    });

    expect(switchAfterClassifiedFailure).toHaveBeenCalledOnce();
    expect(restartSession).toHaveBeenCalledOnce();
  });

  it('still restarts when the failing profile IS the profile the live session runs on', async () => {
    const restartSession = vi.fn(async () => {});
    const switchAfterClassifiedFailure = vi.fn(async () => ({
      status: 'switched' as const,
      activeProfileId: 'backup',
      generation: 8,
      mode: 'spawn_next_turn' as const,
    }));

    await handleConnectedServiceRuntimeAuthFailureForSession({
      getChildren: () => [{
        startedBy: 'daemon',
        happySessionId: 'sess_1',
        pid: 123,
        spawnOptions: {
          directory: '/tmp/project',
          environmentVariables: {
            HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON: JSON.stringify([{
              kind: 'group',
              serviceId: 'openai-codex',
              groupId: 'main',
              activeProfileId: 'current',
              fallbackProfileId: 'current',
              generation: 7,
            }]),
          },
        },
      }],
      switchCoordinator: { switchAfterClassifiedFailure },
      restartSession,
      sessionId: 'sess_1',
      switchesThisTurn: 0,
      classification: {
        kind: 'usage_limit',
        serviceId: 'openai-codex',
        profileId: 'current',
        groupId: 'main',
        resetsAtMs: null,
        retryAfterMs: null,
        planType: null,
        rateLimits: null,
        source: 'structured_provider_error',
      },
    });

    expect(restartSession).toHaveBeenCalledOnce();
  });

  it('does NOT forward a provider-outcome proof carrier on an unverified group switch (B1 proof gate)', async () => {
    // The reactive recovery-success observer is a LOCAL-substep notification. When
    // the group switch produced no post-switch account-adoption verification, the
    // observer payload must NOT carry `verificationByServiceId`, so the daemon's
    // shared proof gate keeps the recovery provider-outcome-waiting instead of
    // clearing it on a metadata-only switch.
    const onRuntimeAuthRecoverySuccess = vi.fn(async () => {});
    const switchAfterClassifiedFailure = vi.fn(async () => ({
      status: 'switched' as const,
      activeProfileId: 'backup',
      generation: 2,
      mode: 'spawn_next_turn' as const,
    }));

    const input = {
      getChildren: () => [{
        startedBy: 'daemon',
        happySessionId: 'sess_1',
        pid: 123,
        spawnOptions: {
          directory: '/tmp/project',
          connectedServices: {
            v: 1,
            bindingsByServiceId: {
              'openai-codex': {
                source: 'connected',
                selection: 'group',
                profileId: 'primary',
                groupId: 'main',
              },
            },
          },
        },
      }],
      switchCoordinator: { switchAfterClassifiedFailure },
      restartSession: vi.fn(async () => {}),
      onRuntimeAuthRecoverySuccess,
      sessionId: 'sess_1',
      switchesThisTurn: 0,
      classification: {
        kind: 'usage_limit',
        serviceId: 'openai-codex',
        profileId: 'primary',
        groupId: 'main',
        resetsAtMs: null,
        retryAfterMs: null,
        planType: null,
        rateLimits: null,
        source: 'structured_provider_error',
      },
    } satisfies Parameters<typeof handleConnectedServiceRuntimeAuthFailureForSession>[0] & {
      onRuntimeAuthRecoverySuccess: typeof onRuntimeAuthRecoverySuccess;
    };

    await handleConnectedServiceRuntimeAuthFailureForSession(input);

    expect(onRuntimeAuthRecoverySuccess).toHaveBeenCalledOnce();
    expect(onRuntimeAuthRecoverySuccess).toHaveBeenCalledWith(
      expect.not.objectContaining({ verificationByServiceId: expect.anything() }),
    );
  });

  it('forwards the post-switch account-adoption verification to the recovery-success observer (B1 proof gate)', async () => {
    // When the group switch DID verify the adopted account, the observer must carry
    // `verificationByServiceId` so the daemon proof gate can clear recovery.
    const onRuntimeAuthRecoverySuccess = vi.fn(async () => {});
    const switchAfterClassifiedFailure = vi.fn(async () => ({
      status: 'switched' as const,
      activeProfileId: 'backup',
      generation: 2,
      mode: 'spawn_next_turn' as const,
      verificationByServiceId: {
        'openai-codex': { status: 'verified' as const },
      },
    }));

    const input = {
      getChildren: () => [{
        startedBy: 'daemon',
        happySessionId: 'sess_1',
        pid: 123,
        spawnOptions: {
          directory: '/tmp/project',
          connectedServices: {
            v: 1,
            bindingsByServiceId: {
              'openai-codex': {
                source: 'connected',
                selection: 'group',
                profileId: 'primary',
                groupId: 'main',
              },
            },
          },
        },
      }],
      switchCoordinator: { switchAfterClassifiedFailure },
      restartSession: vi.fn(async () => {}),
      onRuntimeAuthRecoverySuccess,
      sessionId: 'sess_1',
      switchesThisTurn: 0,
      classification: {
        kind: 'usage_limit',
        serviceId: 'openai-codex',
        profileId: 'primary',
        groupId: 'main',
        resetsAtMs: null,
        retryAfterMs: null,
        planType: null,
        rateLimits: null,
        source: 'structured_provider_error',
      },
    } satisfies Parameters<typeof handleConnectedServiceRuntimeAuthFailureForSession>[0] & {
      onRuntimeAuthRecoverySuccess: typeof onRuntimeAuthRecoverySuccess;
    };

    await handleConnectedServiceRuntimeAuthFailureForSession(input);

    expect(onRuntimeAuthRecoverySuccess).toHaveBeenCalledWith(expect.objectContaining({
      verificationByServiceId: { 'openai-codex': { status: 'verified' } },
    }));
  });

  it('returns the committed runtime switch result without waiting for a deferred restart to complete', async () => {
    let resolveRestart: () => void = () => {};
    const restartDeferred = new Promise<void>((resolve) => {
      resolveRestart = resolve;
    });
    const restartSession = vi.fn(() => restartDeferred);
    const switchAfterClassifiedFailure = vi.fn(async () => ({
      status: 'switched' as const,
      activeProfileId: 'backup',
      generation: 2,
      mode: 'spawn_next_turn' as const,
    }));

    const resultPromise = handleConnectedServiceRuntimeAuthFailureForSession({
      getChildren: () => [{
        startedBy: 'daemon',
        happySessionId: 'sess_1',
        pid: 123,
        spawnOptions: {
          directory: '/tmp/project',
          connectedServices: {
            v: 1,
            bindingsByServiceId: {
              'openai-codex': {
                source: 'connected',
                selection: 'group',
                profileId: 'primary',
                groupId: 'main',
              },
            },
          },
        },
      }],
      switchCoordinator: { switchAfterClassifiedFailure },
      restartSession,
      sessionId: 'sess_1',
      switchesThisTurn: 0,
      classification: {
        kind: 'usage_limit',
        serviceId: 'openai-codex',
        profileId: 'primary',
        groupId: 'main',
        resetsAtMs: null,
        retryAfterMs: null,
        planType: null,
        rateLimits: null,
        source: 'structured_provider_error',
      },
    });

    const observed = await Promise.race([
      resultPromise.then((result) => ({ status: 'resolved' as const, result })),
      new Promise<Readonly<{ status: 'pending' }>>((resolve) => {
        setTimeout(() => resolve({ status: 'pending' as const }), 10);
      }),
    ]);

    resolveRestart();
    await resultPromise;

    expect(observed).toMatchObject({
      status: 'resolved',
      result: {
        status: 'switch_attempted',
        result: {
          status: 'switched',
          activeProfileId: 'backup',
          generation: 2,
          mode: 'spawn_next_turn',
        },
      },
    });
    expect(restartSession).toHaveBeenCalledOnce();
  });

  it('force-refreshes the active group profile before switching on runtime credential failure', async () => {
    const refreshConnectedServiceCredentialForRuntimeAuthFailure = vi.fn(async () => ({
      status: 'refreshed' as const,
      credential: buildConnectedServiceCredentialRecord({
        now: 1,
        serviceId: 'openai-codex',
        profileId: 'primary',
        kind: 'oauth',
        expiresAt: 3_600_000,
        oauth: {
          accessToken: 'fresh-access',
          refreshToken: 'refresh',
          idToken: null,
          scope: null,
          tokenType: null,
          providerAccountId: 'acct',
          providerEmail: null,
        },
      }),
      diagnostic: {
        serviceId: 'openai-codex' as const,
        profileId: 'primary',
        reason: 'runtime_auth_failure' as const,
        status: 'refreshed' as const,
        expiresAt: 3_600_000,
        expiryAgeMs: -3_599_000,
        refreshWindowMs: 60_000,
      },
    }));
    const restartSession = vi.fn(async () => {});
    const switchAfterClassifiedFailure = vi.fn(async () => ({
      status: 'switched' as const,
      activeProfileId: 'backup',
      generation: 2,
    }));

    await expect(handleConnectedServiceRuntimeAuthFailureForSession({
      getChildren: () => [{
        startedBy: 'daemon',
        happySessionId: 'sess_1',
        pid: 123,
        spawnOptions: {
          directory: '/tmp/project',
          connectedServices: {
            v: 1,
            bindingsByServiceId: {
              'openai-codex': {
                source: 'connected',
                selection: 'group',
                profileId: 'primary',
                groupId: 'main',
              },
            },
          },
        },
      }],
      switchCoordinator: { switchAfterClassifiedFailure },
      credentialRefreshService: {
        refreshConnectedServiceCredentialForRuntimeAuthFailure,
      },
      restartSession,
      sessionId: 'sess_1',
      switchesThisTurn: 0,
      classification: {
        kind: 'auth_expired',
        limitCategory: 'auth_invalid',
        serviceId: 'openai-codex',
        profileId: 'primary',
        groupId: 'main',
        resetsAtMs: null,
        planType: null,
        rateLimits: null,
        source: 'structured_provider_error',
      },
    })).resolves.toMatchObject({
      status: 'credential_refreshed',
      restartRequested: false,
    });

    expect(refreshConnectedServiceCredentialForRuntimeAuthFailure).toHaveBeenCalledWith({
      serviceId: 'openai-codex',
      profileId: 'primary',
      sessionId: 'sess_1',
    });
    expect(restartSession).not.toHaveBeenCalled();
    expect(switchAfterClassifiedFailure).not.toHaveBeenCalled();
  });

  it('returns credential-refreshed runtime recovery without requesting a restart', async () => {
    const refreshConnectedServiceCredentialForRuntimeAuthFailure = vi.fn(async () => ({
      status: 'refreshed' as const,
      credential: buildConnectedServiceCredentialRecord({
        now: 1,
        serviceId: 'openai-codex',
        profileId: 'primary',
        kind: 'oauth',
        expiresAt: 3_600_000,
        oauth: {
          accessToken: 'fresh-access',
          refreshToken: 'refresh',
          idToken: null,
          scope: null,
          tokenType: null,
          providerAccountId: 'acct',
          providerEmail: null,
        },
      }),
      diagnostic: {
        serviceId: 'openai-codex' as const,
        profileId: 'primary',
        reason: 'runtime_auth_failure' as const,
        status: 'refreshed' as const,
        expiresAt: 3_600_000,
        expiryAgeMs: -3_599_000,
        refreshWindowMs: 60_000,
      },
    }));
    const restartSession = vi.fn(async () => {});

    const resultPromise = handleConnectedServiceRuntimeAuthFailureForSession({
      getChildren: () => [{
        startedBy: 'daemon',
        happySessionId: 'sess_1',
        pid: 123,
        spawnOptions: {
          directory: '/tmp/project',
          connectedServices: {
            v: 1,
            bindingsByServiceId: {
              'openai-codex': {
                source: 'connected',
                selection: 'group',
                profileId: 'primary',
                groupId: 'main',
              },
            },
          },
        },
      }],
      switchCoordinator: { switchAfterClassifiedFailure: vi.fn() },
      credentialRefreshService: {
        refreshConnectedServiceCredentialForRuntimeAuthFailure,
      },
      restartSession,
      sessionId: 'sess_1',
      switchesThisTurn: 0,
      classification: {
        kind: 'auth_expired',
        limitCategory: 'auth_invalid',
        serviceId: 'openai-codex',
        profileId: 'primary',
        groupId: 'main',
        resetsAtMs: null,
        planType: null,
        rateLimits: null,
        source: 'structured_provider_error',
      },
    });

    const observed = await Promise.race([
      resultPromise.then((result) => ({ status: 'resolved' as const, result })),
      new Promise<Readonly<{ status: 'pending' }>>((resolve) => {
        setTimeout(() => resolve({ status: 'pending' as const }), 10);
      }),
    ]);

    await resultPromise;

    expect(observed).toMatchObject({
      status: 'resolved',
      result: {
        status: 'credential_refreshed',
        restartRequested: false,
      },
    });
    expect(restartSession).not.toHaveBeenCalled();
  });

  it('requests one relaunch after credential refresh when the failing runner already exited', async () => {
    const refreshConnectedServiceCredentialForRuntimeAuthFailure = vi.fn(async () => ({
      status: 'refreshed' as const,
      credential: buildConnectedServiceCredentialRecord({
        now: 1,
        serviceId: 'openai-codex',
        profileId: 'primary',
        kind: 'oauth',
        expiresAt: 3_600_000,
        oauth: {
          accessToken: 'fresh-access',
          refreshToken: 'refresh',
          idToken: null,
          scope: null,
          tokenType: null,
          providerAccountId: 'acct',
          providerEmail: null,
        },
      }),
      diagnostic: {
        serviceId: 'openai-codex' as const,
        profileId: 'primary',
        reason: 'runtime_auth_failure' as const,
        status: 'refreshed' as const,
        expiresAt: 3_600_000,
        expiryAgeMs: -3_599_000,
        refreshWindowMs: 60_000,
      },
    }));
    const restartSession = vi.fn(async () => {});
    const continueAfterRuntimeAuthSwitch = vi.fn(async () => {});
    const exitedChildProcess = {
      exitCode: 1,
      signalCode: null,
    } as TrackedSession['childProcess'];
    const tracked: TrackedSession = {
      startedBy: 'daemon',
      happySessionId: 'sess_1',
      pid: 123,
      childProcess: exitedChildProcess,
      spawnOptions: {
        directory: '/tmp/project',
        connectedServices: {
          v: 1,
          bindingsByServiceId: {
            'openai-codex': {
              source: 'connected',
              selection: 'group',
              profileId: 'primary',
              groupId: 'main',
            },
          },
        },
      },
    };

    await expect(handleConnectedServiceRuntimeAuthFailureForSession({
      getChildren: () => [tracked],
      switchCoordinator: { switchAfterClassifiedFailure: vi.fn() },
      credentialRefreshService: {
        refreshConnectedServiceCredentialForRuntimeAuthFailure,
      },
      continueAfterRuntimeAuthSwitch,
      restartSession,
      sessionId: 'sess_1',
      switchesThisTurn: 0,
      classification: {
        kind: 'auth_expired',
        limitCategory: 'auth_invalid',
        serviceId: 'openai-codex',
        profileId: 'primary',
        groupId: 'main',
        resetsAtMs: null,
        planType: null,
        rateLimits: null,
        source: 'structured_provider_error',
      },
    })).resolves.toMatchObject({
      status: 'credential_refreshed',
      restartRequested: true,
    });

    expect(restartSession).toHaveBeenCalledWith(tracked);
    expect(continueAfterRuntimeAuthSwitch).not.toHaveBeenCalled();
  });

  it('continues after credential refresh without requesting restart', async () => {
    const events: string[] = [];
    const refreshConnectedServiceCredentialForRuntimeAuthFailure = vi.fn(async () => ({
      status: 'refreshed' as const,
      credential: buildConnectedServiceCredentialRecord({
        now: 1,
        serviceId: 'openai-codex',
        profileId: 'primary',
        kind: 'oauth',
        expiresAt: 3_600_000,
        oauth: {
          accessToken: 'fresh-access',
          refreshToken: 'refresh',
          idToken: null,
          scope: null,
          tokenType: null,
          providerAccountId: 'acct',
          providerEmail: null,
        },
      }),
      diagnostic: {
        serviceId: 'openai-codex' as const,
        profileId: 'primary',
        reason: 'runtime_auth_failure' as const,
        status: 'refreshed' as const,
        expiresAt: 3_600_000,
        expiryAgeMs: -3_599_000,
        refreshWindowMs: 60_000,
      },
    }));
    const continueAfterRuntimeAuthSwitch = vi.fn(async () => {
      events.push('continue');
    });
    const restartSession = vi.fn(() => {
      events.push('restart');
    });

    await expect(handleConnectedServiceRuntimeAuthFailureForSession({
      getChildren: () => [{
        startedBy: 'daemon',
        happySessionId: 'sess_1',
        pid: 123,
        spawnOptions: {
          directory: '/tmp/project',
          connectedServices: {
            v: 1,
            bindingsByServiceId: {
              'openai-codex': {
                source: 'connected',
                selection: 'group',
                profileId: 'primary',
                groupId: 'main',
              },
            },
          },
        },
      }],
      switchCoordinator: { switchAfterClassifiedFailure: vi.fn() },
      credentialRefreshService: {
        refreshConnectedServiceCredentialForRuntimeAuthFailure,
      },
      continueAfterRuntimeAuthSwitch,
      restartSession,
      sessionId: 'sess_1',
      switchesThisTurn: 0,
      classification: {
        kind: 'auth_expired',
        limitCategory: 'auth_invalid',
        serviceId: 'openai-codex',
        profileId: 'primary',
        groupId: 'main',
        resetsAtMs: null,
        planType: null,
        rateLimits: null,
        source: 'structured_provider_error',
      },
    })).resolves.toMatchObject({
      status: 'credential_refreshed',
      restartRequested: false,
    });

    expect(continueAfterRuntimeAuthSwitch).toHaveBeenCalledWith({
      tracked: expect.objectContaining({ happySessionId: 'sess_1' }),
      sessionId: 'sess_1',
      attemptId: 'connected-service-auth-switch|hot_applied|openai-codex:group:main:primary:',
      normalizedBindings: {
        v: 1,
        bindingsByServiceId: {
          'openai-codex': {
            source: 'connected',
            selection: 'group',
            groupId: 'main',
            profileId: 'primary',
          },
        },
      },
      serviceIds: new Set(['openai-codex']),
      action: 'hot_applied',
      switchReason: 'automatic_runtime_failure',
    });
    expect(events).toEqual(['continue']);
    expect(restartSession).not.toHaveBeenCalled();
  });

  it('passes the failing session id into runtime credential refresh so active-home materialization failures are session-scoped', async () => {
    const refreshConnectedServiceCredentialForRuntimeAuthFailure = vi.fn(async () => ({
      status: 'refresh_failed' as const,
      credential: null,
      diagnostic: {
        serviceId: 'openai-codex' as const,
        profileId: 'primary',
        reason: 'runtime_auth_failure' as const,
        status: 'refresh_failed' as const,
        category: 'provider_403' as const,
        providerStatus: 403,
        providerErrorCode: 'materialization_failed',
        expiresAt: 999,
        expiryAgeMs: 1,
        refreshWindowMs: 60_000,
      },
    }));
    const continueAfterRuntimeAuthSwitch = vi.fn(async () => {});
    const switchAfterClassifiedFailure = vi.fn(async () => ({
      status: 'no_eligible_member' as const,
      generation: 1,
      groupExhausted: true as const,
      retryAtMs: null,
      excluded: [],
    }));

    await expect(handleConnectedServiceRuntimeAuthFailureForSession({
      getChildren: () => [{
        startedBy: 'daemon',
        happySessionId: 'sess_1',
        pid: 123,
        spawnOptions: {
          directory: '/tmp/project',
          connectedServices: {
            v: 1,
            bindingsByServiceId: {
              'openai-codex': {
                source: 'connected',
                selection: 'group',
                profileId: 'primary',
                groupId: 'main',
              },
            },
          },
        },
      }],
      switchCoordinator: { switchAfterClassifiedFailure },
      credentialRefreshService: {
        refreshConnectedServiceCredentialForRuntimeAuthFailure,
      },
      continueAfterRuntimeAuthSwitch,
      sessionId: 'sess_1',
      switchesThisTurn: 0,
      classification: {
        kind: 'auth_expired',
        limitCategory: 'auth_invalid',
        serviceId: 'openai-codex',
        profileId: 'primary',
        groupId: 'main',
        resetsAtMs: null,
        planType: null,
        rateLimits: null,
        source: 'structured_provider_error',
      },
    })).resolves.toMatchObject({
      status: 'recovery_action_required',
      action: {
        kind: 'connected_service_required',
        serviceId: 'openai-codex',
        profileId: 'primary',
        groupId: 'main',
        reason: 'auth_expired',
      },
    });

    expect(refreshConnectedServiceCredentialForRuntimeAuthFailure).toHaveBeenCalledWith({
      serviceId: 'openai-codex',
      profileId: 'primary',
      sessionId: 'sess_1',
    });
    expect(continueAfterRuntimeAuthSwitch).not.toHaveBeenCalled();
  });

  it('serializes runtime forced refresh through the session auth-switch core', async () => {
    const events: string[] = [];
    const coreRuns: Array<Readonly<{ sessionId: string; reason: string }>> = [];
    const switchCore: ConnectedServiceSessionAuthSwitchCore = {
      async run<T>(params: Readonly<{
        sessionId: string;
        reason: ConnectedServiceSessionAuthSwitchReason;
        execute: () => Promise<T>;
      }>): Promise<T> {
        coreRuns.push({ sessionId: params.sessionId, reason: params.reason });
        events.push('core:start');
        const result = await params.execute();
        events.push('core:end');
        return result;
      },
      clearSession: vi.fn(),
    };
    const refreshConnectedServiceCredentialForRuntimeAuthFailure = vi.fn(async () => {
      events.push('refresh');
      expect(events).toEqual(['core:start', 'refresh']);
      return {
        status: 'refreshed' as const,
        credential: buildConnectedServiceCredentialRecord({
          now: 1,
          serviceId: 'openai-codex',
          profileId: 'primary',
          kind: 'oauth',
          expiresAt: 3_600_000,
          oauth: {
            accessToken: 'fresh-access',
            refreshToken: 'refresh',
            idToken: null,
            scope: null,
            tokenType: null,
            providerAccountId: 'acct',
            providerEmail: null,
          },
        }),
        diagnostic: {
          serviceId: 'openai-codex' as const,
          profileId: 'primary',
          reason: 'runtime_auth_failure' as const,
          status: 'refreshed' as const,
          expiresAt: 3_600_000,
          expiryAgeMs: -3_599_000,
          refreshWindowMs: 60_000,
        },
      };
    });
    const restartSession = vi.fn(async () => {
      events.push('restart');
    });

    await expect(handleConnectedServiceRuntimeAuthFailureForSession({
      getChildren: () => [{
        startedBy: 'daemon',
        happySessionId: 'sess_1',
        pid: 123,
        spawnOptions: {
          directory: '/tmp/project',
          connectedServices: {
            v: 1,
            bindingsByServiceId: {
              'openai-codex': {
                source: 'connected',
                selection: 'group',
                profileId: 'primary',
                groupId: 'main',
              },
            },
          },
        },
      }],
      switchCoordinator: { switchAfterClassifiedFailure: vi.fn() },
      switchCore,
      credentialRefreshService: {
        refreshConnectedServiceCredentialForRuntimeAuthFailure,
      },
      restartSession,
      sessionId: 'sess_1',
      switchesThisTurn: 0,
      classification: {
        kind: 'auth_expired',
        limitCategory: 'auth_invalid',
        serviceId: 'openai-codex',
        profileId: 'primary',
        groupId: 'main',
        resetsAtMs: null,
        planType: null,
        rateLimits: null,
        source: 'structured_provider_error',
      },
    })).resolves.toMatchObject({
      status: 'credential_refreshed',
      restartRequested: false,
    });

    expect(coreRuns).toEqual([{
      sessionId: 'sess_1',
      reason: 'automatic_runtime_failure',
    }]);
    expect(events).toEqual(['core:start', 'refresh', 'core:end']);
    expect(restartSession).not.toHaveBeenCalled();
  });

  it('does not force-refresh the same active profile twice in the failure window', async () => {
    const switchAttemptTracker = new ConnectedServiceRuntimeAuthSwitchAttemptTracker({
      nowMs: () => 1_000,
      windowMs: 60_000,
    });
    const refreshConnectedServiceCredentialForRuntimeAuthFailure = vi.fn(async () => ({
      status: 'refresh_failed' as const,
      credential: null,
      diagnostic: {
        serviceId: 'openai-codex' as const,
        profileId: 'primary',
        reason: 'runtime_auth_failure' as const,
        status: 'refresh_failed' as const,
        category: 'invalid_grant' as const,
        expiresAt: 999,
        expiryAgeMs: 1,
        refreshWindowMs: 60_000,
      },
    }));
    const switchAfterClassifiedFailure = vi.fn(async () => ({
      status: 'no_eligible_member' as const,
      generation: 1,
      groupExhausted: true as const,
      retryAtMs: null,
      excluded: [],
    }));
    const trackedSession = {
      startedBy: 'daemon' as const,
      happySessionId: 'sess_1',
      pid: 123,
      spawnOptions: {
        directory: '/tmp/project',
        connectedServices: {
          v: 1 as const,
          bindingsByServiceId: {
            'openai-codex': {
              source: 'connected' as const,
              selection: 'group' as const,
              profileId: 'primary',
              groupId: 'main',
            },
          },
        },
      },
    };
    const classification = {
      kind: 'auth_expired' as const,
      limitCategory: 'auth_invalid' as const,
      serviceId: 'openai-codex',
      profileId: 'primary',
      groupId: 'main',
      resetsAtMs: null,
      planType: null,
      rateLimits: null,
      source: 'structured_provider_error' as const,
    };

    await handleConnectedServiceRuntimeAuthFailureForSession({
      getChildren: () => [trackedSession],
      switchCoordinator: { switchAfterClassifiedFailure },
      switchAttemptTracker,
      credentialRefreshService: {
        refreshConnectedServiceCredentialForRuntimeAuthFailure,
      },
      sessionId: 'sess_1',
      switchesThisTurn: 0,
      classification,
    });
    await handleConnectedServiceRuntimeAuthFailureForSession({
      getChildren: () => [trackedSession],
      switchCoordinator: { switchAfterClassifiedFailure },
      switchAttemptTracker,
      credentialRefreshService: {
        refreshConnectedServiceCredentialForRuntimeAuthFailure,
      },
      sessionId: 'sess_1',
      switchesThisTurn: 0,
      classification,
    });

    expect(refreshConnectedServiceCredentialForRuntimeAuthFailure).toHaveBeenCalledTimes(1);
    expect(switchAfterClassifiedFailure).not.toHaveBeenCalled();
  });

  it('terminalizes a repeated auth failure for a direct profile after a forced credential refresh', async () => {
    const switchAttemptTracker = new ConnectedServiceRuntimeAuthSwitchAttemptTracker({
      nowMs: () => 1_000,
      windowMs: 60_000,
    });
    const refreshConnectedServiceCredentialForRuntimeAuthFailure = vi.fn(async () => ({
      status: 'refreshed' as const,
      credential: buildConnectedServiceCredentialRecord({
        now: 1,
        serviceId: 'openai-codex',
        profileId: 'primary',
        kind: 'oauth',
        expiresAt: 3_600_000,
        oauth: {
          accessToken: 'fresh-access',
          refreshToken: 'refresh',
          idToken: null,
          scope: null,
          tokenType: null,
          providerAccountId: 'acct',
          providerEmail: null,
        },
      }),
      diagnostic: {
        serviceId: 'openai-codex' as const,
        profileId: 'primary',
        reason: 'runtime_auth_failure' as const,
        status: 'refreshed' as const,
        expiresAt: 3_600_000,
        expiryAgeMs: -3_599_000,
        refreshWindowMs: 60_000,
      },
    }));
    const restartSession = vi.fn();
    const switchAfterClassifiedFailure = vi.fn(async () => ({
      status: 'switched' as const,
      activeProfileId: 'backup',
      generation: 2,
    }));
    const trackedSession = {
      startedBy: 'daemon' as const,
      happySessionId: 'sess_1',
      pid: 123,
      spawnOptions: {
        directory: '/tmp/project',
        connectedServices: {
          v: 1 as const,
          bindingsByServiceId: {
            'openai-codex': {
              source: 'connected' as const,
              selection: 'profile' as const,
              profileId: 'primary',
            },
          },
        },
      },
    };
    const classification = {
      kind: 'auth_expired' as const,
      limitCategory: 'auth_invalid' as const,
      serviceId: 'openai-codex',
      profileId: 'primary',
      groupId: null,
      resetsAtMs: null,
      planType: null,
      rateLimits: null,
      source: 'structured_provider_error' as const,
    };

    await expect(handleConnectedServiceRuntimeAuthFailureForSession({
      getChildren: () => [trackedSession],
      switchCoordinator: { switchAfterClassifiedFailure },
      switchAttemptTracker,
      credentialRefreshService: {
        refreshConnectedServiceCredentialForRuntimeAuthFailure,
      },
      restartSession,
      sessionId: 'sess_1',
      switchesThisTurn: 0,
      classification,
    })).resolves.toMatchObject({
      status: 'credential_refreshed',
      restartRequested: false,
    });

    await expect(handleConnectedServiceRuntimeAuthFailureForSession({
      getChildren: () => [trackedSession],
      switchCoordinator: { switchAfterClassifiedFailure },
      switchAttemptTracker,
      credentialRefreshService: {
        refreshConnectedServiceCredentialForRuntimeAuthFailure,
      },
      restartSession,
      sessionId: 'sess_1',
      switchesThisTurn: 0,
      classification,
    })).resolves.toEqual({
      status: 'recovery_action_required',
      action: {
        kind: 'reconnect_profile',
        serviceId: 'openai-codex',
        profileId: 'primary',
        groupId: null,
        reason: 'auth_expired',
      },
    });

    expect(refreshConnectedServiceCredentialForRuntimeAuthFailure).toHaveBeenCalledTimes(1);
    expect(restartSession).not.toHaveBeenCalled();
    expect(switchAfterClassifiedFailure).not.toHaveBeenCalled();
  });

  it('does not terminalize a scheduler retry of the same direct-profile auth report while refreshed credentials await provider proof', async () => {
    const switchAttemptTracker = new ConnectedServiceRuntimeAuthSwitchAttemptTracker({
      nowMs: () => 1_000,
      windowMs: 60_000,
    });
    const refreshConnectedServiceCredentialForRuntimeAuthFailure = vi.fn(async () => ({
      status: 'refreshed' as const,
      credential: buildConnectedServiceCredentialRecord({
        now: 1,
        serviceId: 'openai-codex',
        profileId: 'primary',
        kind: 'oauth',
        expiresAt: 3_600_000,
        oauth: {
          accessToken: 'fresh-access',
          refreshToken: 'refresh',
          idToken: null,
          scope: null,
          tokenType: null,
          providerAccountId: 'acct',
          providerEmail: null,
        },
      }),
      diagnostic: {
        serviceId: 'openai-codex' as const,
        profileId: 'primary',
        reason: 'runtime_auth_failure' as const,
        status: 'refreshed' as const,
        expiresAt: 3_600_000,
        expiryAgeMs: -3_599_000,
        refreshWindowMs: 60_000,
      },
    }));
    const restartSession = vi.fn();
    const switchAfterClassifiedFailure = vi.fn(async () => ({
      status: 'switched' as const,
      activeProfileId: 'backup',
      generation: 2,
    }));
    const trackedSession = {
      startedBy: 'daemon' as const,
      happySessionId: 'sess_1',
      pid: 123,
      spawnOptions: {
        directory: '/tmp/project',
        connectedServices: {
          v: 1 as const,
          bindingsByServiceId: {
            'openai-codex': {
              source: 'connected' as const,
              selection: 'profile' as const,
              profileId: 'primary',
            },
          },
        },
      },
    };
    const classification = {
      kind: 'auth_expired' as const,
      limitCategory: 'auth_invalid' as const,
      serviceId: 'openai-codex',
      profileId: 'primary',
      groupId: null,
      resetsAtMs: null,
      planType: null,
      rateLimits: null,
      source: 'structured_provider_error' as const,
    };
    const baseInput = {
      getChildren: () => [trackedSession],
      switchCoordinator: { switchAfterClassifiedFailure },
      switchAttemptTracker,
      credentialRefreshService: {
        refreshConnectedServiceCredentialForRuntimeAuthFailure,
      },
      restartSession,
      sessionId: 'sess_1',
      switchesThisTurn: 0,
      classification,
    };

    await expect(handleConnectedServiceRuntimeAuthFailureForSession(baseInput))
      .resolves.toMatchObject({
        status: 'credential_refreshed',
        restartRequested: false,
      });

    await expect(handleConnectedServiceRuntimeAuthFailureForSession({
      ...baseInput,
      recoveryInvocationSource: 'scheduler_retry',
    })).resolves.toEqual({
      status: 'credential_refreshed',
      restartRequested: false,
      pendingProviderOutcome: true,
    });

    await expect(handleConnectedServiceRuntimeAuthFailureForSession(baseInput))
      .resolves.toMatchObject({
        status: 'recovery_action_required',
        action: {
          kind: 'reconnect_profile',
          profileId: 'primary',
          groupId: null,
        },
      });

    expect(refreshConnectedServiceCredentialForRuntimeAuthFailure).toHaveBeenCalledTimes(1);
    expect(restartSession).not.toHaveBeenCalled();
    expect(switchAfterClassifiedFailure).not.toHaveBeenCalled();
  });

  it('does not switch a group selection after a repeated post-refresh auth failure while provider proof is unresolved', async () => {
    const switchAttemptTracker = new ConnectedServiceRuntimeAuthSwitchAttemptTracker({
      nowMs: () => 1_000,
      windowMs: 60_000,
    });
    const refreshConnectedServiceCredentialForRuntimeAuthFailure = vi.fn(async () => ({
      status: 'refreshed' as const,
      credential: buildConnectedServiceCredentialRecord({
        now: 1,
        serviceId: 'claude-subscription',
        profileId: 'broken-member',
        kind: 'oauth',
        expiresAt: 3_600_000,
        oauth: {
          accessToken: 'fresh-access',
          refreshToken: 'refresh',
          idToken: null,
          scope: null,
          tokenType: null,
          providerAccountId: 'acct',
          providerEmail: null,
        },
      }),
      diagnostic: {
        serviceId: 'claude-subscription' as const,
        profileId: 'broken-member',
        reason: 'runtime_auth_failure' as const,
        status: 'refreshed' as const,
        expiresAt: 3_600_000,
        expiryAgeMs: -3_599_000,
        refreshWindowMs: 60_000,
      },
    }));
    const switchAfterClassifiedFailure = vi.fn(async () => ({
      status: 'switched' as const,
      activeProfileId: 'healthy-member',
      generation: 2,
    }));
    const restartSession = vi.fn();
    const trackedSession = {
      startedBy: 'daemon' as const,
      happySessionId: 'sess_1',
      pid: 123,
      spawnOptions: {
        directory: '/tmp/project',
        connectedServices: {
          v: 1 as const,
          bindingsByServiceId: {
            'claude-subscription': {
              source: 'connected' as const,
              selection: 'group' as const,
              profileId: 'broken-member',
              groupId: 'claude',
            },
          },
        },
      },
    };
    const classification = {
      kind: 'auth_expired' as const,
      limitCategory: 'auth_invalid' as const,
      serviceId: 'claude-subscription',
      profileId: 'broken-member',
      groupId: 'claude',
      resetsAtMs: null,
      planType: null,
      rateLimits: null,
      source: 'structured_provider_error' as const,
    };
    const baseInput = {
      getChildren: () => [trackedSession],
      switchCoordinator: { switchAfterClassifiedFailure },
      switchAttemptTracker,
      credentialRefreshService: {
        refreshConnectedServiceCredentialForRuntimeAuthFailure,
      },
      restartSession,
      sessionId: 'sess_1',
      switchesThisTurn: 0,
      classification,
    };

    await expect(handleConnectedServiceRuntimeAuthFailureForSession(baseInput))
      .resolves.toMatchObject({
        status: 'credential_refreshed',
        restartRequested: false,
      });

    await expect(handleConnectedServiceRuntimeAuthFailureForSession(baseInput))
      .resolves.toMatchObject({
        status: 'recovery_action_required',
        action: {
          kind: 'reconnect_profile',
          serviceId: 'claude-subscription',
          profileId: 'broken-member',
          groupId: 'claude',
          reason: 'auth_expired',
        },
      });

    expect(refreshConnectedServiceCredentialForRuntimeAuthFailure).toHaveBeenCalledTimes(1);
    expect(switchAfterClassifiedFailure).not.toHaveBeenCalled();
  });

  it('re-resolves account_changed reports without refreshing the stale account or switching the group', async () => {
    const refreshConnectedServiceCredentialForRuntimeAuthFailure = vi.fn();
    const switchAfterClassifiedFailure = vi.fn(async () => ({
      status: 'switched' as const,
      activeProfileId: 'backup',
      generation: 2,
    }));

    await expect(handleConnectedServiceRuntimeAuthFailureForSession({
      getChildren: () => [{
        startedBy: 'daemon',
        happySessionId: 'sess_1',
        pid: 123,
        spawnOptions: {
          directory: '/tmp/project',
          connectedServices: {
            v: 1,
            bindingsByServiceId: {
              'claude-subscription': {
                source: 'connected',
                selection: 'group',
                profileId: 'old-member',
                groupId: 'claude',
              },
            },
          },
        },
      }],
      switchCoordinator: { switchAfterClassifiedFailure },
      credentialRefreshService: {
        refreshConnectedServiceCredentialForRuntimeAuthFailure,
      },
      sessionId: 'sess_1',
      switchesThisTurn: 0,
      classification: {
        kind: 'account_changed',
        limitCategory: 'auth_invalid',
        serviceId: 'claude-subscription',
        profileId: 'old-member',
        groupId: 'claude',
        resetsAtMs: null,
        planType: null,
        rateLimits: null,
        source: 'structured_provider_error',
      },
    })).resolves.toEqual({
      status: 'recovery_action_required',
      action: {
        kind: 're_resolve_binding',
        serviceId: 'claude-subscription',
        profileId: 'old-member',
        groupId: 'claude',
        reason: 'account_changed',
      },
    });

    expect(refreshConnectedServiceCredentialForRuntimeAuthFailure).not.toHaveBeenCalled();
    expect(switchAfterClassifiedFailure).not.toHaveBeenCalled();
  });

  it('terminalizes a repeated group auth failure after forced refresh when the active and fallback profile are the same member', async () => {
    const switchAttemptTracker = new ConnectedServiceRuntimeAuthSwitchAttemptTracker({
      nowMs: () => 1_000,
      windowMs: 60_000,
    });
    const refreshConnectedServiceCredentialForRuntimeAuthFailure = vi.fn(async () => ({
      status: 'refreshed' as const,
      credential: buildConnectedServiceCredentialRecord({
        now: 1,
        serviceId: 'claude-subscription',
        profileId: 'primary',
        kind: 'oauth',
        expiresAt: 3_600_000,
        oauth: {
          accessToken: 'fresh-access',
          refreshToken: 'refresh',
          idToken: null,
          scope: null,
          tokenType: null,
          providerAccountId: 'acct',
          providerEmail: null,
        },
      }),
      diagnostic: {
        serviceId: 'claude-subscription' as const,
        profileId: 'primary',
        reason: 'runtime_auth_failure' as const,
        status: 'refreshed' as const,
        expiresAt: 3_600_000,
        expiryAgeMs: -3_599_000,
        refreshWindowMs: 60_000,
      },
    }));
    const switchAfterClassifiedFailure = vi.fn(async () => ({
      status: 'switched' as const,
      activeProfileId: 'backup',
      generation: 2,
    }));
    const restartSession = vi.fn();
    const trackedSession = {
      startedBy: 'daemon' as const,
      happySessionId: 'sess_1',
      pid: 123,
      spawnOptions: {
        directory: '/tmp/project',
        connectedServices: {
          v: 1 as const,
          bindingsByServiceId: {
            'claude-subscription': {
              source: 'connected' as const,
              selection: 'group' as const,
              profileId: 'primary',
              groupId: 'claude',
            },
          },
        },
        environmentVariables: {
          HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON: JSON.stringify([{
            kind: 'group',
            serviceId: 'claude-subscription',
            groupId: 'claude',
            activeProfileId: 'primary',
            fallbackProfileId: 'primary',
            generation: 0,
          }]),
        },
      },
    };
    const classification = {
      kind: 'auth_expired' as const,
      limitCategory: 'auth_invalid' as const,
      serviceId: 'claude-subscription',
      profileId: 'primary',
      groupId: 'claude',
      resetsAtMs: null,
      planType: null,
      rateLimits: null,
      source: 'structured_provider_error' as const,
    };
    const baseInput = {
      getChildren: () => [trackedSession],
      switchCoordinator: { switchAfterClassifiedFailure },
      switchAttemptTracker,
      credentialRefreshService: {
        refreshConnectedServiceCredentialForRuntimeAuthFailure,
      },
      restartSession,
      sessionId: 'sess_1',
      switchesThisTurn: 0,
      classification,
    };

    await expect(handleConnectedServiceRuntimeAuthFailureForSession(baseInput))
      .resolves.toMatchObject({
        status: 'credential_refreshed',
        restartRequested: false,
      });

    await expect(handleConnectedServiceRuntimeAuthFailureForSession(baseInput))
      .resolves.toEqual({
        status: 'recovery_action_required',
        action: {
          kind: 'reconnect_profile',
          serviceId: 'claude-subscription',
          profileId: 'primary',
          groupId: 'claude',
          reason: 'auth_expired',
        },
      });

    expect(refreshConnectedServiceCredentialForRuntimeAuthFailure).toHaveBeenCalledTimes(1);
    expect(restartSession).not.toHaveBeenCalled();
    expect(switchAfterClassifiedFailure).not.toHaveBeenCalled();
  });

  it('routes tracked group session failures into the switch coordinator with the tracked group id', async () => {
    const switchAfterClassifiedFailure = vi.fn(async () => ({
      status: 'switched' as const,
      activeProfileId: 'backup',
      generation: 2,
    }));
    const emitSessionEvent = vi.fn();

    await expect(handleConnectedServiceRuntimeAuthFailureForSession({
      getChildren: () => [{
        startedBy: 'daemon',
        happySessionId: 'sess_1',
        pid: 123,
        spawnOptions: {
          directory: '/tmp/project',
          connectedServices: {
            v: 1,
            bindingsByServiceId: {
              'openai-codex': {
                source: 'connected',
                selection: 'group',
                profileId: 'primary',
                groupId: 'main',
              },
            },
          },
        },
      }],
      switchCoordinator: { switchAfterClassifiedFailure },
      emitSessionEvent,
      sessionId: 'sess_1',
      switchesThisTurn: 0,
      classification: {
        kind: 'usage_limit',
        limitCategory: 'usage_limit',
        serviceId: 'openai-codex',
        profileId: null,
        groupId: null,
        resetsAtMs: null,
        retryAfterMs: 30_000,
        quotaScope: 'account',
        providerLimitId: 'weekly',
        action: { kind: 'open_url', url: 'https://chatgpt.com/codex/settings/usage' },
        planType: null,
        rateLimits: null,
        source: 'structured_provider_error',
      },
    })).resolves.toEqual({
      status: 'switch_attempted',
      result: {
        status: 'switched',
        activeProfileId: 'backup',
        generation: 2,
      },
    });

    expect(switchAfterClassifiedFailure).toHaveBeenCalledWith({
      sessionId: 'sess_1',
      serviceId: 'openai-codex',
      groupId: 'main',
      reason: 'usage_limit',
      observedProfileId: 'primary',
      retryAfterMs: 30_000,
      resetsAtMs: null,
      limitCategory: 'usage_limit',
      quotaScope: 'account',
      providerLimitId: 'weekly',
      action: { kind: 'open_url', url: 'https://chatgpt.com/codex/settings/usage' },
      planType: null,
      switchesThisTurn: 0,
    });
    expect(emitSessionEvent).not.toHaveBeenCalled();
  });

  it('uses durable session metadata binding when runtime report and tracked spawn options lost group identity', async () => {
    const switchAfterClassifiedFailure = vi.fn(async () => ({
      status: 'switched' as const,
      activeProfileId: 'backup',
      generation: 2,
    }));

    await expect(handleConnectedServiceRuntimeAuthFailureForSession({
      getChildren: () => [{
        startedBy: 'daemon',
        happySessionId: 'sess_1',
        pid: 123,
        happySessionMetadataFromLocalWebhook: {
          path: '/tmp/project',
          homeDir: '/tmp/home',
          happyHomeDir: '/tmp/home/.happier',
          happyLibDir: '/tmp/home/.happier/lib',
          happyToolsDir: '/tmp/home/.happier/tools',
          host: 'test-host',
          connectedServices: {
            v: 1,
            bindingsByServiceId: {
              'openai-codex': {
                source: 'connected',
                selection: 'group',
                profileId: 'primary',
                groupId: 'main',
              },
            },
          },
        },
        spawnOptions: {
          directory: '/tmp/project',
        },
      }],
      switchCoordinator: { switchAfterClassifiedFailure },
      sessionId: 'sess_1',
      switchesThisTurn: 0,
      classification: {
        kind: 'usage_limit',
        limitCategory: 'usage_limit',
        serviceId: 'openai-codex',
        profileId: null,
        groupId: null,
        resetsAtMs: null,
        retryAfterMs: 30_000,
        quotaScope: 'account',
        providerLimitId: 'weekly',
        action: null,
        planType: null,
        rateLimits: null,
        source: 'structured_provider_error',
      },
    })).resolves.toMatchObject({
      status: 'switch_attempted',
      result: {
        status: 'switched',
        activeProfileId: 'backup',
        generation: 2,
      },
    });

    expect(switchAfterClassifiedFailure).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'sess_1',
      serviceId: 'openai-codex',
      groupId: 'main',
      reason: 'usage_limit',
      observedProfileId: 'primary',
      switchesThisTurn: 0,
    }));
  });

  it('arms daemon-lifetime temporary-throttle recovery without switching accounts', async () => {
    const switchAfterClassifiedFailure = vi.fn(async () => ({
      status: 'switched' as const,
      activeProfileId: 'backup',
      generation: 2,
    }));
    const enable = vi.fn(async () => ({
      status: 'waiting' as const,
      nextRetryAtMs: 46_000,
      attemptCount: 0,
    }));
    const input = {
      getChildren: () => [{
        startedBy: 'daemon' as const,
        happySessionId: 'sess_1',
        pid: 123,
        spawnOptions: {
          directory: '/tmp/project',
          connectedServices: {
            v: 1 as const,
            bindingsByServiceId: {
              'openai-codex': {
                source: 'connected' as const,
                selection: 'group' as const,
                profileId: 'primary',
                groupId: 'main',
              },
            },
          },
        },
      }],
      switchCoordinator: { switchAfterClassifiedFailure },
      temporaryThrottleRecovery: { enable },
      sessionId: 'sess_1',
      switchesThisTurn: 0,
      classification: createTemporaryThrottleClassification({
        resetsAtMs: 90_000,
      }),
    };

    await expect(handleConnectedServiceRuntimeAuthFailureForSession(input)).resolves.toEqual({
      status: 'temporary_retry_armed',
      serviceId: 'openai-codex',
      profileId: 'primary',
      groupId: 'main',
      retryAfterMs: 45_000,
      resetAtMs: 90_000,
      recovery: {
        status: 'waiting',
        nextRetryAtMs: 46_000,
        attemptCount: 0,
      },
    });

    expect(enable).toHaveBeenCalledWith({
      sessionId: 'sess_1',
      issueFingerprint: 'temporary-throttle:openai-codex:main:primary',
      retryAfterMs: 45_000,
      resetAtMs: 90_000,
    });
    expect(switchAfterClassifiedFailure).not.toHaveBeenCalled();
  });

  it('prefers the canonical active group profile from session environment during runtime recovery', async () => {
    const switchAfterClassifiedFailure = vi.fn(async () => ({
      status: 'switched' as const,
      activeProfileId: 'tertiary',
      generation: 3,
    }));
    const emitSessionEvent = vi.fn();

    await expect(handleConnectedServiceRuntimeAuthFailureForSession({
      getChildren: () => [{
        startedBy: 'daemon',
        happySessionId: 'sess_1',
        pid: 123,
        spawnOptions: {
          directory: '/tmp/project',
          connectedServices: {
            v: 1,
            bindingsByServiceId: {
              'openai-codex': {
                source: 'connected',
                selection: 'group',
                profileId: 'primary',
                groupId: 'main',
              },
            },
          },
          environmentVariables: {
            HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON: JSON.stringify([{
              kind: 'group',
              serviceId: 'openai-codex',
              groupId: 'main',
              activeProfileId: 'backup',
              fallbackProfileId: 'primary',
              generation: 2,
            }]),
          },
        },
      }],
      switchCoordinator: { switchAfterClassifiedFailure },
      emitSessionEvent,
      sessionId: 'sess_1',
      switchesThisTurn: 0,
      classification: {
        kind: 'usage_limit',
        limitCategory: 'usage_limit',
        serviceId: 'openai-codex',
        profileId: null,
        groupId: null,
        resetsAtMs: null,
        retryAfterMs: 30_000,
        quotaScope: 'account',
        providerLimitId: 'weekly',
        action: null,
        planType: null,
        rateLimits: null,
        source: 'structured_provider_error',
      },
    })).resolves.toEqual({
      status: 'switch_attempted',
      result: {
        status: 'switched',
        activeProfileId: 'tertiary',
        generation: 3,
      },
    });

    expect(switchAfterClassifiedFailure).toHaveBeenCalledWith(expect.objectContaining({
      observedProfileId: 'backup',
    }));
    expect(emitSessionEvent).not.toHaveBeenCalled();
  });

  it('force-refreshes a classified group profile when tracked spawn options lost connected services', async () => {
    const refreshConnectedServiceCredentialForRuntimeAuthFailure = vi.fn(async () => ({
      status: 'refreshed' as const,
      credential: buildConnectedServiceCredentialRecord({
        now: 1,
        serviceId: 'openai-codex',
        profileId: 'primary',
        kind: 'oauth',
        expiresAt: 3_600_000,
        oauth: {
          accessToken: 'fresh-access',
          refreshToken: 'refresh',
          idToken: null,
          scope: null,
          tokenType: null,
          providerAccountId: 'acct',
          providerEmail: null,
        },
      }),
      diagnostic: {
        serviceId: 'openai-codex' as const,
        profileId: 'primary',
        reason: 'runtime_auth_failure' as const,
        status: 'refreshed' as const,
        expiresAt: 3_600_000,
        expiryAgeMs: -3_599_000,
        refreshWindowMs: 60_000,
      },
    }));
    const restartSession = vi.fn(async () => {});
    const switchAfterClassifiedFailure = vi.fn();

    await expect(handleConnectedServiceRuntimeAuthFailureForSession({
      getChildren: () => [{
        startedBy: 'daemon',
        happySessionId: 'sess_1',
        pid: 123,
        spawnOptions: {
          directory: '/tmp/project',
        },
      }],
      switchCoordinator: { switchAfterClassifiedFailure },
      credentialRefreshService: {
        refreshConnectedServiceCredentialForRuntimeAuthFailure,
      },
      restartSession,
      sessionId: 'sess_1',
      switchesThisTurn: 0,
      classification: {
        kind: 'auth_expired',
        limitCategory: 'auth_invalid',
        serviceId: 'openai-codex',
        profileId: 'primary',
        groupId: 'main',
        resetsAtMs: null,
        planType: null,
        rateLimits: null,
        source: 'structured_provider_error',
      },
    })).resolves.toMatchObject({
      status: 'credential_refreshed',
      restartRequested: false,
    });

    expect(refreshConnectedServiceCredentialForRuntimeAuthFailure).toHaveBeenCalledWith({
      serviceId: 'openai-codex',
      profileId: 'primary',
      sessionId: 'sess_1',
    });
    expect(restartSession).not.toHaveBeenCalled();
    expect(switchAfterClassifiedFailure).not.toHaveBeenCalled();
  });

  it('surfaces reconnect for a classified group after permanent refresh failure when tracked spawn options lost connected services', async () => {
    const refreshConnectedServiceCredentialForRuntimeAuthFailure = vi.fn(async () => ({
      status: 'refresh_failed' as const,
      credential: null,
      diagnostic: {
        serviceId: 'openai-codex' as const,
        profileId: 'primary',
        reason: 'runtime_auth_failure' as const,
        status: 'refresh_failed' as const,
        category: 'provider_401' as const,
        expiresAt: 999,
        expiryAgeMs: 1,
        refreshWindowMs: 60_000,
      },
    }));
    const switchAfterClassifiedFailure = vi.fn(async () => ({
      status: 'switched' as const,
      activeProfileId: 'backup',
      generation: 2,
    }));

    await expect(handleConnectedServiceRuntimeAuthFailureForSession({
      getChildren: () => [{
        startedBy: 'daemon',
        happySessionId: 'sess_1',
        pid: 123,
        spawnOptions: {
          directory: '/tmp/project',
        },
      }],
      switchCoordinator: { switchAfterClassifiedFailure },
      credentialRefreshService: {
        refreshConnectedServiceCredentialForRuntimeAuthFailure,
      },
      sessionId: 'sess_1',
      switchesThisTurn: 0,
      classification: {
        kind: 'refresh_failed',
        limitCategory: 'auth_invalid',
        serviceId: 'openai-codex',
        profileId: 'primary',
        groupId: 'main',
        resetsAtMs: null,
        planType: null,
        rateLimits: null,
        source: 'structured_provider_error',
      },
    })).resolves.toEqual({
      status: 'recovery_action_required',
      action: {
        kind: 'connected_service_required',
        serviceId: 'openai-codex',
        profileId: 'primary',
        groupId: 'main',
        reason: 'refresh_failed',
      },
    });

    expect(refreshConnectedServiceCredentialForRuntimeAuthFailure).toHaveBeenCalledWith({
      serviceId: 'openai-codex',
      profileId: 'primary',
      sessionId: 'sess_1',
    });
    expect(switchAfterClassifiedFailure).not.toHaveBeenCalled();
  });

  it('surfaces reconnect for a classified profile after permanent refresh failure when tracked spawn options lost connected services', async () => {
    const refreshConnectedServiceCredentialForRuntimeAuthFailure = vi.fn(async () => ({
      status: 'refresh_failed' as const,
      credential: null,
      diagnostic: {
        serviceId: 'openai-codex' as const,
        profileId: 'primary',
        reason: 'runtime_auth_failure' as const,
        status: 'refresh_failed' as const,
        category: 'invalid_grant' as const,
        expiresAt: 999,
        expiryAgeMs: 1,
        refreshWindowMs: 60_000,
      },
    }));
    const switchAfterClassifiedFailure = vi.fn();

    await expect(handleConnectedServiceRuntimeAuthFailureForSession({
      getChildren: () => [{
        startedBy: 'daemon',
        happySessionId: 'sess_1',
        pid: 123,
        spawnOptions: {
          directory: '/tmp/project',
        },
      }],
      switchCoordinator: { switchAfterClassifiedFailure },
      credentialRefreshService: {
        refreshConnectedServiceCredentialForRuntimeAuthFailure,
      },
      sessionId: 'sess_1',
      switchesThisTurn: 0,
      classification: {
        kind: 'refresh_failed',
        limitCategory: 'auth_invalid',
        serviceId: 'openai-codex',
        profileId: 'primary',
        groupId: null,
        resetsAtMs: null,
        planType: null,
        rateLimits: null,
        source: 'structured_provider_error',
      },
    })).resolves.toEqual({
      status: 'recovery_action_required',
      action: {
        kind: 'reconnect_profile',
        serviceId: 'openai-codex',
        profileId: 'primary',
        groupId: null,
        reason: 'refresh_failed',
      },
    });

    expect(refreshConnectedServiceCredentialForRuntimeAuthFailure).toHaveBeenCalledWith({
      serviceId: 'openai-codex',
      profileId: 'primary',
      sessionId: 'sess_1',
    });
    expect(switchAfterClassifiedFailure).not.toHaveBeenCalled();
  });

  it('does not synthesize connected-service recovery without a classified profile id', async () => {
    const refreshConnectedServiceCredentialForRuntimeAuthFailure = vi.fn();
    const switchAfterClassifiedFailure = vi.fn();

    await expect(handleConnectedServiceRuntimeAuthFailureForSession({
      getChildren: () => [{
        startedBy: 'daemon',
        happySessionId: 'sess_1',
        pid: 123,
        spawnOptions: {
          directory: '/tmp/project',
        },
      }],
      switchCoordinator: { switchAfterClassifiedFailure },
      credentialRefreshService: {
        refreshConnectedServiceCredentialForRuntimeAuthFailure,
      },
      sessionId: 'sess_1',
      switchesThisTurn: 0,
      classification: {
        kind: 'auth_expired',
        limitCategory: 'auth_invalid',
        serviceId: 'openai-codex',
        profileId: null,
        groupId: 'main',
        resetsAtMs: null,
        planType: null,
        rateLimits: null,
        source: 'structured_provider_error',
      },
    })).resolves.toEqual({
      status: 'recovery_action_required',
      action: {
        kind: 'connected_service_required',
        serviceId: 'openai-codex',
        profileId: null,
        groupId: 'main',
        reason: 'auth_expired',
      },
    });

    expect(refreshConnectedServiceCredentialForRuntimeAuthFailure).not.toHaveBeenCalled();
    expect(switchAfterClassifiedFailure).not.toHaveBeenCalled();
  });

  it('returns a profile action-required state for sessions with single connected profile usage-limit failures', async () => {
    const switchAfterClassifiedFailure = vi.fn();

    await expect(handleConnectedServiceRuntimeAuthFailureForSession({
      getChildren: () => [{
        startedBy: 'daemon',
        happySessionId: 'sess_1',
        pid: 123,
        spawnOptions: {
          directory: '/tmp/project',
          connectedServices: {
            v: 1,
            bindingsByServiceId: {
              'openai-codex': {
                source: 'connected',
                selection: 'profile',
                profileId: 'primary',
              },
            },
          },
        },
      }],
      switchCoordinator: { switchAfterClassifiedFailure },
      sessionId: 'sess_1',
      switchesThisTurn: 0,
      classification: {
        kind: 'usage_limit',
        serviceId: 'openai-codex',
        profileId: 'primary',
        groupId: null,
        resetsAtMs: null,
        planType: null,
        rateLimits: null,
        source: 'structured_provider_error',
      },
    })).resolves.toEqual({
      status: 'recovery_action_required',
      action: {
        kind: 'profile_action_required',
        serviceId: 'openai-codex',
        profileId: 'primary',
        groupId: null,
        reason: 'usage_limit',
      },
    });

    expect(switchAfterClassifiedFailure).not.toHaveBeenCalled();
  });

  it('returns a provider-state-sharing-required action for native Codex usage-limit recovery', async () => {
    const switchAfterClassifiedFailure = vi.fn();
    const refreshConnectedServiceCredentialForRuntimeAuthFailure = vi.fn();

    await expect(handleConnectedServiceRuntimeAuthFailureForSession({
      getChildren: () => [{
        startedBy: 'daemon',
        happySessionId: 'sess_1',
        pid: 123,
        spawnOptions: {
          directory: '/tmp/project',
          connectedServices: {
            v: 1,
            bindingsByServiceId: {
              'openai-codex': {
                source: 'native',
              },
            },
          },
        },
      }],
      switchCoordinator: { switchAfterClassifiedFailure },
      credentialRefreshService: {
        refreshConnectedServiceCredentialForRuntimeAuthFailure,
      },
      sessionId: 'sess_1',
      switchesThisTurn: 0,
      classification: {
        kind: 'usage_limit',
        serviceId: 'openai-codex',
        profileId: null,
        groupId: null,
        resetsAtMs: null,
        planType: null,
        rateLimits: null,
        recoveryAction: { kind: 'provider_state_sharing_required' },
        source: 'structured_provider_error',
      },
    })).resolves.toEqual({
      status: 'recovery_action_required',
      action: {
        kind: 'provider_state_sharing_required',
        serviceId: 'openai-codex',
        profileId: null,
        groupId: null,
        reason: 'usage_limit',
      },
    });

    expect(switchAfterClassifiedFailure).not.toHaveBeenCalled();
    expect(refreshConnectedServiceCredentialForRuntimeAuthFailure).not.toHaveBeenCalled();
  });

  it('uses the tracked auth group to rotate after a Codex provider-state-sharing usage-limit hint', async () => {
    const switchAfterClassifiedFailure = vi.fn(async () => ({
      status: 'switched' as const,
      activeProfileId: 'backup',
      generation: 2,
    }));

    await expect(handleConnectedServiceRuntimeAuthFailureForSession({
      getChildren: () => [{
        startedBy: 'daemon',
        happySessionId: 'sess_1',
        pid: 123,
        spawnOptions: {
          directory: '/tmp/project',
          connectedServices: {
            v: 1,
            bindingsByServiceId: {
              'openai-codex': {
                source: 'connected',
                selection: 'group',
                profileId: 'primary',
                groupId: 'main',
              },
            },
          },
        },
      }],
      switchCoordinator: { switchAfterClassifiedFailure },
      sessionId: 'sess_1',
      switchesThisTurn: 0,
      classification: {
        kind: 'usage_limit',
        serviceId: 'openai-codex',
        profileId: 'primary',
        groupId: 'main',
        resetsAtMs: null,
        planType: null,
        rateLimits: null,
        recoveryAction: { kind: 'provider_state_sharing_required' },
        source: 'structured_provider_error',
      },
    })).resolves.toMatchObject({
      status: 'switch_attempted',
      result: {
        status: 'switched',
        activeProfileId: 'backup',
        generation: 2,
      },
    });

    expect(switchAfterClassifiedFailure).toHaveBeenCalledWith(expect.objectContaining({
      serviceId: 'openai-codex',
      groupId: 'main',
      reason: 'usage_limit',
      observedProfileId: 'primary',
      switchesThisTurn: 0,
    }));
  });

  it('reports an unavailable coordinator at the live daemon boundary without switching', async () => {
    await expect(handleConnectedServiceRuntimeAuthFailureForSession({
      getChildren: () => [{
        startedBy: 'daemon',
        happySessionId: 'sess_1',
        pid: 123,
        spawnOptions: {
          directory: '/tmp/project',
          connectedServices: {
            v: 1,
            bindingsByServiceId: {
              'openai-codex': {
                source: 'connected',
                selection: 'group',
                profileId: 'primary',
                groupId: 'main',
              },
            },
          },
        },
      }],
      switchCoordinator: null,
      sessionId: 'sess_1',
      switchesThisTurn: 0,
      classification: {
        kind: 'usage_limit',
        serviceId: 'openai-codex',
        profileId: 'primary',
        groupId: 'main',
        resetsAtMs: null,
        planType: null,
        rateLimits: null,
        source: 'structured_provider_error',
      },
    })).resolves.toEqual({
      status: 'switch_coordinator_unavailable',
      blocker: 'CLI has no connected-service auth-group load/commit API in this branch.',
    });
  });

  it('carries daemon-observed switch attempts across immediate failed respawns', async () => {
    const switchAttemptTracker = new ConnectedServiceRuntimeAuthSwitchAttemptTracker({
      nowMs: () => 1_000,
      windowMs: 60_000,
    });
    const switchAfterClassifiedFailure = vi.fn(async ({ switchesThisTurn }: { switchesThisTurn?: number }) => (
      switchesThisTurn === 0
        ? { status: 'switched' as const, activeProfileId: 'backup', generation: 2 }
        : { status: 'switch_limit_reached' as const, generation: 2 }
    ));
    const trackedSession = {
      startedBy: 'daemon' as const,
      happySessionId: 'sess_1',
      pid: 123,
      spawnOptions: {
        directory: '/tmp/project',
        connectedServices: {
          v: 1 as const,
          bindingsByServiceId: {
            'openai-codex': {
              source: 'connected' as const,
              selection: 'group' as const,
              profileId: 'primary',
              groupId: 'main',
            },
          },
        },
      },
    };
    const classification = {
      kind: 'usage_limit' as const,
      serviceId: 'openai-codex',
      profileId: 'primary',
      groupId: 'main',
      resetsAtMs: null,
      planType: null,
      rateLimits: null,
      source: 'structured_provider_error' as const,
    };

    await expect(handleConnectedServiceRuntimeAuthFailureForSession({
      getChildren: () => [trackedSession],
      switchCoordinator: { switchAfterClassifiedFailure },
      switchAttemptTracker,
      sessionId: 'sess_1',
      switchesThisTurn: 0,
      classification,
    })).resolves.toMatchObject({
      status: 'switch_attempted',
      result: { status: 'switched', activeProfileId: 'backup', generation: 2 },
    });

    await expect(handleConnectedServiceRuntimeAuthFailureForSession({
      getChildren: () => [trackedSession],
      switchCoordinator: { switchAfterClassifiedFailure },
      switchAttemptTracker,
      sessionId: 'sess_1',
      switchesThisTurn: 0,
      classification,
    })).resolves.toMatchObject({
      status: 'switch_attempted',
      result: { status: 'switch_limit_reached', generation: 2 },
    });

    expect(switchAfterClassifiedFailure).toHaveBeenNthCalledWith(1, expect.objectContaining({
      switchesThisTurn: 0,
    }));
    expect(switchAfterClassifiedFailure).toHaveBeenNthCalledWith(2, expect.objectContaining({
      switchesThisTurn: 1,
    }));
  });

  it('honors hourly switch limits across separate daemon requests even when the switch coordinator instance is recreated', async () => {
    let current = {
      serviceId: 'openai-codex',
      groupId: 'main',
      activeProfileId: 'primary',
      generation: 1,
      policy: {
        ...DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1,
        strategy: 'priority' as const,
        autoSwitch: true,
        maxSwitchesPerTurn: 2,
        maxSwitchesPerSessionHour: 1,
      },
      members: [
        { profileId: 'primary', priority: 1, createdAtMs: 1, enabled: true },
        { profileId: 'backup', priority: 2, createdAtMs: 2, enabled: true },
      ],
      memberStatesByProfileId: new Map(),
    };
    const switchAttemptTracker = new ConnectedServiceRuntimeAuthSwitchAttemptTracker({
      nowMs: () => 1_000,
      windowMs: 60_000,
    });
    const trackedSession = {
      startedBy: 'daemon' as const,
      happySessionId: 'sess_1',
      pid: 123,
      spawnOptions: {
        directory: '/tmp/project',
        connectedServices: {
          v: 1 as const,
          bindingsByServiceId: {
            'openai-codex': {
              source: 'connected' as const,
              selection: 'group' as const,
              profileId: 'primary',
              groupId: 'main',
            },
          },
        },
      },
    };
    const classification = {
      kind: 'usage_limit' as const,
      serviceId: 'openai-codex',
      profileId: 'primary',
      groupId: 'main',
      resetsAtMs: null,
      planType: null,
      rateLimits: null,
      source: 'structured_provider_error' as const,
    };
    const createFreshCoordinator = () => new ConnectedServiceAuthGroupSwitchCoordinator({
      leases: new InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry(),
      nowMs: () => 1_000,
      quotaFreshnessMs: 60_000,
      loadState: async () => current,
      commitSwitch: async ({ toProfileId }) => {
        current = {
          ...current,
          activeProfileId: toProfileId,
          generation: current.generation + 1,
          memberStatesByProfileId: new Map([
            [toProfileId, {
              quotaSnapshot: {
                capturedAtMs: 1_000,
                effectiveRemainingPercent: 80,
              },
            }],
          ]),
        };
        return current;
      },
      applyGeneration: async () => {},
    });

    await expect(handleConnectedServiceRuntimeAuthFailureForSession({
      getChildren: () => [trackedSession],
      switchCoordinator: createFreshCoordinator(),
      switchAttemptTracker,
      sessionId: 'sess_1',
      switchesThisTurn: 0,
      classification,
    })).resolves.toMatchObject({
      status: 'switch_attempted',
      result: { status: 'switched', activeProfileId: 'backup', generation: 2 },
    });

    await expect(handleConnectedServiceRuntimeAuthFailureForSession({
      getChildren: () => [trackedSession],
      switchCoordinator: createFreshCoordinator(),
      switchAttemptTracker,
      sessionId: 'sess_1',
      switchesThisTurn: 0,
      classification,
    })).resolves.toMatchObject({
      status: 'switch_attempted',
      result: { status: 'observed_generation', generation: 2, activeProfileId: 'backup' },
    });
  });

  it('continues the interrupted turn when runtime recovery observes an already-applied generation', async () => {
    const continueAfterRuntimeAuthSwitch = vi.fn(async () => {});
    const switchAfterClassifiedFailure = vi.fn(async () => ({
      status: 'observed_generation' as const,
      activeProfileId: 'backup',
      generation: 2,
    }));

    await expect(handleConnectedServiceRuntimeAuthFailureForSession({
      getChildren: () => [{
        startedBy: 'daemon',
        happySessionId: 'sess_1',
        pid: 123,
        spawnOptions: {
          directory: '/tmp/project',
          connectedServices: {
            v: 1,
            bindingsByServiceId: {
              'openai-codex': {
                source: 'connected',
                selection: 'group',
                profileId: 'primary',
                groupId: 'main',
              },
            },
          },
        },
      }],
      switchCoordinator: { switchAfterClassifiedFailure },
      continueAfterRuntimeAuthSwitch,
      sessionId: 'sess_1',
      switchesThisTurn: 0,
      classification: {
        kind: 'usage_limit',
        limitCategory: 'usage_limit',
        serviceId: 'openai-codex',
        profileId: 'primary',
        groupId: 'main',
        resetsAtMs: null,
        retryAfterMs: 30_000,
        quotaScope: 'account',
        providerLimitId: 'weekly',
        action: null,
        planType: null,
        rateLimits: null,
        source: 'structured_provider_error',
      },
    })).resolves.toMatchObject({
      status: 'switch_attempted',
      result: {
        status: 'observed_generation',
        activeProfileId: 'backup',
        generation: 2,
      },
    });

    expect(continueAfterRuntimeAuthSwitch).toHaveBeenCalledWith({
      tracked: expect.objectContaining({ happySessionId: 'sess_1' }),
      sessionId: 'sess_1',
      attemptId: 'connected-service-auth-switch|hot_applied|openai-codex:group:main:backup:2',
      normalizedBindings: {
        v: 1,
        bindingsByServiceId: {
          'openai-codex': {
            source: 'connected',
            selection: 'group',
            groupId: 'main',
            profileId: 'backup',
          },
        },
      },
      serviceIds: new Set(['openai-codex']),
      action: 'hot_applied',
      switchReason: 'automatic_runtime_failure',
    });
  });

  it('continues the interrupted turn when runtime recovery hot-applies a switched group generation', async () => {
    const continueAfterRuntimeAuthSwitch = vi.fn(async () => {});
    const switchAfterClassifiedFailure = vi.fn(async () => ({
      status: 'switched' as const,
      activeProfileId: 'backup',
      generation: 2,
      mode: 'hot_apply' as const,
    }));

    await expect(handleConnectedServiceRuntimeAuthFailureForSession({
      getChildren: () => [{
        startedBy: 'daemon',
        happySessionId: 'sess_1',
        pid: 123,
        spawnOptions: {
          directory: '/tmp/project',
          connectedServices: {
            v: 1,
            bindingsByServiceId: {
              'openai-codex': {
                source: 'connected',
                selection: 'group',
                profileId: 'primary',
                groupId: 'main',
              },
            },
          },
        },
      }],
      switchCoordinator: { switchAfterClassifiedFailure },
      continueAfterRuntimeAuthSwitch,
      sessionId: 'sess_1',
      switchesThisTurn: 0,
      classification: {
        kind: 'usage_limit',
        limitCategory: 'usage_limit',
        serviceId: 'openai-codex',
        profileId: 'primary',
        groupId: 'main',
        resetsAtMs: null,
        retryAfterMs: 30_000,
        quotaScope: 'account',
        providerLimitId: 'weekly',
        action: null,
        planType: null,
        rateLimits: null,
        source: 'structured_provider_error',
      },
    })).resolves.toMatchObject({
      status: 'switch_attempted',
      result: {
        status: 'switched',
        activeProfileId: 'backup',
        generation: 2,
        mode: 'hot_apply',
      },
    });

    expect(continueAfterRuntimeAuthSwitch).toHaveBeenCalledWith({
      tracked: expect.objectContaining({ happySessionId: 'sess_1' }),
      sessionId: 'sess_1',
      attemptId: 'connected-service-auth-switch|hot_applied|openai-codex:group:main:backup:2',
      normalizedBindings: {
        v: 1,
        bindingsByServiceId: {
          'openai-codex': {
            source: 'connected',
            selection: 'group',
            groupId: 'main',
            profileId: 'backup',
          },
        },
      },
      serviceIds: new Set(['openai-codex']),
      action: 'hot_applied',
      switchReason: 'automatic_runtime_failure',
    });
  });

  it('arms continuation as restart_requested when runtime recovery switches a group account for the next turn', async () => {
    // QA-F 2026-06-12 (session cmqb2ikma): a reactive usage-limit switch that lands as
    // `switched` + `spawn_next_turn` requests a live restart-resume but never armed the
    // continuation attempt — the respawned session resumed its provider context and then sat
    // idle forever (no continuation prompt, no original-prompt replay). The restart path must
    // arm a pending continuation (action `restart_requested`) so the post-respawn webhook
    // resolver can drive the resume prompt.
    const restartSession = vi.fn(async () => {});
    const continueAfterRuntimeAuthSwitch = vi.fn(async () => {});
    const switchAfterClassifiedFailure = vi.fn(async () => ({
      status: 'switched' as const,
      activeProfileId: 'backup',
      generation: 2,
      mode: 'spawn_next_turn' as const,
    }));

    await expect(handleConnectedServiceRuntimeAuthFailureForSession({
      getChildren: () => [{
        startedBy: 'daemon',
        happySessionId: 'sess_1',
        pid: 123,
        spawnOptions: {
          directory: '/tmp/project',
          connectedServices: {
            v: 1,
            bindingsByServiceId: {
              'openai-codex': {
                source: 'connected',
                selection: 'group',
                profileId: 'primary',
                groupId: 'main',
              },
            },
          },
        },
      }],
      switchCoordinator: { switchAfterClassifiedFailure },
      restartSession,
      continueAfterRuntimeAuthSwitch,
      sessionId: 'sess_1',
      switchesThisTurn: 0,
      classification: {
        kind: 'usage_limit',
        limitCategory: 'usage_limit',
        serviceId: 'openai-codex',
        profileId: 'primary',
        groupId: 'main',
        resetsAtMs: null,
        retryAfterMs: 30_000,
        quotaScope: 'account',
        providerLimitId: 'weekly',
        action: null,
        planType: null,
        rateLimits: null,
        source: 'structured_provider_error',
      },
    })).resolves.toMatchObject({
      status: 'switch_attempted',
      result: {
        status: 'switched',
        activeProfileId: 'backup',
        generation: 2,
        mode: 'spawn_next_turn',
      },
    });

    expect(restartSession).toHaveBeenCalledOnce();
    expect(continueAfterRuntimeAuthSwitch).toHaveBeenCalledWith({
      tracked: expect.objectContaining({ happySessionId: 'sess_1' }),
      sessionId: 'sess_1',
      attemptId: 'connected-service-auth-switch|restart_requested|openai-codex:group:main:backup:2',
      normalizedBindings: {
        v: 1,
        bindingsByServiceId: {
          'openai-codex': {
            source: 'connected',
            selection: 'group',
            groupId: 'main',
            profileId: 'backup',
          },
        },
      },
      serviceIds: new Set(['openai-codex']),
      action: 'restart_requested',
      switchReason: 'automatic_runtime_failure',
    });
  });

  it('does not re-continue a stale-profile replay when the same target is already pending provider proof', async () => {
    const continueAfterRuntimeAuthSwitch = vi.fn(async () => {});
    const switchAfterClassifiedFailure = vi.fn(async () => ({
      status: 'observed_generation' as const,
      activeProfileId: 'backup',
      generation: 2,
    }));
    const pendingIntent: RuntimeAuthRecoveryIntent = {
      v: 1,
      sessionId: 'sess_1',
      serviceId: 'openai-codex',
      profileId: null,
      groupId: 'main',
      status: 'resumed_awaiting_proof',
      armedAtMs: 1_000,
      nextRetryAtMs: 6_000,
      attemptCount: 1,
      maxAttempts: 5,
      switchesThisTurn: 1,
      classification: {
        kind: 'usage_limit',
        limitCategory: 'usage_limit',
        serviceId: 'openai-codex',
        profileId: 'primary',
        groupId: 'main',
        resetsAtMs: null,
        retryAfterMs: 30_000,
        quotaScope: 'account',
        providerLimitId: 'weekly',
        action: null,
        planType: null,
        rateLimits: null,
        source: 'structured_provider_error',
      },
      failurePhase: 'handler',
      failureReason: 'classified_failure_reported',
      lastError: 'usage_limit',
      lastErrorClassification: { kind: 'rate_limited', retryable: true },
      pendingTargetProfileId: 'backup',
      pendingTargetGeneration: 2,
      terminalAtMs: null,
      terminalReason: null,
    };

    await expect(handleConnectedServiceRuntimeAuthFailureForSession({
      getChildren: () => [{
        startedBy: 'daemon',
        happySessionId: 'sess_1',
        pid: 123,
        spawnOptions: {
          directory: '/tmp/project',
          connectedServices: {
            v: 1,
            bindingsByServiceId: {
              'openai-codex': {
                source: 'connected',
                selection: 'group',
                profileId: 'primary',
                groupId: 'main',
              },
            },
          },
        },
      }],
      switchCoordinator: { switchAfterClassifiedFailure },
      continueAfterRuntimeAuthSwitch,
      runtimeAuthRecovery: {
        readForSession: () => [pendingIntent],
      },
      sessionId: 'sess_1',
      switchesThisTurn: 0,
      classification: pendingIntent.classification,
    })).resolves.toMatchObject({
      status: 'switch_attempted',
      result: {
        status: 'observed_generation',
        activeProfileId: 'backup',
        generation: 2,
      },
    });

    expect(continueAfterRuntimeAuthSwitch).not.toHaveBeenCalled();
  });

  it('coalesces a pending-proof replay onto the same target profile even when sibling sessions churned the group generation', async () => {
    // Incident 2026-06-12 (cmq8y3nlx): sibling sessions bumped the shared group generation
    // between scheduler replays (81→87), so the exact-generation pending-target match never
    // held and every replay restarted the live runner mid-work. The pending proof target is
    // the PROFILE; a fresher generation for the same target profile is still the same
    // logical switch and must not re-kill the session.
    const restartSession = vi.fn(async () => {});
    const continueAfterRuntimeAuthSwitch = vi.fn(async () => {});
    const switchAfterClassifiedFailure = vi.fn(async () => ({
      status: 'switched' as const,
      activeProfileId: 'backup',
      generation: 9,
      mode: 'spawn_next_turn' as const,
    }));
    const pendingIntent: RuntimeAuthRecoveryIntent = {
      v: 1,
      sessionId: 'sess_1',
      serviceId: 'openai-codex',
      profileId: null,
      groupId: 'main',
      status: 'resumed_awaiting_proof',
      armedAtMs: 1_000,
      nextRetryAtMs: 6_000,
      attemptCount: 1,
      maxAttempts: 5,
      switchesThisTurn: 1,
      classification: {
        kind: 'usage_limit',
        limitCategory: 'usage_limit',
        serviceId: 'openai-codex',
        profileId: 'primary',
        groupId: 'main',
        resetsAtMs: null,
        retryAfterMs: 30_000,
        quotaScope: 'account',
        providerLimitId: 'weekly',
        action: null,
        planType: null,
        rateLimits: null,
        source: 'structured_provider_error',
      },
      failurePhase: 'handler',
      failureReason: 'classified_failure_reported',
      lastError: 'usage_limit',
      lastErrorClassification: { kind: 'rate_limited', retryable: true },
      pendingTargetProfileId: 'backup',
      pendingTargetGeneration: 2,
      terminalAtMs: null,
      terminalReason: null,
    };

    await expect(handleConnectedServiceRuntimeAuthFailureForSession({
      getChildren: () => [{
        startedBy: 'daemon',
        happySessionId: 'sess_1',
        pid: 123,
        spawnOptions: {
          directory: '/tmp/project',
          connectedServices: {
            v: 1,
            bindingsByServiceId: {
              'openai-codex': {
                source: 'connected',
                selection: 'group',
                profileId: 'primary',
                groupId: 'main',
              },
            },
          },
        },
      }],
      switchCoordinator: { switchAfterClassifiedFailure },
      restartSession,
      continueAfterRuntimeAuthSwitch,
      runtimeAuthRecovery: {
        readForSession: () => [pendingIntent],
      },
      sessionId: 'sess_1',
      switchesThisTurn: 0,
      classification: pendingIntent.classification,
    })).resolves.toMatchObject({
      status: 'switch_attempted',
      result: {
        status: 'switched',
        activeProfileId: 'backup',
        generation: 9,
      },
    });

    expect(restartSession).not.toHaveBeenCalled();
    expect(continueAfterRuntimeAuthSwitch).not.toHaveBeenCalled();
  });

  it('refreshes the canonical active group profile instead of a stale classified member during runtime recovery', async () => {
    const refreshConnectedServiceCredentialForRuntimeAuthFailure = vi.fn(async (input: Readonly<{
      serviceId: 'claude-subscription';
      profileId: string;
      sessionId: string;
    }>) => ({
      status: 'refreshed' as const,
      credential: buildConnectedServiceCredentialRecord({
        now: 1,
        serviceId: input.serviceId,
        profileId: input.profileId,
        kind: 'oauth',
        expiresAt: 3_600_000,
        oauth: {
          accessToken: 'fresh-access',
          refreshToken: 'refresh',
          idToken: null,
          scope: null,
          tokenType: null,
          providerAccountId: 'acct',
          providerEmail: null,
        },
      }),
      diagnostic: {
        serviceId: 'claude-subscription' as const,
        profileId: input.profileId,
        reason: 'runtime_auth_failure' as const,
        status: 'refreshed' as const,
        expiresAt: 3_600_000,
        expiryAgeMs: -3_599_000,
        refreshWindowMs: 60_000,
      },
    }));
    const continueAfterRuntimeAuthSwitch = vi.fn(async () => {});
    const restartSession = vi.fn(async () => {});

    await expect(handleConnectedServiceRuntimeAuthFailureForSession({
      getChildren: () => [{
        startedBy: 'daemon',
        happySessionId: 'sess_1',
        pid: 123,
        spawnOptions: {
          directory: '/tmp/project',
          connectedServices: {
            v: 1,
            bindingsByServiceId: {
              'claude-subscription': {
                source: 'connected',
                selection: 'group',
                profileId: 'broken-member',
                groupId: 'claude',
              },
            },
          },
          environmentVariables: {
            HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON: JSON.stringify([{
              kind: 'group',
              serviceId: 'claude-subscription',
              groupId: 'claude',
              activeProfileId: 'healthy-member',
              fallbackProfileId: 'broken-member',
              generation: 2,
            }]),
          },
        },
      }],
      switchCoordinator: {
        switchAfterClassifiedFailure: vi.fn(async () => ({
          status: 'switched' as const,
          activeProfileId: 'backup',
          generation: 3,
        })),
      },
      credentialRefreshService: {
        refreshConnectedServiceCredentialForRuntimeAuthFailure,
      },
      continueAfterRuntimeAuthSwitch,
      restartSession,
      sessionId: 'sess_1',
      switchesThisTurn: 0,
      classification: {
        kind: 'auth_expired',
        limitCategory: 'auth_invalid',
        serviceId: 'claude-subscription',
        profileId: 'broken-member',
        groupId: 'claude',
        resetsAtMs: null,
        planType: null,
        rateLimits: null,
        source: 'structured_provider_error',
      },
    })).resolves.toMatchObject({
      status: 'credential_refreshed',
      restartRequested: false,
    });

    expect(refreshConnectedServiceCredentialForRuntimeAuthFailure).toHaveBeenCalledWith({
      serviceId: 'claude-subscription',
      profileId: 'healthy-member',
      sessionId: 'sess_1',
    });
    expect(continueAfterRuntimeAuthSwitch).toHaveBeenCalledWith(expect.objectContaining({
      normalizedBindings: {
        v: 1,
        bindingsByServiceId: {
          'claude-subscription': {
            source: 'connected',
            selection: 'group',
            groupId: 'claude',
            profileId: 'healthy-member',
          },
        },
      },
      action: 'hot_applied',
    }));
  });

  it('switches away from the canonical active group profile instead of a stale classified member', async () => {
    const switchAfterClassifiedFailure = vi.fn(async () => ({
      status: 'switched' as const,
      activeProfileId: 'tertiary',
      generation: 3,
    }));
    const emitSessionEvent = vi.fn();

    await expect(handleConnectedServiceRuntimeAuthFailureForSession({
      getChildren: () => [{
        startedBy: 'daemon',
        happySessionId: 'sess_1',
        pid: 123,
        spawnOptions: {
          directory: '/tmp/project',
          connectedServices: {
            v: 1,
            bindingsByServiceId: {
              'openai-codex': {
                source: 'connected',
                selection: 'group',
                profileId: 'primary',
                groupId: 'main',
              },
            },
          },
          environmentVariables: {
            HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON: JSON.stringify([{
              kind: 'group',
              serviceId: 'openai-codex',
              groupId: 'main',
              activeProfileId: 'backup',
              fallbackProfileId: 'primary',
              generation: 2,
            }]),
          },
        },
      }],
      switchCoordinator: { switchAfterClassifiedFailure },
      emitSessionEvent,
      sessionId: 'sess_1',
      switchesThisTurn: 0,
      classification: {
        kind: 'usage_limit',
        limitCategory: 'usage_limit',
        serviceId: 'openai-codex',
        profileId: 'primary',
        groupId: 'main',
        resetsAtMs: null,
        retryAfterMs: 30_000,
        quotaScope: 'account',
        providerLimitId: 'weekly',
        action: null,
        planType: null,
        rateLimits: null,
        source: 'structured_provider_error',
      },
    })).resolves.toEqual({
      status: 'switch_attempted',
      result: {
        status: 'switched',
        activeProfileId: 'tertiary',
        generation: 3,
      },
    });

    expect(switchAfterClassifiedFailure).toHaveBeenCalledWith(expect.objectContaining({
      observedProfileId: 'backup',
    }));
    expect(emitSessionEvent).not.toHaveBeenCalled();
  });

  it('keeps a profile-bound group member on same-profile credential refresh without group switching', async () => {
    const switchAfterClassifiedFailure = vi.fn(async () => ({
      status: 'switched' as const,
      activeProfileId: 'backup',
      generation: 2,
      mode: 'hot_apply' as const,
    }));
    const refreshConnectedServiceCredentialForRuntimeAuthFailure = vi.fn(async (input: Readonly<{
      serviceId: 'claude-subscription';
      profileId: string;
      sessionId: string;
    }>) => ({
      status: 'refreshed' as const,
      credential: buildConnectedServiceCredentialRecord({
        now: 1,
        serviceId: input.serviceId,
        profileId: input.profileId,
        kind: 'oauth',
        expiresAt: 3_600_000,
        oauth: {
          accessToken: 'fresh-access',
          refreshToken: 'refresh',
          idToken: null,
          scope: null,
          tokenType: null,
          providerAccountId: 'acct',
          providerEmail: null,
        },
      }),
      diagnostic: {
        serviceId: 'claude-subscription' as const,
        profileId: input.profileId,
        reason: 'runtime_auth_failure' as const,
        status: 'refreshed' as const,
        expiresAt: 3_600_000,
        expiryAgeMs: -3_599_000,
        refreshWindowMs: 60_000,
      },
    }));
    const continueAfterRuntimeAuthSwitch = vi.fn(async () => {});
    const restartSession = vi.fn(async () => {});
    const onRuntimeAuthRecoverySuccess = vi.fn(async () => {});

    await expect(handleConnectedServiceRuntimeAuthFailureForSession({
      getChildren: () => [{
        startedBy: 'daemon',
        happySessionId: 'sess_profile_member',
        pid: 123,
        spawnOptions: {
          directory: '/tmp/project',
          connectedServices: {
            v: 1,
            bindingsByServiceId: {
              'claude-subscription': {
                source: 'connected',
                selection: 'profile',
                profileId: 'member-a',
              },
            },
          },
        },
      }],
      switchCoordinator: { switchAfterClassifiedFailure },
      credentialRefreshService: {
        refreshConnectedServiceCredentialForRuntimeAuthFailure,
      },
      continueAfterRuntimeAuthSwitch,
      restartSession,
      onRuntimeAuthRecoverySuccess,
      sessionId: 'sess_profile_member',
      switchesThisTurn: 0,
      classification: {
        kind: 'auth_expired',
        limitCategory: 'auth_invalid',
        serviceId: 'claude-subscription',
        profileId: 'member-a',
        groupId: 'claude-pool',
        resetsAtMs: null,
        retryAfterMs: null,
        planType: null,
        rateLimits: null,
        source: 'structured_provider_error',
      },
    })).resolves.toMatchObject({
      status: 'credential_refreshed',
      restartRequested: false,
    });

    expect(refreshConnectedServiceCredentialForRuntimeAuthFailure).toHaveBeenCalledWith({
      serviceId: 'claude-subscription',
      profileId: 'member-a',
      sessionId: 'sess_profile_member',
    });
    expect(switchAfterClassifiedFailure).not.toHaveBeenCalled();
    expect(restartSession).not.toHaveBeenCalled();
    expect(continueAfterRuntimeAuthSwitch).toHaveBeenCalledWith(expect.objectContaining({
      normalizedBindings: {
        v: 1,
        bindingsByServiceId: {
          'claude-subscription': {
            source: 'connected',
            selection: 'profile',
            profileId: 'member-a',
          },
        },
      },
      action: 'hot_applied',
    }));
    expect(onRuntimeAuthRecoverySuccess).toHaveBeenCalledWith(expect.objectContaining({
      serviceId: 'claude-subscription',
      profileId: 'member-a',
      status: 'credential_refreshed',
      generation: null,
    }));
  });

  it('parks a profile-bound group member with hard quota on profile wait instead of group switch or respawn', async () => {
    const switchAfterClassifiedFailure = vi.fn(async () => ({
      status: 'switched' as const,
      activeProfileId: 'backup',
      generation: 2,
      mode: 'spawn_next_turn' as const,
    }));
    const restartSession = vi.fn(async () => {});
    const continueAfterRuntimeAuthSwitch = vi.fn(async () => {});

    await expect(handleConnectedServiceRuntimeAuthFailureForSession({
      getChildren: () => [{
        startedBy: 'daemon',
        happySessionId: 'sess_profile_member',
        pid: 123,
        spawnOptions: {
          directory: '/tmp/project',
          connectedServices: {
            v: 1,
            bindingsByServiceId: {
              'claude-subscription': {
                source: 'connected',
                selection: 'profile',
                profileId: 'member-a',
              },
            },
          },
        },
      }],
      switchCoordinator: { switchAfterClassifiedFailure },
      restartSession,
      continueAfterRuntimeAuthSwitch,
      sessionId: 'sess_profile_member',
      switchesThisTurn: 0,
      classification: {
        kind: 'usage_limit',
        limitCategory: 'usage_limit',
        serviceId: 'claude-subscription',
        profileId: 'member-a',
        groupId: 'claude-pool',
        resetsAtMs: 3_600_000,
        retryAfterMs: null,
        quotaScope: 'account',
        providerLimitId: 'weekly',
        action: null,
        planType: null,
        rateLimits: null,
        source: 'structured_provider_error',
      },
    })).resolves.toEqual({
      status: 'recovery_action_required',
      action: {
        kind: 'profile_action_required',
        serviceId: 'claude-subscription',
        profileId: 'member-a',
        groupId: 'claude-pool',
        reason: 'usage_limit',
      },
    });

    expect(switchAfterClassifiedFailure).not.toHaveBeenCalled();
    expect(restartSession).not.toHaveBeenCalled();
    expect(continueAfterRuntimeAuthSwitch).not.toHaveBeenCalled();
  });
});
