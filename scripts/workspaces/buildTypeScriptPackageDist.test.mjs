import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildTypeScriptPackageDist } from './buildTypeScriptPackageDist.mjs';

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
}

async function createPackageFixture(t, name) {
  const root = await mkdtemp(join(tmpdir(), `happier-${name}-`));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  await mkdir(join(root, 'src'), { recursive: true });
  await mkdir(join(root, 'dist'), { recursive: true });
  await writeJson(join(root, 'package.json'), {
    name: `@happier-dev/${name}`,
    type: 'module',
    main: './dist/index.js',
    types: './dist/index.d.ts',
    exports: { '.': { default: './dist/index.js', types: './dist/index.d.ts' } },
  });
  await writeJson(join(root, 'tsconfig.json'), {
    compilerOptions: {
      target: 'ES2022',
      module: 'ESNext',
      moduleResolution: 'Bundler',
      rootDir: 'src',
      outDir: 'dist',
      declaration: true,
      strict: true,
      skipLibCheck: true,
    },
    include: ['src/**/*.ts'],
  });
  await writeFile(join(root, 'dist', 'index.js'), 'export const stable = true;\n', 'utf-8');
  await writeFile(join(root, 'dist', 'index.d.ts'), 'export declare const stable: boolean;\n', 'utf-8');

  return root;
}

test('buildTypeScriptPackageDist preserves previous dist when TypeScript compilation fails', async (t) => {
  const packageDir = await createPackageFixture(t, 'build-ts-package-fail');
  await writeFile(join(packageDir, 'src', 'index.ts'), 'export const built: string = 1;\n', 'utf-8');

  await assert.rejects(
    () =>
      buildTypeScriptPackageDist({
        packageDir,
        args: ['-p', 'tsconfig.json'],
        stdio: 'ignore',
        resolveTypeScriptCommandInvocationImpl: ({ args }) => ({ command: 'tsc', args }),
        runCommandImpl: () => ({ status: 1 }),
      }),
    /failed with code|TypeScript package build failed/,
  );

  assert.equal(await readFile(join(packageDir, 'dist', 'index.js'), 'utf-8'), 'export const stable = true;\n');
});

test('buildTypeScriptPackageDist compiles directly into caller-owned staged output without promoting it', async (t) => {
  const packageDir = await createPackageFixture(t, 'build-ts-package-staged');
  const stagedDist = join(packageDir, '.staged-dist');
  await writeFile(join(packageDir, 'src', 'index.ts'), 'export const built = true;\n', 'utf-8');
  let compilerOutputDir = null;

  const result = await buildTypeScriptPackageDist({
    packageDir,
    args: ['-p', 'tsconfig.json'],
    outputDir: stagedDist,
    stdio: 'ignore',
    resolveTypeScriptCommandInvocationImpl: ({ args }) => ({ command: 'tsc', args }),
    runCommandImpl: (_command, args) => {
      const outDir = args[args.indexOf('--outDir') + 1];
      compilerOutputDir = outDir;
      mkdirSync(outDir, { recursive: true });
      writeFileSync(join(outDir, 'index.js'), 'export const built = true;\n', 'utf-8');
      writeFileSync(join(outDir, 'index.d.ts'), 'export declare const built: boolean;\n', 'utf-8');
      return { status: 0 };
    },
  });

  assert.equal(compilerOutputDir, stagedDist);
  assert.deepEqual(result, { outputDir: stagedDist, promoted: false });
  assert.equal(await readFile(join(packageDir, 'dist', 'index.js'), 'utf-8'), 'export const stable = true;\n');
  assert.match(await readFile(join(stagedDist, 'index.js'), 'utf-8'), /built/);
});

test('buildTypeScriptPackageDist keeps TypeScript incremental metadata out of promoted dist', async (t) => {
  const packageDir = await createPackageFixture(t, 'build-ts-package-incremental-metadata');
  await writeFile(join(packageDir, 'src', 'index.ts'), 'export const built = true;\n', 'utf-8');

  await buildTypeScriptPackageDist({
    packageDir,
    args: ['-p', 'tsconfig.json'],
    stdio: 'ignore',
    resolveTypeScriptCommandInvocationImpl: ({ args }) => ({ command: 'tsc', args }),
    runCommandImpl: (_command, args) => {
      const outDir = args[args.indexOf('--outDir') + 1];
      const tsBuildInfoFile = args[args.indexOf('--tsBuildInfoFile') + 1];
      mkdirSync(outDir, { recursive: true });
      writeFileSync(join(outDir, 'index.js'), 'export const built = true;\n', 'utf-8');
      writeFileSync(join(outDir, 'index.d.ts'), 'export declare const built: boolean;\n', 'utf-8');
      writeFileSync(tsBuildInfoFile, '{}\n', 'utf-8');
      return { status: 0 };
    },
  });

  assert.equal(existsSync(join(packageDir, 'dist', '.tsbuildinfo')), false);
});

test('buildTypeScriptPackageDist promotes live dist under the canonical package build lock', async (t) => {
  const packageDir = await createPackageFixture(t, 'build-ts-package-lock');
  await writeFile(join(packageDir, 'src', 'index.ts'), 'export const built = true;\n', 'utf-8');
  let observedLockOptions = null;
  let compilerLockValue = null;

  await buildTypeScriptPackageDist({
    packageDir,
    args: ['-p', 'tsconfig.json'],
    stdio: 'ignore',
    withWorkspaceBundleLockImpl: async (fn, options) => {
      observedLockOptions = options;
      return await fn({ heldLockValue: 'test-package-lock-lease' });
    },
    resolveTypeScriptCommandInvocationImpl: ({ args }) => ({ command: 'tsc', args }),
    runCommandImpl: (_command, args, options) => {
      compilerLockValue = options.env.HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD;
      const outDir = args[args.indexOf('--outDir') + 1];
      mkdirSync(outDir, { recursive: true });
      writeFileSync(join(outDir, 'index.js'), 'export const built = true;\n', 'utf-8');
      writeFileSync(join(outDir, 'index.d.ts'), 'export declare const built: boolean;\n', 'utf-8');
      return { status: 0 };
    },
  });

  assert.match(observedLockOptions?.lockPath ?? '', /\.dist-build-happier-dev-build-ts-package-lock\.lock$/);
  assert.equal(compilerLockValue, 'test-package-lock-lease');
});
