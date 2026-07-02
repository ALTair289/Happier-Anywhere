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
  'packages/tests',
];

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
    for (const scriptName of ['build', 'typecheck']) {
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
