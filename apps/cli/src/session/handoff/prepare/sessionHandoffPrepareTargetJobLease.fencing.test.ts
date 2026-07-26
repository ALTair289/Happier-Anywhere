import { mkdir, mkdtemp, readFile as readFileMock, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const fsBarrier = vi.hoisted(() => {
  let armed = false;
  let enteredResolve: (() => void) | null = null;
  let releaseResolve: (() => void) | null = null;
  let entered = Promise.resolve();
  let release = Promise.resolve();

  return {
    arm() {
      armed = true;
      entered = new Promise<void>((resolve) => {
        enteredResolve = resolve;
      });
      release = new Promise<void>((resolve) => {
        releaseResolve = resolve;
      });
    },
    async pauseIfArmed(): Promise<void> {
      if (!armed) return;
      armed = false;
      enteredResolve?.();
      await release;
    },
    waitUntilEntered: async () => await entered,
    release: () => releaseResolve?.(),
    reset() {
      armed = false;
      releaseResolve?.();
    },
  };
});

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return {
    ...actual,
    readFile: vi.fn(async (path: string, encoding: BufferEncoding) => {
      const value = await actual.readFile(path, encoding);
      if (path.endsWith('/lease.json')) {
        // Pause after the OS read has captured the validated bytes but before the caller can mutate.
        await fsBarrier.pauseIfArmed();
      }
      return value;
    }),
  };
});

import {
  releaseSessionHandoffPrepareTargetJobLease,
  renewSessionHandoffPrepareTargetJobLease,
  tryAcquireSessionHandoffPrepareTargetJobLease,
} from './sessionHandoffPrepareTargetJobLease';

function leaseDirectory(activeServerDir: string, jobId: string): string {
  return join(activeServerDir, 'session-handoff', 'prepare-target-jobs-staging', jobId, 'lease');
}

async function readStableLease(activeServerDir: string, jobId: string): Promise<Readonly<{ ownerId: string; leaseId: string }>> {
  return JSON.parse(await readFileMock(join(leaseDirectory(activeServerDir, jobId), 'lease.json'), 'utf8')) as {
    ownerId: string;
    leaseId: string;
  };
}

async function settlesWithin(promise: Promise<unknown>, timeoutMs = 500): Promise<boolean> {
  return await Promise.race([
    promise.then(() => true, () => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
  ]);
}

afterEach(() => {
  fsBarrier.reset();
  vi.mocked(readFileMock).mockClear();
});

describe('sessionHandoffPrepareTargetJobLease successor fencing', () => {
  it('does not let a paused stale takeover remove or coexist with a successor acquisition', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-handoff-lease-takeover-fence-'));
    const jobId = 'job_stale_takeover_fence';
    const oldLeaseDirectory = leaseDirectory(activeServerDir, jobId);
    try {
      await mkdir(oldLeaseDirectory, { recursive: true });
      const stale = {
        leaseId: 'stale-lease',
        attempt: 1,
        ownerId: 'stale-owner',
        acquiredAtMs: 1,
        renewedAtMs: 1,
        expiresAtMs: 2,
      };
      await writeFile(join(oldLeaseDirectory, 'lease.json'), `${JSON.stringify(stale)}\n`, 'utf8');
      await writeFile(join(oldLeaseDirectory, 'runner.json'), `${JSON.stringify(stale)}\n`, 'utf8');

      fsBarrier.arm();
      const first = tryAcquireSessionHandoffPrepareTargetJobLease({
        activeServerDir,
        jobId,
        ownerId: 'takeover:first',
        nowMs: 10,
        ttlMs: 5_000,
      });
      await fsBarrier.waitUntilEntered();

      const second = tryAcquireSessionHandoffPrepareTargetJobLease({
        activeServerDir,
        jobId,
        ownerId: 'takeover:successor',
        nowMs: 10,
        ttlMs: 5_000,
      });
      const secondSettledBeforeFirstMutation = await settlesWithin(second);

      fsBarrier.release();
      const [firstResult, secondResult] = await Promise.all([first, second]);
      const winners = [firstResult, secondResult].filter((result) => result.acquired);
      const persisted = await readStableLease(activeServerDir, jobId);

      expect(secondSettledBeforeFirstMutation).toBe(false);
      expect(winners).toHaveLength(1);
      expect(persisted.ownerId).toBe(winners[0]!.lease!.ownerId);
      expect(persisted.leaseId).toBe(winners[0]!.lease!.leaseId);
    } finally {
      fsBarrier.release();
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });

  it('does not let a paused stale renewal overwrite a successor acquisition', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-handoff-lease-renew-fence-'));
    const jobId = 'job_stale_renew_fence';
    try {
      const first = await tryAcquireSessionHandoffPrepareTargetJobLease({
        activeServerDir,
        jobId,
        ownerId: 'renew:first',
        nowMs: 100,
        ttlMs: 1_000,
      });
      expect(first.acquired).toBe(true);

      fsBarrier.arm();
      const renewal = renewSessionHandoffPrepareTargetJobLease({
        activeServerDir,
        jobId,
        ownerId: 'renew:first',
        leaseId: first.lease!.leaseId!,
        nowMs: 200,
        ttlMs: 1_000,
      });
      await fsBarrier.waitUntilEntered();

      const successor = tryAcquireSessionHandoffPrepareTargetJobLease({
        activeServerDir,
        jobId,
        ownerId: 'renew:successor',
        nowMs: 2_000,
        ttlMs: 5_000,
      });
      const successorSettledBeforeRenewal = await settlesWithin(successor);

      fsBarrier.release();
      const [renewed, acquired] = await Promise.all([renewal, successor]);
      const persisted = await readStableLease(activeServerDir, jobId);

      expect(successorSettledBeforeRenewal).toBe(false);
      expect(renewed.renewed).toBe(true);
      expect(acquired.acquired).toBe(true);
      expect(persisted.ownerId).toBe('renew:successor');
      expect(persisted.leaseId).toBe(acquired.lease!.leaseId);
    } finally {
      fsBarrier.release();
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });

  it('does not let a paused stale release delete a successor acquisition', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-handoff-lease-release-fence-'));
    const jobId = 'job_stale_release_fence';
    try {
      const first = await tryAcquireSessionHandoffPrepareTargetJobLease({
        activeServerDir,
        jobId,
        ownerId: 'release:first',
        nowMs: 100,
        ttlMs: 1_000,
      });
      expect(first.acquired).toBe(true);

      fsBarrier.arm();
      const release = releaseSessionHandoffPrepareTargetJobLease({
        activeServerDir,
        jobId,
        ownerId: 'release:first',
        leaseId: first.lease!.leaseId!,
      });
      await fsBarrier.waitUntilEntered();

      const successor = tryAcquireSessionHandoffPrepareTargetJobLease({
        activeServerDir,
        jobId,
        ownerId: 'release:successor',
        nowMs: 2_000,
        ttlMs: 5_000,
      });
      const successorSettledBeforeRelease = await settlesWithin(successor);

      fsBarrier.release();
      const [, acquired] = await Promise.all([release, successor]);
      const persisted = await readStableLease(activeServerDir, jobId);

      expect(successorSettledBeforeRelease).toBe(false);
      expect(acquired.acquired).toBe(true);
      expect(persisted.ownerId).toBe('release:successor');
      expect(persisted.leaseId).toBe(acquired.lease!.leaseId);
    } finally {
      fsBarrier.release();
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });
});
