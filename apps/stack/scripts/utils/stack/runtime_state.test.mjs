import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  createStackDevProxyRuntimePatch,
  createStackServerRuntimeProcessPatch,
  readStackRuntimeStateFile,
  recordStackRuntimeStart,
  recordStackRuntimeUpdate,
  recordStackRuntimeServerPids,
  recordStackRuntimeStopRequest,
} from './runtime_state.mjs';

test('recordStackRuntimeStart refreshes startedAt when the owner pid changes', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'happy-stacks-runtime-state-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const statePath = join(dir, 'stack.runtime.json');
  const first = await recordStackRuntimeStart(statePath, {
    stackName: 'dev-built',
    script: 'run.mjs',
    ephemeral: true,
    ownerPid: process.pid,
    ports: { server: 23456 },
  });

  await new Promise((resolve) => setTimeout(resolve, 10));

  const second = await recordStackRuntimeStart(statePath, {
    stackName: 'dev-built',
    script: 'run.mjs',
    ephemeral: true,
    ownerPid: process.pid + 100000,
    ports: { server: 23456 },
  });

  assert.notEqual(second.startedAt, first.startedAt);
});

test('recordStackRuntimeStopRequest persists stop attribution details', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'happy-stacks-runtime-state-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const statePath = join(dir, 'stack.runtime.json');
  await recordStackRuntimeStart(statePath, {
    stackName: 'dev-built',
    script: 'run.mjs',
    ephemeral: true,
    ownerPid: process.pid,
    ports: { server: 23456 },
  });

  await recordStackRuntimeStopRequest(statePath, {
    signal: 'SIGTERM',
    requestedBy: 'service restart',
    reason: 'explicit restart',
    preserveDaemon: true,
  });

  const state = await readStackRuntimeStateFile(statePath);
  assert.deepEqual(state?.stopRequest, {
    signal: 'SIGTERM',
    requestedBy: 'service restart',
    reason: 'explicit restart',
    preserveDaemon: true,
    requestedAt: state?.stopRequest?.requestedAt,
  });
  assert.equal(typeof state?.stopRequest?.requestedAt, 'string');
});

test('recordStackRuntimeServerPids stores listener and wrapper pids distinctly', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'happy-stacks-runtime-state-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const statePath = join(dir, 'stack.runtime.json');
  await recordStackRuntimeStart(statePath, {
    stackName: 'dev-built',
    script: 'run.mjs',
    ephemeral: true,
    ownerPid: process.pid,
    ports: { server: 23456 },
  });

  await recordStackRuntimeServerPids(statePath, { listenerPid: 301, wrapperPid: 201 });

  const state = await readStackRuntimeStateFile(statePath);
  assert.equal(state?.processes?.serverPid, 301);
  assert.equal(state?.processes?.serverWrapperPid, 201);
});

test('createStackServerRuntimeProcessPatch clears invalid wrapper pid without clearing listener pid', () => {
  assert.deepEqual(createStackServerRuntimeProcessPatch({ listenerPid: 301, wrapperPid: null }), {
    processes: { serverPid: 301, serverWrapperPid: null },
  });
});

test('createStackServerRuntimeProcessPatch can clear proxy metadata when recording direct mode', () => {
  assert.deepEqual(
    createStackServerRuntimeProcessPatch({
      listenerPid: 301,
      wrapperPid: 201,
      serverPort: 4101,
      clearProxyState: true,
    }),
    {
      processes: {
        serverPid: 301,
        serverWrapperPid: 201,
        proxyPid: null,
        serverBackendPid: null,
        serverDrainingPid: null,
      },
      ports: {
        server: 4101,
        serverBackend: null,
      },
      serverProxy: {
        enabled: false,
        mode: 'direct',
        restartMode: null,
        fallbackReason: null,
      },
    },
  );
});

test('createStackDevProxyRuntimePatch records stable and backend proxy state without gateway backend fields', () => {
  assert.deepEqual(
    createStackDevProxyRuntimePatch({
      stablePort: 4101,
      backendPort: 5102,
      proxyPid: process.pid,
      backendPid: 302,
      drainingPid: null,
      mode: 'proxy',
      restartMode: 'exclusiveDb',
    }),
    {
      processes: {
        proxyPid: process.pid,
        serverBackendPid: 302,
        serverDrainingPid: null,
      },
      ports: {
        server: 4101,
        serverBackend: 5102,
      },
      serverProxy: {
        enabled: true,
        mode: 'proxy',
        restartMode: 'exclusiveDb',
        fallbackReason: null,
      },
    }
  );
});

test('stack dev proxy runtime patch clears stale mode-specific metadata across deep merge', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'happy-stacks-runtime-state-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const statePath = join(dir, 'stack.runtime.json');
  await recordStackRuntimeStart(statePath, {
    stackName: 'dev-built',
    script: 'dev.mjs',
    ephemeral: true,
    ownerPid: process.pid,
    ports: { server: 4101 },
  });

  await recordStackRuntimeUpdate(
    statePath,
    createStackDevProxyRuntimePatch({
      stablePort: 4101,
      backendPort: 5102,
      proxyPid: process.pid,
      backendPid: process.pid + 1,
      drainingPid: null,
      mode: 'proxy',
      restartMode: 'blueGreen',
    }),
  );
  await recordStackRuntimeUpdate(
    statePath,
    createStackDevProxyRuntimePatch({
      stablePort: 4101,
      backendPort: null,
      proxyPid: null,
      backendPid: null,
      drainingPid: null,
      mode: 'directFallback',
      fallbackReason: 'proxy bind failed',
    }),
  );

  let state = await readStackRuntimeStateFile(statePath);
  assert.deepEqual(state?.serverProxy, {
    enabled: true,
    mode: 'directFallback',
    restartMode: null,
    fallbackReason: 'proxy bind failed',
  });

  await recordStackRuntimeUpdate(
    statePath,
    createStackDevProxyRuntimePatch({
      stablePort: 4101,
      backendPort: 5103,
      proxyPid: process.pid,
      backendPid: process.pid + 2,
      drainingPid: null,
      mode: 'proxy',
      restartMode: 'exclusiveDb',
    }),
  );

  state = await readStackRuntimeStateFile(statePath);
  assert.deepEqual(state?.serverProxy, {
    enabled: true,
    mode: 'proxy',
    restartMode: 'exclusiveDb',
    fallbackReason: null,
  });
});
