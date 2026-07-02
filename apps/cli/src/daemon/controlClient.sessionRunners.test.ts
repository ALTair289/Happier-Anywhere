import { afterEach, describe, expect, it, vi } from 'vitest';

import { restartAllDaemonSessionRunners } from './controlClient';

const readDaemonStateMock = vi.hoisted(() => vi.fn(async () => ({
  pid: process.pid,
  httpPort: 48765,
  controlToken: 'control-token',
})));

vi.mock('@/persistence', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/persistence')>();
  return {
    ...actual,
    readDaemonState: readDaemonStateMock,
  };
});

describe('daemon control client: session runner restart', () => {
  afterEach(() => {
    readDaemonStateMock.mockReset();
    readDaemonStateMock.mockImplementation(async () => ({
      pid: process.pid,
      httpPort: 48765,
      controlToken: 'control-token',
    }));
    vi.restoreAllMocks();
  });

  it('posts bulk restart requests to the authenticated daemon control endpoint', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        ok: true,
        mode: 'force_current_cli',
        requestedCount: 2,
        restartedCount: 1,
        skippedCount: 1,
        failedCount: 0,
        results: [
          { ok: true, status: 'restarted', sessionId: 'sess_1' },
          { ok: true, status: 'already_current', sessionId: 'sess_2' },
        ],
      }),
    } as Response);

    await expect(restartAllDaemonSessionRunners({
      mode: 'force_current_cli',
      dryRun: false,
      reason: 'daemon_restart_session_runners',
    })).resolves.toMatchObject({
      ok: true,
      requestedCount: 2,
      restartedCount: 1,
      skippedCount: 1,
      failedCount: 0,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:48765/session-runners/restart-all',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
          'x-happier-daemon-token': 'control-token',
        }),
        body: JSON.stringify({
          mode: 'force_current_cli',
          dryRun: false,
          reason: 'daemon_restart_session_runners',
        }),
      }),
    );
  });

  it('fails closed when the daemon returns a malformed bulk restart response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ ok: true }),
    } as Response);

    await expect(restartAllDaemonSessionRunners({
      mode: 'if_stale',
      dryRun: true,
      reason: 'daemon_restart_session_runners_command',
    })).rejects.toThrow('Invalid daemon session runner restart response');
  });
});
