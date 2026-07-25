import assert from 'node:assert/strict';
import test from 'node:test';

import { ensureSourceServerWorkspacePackagesBuilt, spawnSourceServerScript } from './source_server_workspace_deps.mjs';

test('source server admission delegates declaration freshness to the canonical workspace owner', async () => {
  const calls = [];
  const result = await ensureSourceServerWorkspacePackagesBuilt(
    { runtimeBackedStart: false, serverDir: '/repo/apps/server', env: { TEST_ENV: '1' }, quiet: true },
    {
      ensureWorkspacePackagesBuiltForComponentImpl: async (dir, options) => {
        calls.push({ dir, options });
        return { ok: true, built: [], skipped: ['current'] };
      },
    },
  );

  assert.deepEqual(calls, [{ dir: '/repo/apps/server', options: { quiet: true, env: { TEST_ENV: '1' } } }]);
  assert.deepEqual(result, {
    ran: true,
    reason: 'source-server',
    result: { ok: true, built: [], skipped: ['current'] },
  });
});

test('runtime snapshot server admission does not inspect mutable workspace declarations', async () => {
  let called = false;
  const result = await ensureSourceServerWorkspacePackagesBuilt(
    { runtimeBackedStart: true, serverDir: '/repo/apps/server', env: {} },
    { ensureWorkspacePackagesBuiltForComponentImpl: async () => { called = true; } },
  );

  assert.equal(called, false);
  assert.deepEqual(result, { ran: false, reason: 'runtime-backed' });
});

test('source server spawn admits declarations once before launching', async () => {
  const calls = [];
  const child = { pid: 1234 };
  const result = await spawnSourceServerScript(
    { label: 'server', serverDir: '/repo/apps/server', script: 'start', env: { PORT: '34567' }, quiet: true },
    {
      ensureWorkspacePackagesBuiltForComponentImpl: async (dir, options) => calls.push(['workspace', dir, options]),
      pmSpawnScriptImpl: async (options) => {
        calls.push(['spawn', options]);
        return child;
      },
    },
  );

  assert.equal(result, child);
  assert.deepEqual(calls, [
    ['workspace', '/repo/apps/server', { quiet: true, env: { PORT: '34567' } }],
    ['spawn', { label: 'server', dir: '/repo/apps/server', script: 'start', env: { PORT: '34567' } }],
  ]);
});

test('source server spawn fails closed before launch when declaration admission fails', async () => {
  let spawned = false;
  await assert.rejects(
    () => spawnSourceServerScript(
      { label: 'server', serverDir: '/repo/apps/server', script: 'start', env: {} },
      {
        ensureWorkspacePackagesBuiltForComponentImpl: async () => { throw new Error('stale declaration rebuild failed'); },
        pmSpawnScriptImpl: async () => { spawned = true; },
      },
    ),
    /stale declaration rebuild failed/,
  );
  assert.equal(spawned, false);
});
