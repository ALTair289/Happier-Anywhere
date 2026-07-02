import { afterEach, describe, expect, it, vi } from 'vitest';
import { SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY } from '@happier-dev/protocol';
import type { SessionRuntimeIssueV1 } from '@happier-dev/protocol';

import { HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY } from '@/daemon/connectedServices/connectedServiceChildEnvironment';
import { resetConnectedServiceRuntimeAuthFailureReportDedupeForTests } from '@/daemon/connectedServices/runtimeAuth/reportConnectedServiceRuntimeAuthFailureToDaemon';

import {
  surfaceClaudeRuntimeAuthFailure,
  surfaceClaudeRateLimitRuntimeIssue,
} from './surfaceClaudeRuntimeIssues';

const mockNotifyDaemonConnectedServiceRuntimeAuthFailure = vi.hoisted(() => vi.fn(async () => ({})));
const mockNotifyDaemonConnectedServiceQuotaSnapshot = vi.hoisted(() => vi.fn(async () => ({ ok: true })));
vi.mock('@/daemon/controlClient', () => ({
  notifyDaemonConnectedServiceRuntimeAuthFailure: mockNotifyDaemonConnectedServiceRuntimeAuthFailure,
  notifyDaemonConnectedServiceQuotaSnapshot: mockNotifyDaemonConnectedServiceQuotaSnapshot,
}));

type ClaudeFailTurn = (params: { provider: 'claude'; issue: SessionRuntimeIssueV1 }) => Promise<void>;

function createClaudeFailTurnSpy() {
  return vi.fn<ClaudeFailTurn>(async () => undefined);
}

function createScheduledRuntimeAuthRecoveryReport(input: Readonly<{ includeTranscriptEvent?: boolean }> = {}) {
  const diagnostic = {
    code: 'recovery_retry_scheduled',
    failurePhase: 'runtime_auth_recovery',
    source: 'runtime_auth_recovery',
    serviceId: 'claude-subscription',
    profileId: 'claude-main',
    groupId: 'team-pool',
    retryable: true,
    suggestedActions: [],
    diagnostics: { runtimeFailureKind: 'usage_limit' },
  };
  const transcriptEvent = {
    type: 'connected-service-runtime-auth-recovery',
    status: 'retry_scheduled',
    serviceId: 'claude-subscription',
    profileId: 'claude-main',
    groupId: 'team-pool',
    nextRetryAtMs: 1_700_000_100_000,
    terminal: false,
    diagnostic,
  };
  return {
    ok: true,
    result: {
      status: 'recovery_retry_scheduled',
      recovery: {
        status: 'scheduled',
        retryable: true,
        nextRetryAtMs: 1_700_000_100_000,
      },
      uxDiagnostic: diagnostic,
      ...(input.includeTranscriptEvent === false ? {} : { transcriptEvent }),
    },
  };
}

function installClaudeSelectionEnv(): string | undefined {
  const previous = process.env[HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY];
  process.env[HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY] = JSON.stringify([{
    kind: 'group',
    serviceId: 'claude-subscription',
    groupId: 'team-pool',
    activeProfileId: 'claude-main',
    fallbackProfileId: 'claude-backup',
    generation: 4,
  }]);
  return previous;
}

function restoreClaudeSelectionEnv(previous: string | undefined): void {
  if (previous === undefined) {
    delete process.env[HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY];
    return;
  }
  process.env[HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY] = previous;
}

