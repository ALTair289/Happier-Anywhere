import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const scriptsDir = dirname(fileURLToPath(import.meta.url));

const { cpMock, cpDelegate, renameMock, renameDelegate } = vi.hoisted(() => ({
  cpMock: vi.fn(),
  cpDelegate: { current: null },
  renameMock: vi.fn(),
  renameDelegate: { current: null },
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal();
  cpDelegate.current = actual.cp;
  renameDelegate.current = actual.rename;
  return {
    ...actual,
    cp: cpMock,
    rename: renameMock,
  };
});

describe('cli-common build Windows rename fallback', () => {
  const tempDirs = [];

  beforeEach(() => {
    cpMock.mockImplementation((from, to, options) => cpDelegate.current(from, to, options));
    renameMock.mockImplementation((from, to) => renameDelegate.current(from, to));
  });

  afterEach(() => {
    cpMock.mockReset();
    renameMock.mockReset();
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails closed and preserves live dist when Windows blocks the atomic rename with EPERM', async () => {
    const { buildCliCommonDist } = await import(pathToFileURL(join(scriptsDir, 'build.mjs')).href);
    const fixtureDir = mkdtempSync(join(tmpdir(), 'happier-cli-common-build-win32-'));
    tempDirs.push(fixtureDir);
    const buildId = 'rename-fallback';

    const distDir = join(fixtureDir, 'dist');
    mkdirSync(distDir, { recursive: true });
    writeFileSync(join(distDir, 'index.js'), 'export const oldValue = true;\n', 'utf8');
    writeFileSync(join(distDir, 'index.d.ts'), 'export declare const oldValue: boolean;\n', 'utf8');
    writeFileSync(join(fixtureDir, 'package.json'), JSON.stringify({
      name: '@happier-dev/cli-common-fixture',
      exports: {
        '.': {
          default: './dist/index.js',
          types: './dist/index.d.ts',
        },
      },
    }, null, 2), 'utf8');
    writeFileSync(join(fixtureDir, 'tsconfig.json'), JSON.stringify({
      extends: './tsconfig.base.json',
      compilerOptions: {
        outDir: 'dist',
        tsBuildInfoFile: 'dist/.tsbuildinfo',
      },
    }, null, 2), 'utf8');

    if (!renameDelegate.current) {
      throw new Error('expected node:fs/promises.rename delegate to initialize');
    }
    if (!cpDelegate.current) {
      throw new Error('expected node:fs/promises.cp delegate to initialize');
    }

    const liveCopyTargets = [];
    cpMock.mockImplementation(async (from, to, options) => {
      if (to === distDir) liveCopyTargets.push(to);
      return cpDelegate.current(from, to, options);
    });

    renameMock.mockImplementation(async (from, to) => {
      if (from.includes(`${join(fixtureDir, '.tmp.')}`) && to === distDir) {
        const error = new Error(`EPERM: operation not permitted, rename '${from}' -> '${to}'`);
        error.code = 'EPERM';
        throw error;
      }
      return renameDelegate.current(from, to);
    });

    await expect(buildCliCommonDist({
      packageDir: fixtureDir,
      buildId,
      lockPath: join(fixtureDir, 'build.lock'),
      resolveTypeScriptCommandInvocationImpl: ({ args }) => ({ command: 'tsc', args }),
      runCommandImpl: (_cmd, args) => {
        const outDir = args[args.indexOf('--outDir') + 1];
        mkdirSync(outDir, { recursive: true });
        writeFileSync(join(outDir, 'index.js'), 'export const newValue = true;\n', 'utf8');
        writeFileSync(join(outDir, 'index.d.ts'), 'export declare const newValue: boolean;\n', 'utf8');
        return { status: 0 };
      },
    })).rejects.toMatchObject({ code: 'EPERM' });

    expect(readFileSync(join(distDir, 'index.js'), 'utf8')).toContain('oldValue');
    expect(liveCopyTargets).toEqual([]);
    expect(readdirSync(fixtureDir).filter((name) => /^\.(?:tmp|backup|restore)\./.test(name))).toEqual([]);
  });

  it('publishes the full exported tree into the workspace staged output directory', async () => {
    const { buildCliCommonDist } = await import(pathToFileURL(join(scriptsDir, 'build.mjs')).href);
    const fixtureDir = mkdtempSync(join(tmpdir(), 'happier-cli-common-build-staged-output-'));
    tempDirs.push(fixtureDir);
    const stagedOutputDir = join(fixtureDir, 'workspace-staged-dist');

    mkdirSync(join(fixtureDir, 'dist'), { recursive: true });
    writeFileSync(join(fixtureDir, 'dist', 'index.js'), 'export const oldValue = true;\n', 'utf8');
    writeFileSync(join(fixtureDir, 'dist', 'index.d.ts'), 'export declare const oldValue: boolean;\n', 'utf8');
    writeFileSync(join(fixtureDir, 'package.json'), JSON.stringify({
      name: '@happier-dev/cli-common-fixture',
      exports: {
        '.': {
          default: './dist/index.js',
          types: './dist/index.d.ts',
        },
        './firstPartyRuntime': {
          default: './dist/firstPartyRuntime/index.js',
          types: './dist/firstPartyRuntime/index.d.ts',
        },
      },
    }, null, 2), 'utf8');
    writeFileSync(join(fixtureDir, 'tsconfig.json'), '{}\n', 'utf8');

    if (!renameDelegate.current) {
      throw new Error('expected node:fs/promises.rename delegate to initialize');
    }
    renameMock.mockImplementation((from, to) => renameDelegate.current(from, to));

    await buildCliCommonDist({
      packageDir: fixtureDir,
      lockPath: join(fixtureDir, 'build.lock'),
      env: { HAPPIER_WORKSPACE_DIST_OUTPUT_DIR: stagedOutputDir },
      resolveTypeScriptCommandInvocationImpl: ({ args }) => ({ command: 'tsc', args }),
      runCommandImpl: (_cmd, args) => {
        const outDir = args[args.indexOf('--outDir') + 1];
        mkdirSync(join(outDir, 'firstPartyRuntime'), { recursive: true });
        writeFileSync(join(outDir, 'index.js'), 'export const staged = true;\n', 'utf8');
        writeFileSync(join(outDir, 'index.d.ts'), 'export declare const staged: boolean;\n', 'utf8');
        writeFileSync(join(outDir, 'firstPartyRuntime', 'index.js'), 'export const runtime = true;\n', 'utf8');
        writeFileSync(join(outDir, 'firstPartyRuntime', 'index.d.ts'), 'export declare const runtime: boolean;\n', 'utf8');
        return { status: 0 };
      },
    });

    expect(readFileSync(join(stagedOutputDir, 'firstPartyRuntime', 'index.js'), 'utf8')).toContain('runtime');
    expect(readFileSync(join(fixtureDir, 'dist', 'index.js'), 'utf8')).toContain('oldValue');
  });

  it('preserves a successor lock owner when the build completes', async () => {
    const { buildCliCommonDist } = await import(pathToFileURL(join(scriptsDir, 'build.mjs')).href);
    const fixtureDir = mkdtempSync(join(tmpdir(), 'happier-cli-common-build-successor-lock-'));
    tempDirs.push(fixtureDir);
    const lockPath = join(fixtureDir, 'build.lock');
    const successor = JSON.stringify({ pid: process.pid, token: 'successor' });

    writeFileSync(join(fixtureDir, 'package.json'), JSON.stringify({
      name: '@happier-dev/cli-common-fixture',
      exports: { '.': { default: './dist/index.js', types: './dist/index.d.ts' } },
    }), 'utf8');
    writeFileSync(join(fixtureDir, 'tsconfig.json'), '{}\n', 'utf8');
    renameMock.mockImplementation((from, to) => renameDelegate.current(from, to));

    await buildCliCommonDist({
      packageDir: fixtureDir,
      lockPath,
      resolveTypeScriptCommandInvocationImpl: ({ args }) => ({ command: 'tsc', args }),
      runCommandImpl: (_cmd, args) => {
        const outDir = args[args.indexOf('--outDir') + 1];
        mkdirSync(outDir, { recursive: true });
        writeFileSync(join(outDir, 'index.js'), 'export const ok = true;\n', 'utf8');
        writeFileSync(join(outDir, 'index.d.ts'), 'export declare const ok: boolean;\n', 'utf8');
        writeFileSync(lockPath, successor, 'utf8');
        return { status: 0 };
      },
    });

    expect(readFileSync(lockPath, 'utf8')).toBe(successor);
  });

  it('rejects an empty staged entrypoint without replacing the previous live dist', async () => {
    const { buildCliCommonDist } = await import(pathToFileURL(join(scriptsDir, 'build.mjs')).href);
    const fixtureDir = mkdtempSync(join(tmpdir(), 'happier-cli-common-build-empty-entrypoint-'));
    tempDirs.push(fixtureDir);
    const distDir = join(fixtureDir, 'dist');
    mkdirSync(distDir, { recursive: true });
    writeFileSync(join(distDir, 'index.js'), 'export const stable = true;\n', 'utf8');
    writeFileSync(join(distDir, 'index.d.ts'), 'export declare const stable: boolean;\n', 'utf8');
    writeFileSync(join(fixtureDir, 'package.json'), JSON.stringify({
      name: '@happier-dev/cli-common-fixture',
      exports: { '.': { default: './dist/index.js', types: './dist/index.d.ts' } },
    }), 'utf8');
    writeFileSync(join(fixtureDir, 'tsconfig.json'), '{}\n', 'utf8');
    renameMock.mockImplementation((from, to) => renameDelegate.current(from, to));

    await expect(buildCliCommonDist({
      packageDir: fixtureDir,
      lockPath: join(fixtureDir, 'build.lock'),
      resolveTypeScriptCommandInvocationImpl: ({ args }) => ({ command: 'tsc', args }),
      runCommandImpl: (_cmd, args) => {
        const outDir = args[args.indexOf('--outDir') + 1];
        mkdirSync(outDir, { recursive: true });
        writeFileSync(join(outDir, 'index.js'), '', 'utf8');
        writeFileSync(join(outDir, 'index.d.ts'), 'export {};\n', 'utf8');
        return { status: 0 };
      },
    })).rejects.toThrow(/empty dist entrypoint/);

    expect(readFileSync(join(distDir, 'index.js'), 'utf8')).toContain('stable');
  });

  it('reclaims stale legacy build artifacts without deleting a fresh other-owner artifact', async () => {
    const { buildCliCommonDist } = await import(pathToFileURL(join(scriptsDir, 'build.mjs')).href);
    const fixtureDir = mkdtempSync(join(tmpdir(), 'happier-cli-common-build-stale-cleanup-'));
    tempDirs.push(fixtureDir);
    const staleDir = join(fixtureDir, '.dist.build.stale-owner');
    const staleTsconfig = join(fixtureDir, '.tsconfig.build.stale-owner.json');
    const freshDir = join(fixtureDir, '.dist.build.active-other-owner');
    mkdirSync(staleDir);
    mkdirSync(freshDir);
    writeFileSync(staleTsconfig, '{}\n', 'utf8');
    const old = new Date(Date.now() - 48 * 60 * 60 * 1_000);
    utimesSync(staleDir, old, old);
    utimesSync(staleTsconfig, old, old);
    writeFileSync(join(fixtureDir, 'package.json'), JSON.stringify({
      name: '@happier-dev/cli-common-fixture',
      exports: { '.': { default: './dist/index.js', types: './dist/index.d.ts' } },
    }), 'utf8');
    writeFileSync(join(fixtureDir, 'tsconfig.json'), '{}\n', 'utf8');
    renameMock.mockImplementation((from, to) => renameDelegate.current(from, to));

    await buildCliCommonDist({
      packageDir: fixtureDir,
      lockPath: join(fixtureDir, 'build.lock'),
      resolveTypeScriptCommandInvocationImpl: ({ args }) => ({ command: 'tsc', args }),
      runCommandImpl: (_cmd, args) => {
        const outDir = args[args.indexOf('--outDir') + 1];
        mkdirSync(outDir, { recursive: true });
        writeFileSync(join(outDir, 'index.js'), 'export const ok = true;\n', 'utf8');
        writeFileSync(join(outDir, 'index.d.ts'), 'export declare const ok: boolean;\n', 'utf8');
        return { status: 0 };
      },
    });

    expect(existsSync(staleDir)).toBe(false);
    expect(existsSync(staleTsconfig)).toBe(false);
    expect(existsSync(freshDir)).toBe(true);
  });
});
