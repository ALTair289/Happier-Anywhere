import test from 'node:test';
import assert from 'node:assert/strict';

import { createDevProxyUnexpectedExitHandler } from './devProxyLifecycle.mjs';

test('proxy lifecycle owner clears stale runtime truth and requests coherent shutdown on unexpected exit', async () => {
  const updates = [];
  const shutdowns = [];
  const handler = createDevProxyUnexpectedExitHandler({
    stackMode: true,
    runtimeStatePath: '/tmp/runtime.json',
    recordStackRuntimeUpdateImpl: async (path, patch) => updates.push([path, patch]),
    requestShutdownImpl: (reason) => shutdowns.push(reason),
    logger: { error() {} },
  });

  await handler({ expected: false, code: null, signal: 'SIGKILL' });

  assert.deepEqual(updates, [[
    '/tmp/runtime.json',
    {
      processes: { proxyPid: null },
      serverProxy: {
        enabled: false,
        mode: 'unavailable',
        restartMode: null,
        fallbackReason: 'proxy child exited (code=null, signal=SIGKILL)',
      },
    },
  ]]);
  assert.deepEqual(shutdowns, ['server_proxy_unavailable']);
});
