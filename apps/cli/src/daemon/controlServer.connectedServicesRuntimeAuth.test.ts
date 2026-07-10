import { describe, expect, it, vi } from 'vitest';
import { SPAWN_SESSION_ERROR_CODES } from '@happier-dev/protocol';

import { logger } from '@/ui/logger';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import {
  deriveOpenCodeBrokerRefreshToken,
  resetOpenCodeBrokerLoadHandshakesForTests,
} from '@/backends/opencode/brokerPlugin';
import {
  resetBrokerBridgeEffectiveSelectionsForTests,
  updateBrokerBridgeEffectiveSelection,
} from './connectedServices/broker/brokerBridgeEffectiveSelectionRegistry';
import { createDaemonControlApp, startDaemonControlServer } from './controlServer';

/** Scoped broker-refresh token for the master control token the bridge endpoints now require (F2). */
const BROKER_SCOPED_TOKEN = deriveOpenCodeBrokerRefreshToken('token');
import { buildRuntimeAuthRecoveryKey } from './connectedServices/runtimeAuth/recoveryKey/runtimeAuthRecoveryKey';
import {
  RuntimeAuthRecoveryScheduler,
  type RuntimeAuthRecoveryDiagnostic,
} from './connectedServices/runtimeAuth/RuntimeAuthRecoveryScheduler';
import {
  reportConnectedServiceRuntimeAuthFailureToDaemon,
  resetConnectedServiceRuntimeAuthFailureReportDedupeForTests,
} from './connectedServices/runtimeAuth/reportConnectedServiceRuntimeAuthFailureToDaemon';
import { readRuntimeAuthFailureReportOutboxItems } from './connectedServices/runtimeAuth/reportOutbox/runtimeAuthFailureReportOutbox';
import type { ConnectedServiceRuntimeFailureClassification } from './connectedServices/runtimeAuth/types';

