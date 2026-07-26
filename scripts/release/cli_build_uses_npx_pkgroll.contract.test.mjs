import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

test('the CLI build owner delegates its candidate generation to the pkgroll owner', async () => {
  const packageRoot = mkdtempSync(join(tmpdir(), 'cli-build-pkgroll-owner-'));
  try {
    writeFileSync(
      join(packageRoot, 'package.json'),
      JSON.stringify({ type: 'module', module: './dist/index.mjs' }),
      'utf8',
    );
    mkdirSync(join(packageRoot, 'dist'), { recursive: true });
    let pkgrollInvocation = null;
    const { buildCliDist } = await import(
      pathToFileURL(join(repoRoot, 'apps', 'cli', 'scripts', 'build.mjs')).href
    );
    await buildCliDist({
      packageRoot,
      repoRoot: packageRoot,
      skipLock: true,
      env: { ...process.env },
      rmDistImpl: async () => {},
      resolveTypeScriptCliPathImpl: () => '/repo/typescript',
      runTypecheckImpl: () => {},
      runPkgrollBuildImpl: (input) => {
        pkgrollInvocation = input;
        const outputDir = resolve(packageRoot, input.outputDir);
        mkdirSync(outputDir, { recursive: true });
        writeFileSync(join(outputDir, 'index.mjs'), 'export const built = true;\n', 'utf8');
      },
      probeDistRuntimeImportImpl: () => {},
      finalizeDistImpl: () => {},
      syncPackageDistImpl: () => {},
    });

    assert.ok(pkgrollInvocation, 'buildCliDist must delegate candidate generation to runPkgrollBuild');
    assert.match(String(pkgrollInvocation.outputDir), /^dist\.staging\.\d+$/);
  } finally {
    rmSync(packageRoot, { recursive: true, force: true });
  }
});

test('apps/cli pkgroll helper resolves the local pkgroll cli directly instead of shelling out through npx', async () => {
  const helper = await import(pathToFileURL(join(repoRoot, 'apps', 'cli', 'scripts', 'runPkgrollBuild.mjs')).href);
  const pkgrollPath = helper.resolvePkgrollCliPath();

  assert.match(pkgrollPath, /node_modules[\\/]+pkgroll[\\/]+dist[\\/]+cli\.mjs$/, 'pkgroll helper should resolve the local pkgroll cli entrypoint directly');
});
