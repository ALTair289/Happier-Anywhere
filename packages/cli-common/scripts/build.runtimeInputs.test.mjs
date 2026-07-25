import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { resolveTypeScriptCommandInvocation } from '../../../scripts/workspaces/typescriptCommand.mjs';
import { buildCliCommonDist } from './build.mjs';

const require = createRequire(import.meta.url);
const nativeTypeScriptPackageDir = dirname(require.resolve('@typescript/native/package.json'));
const scriptsDir = dirname(fileURLToPath(import.meta.url));
const packageDir = dirname(scriptsDir);

function createFixture({ runtimeSource, testSource }) {
  const fixtureDir = mkdtempSync(join(packageDir, '.runtime-inputs-'));
  mkdirSync(join(fixtureDir, 'src'), { recursive: true });
  mkdirSync(join(fixtureDir, 'node_modules', '@typescript'), { recursive: true });
  symlinkSync(
    nativeTypeScriptPackageDir,
    join(fixtureDir, 'node_modules', '@typescript', 'native'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  writeFileSync(join(fixtureDir, 'package.json'), JSON.stringify({
    name: '@happier-dev/cli-common-runtime-input-fixture',
    type: 'module',
    main: './dist/index.js',
    types: './dist/index.d.ts',
    exports: {
      '.': {
        types: './dist/index.d.ts',
        default: './dist/index.js',
      },
    },
  }, null, 2));
  writeFileSync(join(fixtureDir, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      target: 'ES2022',
      module: 'ESNext',
      moduleResolution: 'Bundler',
      rootDir: 'src',
      outDir: 'dist',
      incremental: true,
      tsBuildInfoFile: 'dist/.tsbuildinfo',
      declaration: true,
      strict: true,
      skipLibCheck: true,
    },
    include: ['src/**/*.ts'],
    exclude: ['node_modules', 'dist'],
  }, null, 2));
  writeFileSync(
    join(fixtureDir, 'tsconfig.build.json'),
    readFileSync(join(packageDir, 'tsconfig.build.json'), 'utf8'),
  );
  writeFileSync(join(fixtureDir, 'src', 'index.ts'), runtimeSource);
  writeFileSync(join(fixtureDir, 'src', 'index.test.ts'), testSource);
  return fixtureDir;
}

describe('cli-common runtime dist TypeScript inputs', () => {
  const tempDirs = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('builds runtime dist despite a test-only type error while full typecheck still rejects it', async () => {
    const fixtureDir = createFixture({
      runtimeSource: "import { join } from 'node:path';\nexport const runtimeValue = join('runtime', 'value');\n",
      testSource: "const testOnlyValue: number = 'not-a-number';\nexport { testOnlyValue };\n",
    });
    tempDirs.push(fixtureDir);

    await buildCliCommonDist({
      packageDir: fixtureDir,
      lockPath: join(fixtureDir, 'build.lock'),
      stdio: 'pipe',
    });

    expect(existsSync(join(fixtureDir, 'dist', 'index.js'))).toBe(true);
    expect(existsSync(join(fixtureDir, 'dist', 'index.test.js'))).toBe(false);

    const typecheck = resolveTypeScriptCommandInvocation({
      cwd: fixtureDir,
      args: ['--noEmit', '-p', 'tsconfig.json'],
    });
    const result = spawnSync(typecheck.command, typecheck.args, {
      cwd: fixtureDir,
      encoding: 'utf8',
    });
    expect(result.status).not.toBe(0);
    expect(`${result.stdout ?? ''}\n${result.stderr ?? ''}`).toContain('index.test.ts');
  });

  it('rejects a runtime source type error', async () => {
    const fixtureDir = createFixture({
      runtimeSource: "export const runtimeValue: number = 'not-a-number';\n",
      testSource: 'export const testOnlyValue: number = 1;\n',
    });
    tempDirs.push(fixtureDir);

    await expect(buildCliCommonDist({
      packageDir: fixtureDir,
      lockPath: join(fixtureDir, 'build.lock'),
      stdio: 'pipe',
    })).rejects.toThrow(/TypeScript package build failed/);
  });
});
