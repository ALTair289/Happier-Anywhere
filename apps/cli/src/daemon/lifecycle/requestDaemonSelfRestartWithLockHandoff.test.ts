import { describe, expect, it, vi } from 'vitest';

import { requestDaemonSelfRestartWithLockHandoff } from './requestDaemonSelfRestartWithLockHandoff';

describe('requestDaemonSelfRestartWithLockHandoff', () => {
  it('releases the daemon lock before requesting a self-restart', async () => {
    const releaseDaemonLock = vi.fn(async () => {});
    const acquireDaemonLock = vi.fn(async () => 'reacquired-lock');
    const requestSelfRestart = vi.fn(async () => ({ status: 'exited' as const }));
    let currentLock: string | null = 'current-lock';

    const result = await requestDaemonSelfRestartWithLockHandoff({
      getCurrentDaemonLockHandle: () => currentLock,
      setCurrentDaemonLockHandle: (lock) => {
        currentLock = lock;
      },
      releaseDaemonLock,
      acquireDaemonLock,
      requestShutdown: vi.fn(),
      requestSelfRestart,
      selfRestartParams: {
        expectedCliVersion: '2.0.0',
        timeoutMs: 30_000,
        pollMs: 250,
      },
    });

    expect(result.status).toBe('exited');
    expect(releaseDaemonLock).toHaveBeenCalledWith('current-lock');
    expect(requestSelfRestart).toHaveBeenCalledWith(expect.objectContaining({
      expectedCliVersion: '2.0.0',
    }));
    expect(acquireDaemonLock).not.toHaveBeenCalled();
    expect(currentLock).toBeNull();
  });

  it('reacquires the daemon lock when replacement confirmation fails', async () => {
    const releaseDaemonLock = vi.fn(async () => {});
    const acquireDaemonLock = vi.fn(async () => 'reacquired-lock');
    const requestShutdown = vi.fn();
    let currentLock: string | null = 'current-lock';

    const result = await requestDaemonSelfRestartWithLockHandoff({
      getCurrentDaemonLockHandle: () => currentLock,
      setCurrentDaemonLockHandle: (lock) => {
        currentLock = lock;
      },
      releaseDaemonLock,
      acquireDaemonLock,
      requestShutdown,
      requestSelfRestart: vi.fn(async () => ({ status: 'replacement_not_confirmed' as const })),
      selfRestartParams: {
        expectedCliVersion: '2.0.0',
        timeoutMs: 30_000,
        pollMs: 250,
      },
    });

    expect(result.status).toBe('replacement_not_confirmed');
    expect(acquireDaemonLock).toHaveBeenCalledTimes(1);
    expect(currentLock).toBe('reacquired-lock');
    expect(requestShutdown).not.toHaveBeenCalled();
  });

  it('stores the reacquired daemon lock when the restart request throws', async () => {
    const releaseDaemonLock = vi.fn(async () => {});
    const acquireDaemonLock = vi.fn(async () => 'reacquired-lock');
    const requestShutdown = vi.fn();
    let currentLock: string | null = 'current-lock';

    await expect(
      requestDaemonSelfRestartWithLockHandoff({
        getCurrentDaemonLockHandle: () => currentLock,
        setCurrentDaemonLockHandle: (lock) => {
          currentLock = lock;
        },
        releaseDaemonLock,
        acquireDaemonLock,
        requestShutdown,
        requestSelfRestart: vi.fn(async () => {
          throw new Error('boom');
        }),
        selfRestartParams: {
          expectedCliVersion: '2.0.0',
          timeoutMs: 30_000,
          pollMs: 250,
        },
      }),
    ).rejects.toThrow('boom');

    expect(acquireDaemonLock).toHaveBeenCalledTimes(1);
    expect(currentLock).toBe('reacquired-lock');
    expect(requestShutdown).not.toHaveBeenCalled();
  });
});
