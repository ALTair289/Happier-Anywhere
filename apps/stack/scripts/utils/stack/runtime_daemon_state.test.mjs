import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  getObservedStackDaemonAsync,
  getObservedStackDaemon,
  readStackRuntimeStateWithDaemonSync,
  recordStackRuntimeDaemonPid,
  startStackRuntimeDaemonPidReconciler,
  syncStackRuntimeDaemonPidFromDaemonState,
} from './runtime_daemon_state.mjs';

const acceptAllStackOwnership = async () => ({ owned: true, reason: 'test_owned' });

test('getObservedStackDaemon prefers daemon.state over stale runtime daemon pid', () => {
  const observed = getObservedStackDaemon(
    {
      cliHomeDir: '/tmp/stack-cli-home',
      internalServerUrl: 'http://127.0.0.1:3009',
      runtimeDaemonPid: 111,
      env: {},
    },
    {
      checkDaemonStateImpl: () => ({ status: 'running', pid: 222 }),
      isPidAliveImpl: (pid) => Number(pid) === 111,
    },
  );

  assert.equal(observed.running, true);
  assert.equal(observed.pid, 222);
  assert.equal(observed.source, 'daemon_state');
});

test('getObservedStackDaemon treats dead runtime daemon pid as stopped when daemon state is not running', () => {
  const observed = getObservedStackDaemon(
    {
      cliHomeDir: '/tmp/stack-cli-home',
      internalServerUrl: 'http://127.0.0.1:3009',
      runtimeDaemonPid: 333,
      env: {},
    },
    {
      checkDaemonStateImpl: () => ({ status: 'stopped', pid: null }),
      isPidAliveImpl: () => false,
    },
  );

  assert.equal(observed.running, false);
  assert.equal(observed.pid, null);
  assert.equal(observed.status, 'stopped');
});

test('getObservedStackDaemonAsync does not treat runtime pids as running when ping-aware state is stopped', async () => {
  const observed = await getObservedStackDaemonAsync(
    {
      cliHomeDir: '/tmp/stack-cli-home',
      internalServerUrl: 'http://127.0.0.1:3009',
      runtimeDaemonPid: 111,
      env: {},
    },
    {
      checkDaemonStateImpl: async () => ({ status: 'stopped', pid: null }),
      isPidAliveImpl: (pid) => Number(pid) === 111,
    },
  );

  assert.equal(observed.running, false);
  assert.equal(observed.pid, 111);
  assert.equal(observed.source, 'runtime_pid');
  assert.equal(observed.status, 'stopped');
});

test('getObservedStackDaemon reports live runtime daemonPids entries without marking them running', () => {
  const observed = getObservedStackDaemon(
    {
      cliHomeDir: '/tmp/stack-cli-home',
      internalServerUrl: 'http://127.0.0.1:3009',
      runtimeDaemonPid: null,
      runtimeDaemonPids: [111, 222],
      env: {},
    },
    {
      checkDaemonStateImpl: () => ({ status: 'stopped', pid: null }),
      isPidAliveImpl: (pid) => Number(pid) === 222,
    },
  );

  assert.equal(observed.running, false);
  assert.equal(observed.pid, 222);
  assert.equal(observed.source, 'runtime_pid');
  assert.equal(observed.status, 'stopped');
});

test('syncStackRuntimeDaemonPidFromDaemonState records the live daemon pid without disturbing sibling process metadata', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-runtime-daemon-state-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const runtimeStatePath = join(root, 'stack.runtime.json');
  await mkdir(root, { recursive: true });
  await writeFile(
    runtimeStatePath,
    JSON.stringify({
      version: 1,
      stackName: 'dev',
      processes: {
        serverPid: 1234,
        daemonPid: 111,
      },
    }) + '\n',
    'utf-8',
  );

  const result = await syncStackRuntimeDaemonPidFromDaemonState(
    {
      runtimeStatePath,
      cliHomeDir: join(root, 'cli'),
      internalServerUrl: 'http://127.0.0.1:3009',
      env: {},
    },
    {
      checkDaemonStateImpl: () => ({ status: 'running', pid: 222 }),
      isPidAliveImpl: (pid) => Number(pid) === 222,
      resolvePidStackOwnershipImpl: acceptAllStackOwnership,
    },
  );

  assert.equal(result.running, true);
  assert.equal(result.pid, 222);

  const runtime = JSON.parse(await readFile(runtimeStatePath, 'utf-8'));
  assert.equal(runtime?.processes?.serverPid, 1234);
  assert.equal(runtime?.processes?.daemonPid, 222);
  assert.deepEqual(runtime?.processes?.daemonPids, [222]);
});