describe('surfaceClaudeRuntimeIssues runtime-auth projection', () => {
  afterEach(() => {
    mockNotifyDaemonConnectedServiceRuntimeAuthFailure.mockReset();
    mockNotifyDaemonConnectedServiceRuntimeAuthFailure.mockResolvedValue({});
    mockNotifyDaemonConnectedServiceQuotaSnapshot.mockReset();
    mockNotifyDaemonConnectedServiceQuotaSnapshot.mockResolvedValue({ ok: true });
    // The shared daemon-report path dedupes on stable identity; tests reuse session ids and
    // classifications across cases, so the window must not leak between tests.
    resetConnectedServiceRuntimeAuthFailureReportDedupeForTests();
  });

  it('keeps sidechain-sourced usage-limit evidence out of turn failure and recovery while still recording quota evidence (FIX-3)', async () => {
    // Incident Jun-11 H-B (trigger half): a SUBAGENT api-error row imported into the parent
    // stream must not fail the parent turn nor produce a runtime-auth failure report. The
    // limit is still real account-level signal, so the quota snapshot is still recorded.
    const previousSelectionEnv = installClaudeSelectionEnv();
    const sendSessionEvent = vi.fn();
    const failTurn = createClaudeFailTurnSpy();
    try {
      await surfaceClaudeRateLimitRuntimeIssue({
        client: {
          sessionId: 'sess_claude_sidechain',
          sendSessionEvent,
          sessionTurnLifecycle: { failTurn },
        },
      } as any, {
        v: 1,
        resetAtMs: 1_781_221_200_000,
        retryAfterMs: null,
        limitCategory: 'usage_limit',
        quotaScope: 'account',
        recoverability: 'wait',
        providerLimitId: 'five_hour',
        planType: null,
        utilization: 100,
        overage: null,
        action: null,
        connectedService: null,
        sourcedFromSidechain: true,
      }, '[claude-test]');

      expect(failTurn).not.toHaveBeenCalled();
      expect(mockNotifyDaemonConnectedServiceRuntimeAuthFailure).not.toHaveBeenCalled();
      expect(sendSessionEvent).not.toHaveBeenCalled();
      expect(mockNotifyDaemonConnectedServiceQuotaSnapshot).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: 'sess_claude_sidechain',
        serviceId: 'claude-subscription',
        snapshot: expect.objectContaining({
          profileId: 'claude-main',
          meters: [expect.objectContaining({
            meterId: 'five_hour',
            resetAtMs: 1_781_221_200_000,
          })],
        }),
      }));
    } finally {
      restoreClaudeSelectionEnv(previousSelectionEnv);
    }
  });

  it('keeps sidechain-sourced transient 401 auth evidence out of turn failure and recovery (incident cmq8y3nlx)', async () => {
    // Incident 2026-06-12 cmq8y3nlx: a SUBAGENT transcript row (`isSidechain: true`) carrying
    // "Please run /login · API Error: 401 Invalid authentication credentials" was classified as
    // a session-level auth failure, the daemon armed reactive runtime-auth recovery and
    // restarted (SIGTERMed) the healthy parent session. Subagent-scoped evidence must never
    // fail the parent turn nor produce a runtime-auth failure report.
    const previousSelectionEnv = installClaudeSelectionEnv();
    const sendSessionEvent = vi.fn();
    const failTurn = createClaudeFailTurnSpy();
    try {
      const surfaced = await surfaceClaudeRuntimeAuthFailure({
        client: {
          sessionId: 'sess_claude_sidechain_auth',
          sendSessionEvent,
          sessionTurnLifecycle: { failTurn },
        },
      } as any, {
        type: 'assistant',
        isSidechain: true,
        isApiErrorMessage: true,
        apiErrorStatus: 401,
        error: 'authentication_failed',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Please run /login · API Error: 401 Invalid authentication credentials' }],
        },
      }, '[claude-test]');

      expect(surfaced).toBe(false);
      expect(failTurn).not.toHaveBeenCalled();
      expect(mockNotifyDaemonConnectedServiceRuntimeAuthFailure).not.toHaveBeenCalled();
      expect(sendSessionEvent).not.toHaveBeenCalled();
    } finally {
      restoreClaudeSelectionEnv(previousSelectionEnv);
    }
  });

  it('keeps SDK-stream subagent (parent_tool_use_id) 401 auth evidence out of turn failure and recovery', async () => {
    const previousSelectionEnv = installClaudeSelectionEnv();
    const sendSessionEvent = vi.fn();
    const failTurn = createClaudeFailTurnSpy();
    try {
      const surfaced = await surfaceClaudeRuntimeAuthFailure({
        client: {
          sessionId: 'sess_claude_subagent_sdk_auth',
          sendSessionEvent,
          sessionTurnLifecycle: { failTurn },
        },
      } as any, {
        type: 'assistant',
        parent_tool_use_id: 'toolu_01TkTXvAj9C6X7TJSKmxH2jX',
        isApiErrorMessage: true,
        error: 'authentication_failed',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Please run /login · API Error: 401 Invalid authentication credentials' }],
        },
      }, '[claude-test]');

      expect(surfaced).toBe(false);
      expect(failTurn).not.toHaveBeenCalled();
      expect(mockNotifyDaemonConnectedServiceRuntimeAuthFailure).not.toHaveBeenCalled();
    } finally {
      restoreClaudeSelectionEnv(previousSelectionEnv);
    }
  });

  it('lets connected-service recovery own parent-scoped 401 evidence while recovery is retryable', async () => {
    const previousSelectionEnv = installClaudeSelectionEnv();
    mockNotifyDaemonConnectedServiceRuntimeAuthFailure.mockResolvedValueOnce(createScheduledRuntimeAuthRecoveryReport());
    const sendSessionEvent = vi.fn();
    const failTurn = createClaudeFailTurnSpy();
    try {
      const surfaced = await surfaceClaudeRuntimeAuthFailure({
        client: {
          sessionId: 'sess_claude_parent_auth',
          sendSessionEvent,
          sessionTurnLifecycle: { failTurn },
        },
      } as any, {
        type: 'assistant',
        isApiErrorMessage: true,
        apiErrorStatus: 401,
        error: 'authentication_failed',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Please run /login · API Error: 401 Invalid authentication credentials' }],
        },
      }, '[claude-test]');

      expect(surfaced).toBe(true);
      expect(failTurn).not.toHaveBeenCalled();
      expect(mockNotifyDaemonConnectedServiceRuntimeAuthFailure).toHaveBeenCalled();
    } finally {
      restoreClaudeSelectionEnv(previousSelectionEnv);
    }
  });

  it('surfaces parent-scoped 401 evidence when connected-service recovery requires user action', async () => {
    const previousSelectionEnv = installClaudeSelectionEnv();
    mockNotifyDaemonConnectedServiceRuntimeAuthFailure.mockResolvedValueOnce({
      ok: true,
      result: {
        status: 'recovery_action_required',
        action: {
          kind: 'reconnect_profile',
          serviceId: 'claude-subscription',
          profileId: 'claude-main',
        },
      },
    });
    const sendSessionEvent = vi.fn();
    const failTurn = createClaudeFailTurnSpy();
    try {
      const surfaced = await surfaceClaudeRuntimeAuthFailure({
        client: {
          sessionId: 'sess_claude_parent_auth_action_required',
          sendSessionEvent,
          sessionTurnLifecycle: { failTurn },
        },
      } as any, {
        type: 'assistant',
        isApiErrorMessage: true,
        apiErrorStatus: 401,
        error: 'authentication_failed',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Please run /login · API Error: 401 Invalid authentication credentials' }],
        },
      }, '[claude-test]');

      expect(surfaced).toBe(true);
      expect(failTurn).toHaveBeenCalledWith(expect.objectContaining({
        provider: 'claude',
        issue: expect.objectContaining({ source: 'auth_error' }),
      }));
      expect(mockNotifyDaemonConnectedServiceRuntimeAuthFailure).toHaveBeenCalled();
    } finally {
      restoreClaudeSelectionEnv(previousSelectionEnv);
    }
  });

  it('lets Claude SDK provider-owned native 401 retries continue without surfacing an auth failure', async () => {
    const previousSelectionEnv = process.env[HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY];
    delete process.env[HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY];
    const sendSessionEvent = vi.fn();
    const failTurn = createClaudeFailTurnSpy();
    try {
      const surfaced = await surfaceClaudeRuntimeAuthFailure({
        client: {
          sessionId: 'sess_claude_native_oauth_provider_retrying',
          sendSessionEvent,
          sessionTurnLifecycle: { failTurn },
        },
      } as any, {
        type: 'system',
        subtype: 'api_error',
        attempt: 1,
        max_retries: 11,
        retry_delay_ms: 1_000,
        error_status: 401,
        error: 'Connection error.',
      }, '[claude-test]');

      expect(surfaced).toBe(false);
      expect(failTurn).not.toHaveBeenCalled();
      expect(mockNotifyDaemonConnectedServiceRuntimeAuthFailure).not.toHaveBeenCalled();
      expect(sendSessionEvent).not.toHaveBeenCalled();
    } finally {
      restoreClaudeSelectionEnv(previousSelectionEnv);
    }
  });

  it('surfaces native Claude OAuth SDK 401 evidence without connected-service recovery', async () => {
    const previousSelectionEnv = process.env[HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY];
    delete process.env[HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY];
    const sendSessionEvent = vi.fn();
    const failTurn = createClaudeFailTurnSpy();
    try {
      const surfaced = await surfaceClaudeRuntimeAuthFailure({
        client: {
          sessionId: 'sess_claude_native_oauth_auth',
          sendSessionEvent,
          sessionTurnLifecycle: { failTurn },
        },
      } as any, {
        type: 'system',
        subtype: 'api_error',
        attempt: 11,
        max_retries: 11,
        retry_delay_ms: 1_000,
        error_status: 401,
        error: 'Connection error.',
      }, '[claude-test]');

      expect(surfaced).toBe(true);
      expect(failTurn).toHaveBeenCalledWith(expect.objectContaining({
        provider: 'claude',
        issue: expect.objectContaining({
          code: 'auth_error',
          source: 'auth_error',
          provider: 'claude',
        }),
      }));
      expect(mockNotifyDaemonConnectedServiceRuntimeAuthFailure).not.toHaveBeenCalled();
      expect(sendSessionEvent).not.toHaveBeenCalled();
    } finally {
      restoreClaudeSelectionEnv(previousSelectionEnv);
    }
  });

  it('does not re-emit daemon typed runtime-auth recovery projection for retryable Claude auth recovery', async () => {
    const previousSelectionEnv = installClaudeSelectionEnv();
    mockNotifyDaemonConnectedServiceRuntimeAuthFailure.mockResolvedValueOnce(createScheduledRuntimeAuthRecoveryReport());
    const sendSessionEvent = vi.fn();
    const failTurn = createClaudeFailTurnSpy();
    try {
      await surfaceClaudeRuntimeAuthFailure({
        client: {
          sessionId: 'sess_claude_1',
          sendSessionEvent,
          sessionTurnLifecycle: { failTurn },
        },
      } as any, { status: 401, message: 'OAuth token has expired' }, '[claude-test]');

      expect(failTurn).not.toHaveBeenCalled();
      expect(sendSessionEvent).not.toHaveBeenCalled();
    } finally {
      restoreClaudeSelectionEnv(previousSelectionEnv);
    }
  });

  it('does not re-emit daemon typed runtime-auth recovery projection for Claude usage-limit issues', async () => {
    const previousSelectionEnv = installClaudeSelectionEnv();
    mockNotifyDaemonConnectedServiceRuntimeAuthFailure.mockResolvedValueOnce(createScheduledRuntimeAuthRecoveryReport());
    const sendSessionEvent = vi.fn();
    try {
      await surfaceClaudeRateLimitRuntimeIssue({
        client: {
          sessionId: 'sess_claude_1',
          sendSessionEvent,
          sessionTurnLifecycle: { failTurn: vi.fn(async () => {}) },
        },
      } as any, {
        v: 1,
        resetAtMs: null,
        retryAfterMs: null,
        quotaScope: 'account',
        recoverability: 'switch_account',
        providerLimitId: 'daily_tokens',
        planType: null,
        utilization: 100,
        overage: null,
        action: null,
        connectedService: null,
      }, '[claude-test]');

      expect(sendSessionEvent).not.toHaveBeenCalled();
    } finally {
      restoreClaudeSelectionEnv(previousSelectionEnv);
    }
  });

  it('records in-band quota evidence for the selected member alongside connected-service recovery', async () => {
    // RD-QUO-2: group-bound Claude sessions must feed live in-band rate-limit evidence into the
    // canonical quota snapshot store (mirroring Codex), not only into runtime-auth recovery.
    const previousSelectionEnv = installClaudeSelectionEnv();
    mockNotifyDaemonConnectedServiceRuntimeAuthFailure.mockResolvedValueOnce(createScheduledRuntimeAuthRecoveryReport());
    try {
      await surfaceClaudeRateLimitRuntimeIssue({
        client: {
          sessionId: 'sess_claude_selected_snapshot',
          sendSessionEvent: vi.fn(),
          sessionTurnLifecycle: { failTurn: vi.fn(async () => {}) },
        },
      } as any, {
        v: 1,
        resetAtMs: 1_768_100_000_000,
        retryAfterMs: null,
        limitCategory: 'usage_limit',
        quotaScope: 'account',
        recoverability: 'switch_account',
        providerLimitId: 'five_hour',
        planType: null,
        utilization: 100,
        overage: null,
        action: null,
        connectedService: null,
      }, '[claude-test]');

      expect(mockNotifyDaemonConnectedServiceQuotaSnapshot).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: 'sess_claude_selected_snapshot',
        serviceId: 'claude-subscription',
        groupId: 'team-pool',
        groupGeneration: 4,
        snapshot: expect.objectContaining({
          serviceId: 'claude-subscription',
          profileId: 'claude-main',
          source: 'runtime_event',
          meters: [expect.objectContaining({
            meterId: 'five_hour',
            resetAtMs: 1_768_100_000_000,
          })],
        }),
      }));
      expect(mockNotifyDaemonConnectedServiceRuntimeAuthFailure).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: 'sess_claude_selected_snapshot',
          classification: expect.objectContaining({
            groupId: 'team-pool',
            groupGeneration: 4,
          }),
        }),
        expect.anything(),
      );
    } finally {
      restoreClaudeSelectionEnv(previousSelectionEnv);
    }
  });

  it('surfaces temporary provider throttles outside usage-limit issue fields', async () => {
    const previousSelectionEnv = installClaudeSelectionEnv();
    mockNotifyDaemonConnectedServiceRuntimeAuthFailure.mockResolvedValueOnce(createScheduledRuntimeAuthRecoveryReport());
    const failTurn = createClaudeFailTurnSpy();
    try {
      await surfaceClaudeRateLimitRuntimeIssue({
        client: {
          sessionId: 'sess_claude_temporary_throttle',
          sendSessionEvent: vi.fn(),
          sessionTurnLifecycle: { failTurn },
        },
      } as any, {
        v: 1,
        resetAtMs: null,
        retryAfterMs: 1_250,
        limitCategory: 'rate_limit',
        quotaScope: 'provider',
        recoverability: 'wait',
        providerLimitId: 'transient',
        planType: null,
        utilization: null,
        overage: null,
        action: null,
        connectedService: null,
      }, '[claude-test]');

      expect(failTurn).toHaveBeenCalledWith({
        provider: 'claude',
        issue: expect.objectContaining({
          code: 'provider_temporary_throttle',
          source: 'provider_status_error',
          provider: 'claude',
          temporaryThrottle: {
            v: 1,
            retryAfterMs: 1_250,
            recoverability: 'retry',
          },
        }),
      });
      const issue = (failTurn.mock.calls[0]?.[0] as { issue?: Record<string, unknown> } | undefined)?.issue;
      expect(issue).not.toHaveProperty('usageLimit');
    } finally {
      restoreClaudeSelectionEnv(previousSelectionEnv);
    }
  });

  it('surfaces provider capacity as a provider status issue with structured limit details', async () => {
    const previousSelectionEnv = installClaudeSelectionEnv();
    mockNotifyDaemonConnectedServiceRuntimeAuthFailure.mockResolvedValueOnce(createScheduledRuntimeAuthRecoveryReport());
    const failTurn = createClaudeFailTurnSpy();
    try {
      await surfaceClaudeRateLimitRuntimeIssue({
        client: {
          sessionId: 'sess_claude_capacity',
          sendSessionEvent: vi.fn(),
          sessionTurnLifecycle: { failTurn },
        },
      } as any, {
        v: 1,
        resetAtMs: null,
        retryAfterMs: 2_000,
        limitCategory: 'capacity',
        quotaScope: 'provider',
        recoverability: 'wait',
        providerLimitId: 'server_overloaded',
        planType: null,
        utilization: null,
        overage: null,
        action: null,
        connectedService: null,
      }, '[claude-test]');

      expect(failTurn).toHaveBeenCalledWith({
        provider: 'claude',
        issue: expect.objectContaining({
          code: 'provider_status_error',
          source: 'provider_status_error',
          provider: 'claude',
          sanitizedPreview: 'Provider reported an error',
          usageLimit: expect.objectContaining({
            limitCategory: 'capacity',
            providerLimitId: 'server_overloaded',
            retryAfterMs: 2_000,
          }),
        }),
      });
    } finally {
      restoreClaudeSelectionEnv(previousSelectionEnv);
    }
  });

  it('records native Claude usage-limit evidence without connected-service recovery when no connected selection exists', async () => {
    const previousSelectionEnv = process.env[HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY];
    delete process.env[HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY];
    const previousHome = process.env.HOME;
    process.env.HOME = '/tmp/happier-claude-native-home';
    const failTurn = createClaudeFailTurnSpy();
    try {
      await surfaceClaudeRateLimitRuntimeIssue({
        client: {
          sessionId: 'sess_native_claude',
          sessionTurnLifecycle: { failTurn },
        },
      } as any, {
        v: 1,
        resetAtMs: 1_700_000_000_000,
        retryAfterMs: null,
        quotaScope: 'account',
        recoverability: 'wait',
        providerLimitId: 'daily_tokens',
        planType: 'max',
        utilization: 100,
        overage: null,
        action: null,
        connectedService: null,
      }, '[claude-test]');

      expect(failTurn).toHaveBeenCalledWith({
        provider: 'claude',
        issue: expect.objectContaining({
          code: 'usage_limit',
          usageLimit: expect.objectContaining({
            providerLimitId: 'daily_tokens',
            effectiveMeterId: 'daily_tokens',
            effectiveRemainingPct: 0,
            allWindows: [
              expect.objectContaining({
                meterId: 'daily_tokens',
                remainingPct: 0,
                resetAtMs: 1_700_000_000_000,
                status: 'ok',
              }),
            ],
            connectedService: {
              serviceId: 'claude-subscription',
              profileId: expect.stringMatching(/^native:[a-f0-9]{48}$/u),
              groupId: null,
            },
          }),
        }),
      });
      expect(mockNotifyDaemonConnectedServiceQuotaSnapshot).toHaveBeenCalledWith({
        sessionId: 'sess_native_claude',
        serviceId: 'claude-subscription',
        snapshot: expect.objectContaining({
          serviceId: 'claude-subscription',
          profileId: expect.stringMatching(/^native:[a-f0-9]{48}$/u),
          providerId: 'claude',
          planLabel: 'max',
          meters: [
            expect.objectContaining({
              meterId: 'daily_tokens',
              utilizationPct: 100,
              resetsAt: 1_700_000_000_000,
            }),
          ],
        }),
      });
      expect(mockNotifyDaemonConnectedServiceRuntimeAuthFailure).not.toHaveBeenCalled();
    } finally {
      if (previousSelectionEnv === undefined) {
        delete process.env[HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY];
      } else {
        process.env[HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY] = previousSelectionEnv;
      }
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
    }
  });

  it('surfaces native Claude temporary throttles without connected-service recovery when no connected selection exists', async () => {
    const previousSelectionEnv = process.env[HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY];
    delete process.env[HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY];
    const previousHome = process.env.HOME;
    process.env.HOME = '/tmp/happier-claude-native-throttle-home';
    const failTurn = createClaudeFailTurnSpy();
    try {
      await surfaceClaudeRateLimitRuntimeIssue({
        client: {
          sessionId: 'sess_native_claude_throttle',
          sessionTurnLifecycle: { failTurn },
        },
      } as any, {
        v: 1,
        resetAtMs: null,
        retryAfterMs: 1_250,
        limitCategory: 'rate_limit',
        quotaScope: 'provider',
        recoverability: 'wait',
        providerLimitId: 'transient',
        planType: null,
        utilization: null,
        overage: null,
        action: null,
        connectedService: null,
      }, '[claude-test]');

      expect(failTurn).toHaveBeenCalledWith({
        provider: 'claude',
        issue: expect.objectContaining({
          code: 'provider_temporary_throttle',
          source: 'provider_status_error',
          temporaryThrottle: {
            v: 1,
            retryAfterMs: 1_250,
            recoverability: 'retry',
          },
        }),
      });
      const issue = (failTurn.mock.calls[0]?.[0] as { issue?: Record<string, unknown> } | undefined)?.issue;
      expect(issue).not.toHaveProperty('usageLimit');
      expect(mockNotifyDaemonConnectedServiceRuntimeAuthFailure).not.toHaveBeenCalled();
    } finally {
      if (previousSelectionEnv === undefined) {
        delete process.env[HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY];
      } else {
        process.env[HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY] = previousSelectionEnv;
      }
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
    }
  });

  it('emits a generic recovery message when the daemon report has a typed diagnostic but no transcript event', async () => {
    const previousSelectionEnv = installClaudeSelectionEnv();
    mockNotifyDaemonConnectedServiceRuntimeAuthFailure.mockResolvedValueOnce(
      createScheduledRuntimeAuthRecoveryReport({ includeTranscriptEvent: false }),
    );
    const sendSessionEvent = vi.fn();
    const failTurn = createClaudeFailTurnSpy();
    try {
      await surfaceClaudeRuntimeAuthFailure({
        client: {
          sessionId: 'sess_claude_1',
          sendSessionEvent,
          sessionTurnLifecycle: { failTurn },
        },
      } as any, { status: 401, message: 'OAuth token has expired' }, '[claude-test]');

      expect(sendSessionEvent).toHaveBeenCalledWith({
        type: 'message',
        message: expect.stringContaining('retry scheduled'),
      });
    } finally {
      restoreClaudeSelectionEnv(previousSelectionEnv);
    }
  });

  it('commits usage-limit recovery metadata through the bound session client method', async () => {
    const previousSelectionEnv = installClaudeSelectionEnv();
    mockNotifyDaemonConnectedServiceRuntimeAuthFailure.mockResolvedValueOnce(createScheduledRuntimeAuthRecoveryReport());
    const client = {
      sessionId: 'sess_claude_bound_update',
      metadata: {} as Record<string, unknown>,
      metadataLock: {
        inLock: async <T>(fn: () => Promise<T> | T): Promise<T> => await fn(),
      },
      updateMetadata(this: any, updater: (metadata: Record<string, unknown>) => Record<string, unknown>) {
        return this.metadataLock.inLock(async () => {
          this.metadata = updater(this.metadata);
        });
      },
      sendSessionEvent: vi.fn(),
      sessionTurnLifecycle: { failTurn: vi.fn(async () => undefined) },
    };
    try {
      await surfaceClaudeRateLimitRuntimeIssue({
        client,
      } as any, {
        v: 1,
        resetAtMs: 1_700_000_060_000,
        retryAfterMs: null,
        quotaScope: 'account',
        recoverability: 'switch_account',
        providerLimitId: 'daily_tokens',
        planType: null,
        utilization: 100,
        overage: null,
        action: null,
        connectedService: null,
      }, '[claude-test]');

      expect(client.metadata).toMatchObject({
        [SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY]: expect.objectContaining({
          status: 'waiting',
          nextCheckAtMs: 1_700_000_100_000,
        }),
      });
    } finally {
      restoreClaudeSelectionEnv(previousSelectionEnv);
    }
  });

  it('leaves repeated daemon-handled group-recovery transcript projections to the daemon', async () => {
    const previousSelectionEnv = installClaudeSelectionEnv();
    mockNotifyDaemonConnectedServiceRuntimeAuthFailure
      .mockResolvedValueOnce(createScheduledRuntimeAuthRecoveryReport())
      .mockResolvedValueOnce(createScheduledRuntimeAuthRecoveryReport());
    const sendSessionEvent = vi.fn();
    const client = {
      sessionId: 'sess_claude_dedupe',
      metadata: {} as Record<string, unknown>,
      metadataLock: {
        inLock: async <T>(fn: () => Promise<T> | T): Promise<T> => await fn(),
      },
      updateMetadata(this: any, updater: (metadata: Record<string, unknown>) => Record<string, unknown>) {
        return this.metadataLock.inLock(async () => {
          this.metadata = updater(this.metadata);
        });
      },
      sendSessionEvent,
      sessionTurnLifecycle: { failTurn: vi.fn(async () => undefined) },
    };
    const details = {
      v: 1 as const,
      resetAtMs: 1_700_000_060_000,
      retryAfterMs: null,
      quotaScope: 'account' as const,
      recoverability: 'switch_account' as const,
      providerLimitId: 'daily_tokens',
      planType: null,
      utilization: 100,
      overage: null,
      action: null,
      connectedService: null,
    };
    try {
      await surfaceClaudeRateLimitRuntimeIssue({ client } as any, details, '[claude-test]');
      await surfaceClaudeRateLimitRuntimeIssue({ client } as any, details, '[claude-test]');

      expect(sendSessionEvent.mock.calls.filter(
        ([event]) => event?.type === 'connected-service-runtime-auth-recovery',
      )).toHaveLength(0);
    } finally {
      restoreClaudeSelectionEnv(previousSelectionEnv);
    }
  });

  it('leaves concurrent daemon-handled group-recovery transcript projections to the daemon', async () => {
    const previousSelectionEnv = installClaudeSelectionEnv();
    mockNotifyDaemonConnectedServiceRuntimeAuthFailure
      .mockResolvedValueOnce(createScheduledRuntimeAuthRecoveryReport())
      .mockResolvedValueOnce(createScheduledRuntimeAuthRecoveryReport());
    const sendSessionEvent = vi.fn();
    const client = {
      sessionId: 'sess_claude_dedupe_concurrent',
      metadata: {} as Record<string, unknown>,
      metadataLock: {
        inLock: async <T>(fn: () => Promise<T> | T): Promise<T> => await fn(),
      },
      updateMetadata(this: any, updater: (metadata: Record<string, unknown>) => Record<string, unknown>) {
        return this.metadataLock.inLock(async () => {
          this.metadata = updater(this.metadata);
        });
      },
      sendSessionEvent,
      sessionTurnLifecycle: { failTurn: vi.fn(async () => undefined) },
    };
    const details = {
      v: 1 as const,
      resetAtMs: 1_700_000_060_000,
      retryAfterMs: null,
      quotaScope: 'account' as const,
      recoverability: 'switch_account' as const,
      providerLimitId: 'daily_tokens',
      planType: null,
      utilization: 100,
      overage: null,
      action: null,
      connectedService: null,
    };
    try {
      await Promise.all([
        surfaceClaudeRateLimitRuntimeIssue({ client } as any, details, '[claude-test]'),
        surfaceClaudeRateLimitRuntimeIssue({ client } as any, details, '[claude-test]'),
      ]);

      expect(sendSessionEvent.mock.calls.filter(
        ([event]) => event?.type === 'connected-service-runtime-auth-recovery',
      )).toHaveLength(0);
    } finally {
      restoreClaudeSelectionEnv(previousSelectionEnv);
    }
  });
});
