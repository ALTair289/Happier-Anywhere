import { cpSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

import { withWorkspaceBundleLock } from '../../../scripts/workspaces/workspaceBundleLock.mjs';
import {
  resolveCliSharedDepsBuildLockPath,
  withOptionalCliSharedDepsBuildLock,
} from './optionalWorkspaceBundleLock.mjs';

describe('optionalWorkspaceBundleLock', () => {
  it('loads the canonical source owner when a checkout has an older bundled cli-common export map', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'happier-cli-lock-source-upgrade-'));
    const sourceRepoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
    try {
      writeFileSync(resolve(repoRoot, 'package.json'), '{"private":true}\n', 'utf8');
      writeFileSync(resolve(repoRoot, 'yarn.lock'), '# stale checkout fixture\n', 'utf8');

      const copiedScriptPath = resolve(repoRoot, 'apps', 'cli', 'scripts', 'optionalWorkspaceBundleLock.mjs');
      mkdirSync(dirname(copiedScriptPath), { recursive: true });
      cpSync(resolve(sourceRepoRoot, 'apps', 'cli', 'scripts', 'optionalWorkspaceBundleLock.mjs'), copiedScriptPath);

      const staleBundledPackageDir = resolve(
        repoRoot,
        'apps',
        'cli',
        'node_modules',
        '@happier-dev',
        'cli-common',
      );
      mkdirSync(resolve(staleBundledPackageDir, 'dist'), { recursive: true });
      writeFileSync(
        resolve(staleBundledPackageDir, 'package.json'),
        `${JSON.stringify({
          name: '@happier-dev/cli-common',
          version: '0.0.0',
          type: 'module',
          exports: { '.': './dist/index.js' },
        })}\n`,
        'utf8',
      );
      writeFileSync(resolve(staleBundledPackageDir, 'dist', 'index.js'), 'export {};\n', 'utf8');

      const canonicalSourcePackageDir = resolve(repoRoot, 'packages', 'cli-common');
      mkdirSync(canonicalSourcePackageDir, { recursive: true });
      for (const relativePath of [
        'workspaceBundleLock.mjs',
        'workspaceLockLease.mjs',
        'processInstance.mjs',
      ]) {
        cpSync(
          resolve(sourceRepoRoot, 'packages', 'cli-common', relativePath),
          resolve(canonicalSourcePackageDir, relativePath),
        );
      }

      const copiedModule = await import(`${pathToFileURL(copiedScriptPath).href}?source-upgrade=${Date.now()}`);
      expect(copiedModule.resolveCliSharedDepsBuildLockPath(repoRoot)).toBe(
        resolve(repoRoot, '.project', 'tmp', 'cli-dist-build.lock'),
      );
      expect(copiedModule.withWorkspaceBundleLock).toBeTypeOf('function');
      expect(copiedModule.withWorkspaceBundleLockSync).toBeTypeOf('function');
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('uses the canonical CLI dist build lock path', () => {
    const repoRoot = join(tmpdir(), 'happier-lock-path');

    expect(resolveCliSharedDepsBuildLockPath(repoRoot)).toBe(
      join(repoRoot, '.project', 'tmp', 'cli-dist-build.lock'),
    );
  });

  it('reenters only when the inherited owner lease exactly matches', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'happier-cli-lock-reentry-'));
    try {
      const lockPath = resolveCliSharedDepsBuildLockPath(repoRoot);

      const result = await withWorkspaceBundleLock(
        async ({ heldLockValue }) =>
          await withOptionalCliSharedDepsBuildLock(
            async () => 'nested',
            {
              repoRoot,
              lockPath,
              env: { HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD: heldLockValue },
              lockTimeoutMs: 60,
              lockPollIntervalMs: 10,
              lockStaleAfterMs: 1_000,
            },
          ),
        {
          lockPath,
          timeoutMs: 2_000,
          pollIntervalMs: 10,
          staleAfterMs: 1_000,
        },
      );

      expect(result).toBe('nested');
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('waits when the inherited lock path does not match', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'happier-cli-lock-mismatch-'));
    try {
      const lockPath = resolveCliSharedDepsBuildLockPath(repoRoot);

      await withWorkspaceBundleLock(
        async () => {
          await expect(
            withOptionalCliSharedDepsBuildLock(
              async () => 'nested',
              {
                repoRoot,
                lockPath,
                env: { HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD: join(repoRoot, 'different.lock') },
                lockTimeoutMs: 60,
                lockPollIntervalMs: 10,
                lockStaleAfterMs: 1_000,
              },
            ),
          ).rejects.toThrow(/Timed out waiting for workspace bundle lock/);
        },
        {
          lockPath,
          timeoutMs: 2_000,
          pollIntervalMs: 10,
          staleAfterMs: 1_000,
        },
      );
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});
