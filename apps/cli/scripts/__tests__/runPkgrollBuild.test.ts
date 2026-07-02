import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { createTempDirSync } from '../../src/testkit/fs/tempDir';
import { preparePkgrollPackageManifest, runPkgrollBuild } from '../runPkgrollBuild.mjs';

describe('runPkgrollBuild', () => {
  it('rewrites package-dist entrypoints to dist for pkgroll without modifying publish file allowlists', () => {
    const manifest = preparePkgrollPackageManifest({
      main: './package-dist/index.cjs',
      module: './package-dist/index.mjs',
      types: './package-dist/index.d.cts',
      exports: {
        '.': {
          require: {
            types: './package-dist/index.d.cts',
            default: './package-dist/index.cjs',
          },
          import: {
            types: './package-dist/index.d.mts',
            default: './package-dist/index.mjs',
          },
        },
      },
      bin: {
        happier: './bin/happier.mjs',
      },
      files: ['package-dist', 'package-dist/**', 'bin'],
    });

    expect(manifest).toMatchObject({
      main: './dist/index.cjs',
      module: './dist/index.mjs',
      types: './dist/index.d.cts',
      exports: {
        '.': {
          require: {
            types: './dist/index.d.cts',
            default: './dist/index.cjs',
          },
          import: {
            types: './dist/index.d.mts',
            default: './dist/index.mjs',
          },
        },
      },
      files: ['package-dist', 'package-dist/**', 'bin'],
    });
    expect(manifest).not.toHaveProperty('bin');
  });

  it('can rewrite package-dist entrypoints to an explicit build output directory', () => {
    const manifest = preparePkgrollPackageManifest(
      {
        main: './package-dist/index.cjs',
        module: './package-dist/index.mjs',
        exports: {
          '.': {
            import: {
              default: './package-dist/index.mjs',
            },
          },
        },
        bin: {
          happier: './bin/happier.mjs',
        },
      },
      { outputDir: '.tmp.cli-dist-build' },
    );

    expect(manifest).toMatchObject({
      main: './.tmp.cli-dist-build/index.cjs',
      module: './.tmp.cli-dist-build/index.mjs',
      exports: {
        '.': {
          import: {
            default: './.tmp.cli-dist-build/index.mjs',
          },
        },
      },
    });
    expect(manifest).not.toHaveProperty('bin');
  });

  it('keeps the original package manifest unchanged while pkgroll runs', () => {
    const dir = createTempDirSync('happier-cli-pkgroll-manifest-');
    const packageJsonPath = join(dir, 'package.json');
    const original = {
      main: './dist/index.cjs',
      bin: {
        happier: './bin/happier.mjs',
      },
      exports: {
        '.': {
          import: {
            default: './dist/index.mjs',
          },
        },
      },
    };
    writeFileSync(packageJsonPath, `${JSON.stringify(original, null, 2)}\n`, 'utf8');

    let manifestDuringPkgroll: any = null;
    const spawn = vi.fn(() => {
      manifestDuringPkgroll = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
      return { status: 0 };
    });

    runPkgrollBuild({ packageJsonPath, spawn });

    expect(spawn).toHaveBeenCalledWith(
      process.execPath,
      expect.arrayContaining([
        expect.stringContaining('pkgroll/dist/cli.mjs'),
        '--packagejson=false',
        '--srcdist',
        'src:dist',
      ]),
      expect.objectContaining({
        cwd: dir,
        stdio: ['ignore', 'inherit', 'inherit'],
        timeout: 600_000,
      }),
    );
    expect(spawn.mock.calls[0]?.[1]).toEqual(
      expect.arrayContaining(['--packagejson=false', '--srcdist', 'src:dist', '--input', 'dist/index.cjs']),
    );
    expect(manifestDuringPkgroll).toEqual(original);
    expect(JSON.parse(readFileSync(packageJsonPath, 'utf8'))).toEqual(original);
  });

  it('passes an explicit output directory to pkgroll without rewriting the package manifest', () => {
    const dir = createTempDirSync('happier-cli-pkgroll-output-dir-');
    const packageJsonPath = join(dir, 'package.json');
    const original = {
      module: './dist/index.mjs',
      exports: {
        '.': {
          import: {
            default: './dist/index.mjs',
          },
        },
      },
    };
    writeFileSync(packageJsonPath, `${JSON.stringify(original, null, 2)}\n`, 'utf8');

    const spawn = vi.fn(() => {
      return { status: 0 };
    });

    runPkgrollBuild({ packageJsonPath, spawn, outputDir: '.tmp.cli-dist-build' });

    expect(spawn.mock.calls[0]?.[1]).toEqual(
      expect.arrayContaining([
        '--packagejson=false',
        '--srcdist',
        'src:.tmp.cli-dist-build',
        '--input',
        '.tmp.cli-dist-build/index.mjs',
      ]),
    );
    expect(JSON.parse(readFileSync(packageJsonPath, 'utf8'))).toEqual(original);
  });

  it('applies bounded timeout override from environment for Windows stall protection', () => {
    const dir = createTempDirSync('happier-cli-pkgroll-timeout-');
    const packageJsonPath = join(dir, 'package.json');
    writeFileSync(packageJsonPath, `${JSON.stringify({ main: './package-dist/index.mjs' }, null, 2)}\n`, 'utf8');

    const spawn = vi.fn(() => ({ status: 0 }));

    runPkgrollBuild({
      packageJsonPath,
      spawn,
      env: { HAPPIER_CLI_PKGROLL_TIMEOUT_MS: '120000' },
    });

    expect(spawn).toHaveBeenCalledWith(
      process.execPath,
      expect.arrayContaining([
        expect.stringContaining('pkgroll/dist/cli.mjs'),
        '--packagejson=false',
        '--srcdist',
        'src:dist',
      ]),
      expect.objectContaining({
        cwd: dir,
        timeout: 120_000,
      }),
    );
  });
});
