import { atomicReplaceDirSync, bundleWorkspacePackage, copyDirSafeSync } from './index';
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

describe('bundleWorkspacePackage', () => {
  let rootDir: string | undefined;
  afterEach(() => {
    if (rootDir) {
      rmSync(rootDir, { recursive: true, force: true });
      rootDir = undefined;
    }
  });

  it('removes legacy dist staging dirs when rebundling into an existing destination', () => {
    rootDir = mkdtempSync(join(tmpdir(), 'happier-cli-common-bundle-workspace-'));

    const srcPackageDir = resolve(rootDir, 'packages/protocol');
    const srcDistDir = resolve(srcPackageDir, 'dist');
    mkdirSync(srcDistDir, { recursive: true });
    writeFileSync(
      resolve(srcPackageDir, 'package.json'),
      JSON.stringify(
        {
          name: '@happier-dev/protocol',
          version: '0.0.0',
          type: 'module',
          exports: { '.': { default: './dist/index.js' } },
        },
        null,
        2,
      ),
    );
    writeFileSync(resolve(srcDistDir, 'index.js'), 'export {};');

    const destPackageDir = resolve(rootDir, 'apps/stack/node_modules/@happier-dev/protocol');
    mkdirSync(resolve(destPackageDir, 'dist'), { recursive: true });
    const legacyTmpDir = resolve(destPackageDir, 'dist.__sync_tmp__.old-staging');
    const legacyBackupDir = resolve(destPackageDir, 'dist.__sync_backup__.old-staging');
    mkdirSync(legacyTmpDir, { recursive: true });
    mkdirSync(legacyBackupDir, { recursive: true });

    bundleWorkspacePackage({
      packageName: '@happier-dev/protocol',
      srcDir: srcPackageDir,
      destDir: destPackageDir,
    });

    expect(() => readdirSync(legacyTmpDir)).toThrow();
    expect(() => readdirSync(legacyBackupDir)).toThrow();

    const destPackageJsonPath = resolve(destPackageDir, 'package.json');
    const destPackageJson = JSON.parse(readFileSync(destPackageJsonPath, 'utf8'));
    expect(destPackageJson).toEqual(
      expect.objectContaining({
        name: '@happier-dev/protocol',
        private: true,
        exports: { '.': { default: './dist/index.js' } },
      }),
    );

    expect(readFileSync(resolve(destPackageDir, 'dist/index.js'), 'utf8')).toBe('export {};');

    const destParent = resolve(destPackageDir, '..');
    const siblingNames = readdirSync(destParent);
    expect(siblingNames.some((name) => name.startsWith('.protocol.__sync_tmp__.'))).toBe(false);
    expect(siblingNames.some((name) => name.startsWith('.protocol.__sync_backup__.'))).toBe(false);
  });

  it('bundles external runtime dependencies inside the same workspace replacement', async () => {
    rootDir = mkdtempSync(join(tmpdir(), 'happier-cli-common-bundle-workspace-'));

    const workspaceModule = await import('./index');
    const bundleWorkspacePackageWithRuntimeDependencies =
      (workspaceModule as Record<string, unknown>).bundleWorkspacePackageWithRuntimeDependencies;
    expect(bundleWorkspacePackageWithRuntimeDependencies).toBeTypeOf('function');

    const srcPackageDir = resolve(rootDir, 'packages/agents');
    const srcDistDir = resolve(srcPackageDir, 'dist');
    const zodPackageDir = resolve(srcPackageDir, 'node_modules/zod');
    mkdirSync(srcDistDir, { recursive: true });
    mkdirSync(resolve(zodPackageDir, 'v4/core'), { recursive: true });
    writeFileSync(
      resolve(srcPackageDir, 'package.json'),
      JSON.stringify(
        {
          name: '@happier-dev/agents',
          version: '0.0.0',
          type: 'module',
          exports: { '.': { default: './dist/index.js' } },
          dependencies: { zod: '4.3.6' },
        },
        null,
        2,
      ),
    );
    writeFileSync(resolve(srcDistDir, 'index.js'), 'export {};');
    writeFileSync(
      resolve(zodPackageDir, 'package.json'),
      JSON.stringify({ name: 'zod', version: '4.3.6', type: 'module', dependencies: {} }, null, 2),
    );
    writeFileSync(resolve(zodPackageDir, 'v4/core/schemas.js'), 'export const schemas = {};\n');

    const destPackageDir = resolve(rootDir, 'apps/cli/node_modules/@happier-dev/agents');

    (bundleWorkspacePackageWithRuntimeDependencies as (params: {
      packageName: string;
      srcDir: string;
      destDir: string;
    }) => void)({
      packageName: '@happier-dev/agents',
      srcDir: srcPackageDir,
      destDir: destPackageDir,
    });

    expect(readFileSync(resolve(destPackageDir, 'dist/index.js'), 'utf8')).toBe('export {};');
    expect(readFileSync(resolve(destPackageDir, 'node_modules/zod/v4/core/schemas.js'), 'utf8')).toBe(
      'export const schemas = {};\n',
    );
  });

  it('copies non-dist package export targets so the bundled public surface remains loadable', async () => {
    rootDir = mkdtempSync(join(tmpdir(), 'happier-cli-common-bundle-workspace-'));

    const srcPackageDir = resolve(rootDir, 'packages/cli-common');
    const srcDistDir = resolve(srcPackageDir, 'dist');
    mkdirSync(srcDistDir, { recursive: true });
    writeFileSync(
      resolve(srcPackageDir, 'package.json'),
      JSON.stringify(
        {
          name: '@happier-dev/cli-common',
          version: '0.0.0',
          type: 'module',
          exports: {
            '.': { default: './dist/index.js' },
            './workspaceLockLease': { default: './workspaceLockLease.mjs' },
            './workspaceBundleLock': { default: './workspaceBundleLock.mjs' },
          },
        },
        null,
        2,
      ),
    );
    writeFileSync(resolve(srcDistDir, 'index.js'), 'export {};\n');
    writeFileSync(resolve(srcPackageDir, 'workspaceLockLease.mjs'), 'export const lease = "canonical";\n');
    writeFileSync(
      resolve(srcPackageDir, 'workspaceBundleLock.mjs'),
      'export { lease } from "./workspaceLockLease.mjs";\n',
    );

    const destPackageDir = resolve(rootDir, 'apps/cli/node_modules/@happier-dev/cli-common');
    bundleWorkspacePackage({
      packageName: '@happier-dev/cli-common',
      srcDir: srcPackageDir,
      destDir: destPackageDir,
    });

    expect(readFileSync(resolve(destPackageDir, 'workspaceBundleLock.mjs'), 'utf8')).toContain(
      './workspaceLockLease.mjs',
    );
    expect(readFileSync(resolve(destPackageDir, 'workspaceLockLease.mjs'), 'utf8')).toContain('canonical');
  });
});

