import { describe, expect, it } from 'vitest';

import { createPendingPathCleanupQueue } from './PendingPathCleanupQueue';

describe('createPendingPathCleanupQueue', () => {
  it('keeps pending targets while retained and removes them once eligible', async () => {
    const removedPaths: string[] = [];
    const queue = createPendingPathCleanupQueue({
      removePath: async (path) => {
        removedPaths.push(path);
      },
    });

    queue.setPending('target-1', { path: '/tmp/target-1' });

    await expect(queue.drainPending({
      shouldKeepPending: async () => true,
      toCleanedResult: (target) => ({ cleaned: true as const, path: target.path }),
    })).resolves.toEqual([]);
    expect(removedPaths).toEqual([]);

    await expect(queue.drainPending({
      shouldKeepPending: async () => false,
      toCleanedResult: (target) => ({ cleaned: true as const, path: target.path }),
    })).resolves.toEqual([{ cleaned: true, path: '/tmp/target-1' }]);
    expect(removedPaths).toEqual(['/tmp/target-1']);
  });

  it('logs retry exhaustion before dropping a repeatedly failing target', async () => {
    const terminalDiagnostics: Array<Readonly<{ key: string; path: string; attempts: number; error: unknown }>> = [];
    let removeAttempts = 0;
    const queue = createPendingPathCleanupQueue({
      maxCleanupRetries: 2,
      removePath: async () => {
        removeAttempts += 1;
        throw Object.assign(new Error('busy'), { code: 'EBUSY' });
      },
      onRetryExhausted: (event) => {
        terminalDiagnostics.push(event);
      },
    });

    await expect(queue.removeNow('target-1', { path: '/tmp/target-1' })).rejects.toMatchObject({ code: 'EBUSY' });
    await expect(queue.drainPending({
      shouldKeepPending: async () => false,
      toCleanedResult: (target) => ({ cleaned: true as const, path: target.path }),
    })).rejects.toMatchObject({ code: 'EBUSY' });
    await expect(queue.drainPending({
      shouldKeepPending: async () => false,
      toCleanedResult: (target) => ({ cleaned: true as const, path: target.path }),
    })).resolves.toEqual([]);

    expect(removeAttempts).toBe(2);
    expect(terminalDiagnostics).toEqual([
      expect.objectContaining({
        key: 'target-1',
        path: '/tmp/target-1',
        attempts: 2,
        error: expect.objectContaining({ code: 'EBUSY' }),
      }),
    ]);
  });
});
