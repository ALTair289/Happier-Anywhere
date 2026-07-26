import { describe, expect, it, vi } from 'vitest';

import type { ManagedConnectionSupervisor, ManagedConnectionState, ReadinessProbeResult } from '@happier-dev/connection-supervisor';

import { HttpStatusError, readHttpStatus } from '@/api/client/httpStatusError';

import { assertManagedConnectionReadyForRequest } from './assertManagedConnectionReadyForRequest';
import { reportRequestOutcomeToSupervisor } from './reportRequestOutcomeToSupervisor';
import { runSupervisedRequest } from './runSupervisedRequest';

function createState(overrides: Partial<ManagedConnectionState> = {}): ManagedConnectionState {
  return {
    phase: 'online',
    reason: null,
    attempt: 0,
    nextRetryAt: null,
    lastConnectedAt: Date.now(),
    lastDisconnectedAt: null,
    lastErrorMessage: null,
    ...overrides,
  };
}

function createSupervisor(state: ManagedConnectionState = createState()): ManagedConnectionSupervisor {
  return {
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    getState: vi.fn(() => state),
    reportProbeResult: vi.fn(),
  };
}

async function expectRejectedHttpStatus(promise: Promise<unknown>, status: number): Promise<void> {
  try {
    await promise;
  } catch (error) {
    expect(readHttpStatus(error)).toBe(status);
    return;
  }

  throw new Error(`Expected request to reject with HTTP ${status}`);
}

