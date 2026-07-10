import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

async function readJson(relativePath) {
  const raw = await readFile(resolve(repoRoot, relativePath), 'utf8');
  return JSON.parse(raw);
}

const workspaceTypeScriptScriptPackages = [
  'packages/protocol',
  'packages/transfers',
  'packages/agents',
  'packages/cli-common',
  'packages/connection-supervisor',
  'apps/bootstrap',
  'apps/cli',
  'apps/docs',
  'apps/server',
  'apps/ui',
  'packages/release-runtime',
  'packages/tests',
];

test('workspace TypeScript tool dependencies stay aligned with the root toolchain owner', async () => {
  const rootPackage = await readJson('package.json');
  const nativeCompiler = rootPackage?.devDependencies?.['@typescript/native'];
  const apiPackage = rootPackage?.devDependencies?.typescript;

  assert.equal(typeof nativeCompiler, 'string');
  assert.equal(typeof apiPackage, 'string');

  for (const packagePath of workspaceTypeScriptScriptPackages) {
    const pkg = await readJson(`${packagePath}/package.json`);
    assert.equal(
      pkg?.devDependencies?.['@typescript/native'],
      nativeCompiler,
      `${packagePath} must use the root-owned native compiler version`,
    );
    assert.equal(
      pkg?.devDependencies?.typescript,
      apiPackage,
      `${packagePath} must use the root-owned TypeScript API version`,
    );
  }
});

test('root and workspace yarn tsc commands delegate to the native compiler runner', async () => {
  const packagePaths = ['.', ...workspaceTypeScriptScriptPackages];

  for (const packagePath of packagePaths) {
    const manifestPath = packagePath === '.' ? 'package.json' : `${packagePath}/package.json`;
    const pkg = await readJson(manifestPath);
    const tscScript = String(pkg?.scripts?.tsc ?? '');

    assert.match(
      tscScript,
      /^node (?:\.\.\/\.\.\/)?scripts\/workspaces\/runTypeScriptCli\.mjs$/,
      `${packagePath} yarn tsc must delegate to the native compiler runner`,
    );
  }
});

test('the shared TypeScript command resolver owns native compiler selection', async () => {
  const resolver = await readFile(resolve(repoRoot, 'scripts/workspaces/typescriptCommand.mjs'), 'utf8');

  assert.match(resolver, /@typescript\/native\/package\.json/);
  assert.doesNotMatch(resolver, /typescript\/bin\/tsc/);
});

test('first-party build orchestrators delegate compiler selection to the shared resolver', async () => {
  const orchestrators = [
    'apps/cli/scripts/build.mjs',
    'apps/cli/scripts/buildSharedDeps.mjs',
    'apps/server/scripts/buildSharedDeps.mjs',
  ];

  for (const relativePath of orchestrators) {
    const source = await readFile(resolve(repoRoot, relativePath), 'utf8');
    assert.match(
      source,
      /scripts\/workspaces\/typescriptCommand\.mjs/,
      `${relativePath} must delegate native compiler selection to the shared resolver`,
    );
    assert.doesNotMatch(
      source,
      /typescript\/bin\/tsc|node_modules[^\n]*typescript[^\n]*bin[^\n]*tsc/,
      `${relativePath} must not retain a competing compiler resolution path`,
    );
  }
});

test('cli-common build scripts resolve TypeScript through workspace tool resolution instead of a hardcoded repo-root binary', async () => {
  const pkg = await readJson('packages/cli-common/package.json');
  const buildScript = await readFile(resolve(repoRoot, 'packages/cli-common/scripts/build.mjs'), 'utf8');

  assert.equal(String(pkg?.scripts?.build ?? ''), 'node scripts/build.mjs');
  assert.match(String(pkg?.scripts?.typecheck ?? ''), /scripts\/workspaces\/runTypeScriptCli\.mjs\b/);
  assert.match(buildScript, /\btsc\b/);
  assert.doesNotMatch(
    `${String(pkg?.scripts?.build ?? '')}\n${buildScript}`,
    /node_modules\/typescript\/bin\/tsc/,
    'cli-common build should not hardcode a repo-root TypeScript binary path'
  );
  assert.doesNotMatch(
    String(pkg?.scripts?.typecheck ?? ''),
    /node_modules\/typescript\/bin\/tsc/,
    'cli-common typecheck should not hardcode a repo-root TypeScript binary path'
  );
});

test('first-party TypeScript package scripts use workspace tool resolution instead of bare tsc shims', async () => {
  for (const packagePath of workspaceTypeScriptScriptPackages) {
    const pkg = await readJson(`${packagePath}/package.json`);
    for (const scriptName of ['build', 'build:esm', 'typecheck', 'types:check']) {
      const script = String(pkg?.scripts?.[scriptName] ?? '');
      if (!script) continue;
      assert.doesNotMatch(script, /(^|&&\s*)tsc\b/, `${packagePath} ${scriptName} must not rely on a bare tsc shim`);
      assert.doesNotMatch(
        script,
        /node_modules\/typescript\/bin\/tsc/,
        `${packagePath} ${scriptName} must not hardcode a repo-root TypeScript binary path`,
      );
      if (script.includes('tsconfig') || /\b--noEmit\b/.test(script)) {
        assert.match(
          script,
          /scripts\/workspaces\/(?:runTypeScriptCli|buildTypeScriptPackageDist)\.mjs\b|node scripts\/build\.mjs\b/,
          `${packagePath} ${scriptName} must resolve TypeScript through shared workspace tooling`,
        );
      }
    }
  }
});

test('docs production builds gate on the native compiler instead of Next embedded TypeScript', async () => {
  const pkg = await readJson('apps/docs/package.json');
  const buildScript = String(pkg?.scripts?.build ?? '');
  const buildRunner = await readFile(resolve(repoRoot, 'apps/docs/scripts/build.mjs'), 'utf8');
  const nextConfig = await readFile(resolve(repoRoot, 'apps/docs/next.config.mjs'), 'utf8');

  assert.equal(buildScript, 'node scripts/build.mjs');
  assert.match(buildRunner, /execYarn(?:Impl)?\(\['-s', 'types:check'\]/);
  assert.match(buildRunner, /next\/dist\/bin\/next/);
  assert.match(
    nextConfig,
    /typescript\s*:\s*\{[\s\S]*?ignoreBuildErrors\s*:\s*true/,
    'Next must not run a competing embedded TypeScript compiler after the native gate',
  );
});

test('tests package typecheck resolves TypeScript through workspace tool resolution instead of a bare bin shim', async () => {
  const pkg = await readJson('packages/tests/package.json');
  const typecheckScript = String(pkg?.scripts?.typecheck ?? '');

  assert.match(typecheckScript, /scripts\/workspaces\/runTypeScriptCli\.mjs\b/);
  assert.doesNotMatch(typecheckScript, /^tsc\b/);
  assert.doesNotMatch(
    typecheckScript,
    /node_modules\/typescript\/bin\/tsc/,
    'tests package typecheck should not hardcode a repo-root TypeScript binary path'
  );
});