test('syncStackRuntimeDaemonPidFromDaemonState prunes stale daemon pid set entries and adds observed daemon pid', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-runtime-daemon-pid-set-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const runtimeStatePath = join(root, 'stack.runtime.json');
  await mkdir(root, { recursive: true });
  await writeFile(
    runtimeStatePath,
    JSON.stringify({
      version: 1,
      stackName: 'dev',
      processes: {
        serverPid: 1234,
        daemonPid: 111,
        daemonPids: [111, 222, 333, 222, 'bad'],
      },
    }) + '\n',
    'utf-8',
  );

  const result = await syncStackRuntimeDaemonPidFromDaemonState(
    {
      runtimeStatePath,
      cliHomeDir: join(root, 'cli'),
      internalServerUrl: 'http://127.0.0.1:3009',
      env: {},
    },
    {
      checkDaemonStateImpl: () => ({ status: 'running', pid: 444 }),
      isPidAliveImpl: (pid) => Number(pid) === 222 || Number(pid) === 444,
      resolvePidStackOwnershipImpl: acceptAllStackOwnership,
    },
  );

  assert.equal(result.running, true);
  assert.equal(result.pid, 444);

  const runtime = JSON.parse(await readFile(runtimeStatePath, 'utf-8'));
  assert.equal(runtime?.processes?.daemonPid, 444);
  assert.deepEqual(runtime?.processes?.daemonPids, [222, 444]);
});

test('syncStackRuntimeDaemonPidFromDaemonState prunes live daemon pid set entries that belong to another stack', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-runtime-daemon-cross-stack-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const runtimeStatePath = join(root, 'stack.runtime.json');
  const cliHomeDir = join(root, 'cli');
  await mkdir(root, { recursive: true });
  await writeFile(
    runtimeStatePath,
    JSON.stringify({
      version: 1,
      stackName: 'remote-dev',
      processes: {
        daemonPid: 111,
        daemonPids: [111],
      },
    }) + '\n',
    'utf-8',
  );

  const ownershipCalls = [];
  const result = await syncStackRuntimeDaemonPidFromDaemonState(
    {
      runtimeStatePath,
      cliHomeDir,
      internalServerUrl: 'http://127.0.0.1:3009',
      env: {},
    },
    {
      checkDaemonStateImpl: () => ({ status: 'running', pid: 222 }),
      isPidAliveImpl: (pid) => Number(pid) === 111 || Number(pid) === 222,
      resolvePidStackOwnershipImpl: async (pid, ctx) => {
        ownershipCalls.push({ pid: Number(pid), ctx });
        return { owned: Number(pid) === 222, reason: Number(pid) === 222 ? 'env_file' : 'stack_name_mismatch' };
      },
    },
  );

  assert.equal(result.running, true);
  assert.equal(result.pid, 222);
  assert.ok(ownershipCalls.some((call) => call.pid === 111));
  assert.ok(ownershipCalls.some((call) => call.pid === 222));
  for (const call of ownershipCalls) {
    assert.equal(call.ctx.stackName, 'remote-dev');
    assert.equal(call.ctx.envPath, join(root, 'env'));
    assert.equal(call.ctx.cliHomeDir, cliHomeDir);
  }

  const runtime = JSON.parse(await readFile(runtimeStatePath, 'utf-8'));
  assert.equal(runtime?.processes?.daemonPid, 222);
  assert.deepEqual(runtime?.processes?.daemonPids, [222]);
});

