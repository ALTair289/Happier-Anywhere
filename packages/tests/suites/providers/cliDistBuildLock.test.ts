import { existsSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { withWorkspaceBundleLock } from '@happier-dev/cli-common/workspaceBundleLock';
import { describe, expect, it } from 'vitest';

import { withCliDistBuildLock } from '../../src/testkit/process/cliDist';

describe('providers: CLI dist build lock', () => {
  it('contends with the canonical owner and rejects path-only inheritance', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'happier-cli-dist-lock-contention-'));
    const lockPath = join(workDir, 'cli-dist-build.lock');
    let testkitEntered = false;

    await withWorkspaceBundleLock(
      async () => {
        await expect(
          withCliDistBuildLock(
            async () => {
              testkitEntered = true;
            },
            { lockPath, heldLockValue: lockPath, timeoutMs: 120, pollIntervalMs: 20, staleAfterMs: 0 },
          ),
        ).rejects.toThrow(/timed out waiting/i);
      },
      { lockPath, timeoutMs: 500, pollIntervalMs: 20, staleAfterMs: 0 },
    );

    expect(testkitEntered).toBe(false);
  });

  it('does not delete a canonical successor that acquires the path before cleanup', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'happier-cli-dist-lock-successor-'));
    const lockPath = join(workDir, 'cli-dist-build.lock');
    let releaseSuccessor!: () => void;
    const successorRelease = new Promise<void>((resolve) => {
      releaseSuccessor = resolve;
    });
    let successorEntered!: () => void;
    const successorEntry = new Promise<void>((resolve) => {
      successorEntered = resolve;
    });
    let successorPromise: Promise<void> | null = null;

    await withCliDistBuildLock(
      async () => {
        unlinkSync(lockPath);
        successorPromise = withWorkspaceBundleLock(
          async () => {
            successorEntered();
            await successorRelease;
          },
          { lockPath, timeoutMs: 500, pollIntervalMs: 20 },
        );
        await successorEntry;
      },
      { lockPath, timeoutMs: 500, pollIntervalMs: 20 },
    );

    expect(existsSync(lockPath)).toBe(true);
    expect(JSON.parse(readFileSync(lockPath, 'utf8'))).toMatchObject({ pid: process.pid });
    releaseSuccessor();
    await successorPromise;
    expect(existsSync(lockPath)).toBe(false);
  });

  it('reclaims stale lock files from dead owners', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'happier-cli-dist-lock-'));
    const lockPath = join(workDir, 'cli-dist-build.lock');
    writeFileSync(lockPath, JSON.stringify({ createdAtMs: 1 }), 'utf8');

    const result = await withCliDistBuildLock(
      async () => {
        expect(existsSync(lockPath)).toBe(true);
        return 'ok';
      },
      { lockPath, timeoutMs: 500, pollIntervalMs: 20, staleAfterMs: 0 },
    );

    expect(result).toBe('ok');
    expect(existsSync(lockPath)).toBe(false);
  });

  it('does not reclaim fresh locks from live owners', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'happier-cli-dist-lock-'));
    const lockPath = join(workDir, 'cli-dist-build.lock');
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, createdAtMs: Date.now() }), 'utf8');

    await expect(
      withCliDistBuildLock(async () => 'ok', {
        lockPath,
        timeoutMs: 120,
        pollIntervalMs: 20,
        staleAfterMs: 120_000,
      }),
    ).rejects.toThrow(/pid=/);

    expect(existsSync(lockPath)).toBe(true);
  });
});
