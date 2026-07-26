import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { createTempDirSync } from '../src/testkit/fs/tempDir';
import { withWorkspaceBundleLock } from './optionalWorkspaceBundleLock.mjs';
import { atomicPromoteDirectorySync, syncPackageDist } from './syncPackageDist.mjs';

describe('syncPackageDist', () => {
  it('retries transient Windows rename locks while preserving atomic promotion', () => {
    const packageRoot = createTempDirSync('happier-cli-atomic-promote-windows-retry-');
    try {
      const sourceDir = join(packageRoot, 'staging');
      const targetDir = join(packageRoot, 'dist');
      const backupDir = join(packageRoot, 'backup');
      mkdirSync(sourceDir, { recursive: true });
      mkdirSync(targetDir, { recursive: true });
      writeFileSync(join(sourceDir, 'index.mjs'), 'export const next = true;\n', 'utf8');
      writeFileSync(join(targetDir, 'index.mjs'), 'export const previous = true;\n', 'utf8');
      let transientFailures = 0;

      atomicPromoteDirectorySync({
        sourceDir,
        targetDir,
        backupDir,
        platform: 'win32',
        waitSync() {},
        renameSync(from, to) {
          if (from === sourceDir && to === targetDir && transientFailures === 0) {
            transientFailures += 1;
            const error = new Error('resource busy') as NodeJS.ErrnoException;
            error.code = 'EBUSY';
            throw error;
          }
          renameSync(from, to);
        },
      });

      expect(transientFailures).toBe(1);
      expect(readFileSync(join(targetDir, 'index.mjs'), 'utf8')).toBe('export const next = true;\n');
      expect(existsSync(backupDir)).toBe(false);
    } finally {
      rmSync(packageRoot, { recursive: true, force: true });
    }
  });

  it('preserves the previous package-dist when replacement copy fails', () => {
    const packageRoot = createTempDirSync('happier-cli-sync-package-dist-');
    try {
      const distDir = join(packageRoot, 'dist');
      const packageDistDir = join(packageRoot, 'package-dist');
      mkdirSync(distDir, { recursive: true });
      mkdirSync(packageDistDir, { recursive: true });
      writeFileSync(join(distDir, 'index.mjs'), 'export const next = true;\n', 'utf8');
      writeFileSync(join(packageDistDir, 'index.mjs'), 'export const previous = true;\n', 'utf8');

      expect(() =>
        syncPackageDist({
          packageRoot,
          cpSync() {
            throw new Error('copy failed');
          },
          mkdirSync,
          renameSync,
          rmSync,
        }),
      ).toThrow('copy failed');

      expect(existsSync(join(packageDistDir, 'index.mjs'))).toBe(true);
      expect(readFileSync(join(packageDistDir, 'index.mjs'), 'utf8')).toBe('export const previous = true;\n');
    } finally {
      rmSync(packageRoot, { recursive: true, force: true });
    }
  });

  it('waits for the shared CLI build lock before promoting package-dist', async () => {
    const packageRoot = createTempDirSync('happier-cli-sync-package-dist-lock-');
    try {
      const distDir = join(packageRoot, 'dist');
      const packageDistDir = join(packageRoot, 'package-dist');
      mkdirSync(distDir, { recursive: true });
      mkdirSync(packageDistDir, { recursive: true });
      writeFileSync(join(distDir, 'index.mjs'), 'export const next = true;\n', 'utf8');
      writeFileSync(join(packageDistDir, 'index.mjs'), 'export const previous = true;\n', 'utf8');

      const lockPath = resolve(packageRoot, '.project', 'tmp', 'cli-dist-build.lock');
      await withWorkspaceBundleLock(
        async () => {
          expect(() =>
            syncPackageDist({
              packageRoot,
              lockPath,
              lockTimeoutMs: 50,
              lockPollIntervalMs: 10,
              lockStaleAfterMs: 1_000,
            }),
          ).toThrow(/Timed out waiting for workspace bundle lock/);
          expect(readFileSync(join(packageDistDir, 'index.mjs'), 'utf8')).toBe('export const previous = true;\n');
        },
        {
          lockPath,
          timeoutMs: 2_000,
          pollIntervalMs: 10,
          staleAfterMs: 1_000,
        },
      );
    } finally {
      rmSync(packageRoot, { recursive: true, force: true });
    }
  });

  it('rejects incomplete write filesystem adapters instead of mixing fake and real promotion operations', () => {
    const packageRoot = createTempDirSync('happier-cli-sync-package-dist-incomplete-fs-');
    try {
      mkdirSync(join(packageRoot, 'dist'), { recursive: true });

      expect(() =>
        syncPackageDist({
          packageRoot,
          cpSync() {
            return undefined;
          },
        }),
      ).toThrow(/incomplete filesystem adapter/);
    } finally {
      rmSync(packageRoot, { recursive: true, force: true });
    }
  });

  it('can skip package-dist promotion for a staged dist build', () => {
    const packageRoot = createTempDirSync('happier-cli-sync-package-dist-skip-');
    try {
      const stagedDistDir = join(packageRoot, '.tmp.cli-dist-build');
      const packageDistDir = join(packageRoot, 'package-dist');
      mkdirSync(stagedDistDir, { recursive: true });
      mkdirSync(packageDistDir, { recursive: true });
      writeFileSync(join(stagedDistDir, 'index.mjs'), 'export const next = true;\n', 'utf8');
      writeFileSync(join(packageDistDir, 'index.mjs'), 'export const previous = true;\n', 'utf8');

      const result = syncPackageDist({
        packageRoot,
        distDir: stagedDistDir,
        env: { HAPPIER_CLI_SKIP_PACKAGE_DIST_SYNC: '1' },
      });

      expect(result.skipped).toBe(true);
      expect(readFileSync(join(packageDistDir, 'index.mjs'), 'utf8')).toBe('export const previous = true;\n');
    } finally {
      rmSync(packageRoot, { recursive: true, force: true });
    }
  });
});