test('syncStackRuntimeDaemonPidFromDaemonState rejects unowned daemon.state pid without marking runtime fallback running', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-runtime-daemon-unowned-state-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const runtimeStatePath = join(root, 'stack.runtime.json');
  const cliHomeDir = join(root, 'cli');
  await mkdir(root, { recursive: true });
  await writeFile(
    runtimeStatePath,
    JSON.stringify({
      version: 1,
      stackName: 'remote-dev',
      processes: {
        daemonPid: 111,
        daemonPids: [111],
      },
    }) + '\n',
    'utf-8',
  );

  const result = await syncStackRuntimeDaemonPidFromDaemonState(
    {
      runtimeStatePath,
      cliHomeDir,
      internalServerUrl: 'http://127.0.0.1:3009',
      env: {},
    },
    {
      checkDaemonStateImpl: () => ({ status: 'running', pid: 222 }),
      isPidAliveImpl: (pid) => Number(pid) === 111 || Number(pid) === 222,
      resolvePidStackOwnershipImpl: async (pid) => ({
        owned: Number(pid) === 111,
        reason: Number(pid) === 111 ? 'cli_home' : 'stack_name_mismatch',
      }),
    },
  );

  assert.equal(result.running, false);
  assert.equal(result.pid, 111);
  assert.equal(result.source, 'runtime_pid');

  const runtime = JSON.parse(await readFile(runtimeStatePath, 'utf-8'));
  assert.equal(runtime?.processes?.daemonPid, 111);
  assert.deepEqual(runtime?.processes?.daemonPids, [111]);
});

test('syncStackRuntimeDaemonPidFromDaemonState clears stale runtime daemon pid when daemon is stopped', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-runtime-daemon-clear-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const runtimeStatePath = join(root, 'stack.runtime.json');
  await mkdir(root, { recursive: true });
  await writeFile(
    runtimeStatePath,
    JSON.stringify({
      version: 1,
      stackName: 'dev',
      processes: {
        daemonPid: 999,
      },
    }) + '\n',
    'utf-8',
  );

  const result = await syncStackRuntimeDaemonPidFromDaemonState(
    {
      runtimeStatePath,
      cliHomeDir: join(root, 'cli'),
      internalServerUrl: 'http://127.0.0.1:3009',
      env: {},
    },
    {
      checkDaemonStateImpl: () => ({ status: 'stopped', pid: null }),
      isPidAliveImpl: () => false,
      resolvePidStackOwnershipImpl: acceptAllStackOwnership,
    },
  );

  assert.equal(result.running, false);
  assert.equal(result.pid, null);

  const runtime = JSON.parse(await readFile(runtimeStatePath, 'utf-8'));
  assert.equal(runtime?.processes?.daemonPid, null);
  assert.deepEqual(runtime?.processes?.daemonPids, []);
});

test('syncStackRuntimeDaemonPidFromDaemonState preserves the recorded dist fingerprint when sync callers omit it', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-runtime-daemon-fingerprint-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const runtimeStatePath = join(root, 'stack.runtime.json');
  await mkdir(root, { recursive: true });
  await writeFile(
    runtimeStatePath,
    JSON.stringify({
      version: 1,
      stackName: 'dev',
      processes: {
        daemonPid: 111,
      },
      daemon: {
        distClosureFingerprint: 'fingerprint-before-sync',
      },
    }) + '\n',
    'utf-8',
  );

  const result = await syncStackRuntimeDaemonPidFromDaemonState(
    {
      runtimeStatePath,
      cliHomeDir: join(root, 'cli'),
      internalServerUrl: 'http://127.0.0.1:3009',
      env: {},
    },
    {
      checkDaemonStateImpl: () => ({ status: 'running', pid: 222 }),
      isPidAliveImpl: () => true,
      resolvePidStackOwnershipImpl: acceptAllStackOwnership,
    },
  );

  assert.equal(result.running, true);
  assert.equal(result.pid, 222);
  assert.equal(result.daemonDistFingerprint, 'fingerprint-before-sync');

  const runtime = JSON.parse(await readFile(runtimeStatePath, 'utf-8'));
  assert.equal(runtime?.processes?.daemonPid, 222);
  assert.equal(runtime?.daemon?.distClosureFingerprint, 'fingerprint-before-sync');
});

