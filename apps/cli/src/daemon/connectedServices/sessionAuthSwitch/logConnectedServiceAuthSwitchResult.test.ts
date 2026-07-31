import { describe, expect, it, vi } from 'vitest';

import type { ConnectedServiceBindingsV1 } from '@happier-dev/protocol';
import type { SessionConnectedServiceAuthSwitchResult } from './switchSessionConnectedServiceAuth';

import { logConnectedServiceAuthSwitchResult } from './logConnectedServiceAuthSwitchResult';

describe('logConnectedServiceAuthSwitchResult', () => {
  it('logs successful switch results with latency and binding diagnostics', () => {
    const logger = { debug: vi.fn() };
    const previousBindings: ConnectedServiceBindingsV1 = {
      v: 1,
      bindingsByServiceId: {
        anthropic: { source: 'connected', selection: 'profile', profileId: 'old-profile' },
      },
    };
    const result: SessionConnectedServiceAuthSwitchResult = {
      ok: true,
      action: 'restart_requested',
      normalizedBindings: previousBindings,
      continuityByServiceId: { anthropic: 'restart_rematerialize' },
      warnings: [],
      verificationByServiceId: {
        anthropic: {
          status: 'weakly_verified',
          reason: 'provider_account_email_verified_without_account_id',
        },
      },
    };

    logConnectedServiceAuthSwitchResult({
      logger,
      sessionId: 'sess-1',
      agentId: 'claude',
      serviceIds: ['anthropic'],
      result,
      startedAtMs: 100,
      finishedAtMs: 175,
      previousBindings,
      expectedGroupGenerationByServiceId: { anthropic: 7 },
    });

    expect(logger.debug).toHaveBeenCalledWith(
      '[DAEMON RUN] Connected-service session auth switch result',
      expect.objectContaining({
        sessionId: 'sess-1',
        agentId: 'claude',
        serviceIds: ['anthropic'],
        ok: true,
        action: 'restart_requested',
        verificationByServiceId: {
          anthropic: {
            status: 'weakly_verified',
            reason: 'provider_account_email_verified_without_account_id',
          },
        },
        latencyMs: 75,
        previousBindings,
        expectedGroupGenerationByServiceId: { anthropic: 7 },
      }),
    );
  });

  it('logs failed switch results with diagnostics and latency', () => {
    const logger = { debug: vi.fn() };
    const result: SessionConnectedServiceAuthSwitchResult = {
      ok: false,
      errorCode: 'restart_failed',
      serviceId: 'anthropic',
      diagnostics: {
        failurePhase: 'restart',
      },
    };

    logConnectedServiceAuthSwitchResult({
      logger,
      sessionId: 'sess-2',
      agentId: 'claude',
      serviceIds: ['anthropic'],
      result,
      startedAtMs: 200,
      finishedAtMs: 260,
      previousBindings: { v: 1, bindingsByServiceId: {} },
      expectedGroupGenerationByServiceId: undefined,
    });

    expect(logger.debug).toHaveBeenCalledWith(
      '[DAEMON RUN] Connected-service session auth switch result',
      expect.objectContaining({
        ok: false,
        errorCode: 'restart_failed',
        serviceId: 'anthropic',
        diagnostics: {
          failurePhase: 'restart',
        },
        latencyMs: 60,
      }),
    );
  });
});