describe('createDaemonControlApp connected-service runtime auth handling', () => {
  it('dispatches manual auth group generation apply requests to the daemon FSM handler', async () => {
    const handleConnectedServiceAuthGroupGenerationApply = vi.fn(async () => ({
      ok: true,
      appliedSessionCount: 1,
      deferredSessionCount: 0,
      skippedIdleSessionCount: 0,
    }));
    const app = createDaemonControlApp({
      getChildren: () => [],
      machineId: 'machine',
      stopSession: async () => false,
      spawnSession: async () => ({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
        errorMessage: 'unused',
      }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      controlToken: 'token',
      handleConnectedServiceAuthGroupGenerationApply,
    } as Parameters<typeof createDaemonControlApp>[0] & {
      handleConnectedServiceAuthGroupGenerationApply: typeof handleConnectedServiceAuthGroupGenerationApply;
    });

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/connected-service-auth/group-generation/apply',
        headers: { 'x-happier-daemon-token': 'token' },
        payload: {
          serviceId: 'claude-subscription',
          groupId: 'claude',
          activeProfileId: 'leeroy_bat',
          generation: 222,
          switchReason: 'manual',
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        ok: true,
        result: {
          ok: true,
          appliedSessionCount: 1,
          deferredSessionCount: 0,
          skippedIdleSessionCount: 0,
        },
      });
      expect(handleConnectedServiceAuthGroupGenerationApply).toHaveBeenCalledWith({
        serviceId: 'claude-subscription',
        groupId: 'claude',
        activeProfileId: 'leeroy_bat',
        generation: 222,
        switchReason: 'manual',
      });
    } finally {
      await app.close();
    }
  });

  it('dispatches manual session auth switches to the daemon handler', async () => {
    const handleSessionConnectedServiceAuthSwitch = vi.fn(async () => ({
      ok: true,
      action: 'restart_requested',
      normalizedBindings: {
        v: 1,
        bindingsByServiceId: {
          anthropic: { source: 'connected', selection: 'profile', profileId: 'work' },
        },
      },
      continuityByServiceId: { anthropic: 'restart_rematerialize' },
      warnings: [],
    }));
    const app = createDaemonControlApp({
      getChildren: () => [],
      machineId: 'machine',
      stopSession: async () => false,
      spawnSession: async () => ({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
        errorMessage: 'unused',
      }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      controlToken: 'token',
      handleSessionConnectedServiceAuthSwitch,
    });

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/connected-service-auth/session/switch',
        headers: { 'x-happier-daemon-token': 'token' },
        payload: {
          sessionId: 'sess_1',
          agentId: 'claude',
          bindings: {
            v: 1,
            bindingsByServiceId: {
              anthropic: { source: 'connected', selection: 'profile', profileId: 'work' },
            },
          },
          rematerializeServiceId: 'anthropic',
          expectedGroupGenerationByServiceId: { anthropic: 4 },
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        ok: true,
        result: {
          ok: true,
          action: 'restart_requested',
          normalizedBindings: {
            v: 1,
            bindingsByServiceId: {
              anthropic: { source: 'connected', selection: 'profile', profileId: 'work' },
            },
          },
          continuityByServiceId: { anthropic: 'restart_rematerialize' },
          warnings: [],
        },
      });
      expect(handleSessionConnectedServiceAuthSwitch).toHaveBeenCalledWith({
        sessionId: 'sess_1',
        agentId: 'claude',
        bindings: {
          v: 1,
          bindingsByServiceId: {
            anthropic: { source: 'connected', selection: 'profile', profileId: 'work' },
          },
        },
        rematerializeServiceId: 'anthropic',
        expectedGroupGenerationByServiceId: { anthropic: 4 },
      });
    } finally {
      await app.close();
    }
  });

  it('dispatches reported provider runtime auth failure kinds to the daemon handler', async () => {
    const handleConnectedServiceRuntimeAuthFailure = vi.fn(async () => ({
      status: 'switch_attempted',
      result: { status: 'switched', activeProfileId: 'backup', generation: 2 },
    }));
    const app = createDaemonControlApp({
      getChildren: () => [],
      machineId: 'machine',
      stopSession: async () => false,
      spawnSession: async () => ({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
        errorMessage: 'unused',
      }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      controlToken: 'token',
      handleConnectedServiceRuntimeAuthFailure,
    });

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/connected-service-runtime-auth/failure',
        headers: { 'x-happier-daemon-token': 'token' },
        payload: {
          sessionId: 'sess_1',
          switchesThisTurn: 0,
          resumePromptMode: 'custom',
          classification: {
            kind: 'capacity',
            limitCategory: 'capacity',
            serviceId: 'openai-codex',
            profileId: 'primary',
            groupId: 'main',
            resetsAtMs: null,
            planType: null,
            rateLimits: null,
            source: 'structured_provider_error',
          },
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        ok: true,
        result: {
          status: 'switch_attempted',
          result: { status: 'switched', activeProfileId: 'backup', generation: 2 },
        },
      });
      expect(handleConnectedServiceRuntimeAuthFailure).toHaveBeenCalledWith({
        sessionId: 'sess_1',
        switchesThisTurn: 0,
        resumePromptMode: 'custom',
        classification: expect.objectContaining({
          kind: 'capacity',
          serviceId: 'openai-codex',
          limitCategory: 'capacity',
          groupId: 'main',
        }),
      });
    } finally {
      await app.close();
    }
  });

  it('does NOT clear the recovery intent for credential_refreshed without provider-outcome proof', async () => {
    const markSucceededByKey = vi.fn(async () => ({ status: 'succeeded' }));
    const cancelByKey = vi.fn(async () => ({ status: 'cancelled' }));
    const handleConnectedServiceRuntimeAuthFailure = vi.fn(async () => ({
      status: 'credential_refreshed',
      restartRequested: true,
    }));
    const app = createDaemonControlApp({
      getChildren: () => [],
      machineId: 'machine',
      stopSession: async () => false,
      spawnSession: async () => ({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
        errorMessage: 'unused',
      }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      controlToken: 'token',
      handleConnectedServiceRuntimeAuthFailure,
      runtimeAuthRecoveryScheduler: { cancelByKey, markSucceededByKey },
    });

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/connected-service-runtime-auth/failure',
        headers: { 'x-happier-daemon-token': 'token' },
        payload: {
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
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        ok: true,
        result: {
          status: 'credential_refreshed',
          restartRequested: true,
        },
      });
      // No deterministic provider-outcome proof => recovery stays pending.
      expect(markSucceededByKey).not.toHaveBeenCalled();
      expect(cancelByKey).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('creates durable runtime-auth recovery intake before running local repair', async () => {
    const calls: string[] = [];
    const beginClassifiedFailure = vi.fn(async () => {
      calls.push('begin');
      return { status: 'scheduled', retryable: true };
    });
    const handleConnectedServiceRuntimeAuthFailure = vi.fn(async () => {
      calls.push('handler');
      expect(calls).toEqual(['begin', 'handler']);
      return {
        status: 'credential_refreshed' as const,
        restartRequested: true,
      };
    });
    const runtimeAuthRecoveryScheduler = {
      beginClassifiedFailure,
    } as unknown as NonNullable<Parameters<typeof createDaemonControlApp>[0]['runtimeAuthRecoveryScheduler']>;
    const app = createDaemonControlApp({
      getChildren: () => [],
      machineId: 'machine',
      stopSession: async () => false,
      spawnSession: async () => ({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
        errorMessage: 'unused',
      }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      controlToken: 'token',
      handleConnectedServiceRuntimeAuthFailure,
      runtimeAuthRecoveryScheduler,
    });

    try {
      const classification = {
        kind: 'auth_expired',
        serviceId: 'claude-subscription',
        profileId: 'leeroy_new',
        groupId: 'claude',
        resetsAtMs: null,
        planType: null,
        rateLimits: null,
        source: 'structured_provider_error',
      };
      const response = await app.inject({
        method: 'POST',
        url: '/connected-service-runtime-auth/failure',
        headers: { 'x-happier-daemon-token': 'token' },
        payload: {
          sessionId: 'sess_claude_group',
          switchesThisTurn: 0,
          classification,
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        ok: true,
        result: {
          status: 'credential_refreshed',
          restartRequested: true,
        },
      });
      expect(beginClassifiedFailure).toHaveBeenCalledWith({
        sessionId: 'sess_claude_group',
        switchesThisTurn: 0,
        classification: expect.objectContaining(classification),
      });
      expect(handleConnectedServiceRuntimeAuthFailure).toHaveBeenCalledOnce();
      expect(calls).toEqual(['begin', 'handler']);
    } finally {
      await app.close();
    }
  });

  it('routes temporary throttles without creating broad runtime-auth recovery intake', async () => {
    const beginClassifiedFailure = vi.fn(async () => {
      throw new Error('temporary throttle must not arm broad runtime-auth recovery');
    });
    const handleConnectedServiceRuntimeAuthFailure = vi.fn(async () => ({
      status: 'temporary_retry_armed' as const,
      serviceId: 'claude-subscription',
      profileId: 'primary',
      groupId: 'claude',
      retryAfterMs: 1_250,
      resetAtMs: null,
      recovery: {
        status: 'scheduled',
        nextRetryAtMs: 2_250,
        attemptCount: 0,
      },
    }));
    const runtimeAuthRecoveryScheduler = {
      beginClassifiedFailure,
    } as unknown as NonNullable<Parameters<typeof createDaemonControlApp>[0]['runtimeAuthRecoveryScheduler']>;
    const app = createDaemonControlApp({
      getChildren: () => [],
      machineId: 'machine',
      stopSession: async () => false,
      spawnSession: async () => ({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
        errorMessage: 'unused',
      }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      controlToken: 'token',
      handleConnectedServiceRuntimeAuthFailure,
      runtimeAuthRecoveryScheduler,
    });

    try {
      const classification = {
        kind: 'temporary_throttle',
        limitCategory: 'rate_limit',
        serviceId: 'claude-subscription',
        profileId: 'primary',
        groupId: 'claude',
        resetsAtMs: null,
        retryAfterMs: 1_250,
        quotaScope: 'provider',
        providerLimitId: 'transient',
        planType: null,
        rateLimits: null,
        source: 'structured_provider_error',
      };
      const response = await app.inject({
        method: 'POST',
        url: '/connected-service-runtime-auth/failure',
        headers: { 'x-happier-daemon-token': 'token' },
        payload: {
          sessionId: 'sess_claude_temp_throttle',
          switchesThisTurn: 0,
          classification,
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        ok: true,
        result: expect.objectContaining({
          status: 'temporary_retry_armed',
          serviceId: 'claude-subscription',
          profileId: 'primary',
          groupId: 'claude',
        }),
      });
      expect(beginClassifiedFailure).not.toHaveBeenCalled();
      expect(handleConnectedServiceRuntimeAuthFailure).toHaveBeenCalledWith({
        sessionId: 'sess_claude_temp_throttle',
        switchesThisTurn: 0,
        classification: expect.objectContaining(classification),
      });
    } finally {
      await app.close();
    }
  });

  it('routes provider capacity temporary retries without broad runtime-auth recovery intake', async () => {
    const beginClassifiedFailure = vi.fn(async () => {
      throw new Error('provider capacity retry must not arm broad runtime-auth recovery');
    });
    const handleConnectedServiceRuntimeAuthFailure = vi.fn(async () => ({
      status: 'temporary_retry_armed' as const,
      serviceId: 'claude-subscription',
      profileId: 'primary',
      groupId: 'claude',
      retryAfterMs: 2_000,
      resetAtMs: null,
      recovery: {
        status: 'scheduled',
        nextRetryAtMs: 3_000,
        attemptCount: 0,
      },
    }));
    const runtimeAuthRecoveryScheduler = {
      beginClassifiedFailure,
    } as unknown as NonNullable<Parameters<typeof createDaemonControlApp>[0]['runtimeAuthRecoveryScheduler']>;
    const app = createDaemonControlApp({
      getChildren: () => [],
      machineId: 'machine',
      stopSession: async () => false,
      spawnSession: async () => ({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
        errorMessage: 'unused',
      }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      controlToken: 'token',
      handleConnectedServiceRuntimeAuthFailure,
      runtimeAuthRecoveryScheduler,
    });

    try {
      const classification = {
        kind: 'capacity',
        limitCategory: 'capacity',
        serviceId: 'claude-subscription',
        profileId: 'primary',
        groupId: 'claude',
        resetsAtMs: null,
        retryAfterMs: 2_000,
        quotaScope: 'provider',
        providerLimitId: 'server_overloaded',
        planType: null,
        rateLimits: null,
        source: 'structured_provider_error',
      };
      const response = await app.inject({
        method: 'POST',
        url: '/connected-service-runtime-auth/failure',
        headers: { 'x-happier-daemon-token': 'token' },
        payload: {
          sessionId: 'sess_claude_capacity',
          switchesThisTurn: 0,
          classification,
        },
      });

      expect(response.statusCode).toBe(200);
      expect(beginClassifiedFailure).not.toHaveBeenCalled();
      expect(handleConnectedServiceRuntimeAuthFailure).toHaveBeenCalledWith({
        sessionId: 'sess_claude_capacity',
        switchesThisTurn: 0,
        classification: expect.objectContaining(classification),
      });
    } finally {
      await app.close();
    }
  });

  it('marks report-path credential refresh without provider proof as awaiting provider outcome', async () => {
    const runtimeAuthRecoveryScheduler = new RuntimeAuthRecoveryScheduler({
      nowMs: () => 1_000,
      baseBackoffMs: 100,
      maxBackoffMs: 1_000,
      jitterMs: () => 0,
      providerOutcomePendingWaitMs: 5_000,
      recover: async () => ({ status: 'credential_refreshed', restartRequested: true }),
    });
    const recoveryKey = buildRuntimeAuthRecoveryKey({
      sessionId: 'sess_1',
      serviceId: 'openai-codex',
      profileId: 'primary',
      groupId: 'main',
    });
    const handleConnectedServiceRuntimeAuthFailure = vi.fn(async () => ({
      status: 'credential_refreshed' as const,
      restartRequested: true,
    }));
    const app = createDaemonControlApp({
      getChildren: () => [],
      machineId: 'machine',
      stopSession: async () => false,
      spawnSession: async () => ({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
        errorMessage: 'unused',
      }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      controlToken: 'token',
      handleConnectedServiceRuntimeAuthFailure,
      runtimeAuthRecoveryScheduler,
    });

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/connected-service-runtime-auth/failure',
        headers: { 'x-happier-daemon-token': 'token' },
        payload: {
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
        },
      });

      expect(response.statusCode).toBe(200);
      expect(runtimeAuthRecoveryScheduler.readByKey(recoveryKey)).toMatchObject({
        status: 'resumed_awaiting_proof',
        lastError: 'recovery_unproven_awaiting_provider_outcome',
        nextRetryAtMs: 6_000,
      });
    } finally {
      await app.close();
    }
  });

  it('does not terminalize a group-exhausted no_eligible_member result when a reset wait is armed', async () => {
    const diagnostics: RuntimeAuthRecoveryDiagnostic[] = [];
    const runtimeAuthRecoveryScheduler = new RuntimeAuthRecoveryScheduler({
      nowMs: () => 1_000,
      baseBackoffMs: 100,
      maxBackoffMs: 1_000,
      jitterMs: () => 0,
      recover: async () => ({ status: 'credential_refreshed' }),
      recordDiagnostic: (event) => {
        diagnostics.push(event);
      },
    });
    const recoveryKey = buildRuntimeAuthRecoveryKey({
      sessionId: 'sess_1',
      serviceId: 'openai-codex',
      profileId: 'primary',
      groupId: 'main',
    });
    const handleConnectedServiceRuntimeAuthFailure = vi.fn(async () => ({
      status: 'switch_attempted' as const,
      result: {
        status: 'no_eligible_member' as const,
        generation: 17,
        groupExhausted: true,
        retryAtMs: 5_000,
        excluded: [
          { profileId: 'primary', reason: 'quota_exhausted', retryAtMs: 5_000 },
        ],
      },
    }));
    const app = createDaemonControlApp({
      getChildren: () => [],
      machineId: 'machine',
      stopSession: async () => false,
      spawnSession: async () => ({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
        errorMessage: 'unused',
      }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      controlToken: 'token',
      handleConnectedServiceRuntimeAuthFailure,
      runtimeAuthRecoveryScheduler,
    });

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/connected-service-runtime-auth/failure',
        headers: { 'x-happier-daemon-token': 'token' },
        payload: {
          sessionId: 'sess_1',
          switchesThisTurn: 0,
          classification: {
            kind: 'usage_limit',
            serviceId: 'openai-codex',
            profileId: 'primary',
            groupId: 'main',
            resetsAtMs: 5_000,
            planType: null,
            rateLimits: null,
            source: 'structured_provider_error',
          },
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        ok: true,
        result: {
          status: 'switch_attempted',
          result: {
            status: 'no_eligible_member',
            generation: 17,
            groupExhausted: true,
            retryAtMs: 5_000,
            excluded: [
              { profileId: 'primary', reason: 'quota_exhausted', retryAtMs: 5_000 },
            ],
          },
        },
      });
      expect(runtimeAuthRecoveryScheduler.readByKey(recoveryKey)).toMatchObject({
        status: 'waiting',
        nextRetryAtMs: 5_000,
        terminalReason: null,
      });
      expect(diagnostics).not.toContainEqual(expect.objectContaining({
        event: 'runtime_auth_recovery_terminal',
      }));
    } finally {
      await app.close();
    }
  });

  it('re-arms a durable wait instead of terminalizing a timing-less group-exhausted no_eligible_member (F0)', async () => {
    const diagnostics: RuntimeAuthRecoveryDiagnostic[] = [];
    const runtimeAuthRecoveryScheduler = new RuntimeAuthRecoveryScheduler({
      nowMs: () => 1_000,
      baseBackoffMs: 100,
      maxBackoffMs: 1_000,
      jitterMs: () => 0,
      recover: async () => ({ status: 'credential_refreshed' }),
      recordDiagnostic: (event) => {
        diagnostics.push(event);
      },
    });
    const recoveryKey = buildRuntimeAuthRecoveryKey({
      sessionId: 'sess_1',
      serviceId: 'openai-codex',
      profileId: 'primary',
      groupId: 'main',
    });
    // Genuinely timing-less group exhaustion (live incident cmq7pyq shape): no
    // retryAtMs, no resetsAtMs anywhere. The in-band path must mirror the
    // scheduler's F0 fix: durable wait at the policy floor, never terminal.
    const handleConnectedServiceRuntimeAuthFailure = vi.fn(async () => ({
      status: 'switch_attempted' as const,
      result: {
        status: 'no_eligible_member' as const,
        generation: 17,
        groupExhausted: true,
        retryAtMs: null,
        excluded: [
          { profileId: 'primary', reason: 'quota_exhausted', retryAtMs: null },
        ],
      },
    }));
    const app = createDaemonControlApp({
      getChildren: () => [],
      machineId: 'machine',
      stopSession: async () => false,
      spawnSession: async () => ({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
        errorMessage: 'unused',
      }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      controlToken: 'token',
      handleConnectedServiceRuntimeAuthFailure,
      runtimeAuthRecoveryScheduler,
    });

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/connected-service-runtime-auth/failure',
        headers: { 'x-happier-daemon-token': 'token' },
        payload: {
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
        },
      });

      expect(response.statusCode).toBe(200);
      // Durable wait at the 30s group-exhausted floor, mirroring the scheduler-side
      // F0 fix — NOT cancelled, so the same key can be re-armed by later reports.
      expect(runtimeAuthRecoveryScheduler.readByKey(recoveryKey)).toMatchObject({
        status: 'waiting',
        nextRetryAtMs: 31_000,
        terminalReason: null,
      });
      expect(diagnostics).not.toContainEqual(expect.objectContaining({
        event: 'runtime_auth_recovery_terminal',
      }));
    } finally {
      await app.close();
    }
  });

  it('re-arms a durable wait with the switch-limit floor instead of terminalizing switch_limit_reached (INC-2)', async () => {
    const diagnostics: RuntimeAuthRecoveryDiagnostic[] = [];
    const runtimeAuthRecoveryScheduler = new RuntimeAuthRecoveryScheduler({
      nowMs: () => 1_000,
      baseBackoffMs: 100,
      maxBackoffMs: 1_000,
      jitterMs: () => 0,
      recover: async () => ({ status: 'credential_refreshed' }),
      recordDiagnostic: (event) => {
        diagnostics.push(event);
      },
    });
    const recoveryKey = buildRuntimeAuthRecoveryKey({
      sessionId: 'sess_1',
      serviceId: 'openai-codex',
      profileId: 'primary',
      groupId: 'main',
    });
    const handleConnectedServiceRuntimeAuthFailure = vi.fn(async () => ({
      status: 'switch_attempted' as const,
      result: {
        status: 'switch_limit_reached' as const,
        limit: 3,
      },
    }));
    const app = createDaemonControlApp({
      getChildren: () => [],
      machineId: 'machine',
      stopSession: async () => false,
      spawnSession: async () => ({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
        errorMessage: 'unused',
      }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      controlToken: 'token',
      handleConnectedServiceRuntimeAuthFailure,
      runtimeAuthRecoveryScheduler,
    });

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/connected-service-runtime-auth/failure',
        headers: { 'x-happier-daemon-token': 'token' },
        payload: {
          sessionId: 'sess_1',
          switchesThisTurn: 3,
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
        },
      });

      expect(response.statusCode).toBe(200);
      // The per-session switch budget frees on a rolling hour window: durable wait
      // on the 5-minute switch-limit floor (INC-2), never a terminal record that
      // blocks re-arming the same key.
      expect(runtimeAuthRecoveryScheduler.readByKey(recoveryKey)).toMatchObject({
        status: 'waiting',
        nextRetryAtMs: 301_000,
        terminalReason: null,
      });
      expect(diagnostics).not.toContainEqual(expect.objectContaining({
        event: 'runtime_auth_recovery_terminal',
      }));
    } finally {
      await app.close();
    }
  });

  it('does NOT clear the recovery intent for a generic ok:true switch result without proof', async () => {
    const markSucceededByKey = vi.fn(async () => ({ status: 'succeeded' }));
    const cancelByKey = vi.fn(async () => ({ status: 'cancelled' }));
    const handleConnectedServiceRuntimeAuthFailure = vi.fn(async () => ({
      status: 'switch_attempted',
      result: {
        ok: true,
        action: 'restart_requested',
      },
    }));
    const app = createDaemonControlApp({
      getChildren: () => [],
      machineId: 'machine',
      stopSession: async () => false,
      spawnSession: async () => ({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
        errorMessage: 'unused',
      }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      controlToken: 'token',
      handleConnectedServiceRuntimeAuthFailure,
      runtimeAuthRecoveryScheduler: { cancelByKey, markSucceededByKey },
    });

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/connected-service-runtime-auth/failure',
        headers: { 'x-happier-daemon-token': 'token' },
        payload: {
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
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        ok: true,
        result: {
          status: 'switch_attempted',
          result: {
            ok: true,
            action: 'restart_requested',
          },
        },
      });
      // No deterministic provider-outcome proof => recovery stays pending.
      expect(markSucceededByKey).not.toHaveBeenCalled();
      expect(cancelByKey).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('terminalizes the matching runtime-auth recovery key when the handler returns action-required', async () => {
    const diagnostics: RuntimeAuthRecoveryDiagnostic[] = [];
    const runtimeAuthRecoveryScheduler = new RuntimeAuthRecoveryScheduler({
      nowMs: () => 1_000,
      baseBackoffMs: 100,
      maxBackoffMs: 1_000,
      jitterMs: () => 0,
      recover: async () => ({ status: 'credential_refreshed' }),
      recordDiagnostic: (event) => {
        diagnostics.push(event);
      },
    });
    const recoveryKey = buildRuntimeAuthRecoveryKey({
      sessionId: 'sess_1',
      serviceId: 'claude-subscription',
      profileId: 'leeroy_new',
      groupId: 'claude',
    });
    const handleConnectedServiceRuntimeAuthFailure = vi.fn(async () => ({
      status: 'recovery_action_required' as const,
      action: {
        kind: 'reconnect_profile' as const,
        serviceId: 'claude-subscription',
        profileId: 'leeroy_new',
        groupId: 'claude',
        reason: 'auth_expired' as const,
      },
    }));
    const app = createDaemonControlApp({
      getChildren: () => [],
      machineId: 'machine',
      stopSession: async () => false,
      spawnSession: async () => ({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
        errorMessage: 'unused',
      }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      controlToken: 'token',
      handleConnectedServiceRuntimeAuthFailure,
      runtimeAuthRecoveryScheduler,
    });

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/connected-service-runtime-auth/failure',
        headers: { 'x-happier-daemon-token': 'token' },
        payload: {
          sessionId: 'sess_1',
          switchesThisTurn: 0,
          classification: {
            kind: 'auth_expired',
            serviceId: 'claude-subscription',
            profileId: 'leeroy_new',
            groupId: 'claude',
            resetsAtMs: null,
            planType: null,
            rateLimits: null,
            source: 'structured_provider_error',
          },
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        ok: true,
        result: {
          status: 'recovery_action_required',
          action: {
            kind: 'reconnect_profile',
            serviceId: 'claude-subscription',
            profileId: 'leeroy_new',
            groupId: 'claude',
            reason: 'auth_expired',
          },
        },
      });
      expect(runtimeAuthRecoveryScheduler.readByKey(recoveryKey)).toMatchObject({
        status: 'cancelled',
        terminalReason: 'recovery_action_required',
      });
      expect(diagnostics).toContainEqual(expect.objectContaining({
        event: 'runtime_auth_recovery_terminal',
        sessionId: 'sess_1',
        serviceId: 'claude-subscription',
        profileId: 'leeroy_new',
        groupId: 'claude',
      }));
    } finally {
      await app.close();
    }
  });

  it('clears the matching runtime-auth recovery key when account adoption is verified', async () => {
    const cancel = vi.fn(async () => ({ status: 'cancelled' }));
    const markSucceededByKey = vi.fn(async () => ({ status: 'succeeded' }));
    const markProviderOutcomeProofByKey = vi.fn(async () => ({ status: 'succeeded' }));
    const cancelByKey = vi.fn(async () => ({ status: 'cancelled' }));
    const handleConnectedServiceRuntimeAuthFailure = vi.fn(async () => ({
      status: 'switch_attempted',
      result: {
        status: 'switched',
        activeProfileId: 'backup',
        generation: 2,
        verificationByServiceId: {
          'openai-codex': { status: 'verified' },
        },
      },
    }));
    const app = createDaemonControlApp({
      getChildren: () => [],
      machineId: 'machine',
      stopSession: async () => false,
      spawnSession: async () => ({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
        errorMessage: 'unused',
      }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      controlToken: 'token',
      handleConnectedServiceRuntimeAuthFailure,
      runtimeAuthRecoveryScheduler: {
        cancel,
        cancelByKey,
        markSucceededByKey,
        markProviderOutcomeProofByKey,
      } as NonNullable<Parameters<typeof createDaemonControlApp>[0]['runtimeAuthRecoveryScheduler']> & {
        markProviderOutcomeProofByKey: typeof markProviderOutcomeProofByKey;
      },
    });

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/connected-service-runtime-auth/failure',
        headers: { 'x-happier-daemon-token': 'token' },
        payload: {
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
        },
      });

      expect(response.statusCode).toBe(200);
      expect(markProviderOutcomeProofByKey).toHaveBeenCalledWith({
        recoveryKey: buildRuntimeAuthRecoveryKey({
          sessionId: 'sess_1',
          serviceId: 'openai-codex',
          profileId: 'primary',
          groupId: 'main',
        }),
        proofKind: 'account_adoption_verified',
      });
      expect(markSucceededByKey).not.toHaveBeenCalled();
      expect(cancel).not.toHaveBeenCalled();
      expect(cancelByKey).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('resolves an exhausted runtime-auth recovery dead-letter when in-band handling returns accepted provider proof', async () => {
    const recoveryClassification: ConnectedServiceRuntimeFailureClassification = {
      kind: 'usage_limit',
      serviceId: 'openai-codex',
      profileId: 'primary',
      groupId: 'main',
      resetsAtMs: null,
      planType: null,
      rateLimits: null,
      source: 'structured_provider_error',
    } as ConnectedServiceRuntimeFailureClassification;
    const diagnostics: RuntimeAuthRecoveryDiagnostic[] = [];
    const runtimeAuthRecoveryScheduler = new RuntimeAuthRecoveryScheduler({
      nowMs: () => 1_000,
      baseBackoffMs: 100,
      maxBackoffMs: 1_000,
      jitterMs: () => 0,
      maxAttempts: 1,
      recover: async () => {
        throw new Error('timeout of 5000ms exceeded');
      },
      recordDiagnostic: (event) => {
        diagnostics.push(event);
      },
    });
    await runtimeAuthRecoveryScheduler.enqueueHandlerFailure({
      sessionId: 'sess_1',
      switchesThisTurn: 0,
      classification: recoveryClassification,
      error: new Error('timeout of 5000ms exceeded'),
    });
    await expect(runtimeAuthRecoveryScheduler.wake({ sessionId: 'sess_1', reason: 'manual' }))
      .resolves.toEqual({ status: 'exhausted' });
    const recoveryKey = buildRuntimeAuthRecoveryKey({
      sessionId: 'sess_1',
      serviceId: 'openai-codex',
      profileId: 'primary',
      groupId: 'main',
    });
    expect(runtimeAuthRecoveryScheduler.readByKey(recoveryKey)).toMatchObject({
      status: 'exhausted',
    });

    const handleConnectedServiceRuntimeAuthFailure = vi.fn(async () => ({
      status: 'switch_attempted',
      result: {
        status: 'switched',
        activeProfileId: 'backup',
        generation: 2,
        verificationByServiceId: {
          'openai-codex': { status: 'verified' },
        },
      },
    }));
    const app = createDaemonControlApp({
      getChildren: () => [],
      machineId: 'machine',
      stopSession: async () => false,
      spawnSession: async () => ({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
        errorMessage: 'unused',
      }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      controlToken: 'token',
      handleConnectedServiceRuntimeAuthFailure,
      runtimeAuthRecoveryScheduler,
    });

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/connected-service-runtime-auth/failure',
        headers: { 'x-happier-daemon-token': 'token' },
        payload: {
          sessionId: 'sess_1',
          switchesThisTurn: 0,
          classification: recoveryClassification,
        },
      });

      expect(response.statusCode).toBe(200);
      expect(runtimeAuthRecoveryScheduler.readByKey(recoveryKey)).toBeNull();
      expect(diagnostics).toContainEqual(expect.objectContaining({
        event: 'runtime_auth_recovery_success',
        reason: 'dead_letter_resolved_by_provider_outcome_proof',
      }));
    } finally {
      await app.close();
    }
  });

  it('actually clears the recovery intent on proven success via a real scheduler (unbound-method regression)', async () => {
    // Regression for the unbound-method bug: controlServer used to extract
    // `scheduler.markSucceededByKey` into a local and call it, losing `this`, so
    // `markSucceededByKey` threw "Cannot read properties of undefined (reading
    // 'readByKey')" — swallowed by `.catch` — and the intent was never cleared.
    // This drives a REAL scheduler instance end-to-end through the control server.
    const recoveryClassification: ConnectedServiceRuntimeFailureClassification = {
      kind: 'usage_limit',
      serviceId: 'openai-codex',
      profileId: 'primary',
      groupId: 'main',
      resetsAtMs: null,
      planType: null,
      rateLimits: null,
      source: 'structured_provider_error',
    } as ConnectedServiceRuntimeFailureClassification;
    const diagnostics: RuntimeAuthRecoveryDiagnostic[] = [];
    const runtimeAuthRecoveryScheduler = new RuntimeAuthRecoveryScheduler({
      nowMs: () => 1_000,
      baseBackoffMs: 100,
      maxBackoffMs: 1_000,
      jitterMs: () => 0,
      // Inner recover never runs in this flow; the control-server success branch
      // clears the pre-armed intent directly.
      recover: async () => ({ status: 'credential_refreshed' }),
      recordDiagnostic: (event) => {
        diagnostics.push(event);
      },
    });
    // Arm a waiting recovery intent that the success branch must clear.
    await runtimeAuthRecoveryScheduler.enqueueHandlerFailure({
      sessionId: 'sess_1',
      switchesThisTurn: 0,
      classification: recoveryClassification,
      error: new Error('timeout of 5000ms exceeded'),
    });
    const recoveryKey = buildRuntimeAuthRecoveryKey({
      sessionId: 'sess_1',
      serviceId: 'openai-codex',
      profileId: 'primary',
      groupId: 'main',
    });
    expect(runtimeAuthRecoveryScheduler.readByKey(recoveryKey)).not.toBeNull();

    // Proven success: switch with verified account adoption.
    const handleConnectedServiceRuntimeAuthFailure = vi.fn(async () => ({
      status: 'switch_attempted',
      result: {
        status: 'switched',
        activeProfileId: 'backup',
        generation: 2,
        verificationByServiceId: {
          'openai-codex': { status: 'verified' },
        },
      },
    }));
    const app = createDaemonControlApp({
      getChildren: () => [],
      machineId: 'machine',
      stopSession: async () => false,
      spawnSession: async () => ({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
        errorMessage: 'unused',
      }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      controlToken: 'token',
      handleConnectedServiceRuntimeAuthFailure,
      runtimeAuthRecoveryScheduler,
    });

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/connected-service-runtime-auth/failure',
        headers: { 'x-happier-daemon-token': 'token' },
        payload: {
          sessionId: 'sess_1',
          switchesThisTurn: 0,
          classification: recoveryClassification,
        },
      });

      expect(response.statusCode).toBe(200);
      // The intent is actually gone, proving markSucceededByKey ran without
      // throwing the unbound-method error.
      expect(runtimeAuthRecoveryScheduler.readByKey(recoveryKey)).toBeNull();
      expect(diagnostics.map((event) => event.event)).toContain('runtime_auth_recovery_success');
    } finally {
      await app.close();
    }
  });

  it('returns a typed recovery failure when runtime auth handling throws', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const handleConnectedServiceRuntimeAuthFailure = vi.fn(async () => {
      throw new Error('switch coordinator crashed');
    });
    const app = createDaemonControlApp({
      getChildren: () => [],
      machineId: 'machine',
      stopSession: async () => false,
      spawnSession: async () => ({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
        errorMessage: 'unused',
      }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      controlToken: 'token',
      handleConnectedServiceRuntimeAuthFailure,
    });

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/connected-service-runtime-auth/failure',
        headers: { 'x-happier-daemon-token': 'token' },
        payload: {
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
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        ok: true,
        result: {
          status: 'recovery_handler_failed',
          errorCode: 'unexpected_error',
        },
      });
      expect(warnSpy).toHaveBeenCalledWith(
        '[CONTROL SERVER] Connected-service runtime auth failure handler failed',
        expect.objectContaining({
          sessionId: 'sess_1',
          serviceId: 'openai-codex',
          kind: 'usage_limit',
        }),
      );
    } finally {
      warnSpy.mockRestore();
      await app.close();
    }
  });

  it('preserves generation apply failure results when recovery scheduling fails', async () => {
    const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => {});
    const handleConnectedServiceRuntimeAuthFailure = vi.fn(async () => ({
      status: 'switch_attempted',
      result: {
        status: 'generation_apply_failed',
        activeProfileId: 'backup',
        generation: 2,
        errorCode: 'post_switch_verification_failed',
      },
    }));
    const enqueueApplyFailure = vi.fn(async () => {
      throw new Error('intent store unavailable');
    });
    const app = createDaemonControlApp({
      getChildren: () => [],
      machineId: 'machine',
      stopSession: async () => false,
      spawnSession: async () => ({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
        errorMessage: 'unused',
      }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      controlToken: 'token',
      handleConnectedServiceRuntimeAuthFailure,
      runtimeAuthRecoveryScheduler: { enqueueApplyFailure },
    });

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/connected-service-runtime-auth/failure',
        headers: { 'x-happier-daemon-token': 'token' },
        payload: {
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
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        ok: true,
        result: {
          status: 'switch_attempted',
          result: {
            status: 'generation_apply_failed',
            activeProfileId: 'backup',
            generation: 2,
            errorCode: 'post_switch_verification_failed',
          },
        },
      });
      expect(enqueueApplyFailure).toHaveBeenCalled();
      expect(debugSpy).toHaveBeenCalledWith(
        '[CONTROL SERVER] Connected-service runtime auth recovery scheduling failed after apply failure',
        expect.objectContaining({ sessionId: 'sess_1' }),
      );
    } finally {
      debugSpy.mockRestore();
      await app.close();
    }
  });

  it('returns scheduled runtime-auth recovery diagnostics with retry metadata', async () => {
    const handleConnectedServiceRuntimeAuthFailure = vi.fn(async () => ({
      status: 'switch_attempted',
      result: {
        status: 'generation_apply_failed',
        activeProfileId: 'backup',
        generation: 2,
        errorCode: 'hot_apply_failed',
      },
    }));
    const enqueueApplyFailure = vi.fn(async () => ({
      status: 'scheduled',
      retryable: true,
      nextRetryAtMs: 1_700_000_100_000,
    }));
    const app = createDaemonControlApp({
      getChildren: () => [],
      machineId: 'machine',
      stopSession: async () => false,
      spawnSession: async () => ({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
        errorMessage: 'unused',
      }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      controlToken: 'token',
      handleConnectedServiceRuntimeAuthFailure,
      runtimeAuthRecoveryScheduler: { enqueueApplyFailure },
    });

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/connected-service-runtime-auth/failure',
        headers: { 'x-happier-daemon-token': 'token' },
        payload: {
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
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        ok: true,
        result: {
          status: 'recovery_retry_scheduled',
          recovery: {
            status: 'scheduled',
            retryable: true,
            nextRetryAtMs: 1_700_000_100_000,
          },
          uxDiagnostic: {
            code: 'recovery_retry_scheduled',
            failurePhase: 'runtime_auth_recovery',
            source: 'runtime_auth_recovery',
            serviceId: 'openai-codex',
            profileId: 'primary',
            groupId: 'main',
            retryable: true,
            diagnostics: {
              runtimeFailureKind: 'usage_limit',
              classificationSource: 'structured_provider_error',
              nextRetryAtMs: 1_700_000_100_000,
            },
          },
        },
      });
    } finally {
      await app.close();
    }
  });

  it.each([
    {
      name: 'exhausted',
      recovery: {
        status: 'exhausted',
        retryable: false,
        attemptCount: 5,
        lastError: 'max_attempts_exhausted',
      },
      expectedStatus: 'recovery_dead_lettered',
    },
    {
      name: 'cancelled',
      recovery: {
        status: 'cancelled',
        retryable: false,
      },
      expectedStatus: 'recovery_cancelled',
    },
    {
      name: 'terminal non-retry',
      recovery: {
        status: 'terminal_non_retry',
        retryable: false,
      },
      expectedStatus: 'recovery_terminal',
    },
  ])('surfaces terminal apply-failure recovery scheduling results: $name', async ({
    recovery,
    expectedStatus,
  }) => {
    const originalResult = {
      status: 'switch_attempted',
      result: {
        status: 'generation_apply_failed',
        activeProfileId: 'backup',
        generation: 2,
        errorCode: 'hot_apply_failed',
      },
    };
    const handleConnectedServiceRuntimeAuthFailure = vi.fn(async () => originalResult);
    const enqueueApplyFailure = vi.fn(async () => recovery);
    const app = createDaemonControlApp({
      getChildren: () => [],
      machineId: 'machine',
      stopSession: async () => false,
      spawnSession: async () => ({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
        errorMessage: 'unused',
      }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      controlToken: 'token',
      handleConnectedServiceRuntimeAuthFailure,
      runtimeAuthRecoveryScheduler: { enqueueApplyFailure },
    });

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/connected-service-runtime-auth/failure',
        headers: { 'x-happier-daemon-token': 'token' },
        payload: {
          sessionId: 'sess_1',
          switchesThisTurn: 1,
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
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        ok: true,
        result: {
          status: expectedStatus,
          recovery,
          originalResult,
          terminal: true,
        },
      });
      expect(response.json().result.status).not.toBe('switch_attempted');
      expect(response.json().result.status).not.toBe('recovery_retry_scheduled');
      expect(handleConnectedServiceRuntimeAuthFailure).toHaveBeenCalledTimes(1);
      expect(enqueueApplyFailure).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  it.each([
    {
      name: 'exhausted',
      recovery: {
        status: 'exhausted',
        retryable: false,
        attemptCount: 5,
        lastError: 'max_attempts_exhausted',
      },
      expectedStatus: 'recovery_dead_lettered',
    },
    {
      name: 'cancelled',
      recovery: {
        status: 'cancelled',
        retryable: false,
      },
      expectedStatus: 'recovery_cancelled',
    },
    {
      name: 'terminal non-retry',
      recovery: {
        status: 'terminal_non_retry',
        retryable: false,
      },
      expectedStatus: 'recovery_terminal',
    },
  ])('surfaces terminal handler-failure recovery scheduling results: $name', async ({
    recovery,
    expectedStatus,
  }) => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const handleConnectedServiceRuntimeAuthFailure = vi.fn(async () => {
      throw new Error('switch coordinator crashed');
    });
    const enqueueHandlerFailure = vi.fn(async () => recovery);
    const app = createDaemonControlApp({
      getChildren: () => [],
      machineId: 'machine',
      stopSession: async () => false,
      spawnSession: async () => ({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
        errorMessage: 'unused',
      }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      controlToken: 'token',
      handleConnectedServiceRuntimeAuthFailure,
      runtimeAuthRecoveryScheduler: { enqueueHandlerFailure },
    });

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/connected-service-runtime-auth/failure',
        headers: { 'x-happier-daemon-token': 'token' },
        payload: {
          sessionId: 'sess_1',
          switchesThisTurn: 1,
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
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        ok: true,
        result: {
          status: expectedStatus,
          recovery,
          terminal: true,
        },
      });
      expect(response.json().result.status).not.toBe('recovery_handler_failed');
      expect(response.json().result.status).not.toBe('recovery_retry_scheduled');
      expect(handleConnectedServiceRuntimeAuthFailure).toHaveBeenCalledTimes(1);
      expect(enqueueHandlerFailure).toHaveBeenCalledTimes(1);
    } finally {
      warnSpy.mockRestore();
      await app.close();
    }
  });

  it.each([
    {
      name: 'exhausted',
      prepare: async (input: Readonly<{
        scheduler: RuntimeAuthRecoveryScheduler;
        sessionId: string;
        classification: ConnectedServiceRuntimeFailureClassification;
        applyFailure: unknown;
      }>) => {
        await input.scheduler.enqueueApplyFailure({
          sessionId: input.sessionId,
          switchesThisTurn: 1,
          classification: input.classification,
          result: input.applyFailure,
        });
        await expect(input.scheduler.wake({ sessionId: input.sessionId, reason: 'manual' }))
          .resolves.toEqual({ status: 'exhausted' });
      },
      expectedStatus: 'recovery_dead_lettered',
      expectedRecoveryStatus: 'exhausted',
      expectedDeadLetterEvents: 1,
    },
    {
      name: 'cancelled',
      prepare: async (input: Readonly<{
        scheduler: RuntimeAuthRecoveryScheduler;
        sessionId: string;
        classification: ConnectedServiceRuntimeFailureClassification;
        applyFailure: unknown;
      }>) => {
        await input.scheduler.enqueueApplyFailure({
          sessionId: input.sessionId,
          switchesThisTurn: 1,
          classification: input.classification,
          result: input.applyFailure,
        });
        await input.scheduler.cancelByKey(buildRuntimeAuthRecoveryKey({
          sessionId: input.sessionId,
          serviceId: input.classification.serviceId,
          profileId: input.classification.profileId,
          groupId: input.classification.groupId,
        }));
      },
      expectedStatus: 'recovery_cancelled',
      expectedRecoveryStatus: 'cancelled',
      expectedDeadLetterEvents: 0,
    },
  ])('does not re-emit a terminal transcript event for an already $name recovery', async ({
    prepare,
    expectedStatus,
    expectedRecoveryStatus,
    expectedDeadLetterEvents,
  }) => {
    const sessionId = 'sess_1';
    const classification = {
      kind: 'usage_limit',
      serviceId: 'openai-codex',
      profileId: 'primary',
      groupId: 'main',
      resetsAtMs: null,
      planType: null,
      rateLimits: null,
      source: 'structured_provider_error',
    } satisfies ConnectedServiceRuntimeFailureClassification;
    const applyFailure = {
      status: 'generation_apply_failed',
      errorCode: 'hot_apply_failed',
      diagnostics: {
        underlyingError: 'timeout of 5000ms exceeded',
      },
    };
    const diagnostics: RuntimeAuthRecoveryDiagnostic[] = [];
    const scheduler = new RuntimeAuthRecoveryScheduler({
      nowMs: () => 1_000,
      baseBackoffMs: 100,
      maxBackoffMs: 1_000,
      jitterMs: () => 0,
      maxAttempts: 1,
      recover: async () => applyFailure,
      recordDiagnostic: (event) => {
        diagnostics.push(event);
      },
    });
    await prepare({ scheduler, sessionId, classification, applyFailure });

    const handleConnectedServiceRuntimeAuthFailure = vi.fn(async () => ({
      status: 'switch_attempted',
      result: applyFailure,
    }));
    const app = createDaemonControlApp({
      getChildren: () => [],
      machineId: 'machine',
      stopSession: async () => false,
      spawnSession: async () => ({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
        errorMessage: 'unused',
      }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      controlToken: 'token',
      handleConnectedServiceRuntimeAuthFailure,
      runtimeAuthRecoveryScheduler: scheduler,
    });

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/connected-service-runtime-auth/failure',
        headers: { 'x-happier-daemon-token': 'token' },
        payload: {
          sessionId,
          switchesThisTurn: 2,
          classification,
        },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toMatchObject({
        ok: true,
        result: {
          status: expectedStatus,
          recovery: {
            status: expectedRecoveryStatus,
            retryable: false,
          },
          originalResult: {
            status: 'switch_attempted',
            result: applyFailure,
          },
          terminal: true,
        },
      });
      expect(body.result).not.toHaveProperty('transcriptEvent');
      expect(diagnostics.filter((event) => (
        event.event === 'runtime_auth_recovery_dead_letter' && event.transcriptEvent
      ))).toHaveLength(expectedDeadLetterEvents);
      expect(handleConnectedServiceRuntimeAuthFailure).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  it('returns typed handler failures when handler recovery scheduling also fails', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => {});
    const handleConnectedServiceRuntimeAuthFailure = vi.fn(async () => {
      throw new Error('switch coordinator crashed');
    });
    const enqueueHandlerFailure = vi.fn(async () => {
      throw new Error('intent store unavailable');
    });
    const app = createDaemonControlApp({
      getChildren: () => [],
      machineId: 'machine',
      stopSession: async () => false,
      spawnSession: async () => ({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
        errorMessage: 'unused',
      }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      controlToken: 'token',
      handleConnectedServiceRuntimeAuthFailure,
      runtimeAuthRecoveryScheduler: { enqueueHandlerFailure },
    });

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/connected-service-runtime-auth/failure',
        headers: { 'x-happier-daemon-token': 'token' },
        payload: {
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
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        ok: true,
        result: {
          status: 'recovery_handler_failed',
          errorCode: 'unexpected_error',
        },
      });
      expect(enqueueHandlerFailure).toHaveBeenCalled();
      expect(debugSpy).toHaveBeenCalledWith(
        '[CONTROL SERVER] Connected-service runtime auth recovery scheduling failed after handler failure',
        expect.objectContaining({ sessionId: 'sess_1' }),
      );
    } finally {
      debugSpy.mockRestore();
      warnSpy.mockRestore();
      await app.close();
    }
  });

  it('sanitizes raw handler error messages before logging runtime auth diagnostics', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const handleConnectedServiceRuntimeAuthFailure = vi.fn(async () => {
      throw new Error('refresh failed Bearer raw-secret-token accessToken=raw-access-token');
    });
    const app = createDaemonControlApp({
      getChildren: () => [],
      machineId: 'machine',
      stopSession: async () => false,
      spawnSession: async () => ({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
        errorMessage: 'unused',
      }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      controlToken: 'token',
      handleConnectedServiceRuntimeAuthFailure,
    });

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/connected-service-runtime-auth/failure',
        headers: { 'x-happier-daemon-token': 'token' },
        payload: {
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
        },
      });

      expect(response.statusCode).toBe(200);
      const logged = JSON.stringify(warnSpy.mock.calls);
      expect(logged).not.toContain('raw-secret-token');
      expect(logged).not.toContain('raw-access-token');
      expect(logged).toContain('[REDACTED]');
    } finally {
      warnSpy.mockRestore();
      await app.close();
    }
  });

  it('dispatches reported in-band quota snapshots to the daemon handler', async () => {
    const handleConnectedServiceQuotaSnapshot = vi.fn(async () => ({
      status: 'recorded',
    }));
    const app = createDaemonControlApp({
      getChildren: () => [],
      machineId: 'machine',
      stopSession: async () => false,
      spawnSession: async () => ({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
        errorMessage: 'unused',
      }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      controlToken: 'token',
      handleConnectedServiceQuotaSnapshot,
    });

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/connected-service-quota-snapshot',
        headers: { 'x-happier-daemon-token': 'token' },
        payload: {
          sessionId: 'sess_1',
          serviceId: 'openai-codex',
          groupId: 'main',
          groupGeneration: 7,
          snapshot: {
            v: 1,
            serviceId: 'openai-codex',
            profileId: 'primary',
            fetchedAt: 1_000,
            staleAfterMs: 300_000,
            planLabel: 'pro',
            accountLabel: null,
            meters: [],
          },
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        ok: true,
        result: { status: 'recorded' },
      });
      expect(handleConnectedServiceQuotaSnapshot).toHaveBeenCalledWith({
        sessionId: 'sess_1',
        serviceId: 'openai-codex',
        groupId: 'main',
        groupGeneration: 7,
        snapshot: expect.objectContaining({
          serviceId: 'openai-codex',
          profileId: 'primary',
        }),
      });
    } finally {
      await app.close();
    }
  });

  it('dispatches connected-service recovery credit consume requests to the daemon handler', async () => {
    const handleConnectedServiceQuotaRecoveryCreditConsume = vi.fn(async () => ({
      ok: true,
      snapshot: null,
      receipt: {
        idempotencyKey: 'reset-req-1',
        providerCreditId: 'credit-1',
        status: 'consumed',
      },
    }));
    const app = createDaemonControlApp({
      getChildren: () => [],
      machineId: 'machine',
      stopSession: async () => false,
      spawnSession: async () => ({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
        errorMessage: 'unused',
      }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      controlToken: 'token',
      handleConnectedServiceQuotaRecoveryCreditConsume,
    });

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/connected-service-quota-recovery-credit/consume',
        headers: { 'x-happier-daemon-token': 'token' },
        payload: {
          serviceId: 'openai-codex',
          profileId: 'primary',
          idempotencyKey: 'reset-req-1',
          providerCreditId: 'credit-1',
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        ok: true,
        result: {
          ok: true,
          snapshot: null,
          receipt: {
            idempotencyKey: 'reset-req-1',
            providerCreditId: 'credit-1',
            status: 'consumed',
          },
        },
      });
      expect(handleConnectedServiceQuotaRecoveryCreditConsume).toHaveBeenCalledWith({
        serviceId: 'openai-codex',
        profileId: 'primary',
        idempotencyKey: 'reset-req-1',
        providerCreditId: 'credit-1',
      });
    } finally {
      await app.close();
    }
  });

  it('rejects in-band quota producers while the daemon is shutting down', async () => {
    const handleConnectedServiceQuotaSnapshot = vi.fn(async () => ({ status: 'recorded' }));
    const handleConnectedServiceQuotaRecoveryCreditConsume = vi.fn(async () => ({ ok: true, snapshot: null }));
    const app = createDaemonControlApp({
      getChildren: () => [],
      machineId: 'machine',
      stopSession: async () => false,
      spawnSession: async () => ({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
        errorMessage: 'unused',
      }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      controlToken: 'token',
      isShuttingDown: () => true,
      handleConnectedServiceQuotaSnapshot,
      handleConnectedServiceQuotaRecoveryCreditConsume,
    });

    try {
      const snapshotResponse = await app.inject({
        method: 'POST',
        url: '/connected-service-quota-snapshot',
        headers: { 'x-happier-daemon-token': 'token' },
        payload: {
          sessionId: 'sess_1',
          serviceId: 'openai-codex',
          snapshot: {
            v: 1,
            serviceId: 'openai-codex',
            profileId: 'primary',
            fetchedAt: 1_000,
            staleAfterMs: 300_000,
            planLabel: 'pro',
            accountLabel: null,
            meters: [],
          },
        },
      });
      const consumeResponse = await app.inject({
        method: 'POST',
        url: '/connected-service-quota-recovery-credit/consume',
        headers: { 'x-happier-daemon-token': 'token' },
        payload: {
          serviceId: 'openai-codex',
          profileId: 'primary',
          idempotencyKey: 'reset-req-1',
        },
      });

      expect(snapshotResponse.statusCode).toBe(503);
      expect(snapshotResponse.json()).toEqual({
        ok: false,
        errorCode: 'daemon_shutting_down',
      });
      expect(consumeResponse.statusCode).toBe(503);
      expect(consumeResponse.json()).toEqual({
        ok: false,
        errorCode: 'daemon_shutting_down',
      });
      expect(handleConnectedServiceQuotaSnapshot).not.toHaveBeenCalled();
      expect(handleConnectedServiceQuotaRecoveryCreditConsume).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('rejects in-band quota snapshots with mismatched service ids before dispatching', async () => {
    const handleConnectedServiceQuotaSnapshot = vi.fn(async () => ({
      status: 'recorded',
    }));
    const app = createDaemonControlApp({
      getChildren: () => [],
      machineId: 'machine',
      stopSession: async () => false,
      spawnSession: async () => ({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
        errorMessage: 'unused',
      }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      controlToken: 'token',
      handleConnectedServiceQuotaSnapshot,
    });

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/connected-service-quota-snapshot',
        headers: { 'x-happier-daemon-token': 'token' },
        payload: {
          sessionId: 'sess_1',
          serviceId: 'openai-codex',
          snapshot: {
            v: 1,
            serviceId: 'claude-subscription',
            profileId: 'native:1234567890abcdef1234567890abcdef1234567890abcdef',
            fetchedAt: 1_000,
            staleAfterMs: 300_000,
            providerId: 'claude',
            planLabel: null,
            accountLabel: null,
            meters: [],
          },
        },
      });

      expect(response.statusCode).toBe(400);
      expect(handleConnectedServiceQuotaSnapshot).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('dispatches session turn lifecycle events to the daemon handler', async () => {
    const handleConnectedServiceTurnLifecycle = vi.fn(async () => ({ ok: true }));
    const app = createDaemonControlApp({
      getChildren: () => [],
      machineId: 'machine',
      stopSession: async () => false,
      spawnSession: async () => ({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
        errorMessage: 'unused',
      }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      controlToken: 'token',
      handleConnectedServiceTurnLifecycle,
    });

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/connected-service-turn-lifecycle',
        headers: { 'x-happier-daemon-token': 'token' },
        payload: {
          sessionId: 'sess_1',
          event: 'task_started',
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        ok: true,
        result: { ok: true },
      });
      expect(handleConnectedServiceTurnLifecycle).toHaveBeenCalledWith({
        sessionId: 'sess_1',
        event: 'task_started',
      });
    } finally {
      await app.close();
    }
  });

  // QAE-1: user "Stop waiting" must clear the daemon-side durable recovery wait
  // state regardless of provider runtime controls; runners notify this endpoint.
  it('dispatches usage-limit wait-resume cancels to the daemon recovery owner', async () => {
    const handleConnectedServiceUsageLimitWaitResumeCancel = vi.fn(async () => ({ ok: true }));
    const app = createDaemonControlApp({
      getChildren: () => [],
      machineId: 'machine',
      stopSession: async () => false,
      spawnSession: async () => ({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
        errorMessage: 'unused',
      }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      controlToken: 'token',
      handleConnectedServiceUsageLimitWaitResumeCancel,
    });

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/connected-service-usage-limit/wait-resume-cancel',
        headers: { 'x-happier-daemon-token': 'token' },
        payload: { sessionId: 'sess_1' },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        ok: true,
        result: { ok: true },
      });
      expect(handleConnectedServiceUsageLimitWaitResumeCancel).toHaveBeenCalledWith({
        sessionId: 'sess_1',
      });
    } finally {
      await app.close();
    }
  });

  it('returns 501 for usage-limit wait-resume cancels when no daemon handler is wired', async () => {
    const app = createDaemonControlApp({
      getChildren: () => [],
      machineId: 'machine',
      stopSession: async () => false,
      spawnSession: async () => ({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
        errorMessage: 'unused',
      }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      controlToken: 'token',
    });

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/connected-service-usage-limit/wait-resume-cancel',
        headers: { 'x-happier-daemon-token': 'token' },
        payload: { sessionId: 'sess_1' },
      });
      expect(response.statusCode).toBe(501);
      expect(response.json()).toEqual({
        ok: false,
        errorCode: 'connected_service_usage_limit_wait_resume_cancel_handler_unavailable',
      });
    } finally {
      await app.close();
    }
  });

  it('dispatches Codex ChatGPT refresh bridge requests to the daemon handler', async () => {
    const handleCodexChatGptAuthTokensRefresh = vi.fn(async () => ({
      accessToken: 'fresh-access',
      chatgptAccountId: 'acct_123',
      chatgptPlanType: 'plus',
    }));
    const app = createDaemonControlApp({
      getChildren: () => [],
      machineId: 'machine',
      stopSession: async () => false,
      spawnSession: async () => ({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
        errorMessage: 'unused',
      }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      controlToken: 'token',
      handleCodexChatGptAuthTokensRefresh,
    });

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/connected-service-auth/openai-codex/chatgpt-auth-tokens/refresh',
        // SEC-F1: session-mode (sessionId, no broker identity) requires the MASTER control token —
        // the credential runner processes actually hold. The scoped broker token is identity-mode only.
        headers: { 'x-happier-daemon-token': 'token' },
        payload: {
          sessionId: 'sess_1',
          selection: {
            kind: 'group',
            serviceId: 'openai-codex',
            groupId: 'main',
            activeProfileId: 'backup',
            fallbackProfileId: 'work',
            generation: 7,
          },
          chatgptPlanType: 'plus',
          forceRefresh: false,
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        ok: true,
        result: {
          accessToken: 'fresh-access',
          chatgptAccountId: 'acct_123',
          chatgptPlanType: 'plus',
        },
      });
      expect(response.json().result).not.toHaveProperty('refreshToken');
      expect(handleCodexChatGptAuthTokensRefresh).toHaveBeenCalledWith({
        sessionId: 'sess_1',
        brokerSelectionIdentity: null,
        selection: {
          kind: 'group',
          serviceId: 'openai-codex',
          groupId: 'main',
          activeProfileId: 'backup',
          fallbackProfileId: 'work',
          generation: 7,
        },
        chatgptPlanType: 'plus',
        forceRefresh: false,
        failingAccessTokenFingerprint: null,
      });
    } finally {
      await app.close();
    }
  });

  it('returns 403 when the bridge handler rejects the session selection authorization', async () => {
    const handleCodexChatGptAuthTokensRefresh = vi.fn(async () => {
      throw new Error('connected_service_bridge_selection_not_authorized');
    });
    const app = createDaemonControlApp({
      getChildren: () => [],
      machineId: 'machine',
      stopSession: async () => false,
      spawnSession: async () => ({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
        errorMessage: 'unused',
      }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      controlToken: 'token',
      handleCodexChatGptAuthTokensRefresh,
    });

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/connected-service-auth/openai-codex/chatgpt-auth-tokens/refresh',
        headers: { 'x-happier-daemon-token': BROKER_SCOPED_TOKEN },
        payload: {
          sessionId: 'sess_1',
          selection: { kind: 'profile', serviceId: 'openai-codex', profileId: 'other-profile' },
          chatgptPlanType: 'plus',
        },
      });

      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({
        ok: false,
        errorCode: 'connected_service_bridge_selection_not_authorized',
      });
    } finally {
      await app.close();
    }
  });

  it('resolves the effective broker selection by selection identity before dispatching refresh handlers', async () => {
    resetBrokerBridgeEffectiveSelectionsForTests();
    const updated = updateBrokerBridgeEffectiveSelection({
      selectionIdentity: 'opencode|connected|broker:1|openai-codex:acct-old:',
      serviceId: 'openai-codex',
      selection: {
        kind: 'group',
        serviceId: 'openai-codex',
        groupId: 'main',
        activeProfileId: 'profile-new',
        fallbackProfileId: 'profile-old',
        generation: 15,
      },
    });
    const handleCodexChatGptAuthTokensRefresh = vi.fn(async () => ({
      accessToken: 'fresh-access',
      chatgptAccountId: 'acct_new',
      chatgptPlanType: 'plus',
    }));
    const app = createDaemonControlApp({
      getChildren: () => [],
      machineId: 'machine',
      stopSession: async () => false,
      spawnSession: async () => ({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
        errorMessage: 'unused',
      }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      controlToken: 'token',
      handleCodexChatGptAuthTokensRefresh,
    });

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/connected-service-auth/openai-codex/chatgpt-auth-tokens/refresh',
        headers: { 'x-happier-daemon-token': BROKER_SCOPED_TOKEN },
        payload: {
          sessionId: 'opencode-broker:openai:1',
          selectionIdentity: 'opencode|connected|broker:1|openai-codex:acct-old:',
          selection: {
            kind: 'profile',
            serviceId: 'openai-codex',
            profileId: 'profile-old',
          },
          chatgptPlanType: 'plus',
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        ok: true,
        result: {
          accessToken: 'fresh-access',
          chatgptAccountId: 'acct_new',
          chatgptPlanType: 'plus',
          selectionEpoch: updated.selectionEpoch,
        },
      });
      expect(handleCodexChatGptAuthTokensRefresh).toHaveBeenCalledWith({
        sessionId: 'opencode-broker:openai:1',
        brokerSelectionIdentity: 'opencode|connected|broker:1|openai-codex:acct-old:',
        selection: {
          kind: 'group',
          serviceId: 'openai-codex',
          groupId: 'main',
          activeProfileId: 'profile-new',
          fallbackProfileId: 'profile-old',
          generation: 15,
        },
        chatgptPlanType: 'plus',
        forceRefresh: false,
        failingAccessTokenFingerprint: null,
      });
    } finally {
      await app.close();
      resetBrokerBridgeEffectiveSelectionsForTests();
    }
  });

  it('rejects Codex ChatGPT refresh bridge payloads with invalid group ids before they reach the handler', async () => {
    const handleCodexChatGptAuthTokensRefresh = vi.fn(async () => ({
      accessToken: 'fresh-access',
      chatgptAccountId: 'acct_123',
      chatgptPlanType: 'plus',
    }));
    const app = createDaemonControlApp({
      getChildren: () => [],
      machineId: 'machine',
      stopSession: async () => false,
      spawnSession: async () => ({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
        errorMessage: 'unused',
      }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      controlToken: 'token',
      handleCodexChatGptAuthTokensRefresh,
    });

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/connected-service-auth/openai-codex/chatgpt-auth-tokens/refresh',
        headers: { 'x-happier-daemon-token': BROKER_SCOPED_TOKEN },
        payload: {
          sessionId: 'sess_1',
          selection: {
            kind: 'group',
            serviceId: 'openai-codex',
            groupId: '../escape',
            activeProfileId: 'backup',
            fallbackProfileId: 'work',
            generation: 7,
          },
          chatgptPlanType: 'plus',
        },
      });

      expect(response.statusCode).toBe(400);
      expect(handleCodexChatGptAuthTokensRefresh).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('dispatches Claude subscription Anthropic refresh bridge requests to the daemon handler (access-only response)', async () => {
    const handleClaudeSubscriptionAuthTokensRefresh = vi.fn(async () => ({
      accessToken: 'fresh-claude-access',
      anthropicAccountId: 'anthropic-acct',
      expiresAt: 123_456,
    }));
    const app = createDaemonControlApp({
      getChildren: () => [],
      machineId: 'machine',
      stopSession: async () => false,
      spawnSession: async () => ({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
        errorMessage: 'unused',
      }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      controlToken: 'token',
      handleClaudeSubscriptionAuthTokensRefresh,
    });

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/connected-service-auth/claude-subscription/anthropic-auth-tokens/refresh',
        // SEC-F1: session-mode requires the MASTER control token (see codex twin above).
        headers: { 'x-happier-daemon-token': 'token' },
        payload: {
          sessionId: 'sess_1',
          selection: {
            kind: 'group',
            serviceId: 'claude-subscription',
            groupId: 'main',
            activeProfileId: 'backup',
            fallbackProfileId: 'work',
            generation: 7,
          },
          forceRefresh: true,
        },
      });

      expect(response.statusCode).toBe(200);
      // The bridge returns ONLY the access token (+ non-secret account/expiry); never a refresh token.
      expect(response.json()).toEqual({
        ok: true,
        result: {
          accessToken: 'fresh-claude-access',
          anthropicAccountId: 'anthropic-acct',
          expiresAt: 123_456,
        },
      });
      expect(response.json().result).not.toHaveProperty('refreshToken');
      expect(handleClaudeSubscriptionAuthTokensRefresh).toHaveBeenCalledWith({
        sessionId: 'sess_1',
        brokerSelectionIdentity: null,
        selection: {
          kind: 'group',
          serviceId: 'claude-subscription',
          groupId: 'main',
          activeProfileId: 'backup',
          fallbackProfileId: 'work',
          generation: 7,
        },
        forceRefresh: true,
        failingAccessTokenFingerprint: null,
      });
    } finally {
      await app.close();
    }
  });

  it('SEC-F1: bridge auth is principal-discriminated — missing/wrong tokens 401; scoped token without a broker identity 403; scoped token with identity accepted', async () => {
    // Security boundary (no-leak, plan §5 item 6 / Lane C + F2 least privilege): the access-token
    // bridges MUST reject any call lacking the SCOPED broker-refresh token and never run the refresh
    // handler. A missing token, a wrong token, AND the broad MASTER control token all fail closed with
    // 401 before the handler can mint/return an access token — only the scoped capability token passes.
    const handleCodexChatGptAuthTokensRefresh = vi.fn(async () => ({
      accessToken: 'must-not-be-minted',
      chatgptAccountId: null,
      chatgptPlanType: null,
    }));
    const handleClaudeSubscriptionAuthTokensRefresh = vi.fn(async () => ({
      accessToken: 'must-not-be-minted',
      anthropicAccountId: null,
      expiresAt: null,
    }));
    const app = createDaemonControlApp({
      getChildren: () => [],
      machineId: 'machine',
      stopSession: async () => false,
      spawnSession: async () => ({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
        errorMessage: 'unused',
      }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      controlToken: 'token',
      handleCodexChatGptAuthTokensRefresh,
      handleClaudeSubscriptionAuthTokensRefresh,
    });

    try {
      const cases: ReadonlyArray<{ url: string; headers: Record<string, string> }> = [
        // SEC-F1: the master token is a valid SESSION-MODE credential on the bridge routes (it is a
        // strict privilege superset of this control surface) — its acceptance is pinned by the
        // dispatch tests above. Missing/wrong tokens stay 401.
        { url: '/connected-service-auth/claude-subscription/anthropic-auth-tokens/refresh', headers: {} },
        { url: '/connected-service-auth/claude-subscription/anthropic-auth-tokens/refresh', headers: { 'x-happier-daemon-token': 'wrong' } },
        { url: '/connected-service-auth/openai-codex/chatgpt-auth-tokens/refresh', headers: {} },
        { url: '/connected-service-auth/openai-codex/chatgpt-auth-tokens/refresh', headers: { 'x-happier-daemon-token': 'wrong' } },
      ];
      for (const testCase of cases) {
        const response = await app.inject({
          method: 'POST',
          url: testCase.url,
          headers: testCase.headers,
          payload: {
            sessionId: 'sess_1',
            selection: { kind: 'profile', serviceId: testCase.url.includes('claude') ? 'claude-subscription' : 'openai-codex', profileId: 'work' },
          },
        });
        expect(response.statusCode).toBe(401);
        expect(response.json()).toEqual({ success: false, error: 'Unauthorized' });
      }
      expect(handleClaudeSubscriptionAuthTokensRefresh).not.toHaveBeenCalled();
      expect(handleCodexChatGptAuthTokensRefresh).not.toHaveBeenCalled();

      // SEC-F1: the SCOPED broker token is IDENTITY-MODE ONLY. A scoped-token holder naming a
      // sessionId without a broker selection identity is rejected BEFORE the handler runs —
      // otherwise a leaked broker token could name a live victim session and receive that
      // session's refreshed access token.
      const scopedSessionOnly = await app.inject({
        method: 'POST',
        url: '/connected-service-auth/openai-codex/chatgpt-auth-tokens/refresh',
        headers: { 'x-happier-daemon-token': BROKER_SCOPED_TOKEN },
        payload: { sessionId: 'sess_victim', selection: { kind: 'profile', serviceId: 'openai-codex', profileId: 'work' } },
      });
      expect(scopedSessionOnly.statusCode).toBe(403);
      expect(scopedSessionOnly.json()).toEqual({ ok: false, errorCode: 'connected_service_bridge_selection_not_authorized' });
      const scopedSessionOnlyClaude = await app.inject({
        method: 'POST',
        url: '/connected-service-auth/claude-subscription/anthropic-auth-tokens/refresh',
        headers: { 'x-happier-daemon-token': BROKER_SCOPED_TOKEN },
        payload: { sessionId: 'sess_victim', selection: { kind: 'profile', serviceId: 'claude-subscription', profileId: 'work' } },
      });
      expect(scopedSessionOnlyClaude.statusCode).toBe(403);
      expect(handleCodexChatGptAuthTokensRefresh).not.toHaveBeenCalled();
      expect(handleClaudeSubscriptionAuthTokensRefresh).not.toHaveBeenCalled();

      // The SCOPED token WITH a broker selection identity is accepted (identity-mode).
      const ok = await app.inject({
        method: 'POST',
        url: '/connected-service-auth/openai-codex/chatgpt-auth-tokens/refresh',
        headers: { 'x-happier-daemon-token': BROKER_SCOPED_TOKEN },
        payload: {
          sessionId: 'opencode-broker:openai:1',
          selectionIdentity: 'opencode|connected|broker:1|openai-codex:work:',
          selection: { kind: 'profile', serviceId: 'openai-codex', profileId: 'work' },
        },
      });
      expect(ok.statusCode).toBe(200);
      expect(handleCodexChatGptAuthTokensRefresh).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  it('records the broker load handshake under the SCOPED token and exposes it via the loaded-status query (F4)', async () => {
    resetOpenCodeBrokerLoadHandshakesForTests();
    const app = createDaemonControlApp({
      getChildren: () => [],
      machineId: 'machine',
      stopSession: async () => false,
      spawnSession: async () => ({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
        errorMessage: 'unused',
      }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      controlToken: 'token',
    });

    try {
      const identity = 'opencode|connected|broker:1|openai-codex:p:';
      const loadNonce = 'spawn-control-server-test';

      // Before any handshake, loaded-status (master-token query) reports not-observed.
      const before = await app.inject({
        method: 'POST',
        url: '/connected-service-auth/opencode-broker/loaded-status',
        headers: { 'x-happier-daemon-token': 'token' },
        payload: { selectionIdentity: identity, loadNonce },
      });
      expect(before.statusCode).toBe(200);
      expect(before.json()).toEqual({ ok: true, observed: false });

      // The broker registers its handshake using the SCOPED token (master token is rejected here).
      const masterRejected = await app.inject({
        method: 'POST',
        url: '/connected-service-auth/broker/loaded',
        headers: { 'x-happier-daemon-token': 'token' },
        payload: { selectionIdentity: identity, loadNonce, providers: ['openai'] },
      });
      expect(masterRejected.statusCode).toBe(401);

      const registered = await app.inject({
        method: 'POST',
        url: '/connected-service-auth/broker/loaded',
        headers: { 'x-happier-daemon-token': BROKER_SCOPED_TOKEN },
        payload: { selectionIdentity: identity, loadNonce, providers: ['openai'] },
      });
      expect(registered.statusCode).toBe(200);
      expect(registered.json()).toEqual({ ok: true, result: { acknowledged: true } });

      // loaded-status now reports observed.
      const after = await app.inject({
        method: 'POST',
        url: '/connected-service-auth/opencode-broker/loaded-status',
        headers: { 'x-happier-daemon-token': 'token' },
        payload: { selectionIdentity: identity, loadNonce },
      });
      expect(after.statusCode).toBe(200);
      expect(after.json()).toEqual({ ok: true, observed: true });
    } finally {
      resetOpenCodeBrokerLoadHandshakesForTests();
      await app.close();
    }
  });
});

describe('startDaemonControlServer connected-service runtime wiring', () => {
  it('wires reported runtime auth failures to the production control server handler', async () => {
    const handleConnectedServiceRuntimeAuthFailure = vi.fn(async () => ({
      status: 'recovery_action_required',
      action: {
        kind: 'reconnect_profile',
        serviceId: 'openai-codex',
        profileId: 'primary',
        groupId: null,
        reason: 'usage_limit',
      },
    }));
    const server = await startDaemonControlServer({
      getChildren: () => [],
      machineId: 'machine',
      stopSession: async () => false,
      spawnSession: async () => ({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
        errorMessage: 'unused',
      }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      controlToken: 'token',
      handleConnectedServiceRuntimeAuthFailure,
    });

    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/connected-service-runtime-auth/failure`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-happier-daemon-token': 'token',
        },
        body: JSON.stringify({
          sessionId: 'sess_1',
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
        }),
      });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        ok: true,
        result: {
          status: 'recovery_action_required',
          action: {
            kind: 'reconnect_profile',
            serviceId: 'openai-codex',
            profileId: 'primary',
            groupId: null,
            reason: 'usage_limit',
          },
        },
      });
      expect(handleConnectedServiceRuntimeAuthFailure).toHaveBeenCalledWith({
        sessionId: 'sess_1',
        switchesThisTurn: 0,
        classification: expect.objectContaining({
          kind: 'usage_limit',
          serviceId: 'openai-codex',
        }),
      });
    } finally {
      await server.stop();
    }
  });

  it('wires reported quota snapshots to the production control server handler', async () => {
    const handleConnectedServiceQuotaSnapshot = vi.fn(async () => ({
      status: 'recorded',
      groupRuntimeStateRecorded: true,
      quotaStateRecorded: true,
    }));
    const server = await startDaemonControlServer({
      getChildren: () => [],
      machineId: 'machine',
      stopSession: async () => false,
      spawnSession: async () => ({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
        errorMessage: 'unused',
      }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      controlToken: 'token',
      handleConnectedServiceQuotaSnapshot,
    });

    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/connected-service-quota-snapshot`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-happier-daemon-token': 'token',
        },
        body: JSON.stringify({
          sessionId: 'sess_1',
          serviceId: 'openai-codex',
          snapshot: {
            v: 1,
            serviceId: 'openai-codex',
            profileId: 'primary',
            fetchedAt: 1_000,
            staleAfterMs: 300_000,
            planLabel: 'pro',
            accountLabel: null,
            meters: [],
          },
        }),
      });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        ok: true,
        result: {
          status: 'recorded',
          groupRuntimeStateRecorded: true,
          quotaStateRecorded: true,
        },
      });
      expect(handleConnectedServiceQuotaSnapshot).toHaveBeenCalledWith({
        sessionId: 'sess_1',
        serviceId: 'openai-codex',
        snapshot: expect.objectContaining({
          serviceId: 'openai-codex',
          profileId: 'primary',
        }),
      });
    } finally {
      await server.stop();
    }
  });

  it('wires connected-service turn lifecycle events to the production control server handler', async () => {
    const handleConnectedServiceTurnLifecycle = vi.fn(async () => ({
      status: 'recorded',
    }));
    const server = await startDaemonControlServer({
      getChildren: () => [],
      machineId: 'machine',
      stopSession: async () => false,
      spawnSession: async () => ({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
        errorMessage: 'unused',
      }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      controlToken: 'token',
      handleConnectedServiceTurnLifecycle,
    });

    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/connected-service-turn-lifecycle`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-happier-daemon-token': 'token',
        },
        body: JSON.stringify({
          sessionId: 'sess_1',
          event: 'turn_cancelled',
        }),
      });
      expect(response.status).toBe(200);
      const payload = await response.json();
      expect(payload).toEqual({
        ok: true,
        result: {
          status: 'recorded',
        },
      });
      expect(handleConnectedServiceTurnLifecycle).toHaveBeenCalledWith({
        sessionId: 'sess_1',
        event: 'turn_cancelled',
      });
    } finally {
      await server.stop();
    }
  });

  it('wires Codex ChatGPT refresh bridge requests to the production control server handler', async () => {
    const handleCodexChatGptAuthTokensRefresh = vi.fn(async () => ({
      accessToken: 'fresh-access',
      chatgptAccountId: 'acct_123',
      chatgptPlanType: null,
    }));
    const server = await startDaemonControlServer({
      getChildren: () => [],
      machineId: 'machine',
      stopSession: async () => false,
      spawnSession: async () => ({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
        errorMessage: 'unused',
      }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      controlToken: 'token',
      handleCodexChatGptAuthTokensRefresh,
    });

    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/connected-service-auth/openai-codex/chatgpt-auth-tokens/refresh`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          // SEC-F1: session-mode (sessionId, no broker identity) authenticates with the MASTER token.
          'x-happier-daemon-token': 'token',
        },
        body: JSON.stringify({
          sessionId: 'sess_1',
          selection: {
            kind: 'profile',
            serviceId: 'openai-codex',
            profileId: 'work',
          },
        }),
      });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        ok: true,
        result: {
          accessToken: 'fresh-access',
          chatgptAccountId: 'acct_123',
          chatgptPlanType: null,
        },
      });
      expect(handleCodexChatGptAuthTokensRefresh).toHaveBeenCalledWith({
        sessionId: 'sess_1',
        brokerSelectionIdentity: null,
        selection: {
          kind: 'profile',
          serviceId: 'openai-codex',
          profileId: 'work',
        },
        chatgptPlanType: null,
        forceRefresh: false,
        failingAccessTokenFingerprint: null,
      });
    } finally {
      await server.stop();
    }
  });

  it('defers runtime-auth recovery without running the handler while the daemon is shutting down', async () => {
    // Daemon-lifecycle guard: during shutdown the handler must NOT run (no switch/restart/
    // continuation), must NOT enqueue, must NOT clear the recovery intent, and must NOT emit
    // an account-switch success. The recovery intent is deferred (left for a future daemon).
    const handleConnectedServiceRuntimeAuthFailure = vi.fn(async () => ({
      status: 'switch_attempted',
      result: { status: 'switched', activeProfileId: 'backup', generation: 2 },
    }));
    const markSucceededByKey = vi.fn(async () => ({ status: 'succeeded' }));
    const cancelByKey = vi.fn(async () => ({ status: 'cancelled' }));
    const enqueueHandlerFailure = vi.fn(async () => ({ status: 'scheduled', retryable: true }));
    const app = createDaemonControlApp({
      getChildren: () => [],
      machineId: 'machine',
      stopSession: async () => false,
      spawnSession: async () => ({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
        errorMessage: 'unused',
      }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      controlToken: 'token',
      handleConnectedServiceRuntimeAuthFailure,
      runtimeAuthRecoveryScheduler: { markSucceededByKey, cancelByKey, enqueueHandlerFailure },
      isShuttingDown: () => true,
    });

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/connected-service-runtime-auth/failure',
        headers: { 'x-happier-daemon-token': 'token' },
        payload: {
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
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        ok: true,
        result: {
          status: 'daemon_lifecycle_unavailable',
          reason: 'recovery_deferred_shutdown',
        },
      });
      // The handler never ran, nothing was enqueued, and recovery was neither cleared nor terminated.
      expect(handleConnectedServiceRuntimeAuthFailure).not.toHaveBeenCalled();
      expect(enqueueHandlerFailure).not.toHaveBeenCalled();
      expect(markSucceededByKey).not.toHaveBeenCalled();
      expect(cancelByKey).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('does not create durable runtime-auth recovery intake before shutdown deferral', async () => {
    const beginClassifiedFailure = vi.fn(async () => ({ status: 'scheduled', retryable: true }));
    const handleConnectedServiceRuntimeAuthFailure = vi.fn(async () => ({
      status: 'switch_attempted',
      result: { status: 'switched', activeProfileId: 'backup', generation: 2 },
    }));
    const runtimeAuthRecoveryScheduler = {
      beginClassifiedFailure,
    } as unknown as NonNullable<Parameters<typeof createDaemonControlApp>[0]['runtimeAuthRecoveryScheduler']>;
    const app = createDaemonControlApp({
      getChildren: () => [],
      machineId: 'machine',
      stopSession: async () => false,
      spawnSession: async () => ({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
        errorMessage: 'unused',
      }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      controlToken: 'token',
      handleConnectedServiceRuntimeAuthFailure,
      runtimeAuthRecoveryScheduler,
      isShuttingDown: () => true,
    });

    try {
      const classification = {
        kind: 'usage_limit',
        serviceId: 'openai-codex',
        profileId: 'primary',
        groupId: 'main',
        resetsAtMs: null,
        planType: null,
        rateLimits: null,
        source: 'structured_provider_error',
      };
      const response = await app.inject({
        method: 'POST',
        url: '/connected-service-runtime-auth/failure',
        headers: { 'x-happier-daemon-token': 'token' },
        payload: {
          sessionId: 'sess_1',
          switchesThisTurn: 0,
          classification,
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        ok: true,
        result: {
          status: 'daemon_lifecycle_unavailable',
          reason: 'recovery_deferred_shutdown',
        },
      });
      expect(beginClassifiedFailure).not.toHaveBeenCalled();
      expect(handleConnectedServiceRuntimeAuthFailure).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('preserves shutdown deferrals in the session-side runtime-auth report outbox', async () => {
    resetConnectedServiceRuntimeAuthFailureReportDedupeForTests();
    const outboxDir = await createTempDir('happier-runtime-auth-control-shutdown-deferral-');
    const beginClassifiedFailure = vi.fn(async () => ({ status: 'scheduled', retryable: true }));
    const handleConnectedServiceRuntimeAuthFailure = vi.fn(async () => ({
      status: 'switch_attempted',
      result: { status: 'switched', activeProfileId: 'backup', generation: 2 },
    }));
    const runtimeAuthRecoveryScheduler = {
      beginClassifiedFailure,
    } as unknown as NonNullable<Parameters<typeof createDaemonControlApp>[0]['runtimeAuthRecoveryScheduler']>;
    const app = createDaemonControlApp({
      getChildren: () => [],
      machineId: 'machine',
      stopSession: async () => false,
      spawnSession: async () => ({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
        errorMessage: 'unused',
      }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      controlToken: 'token',
      handleConnectedServiceRuntimeAuthFailure,
      runtimeAuthRecoveryScheduler,
      isShuttingDown: () => true,
    });

    try {
      const classification = {
        kind: 'usage_limit',
        serviceId: 'openai-codex',
        profileId: 'primary',
        groupId: 'main',
        resetsAtMs: null,
        providerLimitId: 'refresh-token-secret',
        planType: null,
        rateLimits: null,
        source: 'structured_provider_error',
        accessToken: 'secret-access-token',
      };
      await expect(reportConnectedServiceRuntimeAuthFailureToDaemon({
        sessionId: 'sess_shutdown_route_report',
        switchesThisTurn: 0,
        classification,
        notify: async (body) => {
          const response = await app.inject({
            method: 'POST',
            url: '/connected-service-runtime-auth/failure',
            headers: { 'x-happier-daemon-token': 'token' },
            payload: body,
          });
          expect(response.statusCode).toBe(200);
          return response.json();
        },
        logger: { debug: vi.fn() },
        reportOutboxDir: outboxDir,
        nowMs: () => 1_700_000_000_000,
      })).resolves.toMatchObject({
        handled: false,
        report: {
          ok: true,
          result: {
            status: 'daemon_lifecycle_unavailable',
            reason: 'recovery_deferred_shutdown',
          },
        },
      });

      expect(beginClassifiedFailure).not.toHaveBeenCalled();
      expect(handleConnectedServiceRuntimeAuthFailure).not.toHaveBeenCalled();
      const items = await readRuntimeAuthFailureReportOutboxItems({ outboxDir });
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        sessionId: 'sess_shutdown_route_report',
        classification: expect.objectContaining({
          kind: 'usage_limit',
          serviceId: 'openai-codex',
          profileId: 'primary',
          groupId: 'main',
          providerLimitId: null,
        }),
      });
      expect(JSON.stringify(items[0])).not.toContain('secret-access-token');
      expect(JSON.stringify(items[0])).not.toContain('refresh-token-secret');
    } finally {
      await app.close();
      await removeTempDir(outboxDir);
    }
  });
});