test('recordStackRuntimeDaemonPid clears daemon pid when requested explicitly', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-runtime-daemon-record-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const runtimeStatePath = join(root, 'stack.runtime.json');
  await mkdir(root, { recursive: true });
  await writeFile(
    runtimeStatePath,
    JSON.stringify({
      version: 1,
      stackName: 'dev',
      processes: {
        daemonPid: 444,
      },
    }) + '\n',
    'utf-8',
  );

  await recordStackRuntimeDaemonPid(runtimeStatePath, null);

  const runtime = JSON.parse(await readFile(runtimeStatePath, 'utf-8'));
  assert.equal(runtime?.processes?.daemonPid, null);
  assert.deepEqual(runtime?.processes?.daemonPids, []);
});

test('recordStackRuntimeDaemonPid explicit clear removes live existing daemon pid entries', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-runtime-daemon-record-live-clear-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const runtimeStatePath = join(root, 'stack.runtime.json');
  await mkdir(root, { recursive: true });
  await writeFile(
    runtimeStatePath,
    JSON.stringify({
      version: 1,
      stackName: 'dev',
      processes: {
        daemonPid: 444,
        daemonPids: [444, 555],
      },
    }) + '\n',
    'utf-8',
  );

  await recordStackRuntimeDaemonPid(runtimeStatePath, null, {
    isPidAliveImpl: () => true,
    isDaemonPidEligibleImpl: () => true,
  });

  const runtime = JSON.parse(await readFile(runtimeStatePath, 'utf-8'));
  assert.equal(runtime?.processes?.daemonPid, null);
  assert.deepEqual(runtime?.processes?.daemonPids, []);
});

test('readStackRuntimeStateWithDaemonSync returns the refreshed daemon pid after syncing from daemon.state', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-runtime-daemon-read-sync-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const runtimeStatePath = join(root, 'stack.runtime.json');
  await mkdir(root, { recursive: true });
  await writeFile(
    runtimeStatePath,
    JSON.stringify({
      version: 1,
      stackName: 'dev',
      processes: {
        serverPid: 1234,
        daemonPid: 111,
      },
    }) + '\n',
    'utf-8',
  );

  const runtime = await readStackRuntimeStateWithDaemonSync(
    {
      runtimeStatePath,
      cliHomeDir: join(root, 'cli'),
      internalServerUrl: 'http://127.0.0.1:3009',
      env: {},
    },
    {
      checkDaemonStateImpl: () => ({ status: 'running', pid: 222 }),
      isPidAliveImpl: () => true,
      resolvePidStackOwnershipImpl: acceptAllStackOwnership,
    },
  );

  assert.equal(runtime?.processes?.serverPid, 1234);
  assert.equal(runtime?.processes?.daemonPid, 222);
});

test('startStackRuntimeDaemonPidReconciler refreshes stale runtime pid after daemon self-restart', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-runtime-daemon-reconcile-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const runtimeStatePath = join(root, 'stack.runtime.json');
  await mkdir(root, { recursive: true });
  await writeFile(
    runtimeStatePath,
    JSON.stringify({
      version: 1,
      stackName: 'remote-dev',
      processes: {
        serverPid: 1234,
        daemonPid: 42158,
        daemonPids: [42158],
      },
    }) + '\n',
    'utf-8',
  );

  const intervals = [];
  const clearCalls = [];
  const reconciler = startStackRuntimeDaemonPidReconciler(
    {
      runtimeStatePath,
      cliHomeDir: join(root, 'cli'),
      internalServerUrl: 'http://127.0.0.1:52753',
      env: {},
      intervalMs: 1000,
    },
    {
      checkDaemonStateImpl: async () => ({ status: 'running', pid: 76071 }),
      isPidAliveImpl: (pid) => Number(pid) === 76071,
      resolvePidStackOwnershipImpl: acceptAllStackOwnership,
      setIntervalImpl: (fn, intervalMs) => {
        intervals.push({ fn, intervalMs });
        return { unref() {} };
      },
      clearIntervalImpl: (timer) => clearCalls.push(timer),
    },
  );

  await reconciler.syncNow();

  const runtime = JSON.parse(await readFile(runtimeStatePath, 'utf-8'));
  assert.equal(runtime?.processes?.serverPid, 1234);
  assert.equal(runtime?.processes?.daemonPid, 76071);
  assert.deepEqual(runtime?.processes?.daemonPids, [76071]);
  assert.equal(intervals.length, 1);
  assert.equal(intervals[0]?.intervalMs, 1000);

  reconciler.close();
  assert.equal(clearCalls.length, 1);
});
