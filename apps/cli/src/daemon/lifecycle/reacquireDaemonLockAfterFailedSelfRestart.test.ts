import { describe, expect, it, vi } from 'vitest';

import { reacquireDaemonLockAfterFailedSelfRestart } from './reacquireDaemonLockAfterFailedSelfRestart';

describe('reacquireDaemonLockAfterFailedSelfRestart', () => {
  it('returns the current lock when the restart did not release it', async () => {
    const requestShutdown = vi.fn();
    const acquireDaemonLock = vi.fn(async () => 'new-lock');

    await expect(
      reacquireDaemonLockAfterFailedSelfRestart({
        releasedDaemonLockForRestart: false,
        currentDaemonLockHandle: 'current-lock',
        acquireDaemonLock,
        requestShutdown,
        resultStatus: 'replacement_not_confirmed',
      }),
    ).resolves.toBe('current-lock');

    expect(acquireDaemonLock).not.toHaveBeenCalled();
    expect(requestShutdown).not.toHaveBeenCalled();
  });

  it('keeps serving only when the daemon lock is reacquired after a failed replacement', async () => {
    const requestShutdown = vi.fn();
    const acquireDaemonLock = vi.fn(async () => 'reacquired-lock');

    await expect(
      reacquireDaemonLockAfterFailedSelfRestart({
        releasedDaemonLockForRestart: true,
        currentDaemonLockHandle: null,
        acquireDaemonLock,
        requestShutdown,
        resultStatus: 'replacement_not_confirmed',
      }),
    ).resolves.toBe('reacquired-lock');

    expect(acquireDaemonLock).toHaveBeenCalledTimes(1);
    expect(requestShutdown).not.toHaveBeenCalled();
  });

  it('requests shutdown when the daemon cannot reacquire its lock after a failed replacement', async () => {
    const requestShutdown = vi.fn();
    const acquireDaemonLock = vi.fn(async () => null);

    await expect(
      reacquireDaemonLockAfterFailedSelfRestart({
        releasedDaemonLockForRestart: true,
        currentDaemonLockHandle: null,
        acquireDaemonLock,
        requestShutdown,
        resultStatus: 'replacement_not_confirmed',
      }),
    ).rejects.toThrow(/could not reacquire its lifecycle lock/);

    expect(acquireDaemonLock).toHaveBeenCalledTimes(1);
    expect(requestShutdown).toHaveBeenCalledWith(
      'exception',
      expect.stringContaining('serving lockless'),
    );
  });
});
