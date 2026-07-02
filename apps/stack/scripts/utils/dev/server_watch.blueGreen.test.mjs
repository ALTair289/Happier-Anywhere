import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createDevServerReloadDescriptors, createDevServerReloadExecutor, selectDevServerRestartMode } from './server.mjs';
import { getSpawnedProcessPlannedExitReason } from '../proc/proc.mjs';

async function withTempServerDir(t, fn) {
  const dir = await mkdtemp(join(tmpdir(), 'hstack-dev-server-proxy-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  return await fn(dir);
}

function createExecutorOptions(serverDir, overrides = {}) {
  return {
    enabled: true,
    stackMode: true,
    serverComponentName: 'happier-server-light',
    serverDir,
    serverPort: 4101,
    serverBindPort: 5101,
    internalServerUrl: 'http://127.0.0.1:5101',
    serverScript: 'dev:light',
    serverEnv: { HAPPIER_DB_PROVIDER: 'sqlite', PORT: '5101' },
    runtimeStatePath: join(serverDir, 'stack.runtime.json'),
    stackName: 'proxy-test',
    envPath: join(serverDir, 'env'),
    children: [],
    serverProcRef: { current: { pid: 101, exitCode: null } },
    isShuttingDown: () => false,
    ...overrides,
  };
}

test('selectDevServerRestartMode fails closed to exclusiveDb unless blue-green safety is proven', () => {
  assert.equal(selectDevServerRestartMode({ dbProvider: 'pglite', migrationsChanged: false }), 'exclusiveDb');
  assert.equal(selectDevServerRestartMode({ dbProvider: 'sqlite', migrationsChanged: true }), 'exclusiveDb');
  assert.equal(selectDevServerRestartMode({ dbProvider: 'sqlite', migrationsChanged: false }), 'exclusiveDb');
  assert.equal(
    selectDevServerRestartMode({
      dbProvider: 'sqlite',
      migrationsChanged: false,
      sqliteRuntimeMigrationsNoop: true,
      overlapSafeStartup: true,
    }),
    'blueGreen'
  );
});

test('server reload descriptors keep app and prisma changes distinguishable', async (t) => {
  await withTempServerDir(t, async (serverDir) => {
    await import('node:fs/promises').then(async ({ mkdir, writeFile }) => {
      await mkdir(join(serverDir, 'sources'), { recursive: true });
      await mkdir(join(serverDir, 'prisma'), { recursive: true });
      await writeFile(join(serverDir, 'sources', 'main.ts'), 'export {};\n', 'utf-8');
      await writeFile(join(serverDir, 'prisma', 'schema.prisma'), 'datasource db { provider = "sqlite" }\n', 'utf-8');
    });

    const descriptors = createDevServerReloadDescriptors({ serverDir });
    const byId = new Map(descriptors.map((descriptor) => [descriptor.id, descriptor]));

    assert.ok(byId.has('server:app'));
    assert.ok(byId.has('server:prisma'));
    assert.deepEqual(byId.get('server:app').paths.map((p) => p.slice(serverDir.length + 1)).sort(), ['sources']);
    assert.deepEqual(byId.get('server:prisma').paths.map((p) => p.slice(serverDir.length + 1)).sort(), ['prisma']);
  });
});

test('server reload descriptors ignore test-only source edits without missing runtime source edits', async (t) => {
  await withTempServerDir(t, async (serverDir) => {
    const { mkdir, writeFile } = await import('node:fs/promises');
    await mkdir(join(serverDir, 'sources', 'app', 'session'), { recursive: true });
    await mkdir(join(serverDir, 'prisma'), { recursive: true });
    await writeFile(join(serverDir, 'sources', 'app', 'session', 'runtime.ts'), 'export const value = 1;\n', 'utf-8');
    await writeFile(join(serverDir, 'prisma', 'schema.prisma'), 'datasource db { provider = "sqlite" }\n', 'utf-8');

    const descriptor = createDevServerReloadDescriptors({ serverDir }).find((item) => item.id === 'server:app');
    assert.ok(descriptor);

    const before = descriptor.readSignature();
    await writeFile(
      join(serverDir, 'sources', 'app', 'session', 'runtime.pendingCountZero.spec.ts'),
      'export const testOnly = true;\n',
      'utf-8',
    );
    assert.equal(descriptor.readSignature(), before);

    await writeFile(join(serverDir, 'sources', 'app', 'session', 'runtime.ts'), 'export const value = 2;\n', 'utf-8');
    assert.notEqual(descriptor.readSignature(), before);
  });
});

test('proxy exclusiveDb restart enters maintenance, replaces backend on an ephemeral port, flips, and records runtime state', async (t) => {
  await withTempServerDir(t, async (serverDir) => {
    const calls = [];
    const updates = [];
    const children = [];
    const oldServer = { pid: 101, exitCode: null };
    const proxy = {
      pid: process.pid,
      enterMaintenance(args) {
        calls.push(['maintenance', args.retryAfterMs]);
        return { targetHost: '127.0.0.1', targetPort: 6101 };
      },
      flipUpstream({ targetPort }) {
        calls.push(['flip', targetPort]);
      },
      drainConnections(args) {
        calls.push(['drain', args?.targetPort ?? null, args?.graceMs ?? null]);
      },
    };
    let spawnCount = 0;

    const executor = createDevServerReloadExecutor(
      createExecutorOptions(serverDir, {
        children,
        proxyController: proxy,
        serverProcRef: { current: oldServer },
      }),
      {
        preflightDevServerRestartImpl: async () => {},
        killProcessGroupOwnedByStackImpl: async (pid) => {
          if (Number(pid) === 101) {
            assert.equal(getSpawnedProcessPlannedExitReason(oldServer), 'dev-reload');
          }
          calls.push(['kill', pid]);
          return { killed: true };
        },
        waitForTcpPortFreeImpl: async (port) => {
          calls.push(['wait-free', port]);
          return true;
        },
        pickNextFreeTcpPortImpl: async () => 5102,
        pmSpawnScriptImpl: async ({ env }) => {
          spawnCount += 1;
          calls.push(['spawn', Number(env.PORT)]);
          return { pid: 202, exitCode: null };
        },
        waitForServerReadyImpl: async (url) => {
          calls.push(['ready', url]);
        },
        listListenPidsImpl: async () => [spawnCount === 0 ? 101 : 302],
        getProcessGroupIdImpl: async (pid) => (
          Number(pid) === 101 ? 7 :
          Number(pid) === 202 || Number(pid) === 302 ? 44 :
          Number(pid)
        ),
        recordStackRuntimeUpdateImpl: async (_path, patch) => {
          updates.push(patch);
        },
        logger: { log() {}, error() {} },
      }
    );

    await executor.build();
    await executor.restart();

    assert.deepEqual(calls, [
      ['maintenance', 2000],
      ['kill', 101],
      ['wait-free', 5101],
      ['spawn', 5102],
      ['ready', 'http://127.0.0.1:5102'],
      ['flip', 5102],
      ['drain', 6101, 2000],
      ['drain', 5101, 2000],
    ]);
    assert.equal(getSpawnedProcessPlannedExitReason(oldServer), 'dev-reload');
    assert.equal(children[0].pid, 202);
    assert.deepEqual(updates, [
      {
        processes: {
          serverPid: 302,
          serverWrapperPid: 202,
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
      },
    ]);
  });
});

test('proxy exclusiveDb restart attempts rollback when replacement readiness fails after old backend stopped', async (t) => {
  await withTempServerDir(t, async (serverDir) => {
    const calls = [];
    const proxy = {
      enterMaintenance() {
        calls.push(['maintenance']);
        return { targetHost: '127.0.0.1', targetPort: 6101 };
      },
      flipUpstream({ targetPort }) {
        calls.push(['flip', targetPort]);
      },
      drainConnections(args) {
        calls.push(['drain', args?.targetPort ?? null, args?.graceMs ?? null]);
      },
    };
    let spawnCount = 0;

    const executor = createDevServerReloadExecutor(
      createExecutorOptions(serverDir, { proxyController: proxy }),
      {
        preflightDevServerRestartImpl: async () => {},
        killProcessGroupOwnedByStackImpl: async (pid) => {
          calls.push(['kill', pid]);
          return { killed: true };
        },
        waitForTcpPortFreeImpl: async (port) => {
          calls.push(['wait-free', port]);
          return true;
        },
        pickNextFreeTcpPortImpl: async () => 5102,
        pmSpawnScriptImpl: async ({ env }) => {
          spawnCount += 1;
          calls.push(['spawn', Number(env.PORT)]);
          return { pid: spawnCount === 1 ? 202 : 203, exitCode: null };
        },
        waitForServerReadyImpl: async (url) => {
          calls.push(['ready', url]);
          if (url.endsWith(':5102')) {
            throw new Error('replacement not ready');
          }
        },
        listListenPidsImpl: async () => [spawnCount === 0 ? 101 : spawnCount === 1 ? 302 : 303],
        getProcessGroupIdImpl: async (pid) => (
          Number(pid) === 101 ? 7 :
          Number(pid) === 202 || Number(pid) === 302 ? 44 :
          Number(pid) === 203 || Number(pid) === 303 ? 45 :
          Number(pid)
        ),
        recordStackRuntimeUpdateImpl: async () => {},
        logger: { log() {}, error() {} },
      }
    );

    await assert.rejects(() => executor.restart(), /replacement not ready/);

    assert.deepEqual(calls, [
      ['maintenance'],
      ['kill', 101],
      ['wait-free', 5101],
      ['spawn', 5102],
      ['ready', 'http://127.0.0.1:5102'],
      ['kill', 202],
      ['spawn', 5101],
      ['ready', 'http://127.0.0.1:5101'],
      ['flip', 5101],
      ['drain', 6101, 2000],
      ['drain', 5102, 2000],
    ]);
  });
});

test('proxy exclusiveDb restart attempts rollback when backend port release fails after old backend stopped', async (t) => {
  await withTempServerDir(t, async (serverDir) => {
    const calls = [];
    const proxy = {
      enterMaintenance() {
        calls.push(['maintenance']);
        return { targetHost: '127.0.0.1', targetPort: 6101 };
      },
      flipUpstream({ targetPort }) {
        calls.push(['flip', targetPort]);
      },
      drainConnections(args) {
        calls.push(['drain', args?.targetPort ?? null, args?.graceMs ?? null]);
      },
    };
    let spawnCount = 0;

    const executor = createDevServerReloadExecutor(
      createExecutorOptions(serverDir, { proxyController: proxy }),
      {
        preflightDevServerRestartImpl: async () => {},
        killProcessGroupOwnedByStackImpl: async (pid) => {
          calls.push(['kill', pid]);
          return { killed: true };
        },
        waitForTcpPortFreeImpl: async (port) => {
          calls.push(['wait-free', port]);
          return false;
        },
        pmSpawnScriptImpl: async ({ env }) => {
          spawnCount += 1;
          calls.push(['spawn', Number(env.PORT)]);
          return { pid: 203, exitCode: null };
        },
        waitForServerReadyImpl: async (url) => {
          calls.push(['ready', url]);
        },
        listListenPidsImpl: async () => [spawnCount === 0 ? 101 : 303],
        getProcessGroupIdImpl: async (pid) => (
          Number(pid) === 101 ? 7 :
          Number(pid) === 203 || Number(pid) === 303 ? 45 :
          Number(pid)
        ),
        recordStackRuntimeUpdateImpl: async () => {},
        logger: { log() {}, error() {} },
      }
    );

    await assert.rejects(() => executor.restart(), /did not release/);

    assert.deepEqual(calls, [
      ['maintenance'],
      ['kill', 101],
      ['wait-free', 5101],
      ['spawn', 5101],
      ['ready', 'http://127.0.0.1:5101'],
      ['flip', 5101],
      ['drain', 6101, 2000],
    ]);
  });
});

test('proxy exclusiveDb restart keeps old backend serving when safe-stop proof fails before old backend is stopped', async (t) => {
  await withTempServerDir(t, async (serverDir) => {
    const calls = [];
    const proxy = {
      enterMaintenance() {
        calls.push(['maintenance']);
      },
      flipUpstream({ targetPort }) {
        calls.push(['flip', targetPort]);
      },
      drainConnections(args) {
        calls.push(['drain', args?.targetPort ?? null, args?.graceMs ?? null]);
      },
    };

    const executor = createDevServerReloadExecutor(
      createExecutorOptions(serverDir, { proxyController: proxy }),
      {
        preflightDevServerRestartImpl: async () => {},
        listListenPidsImpl: async () => [],
        getProcessGroupIdImpl: async (pid) => Number(pid),
        isTcpPortFreeImpl: async () => false,
        isPidAliveImpl: () => true,
        logger: { log() {}, error() {} },
      }
    );

    await assert.rejects(() => executor.restart(), /not provably stack-owned/);

    assert.deepEqual(calls, []);
  });
});

test('proxy blueGreen restart boots replacement before flipping and draining the old backend', async (t) => {
  await withTempServerDir(t, async (serverDir) => {
    const calls = [];
    const updates = [];
    const proxy = {
      pid: process.pid,
      enterMaintenance() {
        calls.push(['maintenance']);
      },
      flipUpstream({ targetPort }) {
        calls.push(['flip', targetPort]);
      },
      drainConnections(args) {
        calls.push(['drain', args?.targetPort ?? null, args?.graceMs ?? null]);
      },
    };

    const executor = createDevServerReloadExecutor(
      createExecutorOptions(serverDir, {
        proxyController: proxy,
        serverEnv: {
          HAPPIER_DB_PROVIDER: 'sqlite',
          PORT: '5101',
          HAPPIER_STACK_DEV_PROXY_DRAIN_MS: '0',
        },
        serverRestartModeContext: {
          migrationsChanged: false,
          sqliteRuntimeMigrationsNoop: true,
          overlapSafeStartup: true,
        },
      }),
      {
        preflightDevServerRestartImpl: async () => {},
        pickNextFreeTcpPortImpl: async () => 5102,
        pmSpawnScriptImpl: async ({ env }) => {
          calls.push(['spawn', Number(env.PORT)]);
          return { pid: 202, exitCode: null };
        },
        waitForServerReadyImpl: async (url) => {
          calls.push(['ready', url]);
        },
        listListenPidsImpl: async (port) => (Number(port) === 5101 ? [301] : [302]),
        getProcessGroupIdImpl: async (pid) => (
          Number(pid) === 101 || Number(pid) === 301 ? 7 :
          Number(pid) === 202 || Number(pid) === 302 ? 44 :
          Number(pid)
        ),
        killProcessGroupOwnedByStackImpl: async (pid) => {
          calls.push(['kill', pid]);
          return { killed: true };
        },
        recordStackRuntimeUpdateImpl: async (_path, patch) => {
          updates.push(patch);
        },
        sleepImpl: async (ms) => {
          calls.push(['unexpected-sleep', ms]);
        },
        logger: { log() {}, warn() {}, error() {} },
      }
    );

    await executor.restart();

    assert.deepEqual(calls, [
      ['spawn', 5102],
      ['ready', 'http://127.0.0.1:5102'],
      ['flip', 5102],
      ['drain', 5101, 0],
      ['kill', 101],
    ]);
    assert.deepEqual(updates, [
      {
        processes: {
          serverPid: 302,
          serverWrapperPid: 202,
          proxyPid: process.pid,
          serverBackendPid: 302,
          serverDrainingPid: 301,
        },
        ports: {
          server: 4101,
          serverBackend: 5102,
        },
        serverProxy: {
          enabled: true,
          mode: 'proxy',
          restartMode: 'blueGreen',
          fallbackReason: null,
        },
      },
      {
        processes: {
          serverPid: 302,
          serverWrapperPid: 202,
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
          restartMode: 'blueGreen',
          fallbackReason: null,
        },
      },
    ]);
  });
});

test('proxy blueGreen restart is selected for sqlite app-only reload descriptors', async (t) => {
  await withTempServerDir(t, async (serverDir) => {
    const calls = [];
    const proxy = {
      pid: process.pid,
      enterMaintenance() {
        calls.push(['maintenance']);
      },
      flipUpstream({ targetPort }) {
        calls.push(['flip', targetPort]);
      },
      drainConnections(args) {
        calls.push(['drain', args?.targetPort ?? null, args?.graceMs ?? null]);
      },
    };

    const executor = createDevServerReloadExecutor(
      createExecutorOptions(serverDir, {
        proxyController: proxy,
        serverEnv: {
          HAPPIER_DB_PROVIDER: 'sqlite',
          PORT: '5101',
          HAPPIER_STACK_DEV_PROXY_DRAIN_MS: '0',
        },
      }),
      {
        preflightDevServerRestartImpl: async () => {},
        pickNextFreeTcpPortImpl: async () => 5102,
        pmSpawnScriptImpl: async ({ env }) => {
          calls.push(['spawn', Number(env.PORT), env.HAPPIER_STACK_MIGRATE_MODE ?? null]);
          return { pid: 202, exitCode: null };
        },
        waitForServerReadyImpl: async (url) => {
          calls.push(['ready', url]);
        },
        listListenPidsImpl: async (port) => (Number(port) === 5101 ? [301] : [302]),
        getProcessGroupIdImpl: async (pid) => (
          Number(pid) === 101 || Number(pid) === 301 ? 7 :
          Number(pid) === 202 || Number(pid) === 302 ? 44 :
          Number(pid)
        ),
        killProcessGroupOwnedByStackImpl: async (pid) => {
          calls.push(['kill', pid]);
          return { killed: true };
        },
        recordStackRuntimeUpdateImpl: async () => {},
        sleepImpl: async () => {},
        logger: { log() {}, warn() {}, error() {} },
      }
    );

    await executor.build({ changedDescriptors: ['server:app'] });
    await executor.restart({ changedDescriptors: ['server:app'] });

    assert.deepEqual(calls, [
      ['spawn', 5102, 'skip'],
      ['ready', 'http://127.0.0.1:5102'],
      ['flip', 5102],
      ['drain', 5101, 0],
      ['kill', 101],
    ]);
  });
});

test('proxy blueGreen restart keeps the old backend serving when replacement readiness fails', async (t) => {
  await withTempServerDir(t, async (serverDir) => {
    const calls = [];
    const proxy = {
      enterMaintenance() {
        calls.push(['maintenance']);
      },
      flipUpstream({ targetPort }) {
        calls.push(['flip', targetPort]);
      },
    };

    const executor = createDevServerReloadExecutor(
      createExecutorOptions(serverDir, {
        proxyController: proxy,
        serverEnv: {
          HAPPIER_DB_PROVIDER: 'sqlite',
          PORT: '5101',
          HAPPIER_STACK_DEV_PROXY_DRAIN_MS: '0',
        },
        serverRestartModeContext: {
          migrationsChanged: false,
          sqliteRuntimeMigrationsNoop: true,
          overlapSafeStartup: true,
        },
      }),
      {
        preflightDevServerRestartImpl: async () => {},
        pickNextFreeTcpPortImpl: async () => 5102,
        pmSpawnScriptImpl: async ({ env }) => {
          calls.push(['spawn', Number(env.PORT)]);
          return { pid: 202, exitCode: null };
        },
        waitForServerReadyImpl: async (url) => {
          calls.push(['ready', url]);
          throw new Error('replacement not ready');
        },
        listListenPidsImpl: async (port) => (Number(port) === 5101 ? [301] : [302]),
        getProcessGroupIdImpl: async (pid) => (
          Number(pid) === 101 || Number(pid) === 301 ? 7 :
          Number(pid) === 202 || Number(pid) === 302 ? 44 :
          Number(pid)
        ),
        killProcessGroupOwnedByStackImpl: async (pid) => {
          calls.push(['kill', pid]);
          return { killed: true };
        },
        recordStackRuntimeUpdateImpl: async () => {},
        logger: { log() {}, warn() {}, error() {} },
      }
    );

    await assert.rejects(() => executor.restart(), /replacement not ready/);

    assert.deepEqual(calls, [
      ['spawn', 5102],
      ['ready', 'http://127.0.0.1:5102'],
      ['kill', 202],
    ]);
  });
});
