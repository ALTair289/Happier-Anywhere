import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { createTempDirSync } from '../src/testkit/fs/tempDir';
import { buildCliDist } from './build.mjs';
import { withWorkspaceBundleLock, withWorkspaceBundleLockSync } from './optionalWorkspaceBundleLock.mjs';

describe('buildCliDist', () => {
  it('does not reacquire a matching build lock declared by its parent process', async () => {
    const packageRoot = createTempDirSync('happier-cli-build-parent-lock-');
    try {
      const lockPath = resolve(packageRoot, '.project', 'tmp', 'cli-dist-build.lock');
      const events: string[] = [];

      await withWorkspaceBundleLock(
        async () => {
          await buildCliDist({
            packageRoot,
            repoRoot: packageRoot,
            lockPath,
            lockTimeoutMs: 50,
            lockPollIntervalMs: 10,
            lockStaleAfterMs: 1_000,
            env: {
              ...process.env,
              HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD: lockPath,
            },
            rmDistImpl: async () => { events.push('rm'); },
            resolveTypeScriptCliPathImpl: () => '/repo/node_modules/@typescript/native/bin/tsc',
            runTypecheckImpl: () => { events.push('typecheck'); },
            runPkgrollBuildImpl: () => { events.push('bundle'); },
            finalizeDistImpl: () => { events.push('finalize'); },
            syncPackageDistImpl: () => { events.push('sync'); },
          });
        },
        {
          lockPath,
          timeoutMs: 500,
          pollIntervalMs: 10,
          staleAfterMs: 1_000,
        },
      );

      expect(events).toEqual(['rm', 'typecheck', 'bundle', 'finalize', 'sync']);
    } finally {
      rmSync(packageRoot, { recursive: true, force: true });
    }
  });

  it('holds the CLI dist build lock across typecheck, bundle, finalize, and package sync', async () => {
    const packageRoot = createTempDirSync('happier-cli-build-lock-section-');
    try {
      const lockPath = resolve(packageRoot, '.project', 'tmp', 'cli-dist-build.lock');
      const eventsPath = join(packageRoot, 'events.txt');

      await buildCliDist({
        packageRoot,
        repoRoot: packageRoot,
        lockPath,
        env: {
          ...process.env,
          HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD: lockPath,
        },
        lockTimeoutMs: 500,
        lockPollIntervalMs: 10,
        lockStaleAfterMs: 1_000,
        rmDistImpl: async () => {
          writeFileSync(eventsPath, 'rm\n', { flag: 'a' });
        },
        resolveTypeScriptCliPathImpl: () => '/repo/node_modules/@typescript/native/bin/tsc',
        runTypecheckImpl: () => {
          writeFileSync(eventsPath, 'typecheck\n', { flag: 'a' });
        },
        runPkgrollBuildImpl: () => {
          writeFileSync(eventsPath, 'bundle\n', { flag: 'a' });
        },
        finalizeDistImpl: () => {
          expect(() =>
            withWorkspaceBundleLockSync(
              () => undefined,
              {
                lockPath,
                timeoutMs: 50,
                pollIntervalMs: 10,
                staleAfterMs: 1_000,
              },
            ),
          ).toThrow(/Timed out waiting for workspace bundle lock/);
          writeFileSync(eventsPath, 'finalize\n', { flag: 'a' });
        },
        syncPackageDistImpl: () => {
          writeFileSync(eventsPath, 'sync\n', { flag: 'a' });
        },
      });

      expect(readFileSync(eventsPath, 'utf8')).toBe('rm\ntypecheck\nbundle\nfinalize\nsync\n');
    } finally {
      rmSync(packageRoot, { recursive: true, force: true });
    }
  });
});
