import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return {
    ...actual,
    rename: vi.fn(async (oldPath: string, newPath: string) => {
      if (newPath.endsWith('/runner.json')) {
        const error = new Error('injected renewal failure') as NodeJS.ErrnoException;
        error.code = 'EIO';
        throw error;
      }
      return await actual.rename(oldPath, newPath);
    }),
  };
});

import {
  startSessionHandoffPrepareTargetJobLeaseHeartbeat,
  tryAcquireSessionHandoffPrepareTargetJobLease,
} from './sessionHandoffPrepareTargetJobLease';

describe('sessionHandoffPrepareTargetJobLease heartbeat failure', () => {
  it('surfaces renewal errors and invalidates the proof', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-handoff-prepare-heartbeat-error-'));
    const jobId = 'prepare_test_heartbeat_error';
    const ownerId = 'status-probe:heartbeat-error';
    try {
      const acquired = await tryAcquireSessionHandoffPrepareTargetJobLease({
        activeServerDir,
        jobId,
        ownerId,
        nowMs: Date.now(),
        ttlMs: 1_000,
      });
      expect(acquired.acquired).toBe(true);

      const heartbeat = startSessionHandoffPrepareTargetJobLeaseHeartbeat({
        activeServerDir,
        jobId,
        ownerId,
        leaseId: acquired.lease!.leaseId!,
        ttlMs: 1_000,
        nowMs: () => Date.now(),
      });

      await vi.waitFor(() => {
        expect(heartbeat.getState()).toMatchObject({
          status: 'error',
          error: expect.objectContaining({ code: 'EIO' }),
        });
      });
      await expect(heartbeat.proof.validate()).resolves.toBe(false);
      await expect(heartbeat.stop()).resolves.toMatchObject({ status: 'error' });
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });
});