describe('request supervision', () => {
  it('fails fast when the managed connection is already auth_failed', async () => {
    const supervisor = createSupervisor(createState({ phase: 'auth_failed', reason: 'auth_invalid' }));

    expect(() => assertManagedConnectionReadyForRequest(supervisor.getState(), { requireAuth: true })).toThrowError(
      expect.objectContaining({
        name: 'HttpStatusError',
        message: 'Authentication required',
        code: 'not_authenticated',
      }),
    );
    expect(() => assertManagedConnectionReadyForRequest(createState({ phase: 'offline', reason: 'server_unreachable' }))).toThrowError(
      expect.objectContaining({
        name: 'HttpStatusError',
        message: 'Server is currently unreachable',
      }),
    );
    try {
      assertManagedConnectionReadyForRequest(supervisor.getState(), { requireAuth: true });
    } catch (error) {
      expect(readHttpStatus(error)).toBe(401);
    }

    await expect(
      runSupervisedRequest({
        supervisor,
        requireAuth: true,
        request: async () => 'ok',
      }),
    ).rejects.toMatchObject({
      name: 'HttpStatusError',
      message: 'Authentication required',
    });
  });

  it('allows requests to proceed while offline when online gating is disabled', async () => {
    const supervisor = createSupervisor(createState({ phase: 'offline', reason: 'server_unreachable' }));

    await expect(
      runSupervisedRequest({
        supervisor,
        requireAuth: true,
        requireOnline: false,
        request: async () => 'ok',
      }),
    ).resolves.toBe('ok');
  });

  it('keeps omitted purpose on the legacy online default', async () => {
    const supervisor = createSupervisor(createState({ phase: 'offline', reason: 'server_unreachable' }));
    const request = vi.fn(async () => 'ok');

    await expectRejectedHttpStatus(
      runSupervisedRequest({
        supervisor,
        request,
      }),
      503,
    );

    expect(request).not.toHaveBeenCalled();
  });

  it('derives probe online policy when overrides are omitted', async () => {
    const supervisor = createSupervisor(createState({ phase: 'offline', reason: 'server_unreachable' }));

    await expect(
      runSupervisedRequest({
        supervisor,
        purpose: 'probe',
        request: async () => 'ok',
      }),
    ).resolves.toBe('ok');
  });

  it('derives recovery read online policy when overrides are omitted', async () => {
    const supervisor = createSupervisor(createState({ phase: 'offline', reason: 'server_unreachable' }));
    const request = vi.fn(async () => 'ok');

    await expectRejectedHttpStatus(
      runSupervisedRequest({
        supervisor,
        purpose: 'recovery_read',
        request,
      }),
      503,
    );

    expect(request).not.toHaveBeenCalled();
  });

  it('prefers explicit online override for recovery read purpose', async () => {
    const supervisor = createSupervisor(createState({ phase: 'offline', reason: 'server_unreachable' }));

    await expect(
      runSupervisedRequest({
        supervisor,
        purpose: 'recovery_read',
        requireOnline: false,
        request: async () => 'ok',
      }),
    ).resolves.toBe('ok');
  });

  it('prefers explicit auth override for recovery read purpose', async () => {
    const supervisor = createSupervisor(createState({ phase: 'auth_failed', reason: 'auth_invalid' }));

    await expect(
      runSupervisedRequest({
        supervisor,
        purpose: 'recovery_read',
        requireAuth: false,
        request: async () => 'ok',
      }),
    ).resolves.toBe('ok');
  });

  it('reports terminal auth errors back into the supervisor', async () => {
    const supervisor = createSupervisor();

    await expect(
      runSupervisedRequest({
        supervisor,
        requireAuth: true,
        request: async () => {
          throw new HttpStatusError(401, 'expired token');
        },
      }),
    ).rejects.toThrow(/expired token/i);

    expect(supervisor.reportProbeResult).toHaveBeenCalledWith({
      status: 'auth_failed',
      statusCode: 401,
      errorMessage: 'expired token',
    } satisfies ReadinessProbeResult);
  });

  it('keeps durable domain-write failures operation-local while still reporting authentication loss', async () => {
    const supervisor = createSupervisor();
    const serviceUnavailable = new HttpStatusError(503, 'settlement temporarily unavailable');

    await expect(
      runSupervisedRequest({
        supervisor,
        purpose: 'durable_write',
        request: async () => {
          throw serviceUnavailable;
        },
      }),
    ).rejects.toBe(serviceUnavailable);

    expect(supervisor.reportProbeResult).not.toHaveBeenCalled();

    await expect(
      runSupervisedRequest({
        supervisor,
        purpose: 'durable_write',
        request: async () => {
          throw new HttpStatusError(401, 'expired token');
        },
      }),
    ).rejects.toThrow(/expired token/i);

    expect(supervisor.reportProbeResult).toHaveBeenCalledOnce();
    expect(supervisor.reportProbeResult).toHaveBeenCalledWith({
      status: 'auth_failed',
      statusCode: 401,
      errorMessage: 'expired token',
    } satisfies ReadinessProbeResult);
  });

  it('keeps every non-probe HTTP request outcome from deciding socket health', async () => {
    const purposes = [
      undefined,
      'durable_write',
      'recovery_read',
      'transcript_sync',
      'ephemeral_update',
      'snapshot_fetch',
    ] as const;

    for (const purpose of purposes) {
      const supervisor = createSupervisor();
      const serviceUnavailable = new HttpStatusError(503, `domain failure for ${purpose ?? 'legacy request'}`);

      await expect(runSupervisedRequest({
        supervisor,
        ...(purpose ? { purpose } : {}),
        request: async () => {
          throw serviceUnavailable;
        },
      })).rejects.toBe(serviceUnavailable);

      expect(supervisor.reportProbeResult).not.toHaveBeenCalled();
    }
  });

  it('reports socket connect auth errors back into the supervisor', async () => {
    const supervisor = createSupervisor();
    const socketAuthError = Object.assign(new Error('invalid token'), {
      data: {
        statusCode: 401,
        error: 'invalid-token',
      },
    });

    await expect(
      runSupervisedRequest({
        supervisor,
        requireAuth: true,
        request: async () => {
          throw socketAuthError;
        },
      }),
    ).rejects.toBe(socketAuthError);

    expect(supervisor.reportProbeResult).toHaveBeenCalledWith({
      status: 'auth_failed',
      statusCode: 401,
      errorMessage: 'invalid token',
    } satisfies ReadinessProbeResult);
  });

  it('reports retryable response and transport failures without inventing domain semantics', () => {
    const supervisor = createSupervisor();
    const connectionError = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:443'), {
      code: 'ECONNREFUSED',
    });

    reportRequestOutcomeToSupervisor({
      supervisor,
      statusCode: 503,
      error: new HttpStatusError(503, 'busy'),
      hadAuth: true,
    });

    reportRequestOutcomeToSupervisor({
      supervisor,
      error: connectionError,
      hadAuth: true,
    });

    reportRequestOutcomeToSupervisor({
      supervisor,
      error: new Error('domain validation failed'),
      hadAuth: true,
    });

    expect(supervisor.reportProbeResult).toHaveBeenNthCalledWith(1, {
      status: 'retry_later',
      errorMessage: 'busy',
    } satisfies ReadinessProbeResult);
    expect(supervisor.reportProbeResult).toHaveBeenNthCalledWith(2, {
      status: 'server_unreachable',
      errorMessage: 'connect ECONNREFUSED 127.0.0.1:443',
    } satisfies ReadinessProbeResult);
    expect(supervisor.reportProbeResult).toHaveBeenCalledTimes(2);
  });
});