describe('atomicReplaceDirSync', () => {
  let rootDir: string | undefined;

  afterEach(() => {
    if (rootDir) {
      rmSync(rootDir, { recursive: true, force: true });
      rootDir = undefined;
    }
  });

  it('retries a staged swap when the destination briefly reappears during the rename', () => {
    rootDir = mkdtempSync(join(tmpdir(), 'happier-cli-common-atomic-replace-'));

    const destDir = resolve(rootDir, 'apps/cli/node_modules/@happier-dev/protocol');
    const tempFileName = 'next.txt';
    const previousFileName = 'previous.txt';

    mkdirSync(destDir, { recursive: true });
    writeFileSync(resolve(destDir, previousFileName), 'old');

    let stagedDir = '';
    let renameFailures = 0;

    atomicReplaceDirSync({
      destDir,
      buildInto(tempDir) {
        stagedDir = tempDir;
        mkdirSync(tempDir, { recursive: true });
        writeFileSync(resolve(tempDir, tempFileName), 'new');
      },
      fsOps: {
        renameSync(source, target) {
          if (source === stagedDir && target === destDir && renameFailures === 0) {
            renameFailures += 1;
            const error = new Error('ENOTEMPTY');
            Reflect.set(error, 'code', 'ENOTEMPTY');
            throw error;
          }

          return renameSync(source, target);
        },
      },
    });

    expect(renameFailures).toBe(1);
    expect(readFileSync(resolve(destDir, tempFileName), 'utf8')).toBe('new');
    expect(existsSync(resolve(destDir, previousFileName))).toBe(false);
  });

  it('continues when the destination disappears after the existence check', () => {
    rootDir = mkdtempSync(join(tmpdir(), 'happier-cli-common-atomic-replace-'));

    const destDir = resolve(rootDir, 'apps/cli/node_modules/@happier-dev/protocol');
    const tempFileName = 'next.txt';
    const previousFileName = 'previous.txt';

    mkdirSync(destDir, { recursive: true });
    writeFileSync(resolve(destDir, previousFileName), 'old');

    let stagedDir = '';
    let existsChecks = 0;
    let renameCalls = 0;

    atomicReplaceDirSync({
      destDir,
      buildInto(tempDir) {
        stagedDir = tempDir;
        mkdirSync(tempDir, { recursive: true });
        writeFileSync(resolve(tempDir, tempFileName), 'new');
      },
      fsOps: {
        existsSync(targetPath) {
          if (targetPath === destDir) {
            existsChecks += 1;
            return existsChecks === 1 ? true : existsSync(targetPath);
          }
          return existsSync(targetPath);
        },
        renameSync(source, target) {
          if (source === destDir && target !== destDir && renameCalls === 0) {
            renameCalls += 1;
            rmSync(destDir, { recursive: true, force: true });
            const error = new Error('ENOENT');
            Reflect.set(error, 'code', 'ENOENT');
            throw error;
          }
          return renameSync(source, target);
        },
      },
    });

    expect(renameCalls).toBe(1);
    expect(readFileSync(resolve(destDir, tempFileName), 'utf8')).toBe('new');
    expect(existsSync(resolve(destDir, previousFileName))).toBe(false);
  });

  it('does not remove the live destination when backup rename is blocked', () => {
    rootDir = mkdtempSync(join(tmpdir(), 'happier-cli-common-atomic-replace-'));

    const destDir = resolve(rootDir, 'apps/cli/node_modules/@happier-dev/protocol');
    const previousFileName = 'previous.txt';

    mkdirSync(destDir, { recursive: true });
    writeFileSync(resolve(destDir, previousFileName), 'old');

    let stagedDir = '';

    expect(() => atomicReplaceDirSync({
      destDir,
      buildInto(tempDir) {
        stagedDir = tempDir;
        mkdirSync(tempDir, { recursive: true });
        writeFileSync(resolve(tempDir, 'next.txt'), 'new');
      },
      fsOps: {
        renameSync(source, target) {
          if (source === destDir && target !== destDir) {
            const error = new Error('EPERM');
            Reflect.set(error, 'code', 'EPERM');
            throw error;
          }
          return renameSync(source, target);
        },
      },
    })).toThrow(/EPERM/);

    expect(existsSync(stagedDir)).toBe(false);
    expect(readFileSync(resolve(destDir, previousFileName), 'utf8')).toBe('old');
  });
});

describe('copyDirSafeSync', () => {
  let rootDir: string | undefined;

  afterEach(() => {
    if (rootDir) {
      rmSync(rootDir, { recursive: true, force: true });
      rootDir = undefined;
    }
  });

  it('retries a transient ENOENT while copying a directory tree', () => {
    rootDir = mkdtempSync(join(tmpdir(), 'happier-cli-common-copy-dir-'));

    const srcDir = resolve(rootDir, 'packages/protocol/dist');
    const destDir = resolve(rootDir, 'apps/cli/node_modules/@happier-dev/protocol/dist');
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(resolve(srcDir, 'index.js'), 'export const ok = true;\n');

    let attempts = 0;

    copyDirSafeSync(srcDir, destDir, {
      retries: 1,
      delayMs: 0,
      cpSyncImpl(source, target, options) {
        attempts += 1;
        if (attempts === 1) {
          const error = new Error('ENOENT');
          Reflect.set(error, 'code', 'ENOENT');
          throw error;
        }

        return cpSync(source, target, options);
      },
    });

    expect(attempts).toBe(2);
    expect(readFileSync(resolve(destDir, 'index.js'), 'utf8')).toBe('export const ok = true;\n');
  });
});
