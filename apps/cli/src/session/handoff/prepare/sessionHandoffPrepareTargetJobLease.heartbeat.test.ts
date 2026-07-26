import { mkdtemp, rename as renameMock, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

function createDeferred(): Readonly<{ promise: Promise<void>; resolve: () => void }> {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const renewalRenameEntered = createDeferred();
const releaseRenewalRename = createDeferred();

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return {
    ...actual,
    rename: vi.fn(async (oldPath: string, newPath: string) => {
      if (newPath.endsWith('/runner.json')) {
        renewalRenameEntered.resolve();
        await releaseRenewalRename.promise;
      }
      return await actual.rename(oldPath, newPath);
    }),
  };
});

import {
  startSessionHandoffPrepareTargetJobLeaseHeartbeat,
  tryAcquireSessionHandoffPrepareTargetJobLease,
} from './sessionHandoffPrepareTargetJobLease';

describe('sessionHandoffPrepareTargetJobLease heartbeat serialization', () => {
  it('drains an in-flight atomic renewal before stop resolves', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-handoff-prepare-heartbeat-stop-'));
    const jobId = 'prepare_test_heartbeat_stop';
    const ownerId = 'status-probe:heartbeat-stop';
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
      await renewalRenameEntered.promise;

      let stopResolved = false;
      const stop = heartbeat.stop().then((state) => {
        stopResolved = true;
        return state;
      });
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(stopResolved).toBe(false);

      releaseRenewalRename.resolve();
      await expect(stop).resolves.toMatchObject({ status: 'active' });
      expect(renameMock).toHaveBeenCalledWith(expect.any(String), expect.stringMatching(/runner\.json$/u));
    } finally {
      releaseRenewalRename.resolve();
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });
});
