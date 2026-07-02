import { describe, expect, it, vi } from 'vitest';

import { createDaemonControlApp } from './controlServer';

function createBaseApp(overrides: Partial<Parameters<typeof createDaemonControlApp>[0]> = {}) {
  return createDaemonControlApp({
    getChildren: () => [],
    machineId: 'machine_local',
    stopSession: async () => true,
    spawnSession: async () => ({ type: 'success', sessionId: 'happy-test-123' }),
    requestShutdown: () => {},
    onHappySessionWebhook: () => {},
    controlToken: 'test-token',
    ...overrides,
  });
}

describe('daemon control server: /restart', () => {
  it('requires daemon control auth', async () => {
    const requestSelfRestart = vi.fn(async () => {});
    const app = createBaseApp({ requestSelfRestart } as Partial<Parameters<typeof createDaemonControlApp>[0]>);
    try {
      await app.ready();
      const res = await app.inject({ method: 'POST', url: '/restart' });
      expect(res.statusCode).toBe(401);
      expect(requestSelfRestart).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('returns restarting once and already_restarting for concurrent requests', async () => {
    let resolveRestart!: () => void;
    const restartPromise = new Promise<void>((resolve) => {
      resolveRestart = resolve;
    });
    const requestSelfRestart = vi.fn(async () => {
      await restartPromise;
    });
    const app = createBaseApp({ requestSelfRestart } as Partial<Parameters<typeof createDaemonControlApp>[0]>);
    try {
      await app.ready();
      const first = await app.inject({
        method: 'POST',
        url: '/restart',
        headers: { 'x-happier-daemon-token': 'test-token' },
      });
      const second = await app.inject({
        method: 'POST',
        url: '/restart',
        headers: { 'x-happier-daemon-token': 'test-token' },
      });

      expect(first.statusCode).toBe(202);
      expect(first.json()).toEqual({ status: 'restarting' });
      expect(second.statusCode).toBe(202);
      expect(second.json()).toEqual({ status: 'already_restarting' });

      await vi.waitFor(() => expect(requestSelfRestart).toHaveBeenCalledTimes(1));
      resolveRestart();
    } finally {
      await app.close();
    }
  });

  it('rejects restart while shutting down', async () => {
    const requestSelfRestart = vi.fn(async () => {});
    const app = createBaseApp({
      requestSelfRestart,
      isShuttingDown: () => true,
    } as Partial<Parameters<typeof createDaemonControlApp>[0]>);
    try {
      await app.ready();
      const res = await app.inject({
        method: 'POST',
        url: '/restart',
        headers: { 'x-happier-daemon-token': 'test-token' },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({ status: 'shutting_down' });
      expect(requestSelfRestart).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('resets the single-flight state after replacement failure', async () => {
    const requestSelfRestart = vi.fn()
      .mockRejectedValueOnce(new Error('replacement timeout'))
      .mockResolvedValueOnce(undefined);
    const app = createBaseApp({ requestSelfRestart } as Partial<Parameters<typeof createDaemonControlApp>[0]>);
    try {
      await app.ready();
      const first = await app.inject({
        method: 'POST',
        url: '/restart',
        headers: { 'x-happier-daemon-token': 'test-token' },
      });
      expect(first.statusCode).toBe(202);
      await vi.waitFor(() => expect(requestSelfRestart).toHaveBeenCalledTimes(1));

      const second = await app.inject({
        method: 'POST',
        url: '/restart',
        headers: { 'x-happier-daemon-token': 'test-token' },
      });
      expect(second.statusCode).toBe(202);
      expect(second.json()).toEqual({ status: 'restarting' });
      await vi.waitFor(() => expect(requestSelfRestart).toHaveBeenCalledTimes(2));
    } finally {
      await app.close();
    }
  });

  it('rejects unsupported restart options instead of silently ignoring handler contract drift', async () => {
    const requestSelfRestart = vi.fn(async () => {});
    const app = createBaseApp({ requestSelfRestart } as Partial<Parameters<typeof createDaemonControlApp>[0]>);
    try {
      await app.ready();
      const res = await app.inject({
        method: 'POST',
        url: '/restart',
        headers: { 'x-happier-daemon-token': 'test-token' },
        payload: {
          stopSessions: true,
          restartSessionRunners: false,
        },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ status: 'unsupported_restart_options' });
      expect(requestSelfRestart).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
