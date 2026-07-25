import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

import { createTempDirSync } from '../../src/testkit/fs/tempDir';

function copyCliScriptFixture(options: {
  packageRoot: string;
  relativePath: string;
}) {
  const srcPath = resolve(process.cwd(), 'scripts', options.relativePath);
  const destPath = resolve(options.packageRoot, 'scripts', options.relativePath);
  mkdirSync(resolve(destPath, '..'), { recursive: true });
  cpSync(srcPath, destPath);
  return destPath;
}

function copyBundledCliCommonLockSurface(packageRoot: string) {
  const sourcePackageRoot = resolve(process.cwd(), '..', '..', 'packages', 'cli-common');
  const bundledPackageRoot = resolve(packageRoot, 'node_modules', '@happier-dev', 'cli-common');
  mkdirSync(bundledPackageRoot, { recursive: true });
  for (const relativePath of [
    'package.json',
    'workspaceBundleLock.mjs',
    'workspaceLockLease.mjs',
    'processInstance.mjs',
    'processInstance.d.mts',
  ]) {
    cpSync(resolve(sourcePackageRoot, relativePath), resolve(bundledPackageRoot, relativePath));
  }
}

describe('apps/cli published script surface', () => {
  it('keeps shipped build helpers self-contained outside the monorepo checkout', async () => {
    const packageRoot = createTempDirSync('happier-cli-published-script-surface-');
    try {
      writeFileSync(
        join(packageRoot, 'package.json'),
        `${JSON.stringify({ name: '@happier-dev/cli', version: '0.0.0', type: 'module' }, null, 2)}\n`,
        'utf8',
      );

      copyCliScriptFixture({ packageRoot, relativePath: 'optionalWorkspaceBundleLock.mjs' });
      copyCliScriptFixture({ packageRoot, relativePath: 'rmDirSafe.mjs' });
      const rmDistPath = copyCliScriptFixture({ packageRoot, relativePath: 'rmDist.mjs' });
      const syncPackageDistPath = copyCliScriptFixture({ packageRoot, relativePath: 'syncPackageDist.mjs' });
      copyBundledCliCommonLockSurface(packageRoot);

      mkdirSync(join(packageRoot, 'dist'), { recursive: true });
      mkdirSync(join(packageRoot, 'package-dist'), { recursive: true });
      writeFileSync(join(packageRoot, 'dist', 'index.mjs'), 'export const next = true;\n', 'utf8');
      writeFileSync(join(packageRoot, 'package-dist', 'index.mjs'), 'export const previous = true;\n', 'utf8');

      const runNative = (source: string) => spawnSync(process.execPath, ['--input-type=module', '-e', source], {
        cwd: packageRoot,
        encoding: 'utf8',
      });
      const removed = runNative(
        `const { main } = await import(${JSON.stringify(pathToFileURL(rmDistPath).href)});`
        + `await main(['node', 'rmDist.mjs']);`,
      );
      expect(removed.status, removed.stderr).toBe(0);

      expect(existsSync(join(packageRoot, 'dist', 'index.mjs'))).toBe(false);
      expect(existsSync(join(packageRoot, 'package-dist', 'index.mjs'))).toBe(true);

      mkdirSync(join(packageRoot, 'dist'), { recursive: true });
      writeFileSync(join(packageRoot, 'dist', 'index.mjs'), 'export const refreshed = true;\n', 'utf8');

      const synced = runNative(
        `const { syncPackageDist } = await import(${JSON.stringify(pathToFileURL(syncPackageDistPath).href)});`
        + `const result = syncPackageDist({ packageRoot: ${JSON.stringify(packageRoot)} });`
        + `process.stdout.write(JSON.stringify(result));`,
      );
      expect(synced.status, synced.stderr).toBe(0);
      expect(JSON.parse(synced.stdout).packageDistDir).toBe(join(packageRoot, 'package-dist'));
      expect(existsSync(join(packageRoot, 'package-dist', 'index.mjs'))).toBe(true);
    } finally {
      rmSync(packageRoot, { recursive: true, force: true });
    }
  });
});
