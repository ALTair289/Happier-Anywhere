import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import http from 'node:http';

import { filterEnvForSpawn, withPatchedProcessEnv } from './testkit/core/env_scope.mjs';
import { spawnDetachedInlineNodeTestProcess, spawnDetachedTestProcess } from './testkit/core/spawn_test_process.mjs';
import { readStackInfoSnapshot } from './stack/stack_info_snapshot.mjs';
import { listListenPidsWithStatus } from './utils/net/ports.mjs';

async function withListeningServer() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? Number(addr.port) : 0;
  return {
    port,
    async close() {
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

async function reserveUnusedPort() {
  const listener = await withListeningServer();
  const port = listener.port;
  await listener.close();
  return port;
}

async function waitForJsonFile(path, { timeoutMs = 5_000, intervalMs = 30 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      return JSON.parse(await readFile(path, 'utf-8'));
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
  throw new Error(`timed out waiting for ${path}: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

async function waitForProcessAlive(pid, { timeoutMs = 5_000, intervalMs = 20 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
  throw new Error(`timed out waiting for pid ${pid}`);
}

async function waitForListenPid(port, expectedPid, { timeoutMs = 5_000, intervalMs = 20 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastPids = [];
  while (Date.now() < deadline) {
    const status = await listListenPidsWithStatus(port);
    lastPids = Array.isArray(status.pids) ? status.pids : [];
    if (lastPids.includes(expectedPid)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`timed out waiting for pid ${expectedPid} to listen on ${port}; saw [${lastPids.join(', ')}]`);
}

function baseListenerEnv(extraEnv = {}) {
  return {
    ...filterEnvForSpawn(process.env, {
      keepKeys: ['PATH', 'Path', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'SystemRoot', 'ComSpec'],
    }),
    ...extraEnv,
  };
}

async function spawnTcpListener({ readyPath, env }) {
  const child = spawnDetachedTestProcess(
    process.execPath,
    [
      '-e',
      `
const fs = require('node:fs');
const net = require('node:net');

const readyPath = process.argv[1];
const server = net.createServer((socket) => {
  socket.end('ok');
});

server.listen(0, '127.0.0.1', () => {
  const address = server.address();
  fs.writeFileSync(readyPath, JSON.stringify({ pid: process.pid, port: address.port }) + '\\n', 'utf-8');
});

function shutdown() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 500).unref();
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
setInterval(() => {}, 1000);
      `,
      readyPath,
    ],
    {
      env,
      stdio: 'ignore',
    },
  );
  const ready = await waitForJsonFile(readyPath);
  return {
    pid: Number(child.pid),
    port: Number(ready.port),
    async close() {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        try {
          process.kill(child.pid, 'SIGKILL');
        } catch {
          // ignore
        }
      }
    },
  };
}

async function spawnProcessGroupTcpListener({ readyPath, env }) {
  if (process.platform === 'win32') {
    throw new Error('process group listener helper is not supported on Windows');
  }

  const child = spawnDetachedTestProcess(
    process.execPath,
    [
      '-e',
      `
const { spawn } = require('node:child_process');
const fs = require('node:fs');

const readyPath = process.argv[1];
const listener = spawn(process.execPath, ['-e', \`
const fs = require('node:fs');
const net = require('node:net');

const readyPath = process.argv[1];
const ownerPid = Number(process.argv[2]);
const server = net.createServer((socket) => {
  socket.end('ok');
});

server.listen(0, '127.0.0.1', () => {
  const address = server.address();
  fs.writeFileSync(
    readyPath,
    JSON.stringify({ ownerPid, listenerPid: process.pid, port: address.port }) + '\\\\n',
    'utf-8',
  );
});

function shutdown() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 500).unref();
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
setInterval(() => {}, 1000);
\`, readyPath, String(process.pid)], {
  detached: false,
  stdio: 'ignore',
});

listener.unref();

function shutdown() {
  if (listener.pid) {
    try {
      process.kill(listener.pid, 'SIGTERM');
    } catch {}
  }
  setTimeout(() => process.exit(0), 500).unref();
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
setInterval(() => {}, 1000);
      `,
      readyPath,
    ],
    {
      env,
      stdio: 'ignore',
    },
  );
  const ready = await waitForJsonFile(readyPath);
  return {
    ownerPid: Number(child.pid),
    listenerPid: Number(ready.listenerPid),
    port: Number(ready.port),
    async close() {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        try {
          process.kill(child.pid, 'SIGKILL');
        } catch {
          // ignore
        }
      }
    },
  };
}

test('readStackInfoSnapshot reports running when owner pid is stale but an infra pid is alive', async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-info-running-process-'));
  const storageDir = join(tmp, 'storage');
  const stackName = 'dev-auth';
  const baseDir = join(storageDir, stackName);

  await mkdir(baseDir, { recursive: true });
  await writeFile(join(baseDir, 'env'), 'HAPPIER_STACK_SERVER_PORT=3009\n', 'utf-8');
  await writeFile(
    join(baseDir, 'stack.runtime.json'),
    JSON.stringify({
      version: 1,
      stackName,
      ownerPid: 999_999_999,
      processes: { serverPid: process.pid },
      ports: { server: 3009 },
    }) + '\n',
    'utf-8'
  );

  const restore = withPatchedProcessEnv(t, { HAPPIER_STACK_STORAGE_DIR: storageDir });
  try {
    const out = await readStackInfoSnapshot({ rootDir: process.cwd(), stackName });
    assert.equal(out.runtime.running, true);
    assert.equal(out.runtime.runningPid, process.pid);
  } finally {
    restore();
    await rm(tmp, { recursive: true, force: true });
  }
});

test('readStackInfoSnapshot resolves listener child owned by recorded runtime process group', async (t) => {
  if (process.platform === 'win32') {
    t.skip('process group ownership discovery is not available on Windows');
    return;
  }

  const tmp = await mkdtemp(join(tmpdir(), 'hstack-info-pgid-listener-'));
  const storageDir = join(tmp, 'storage');
  const stackName = 'dev-auth';
  const baseDir = join(storageDir, stackName);
  const readyPath = join(tmp, 'server-ready.json');
  let listener = null;

  await mkdir(baseDir, { recursive: true });

  try {
    listener = await spawnProcessGroupTcpListener({
      readyPath,
      env: baseListenerEnv(),
    });
    await waitForListenPid(listener.port, listener.listenerPid);

    await writeFile(join(baseDir, 'env'), `HAPPIER_STACK_SERVER_PORT=${listener.port}\n`, 'utf-8');
    await writeFile(
      join(baseDir, 'stack.runtime.json'),
      JSON.stringify({
        version: 1,
        stackName,
        ownerPid: 999_999_999,
        processes: { serverPid: listener.ownerPid },
        ports: { server: listener.port },
      }) + '\n',
      'utf-8',
    );

    const restore = withPatchedProcessEnv(t, { HAPPIER_STACK_STORAGE_DIR: storageDir });
    try {
      const out = await readStackInfoSnapshot({ rootDir: process.cwd(), stackName });
      assert.equal(out.runtime.running, true);
      assert.equal(out.runtime.components.server.pid, listener.listenerPid);
      assert.equal(out.runtime.components.server.running, true);
      assert.deepEqual(out.runtime.components.server.ownedListenerPids, [listener.listenerPid]);
    } finally {
      restore();
    }
  } finally {
    await listener?.close();
    await rm(tmp, { recursive: true, force: true });
  }
});

test('readStackInfoSnapshot falls back to live recorded pid and reachable port when listener pid discovery is unsupported', async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-info-listener-discovery-unsupported-'));
  const storageDir = join(tmp, 'storage');
  const stackName = 'dev-auth';
  const baseDir = join(storageDir, stackName);
  const port = await reserveUnusedPort();

  await mkdir(baseDir, { recursive: true });
  await writeFile(join(baseDir, 'env'), `HAPPIER_STACK_SERVER_PORT=${port}\n`, 'utf-8');
  await writeFile(
    join(baseDir, 'stack.runtime.json'),
    JSON.stringify({
      version: 1,
      stackName,
      ownerPid: 999_999_999,
      processes: { serverPid: process.pid },
      ports: { server: port },
    }) + '\n',
    'utf-8',
  );

  const restore = withPatchedProcessEnv(t, { HAPPIER_STACK_STORAGE_DIR: storageDir });
  try {
    const out = await readStackInfoSnapshot({
      rootDir: process.cwd(),
      stackName,
      listListenPidsWithStatusImpl: async () => ({
        supported: false,
        pids: [],
        reason: 'unsupported-test',
      }),
      isTcpPortListeningImpl: async () => true,
    });
    assert.equal(out.runtime.components.server.running, true);
    assert.equal(out.runtime.components.server.pid, process.pid);
    assert.equal(out.runtime.components.server.portListening, true);
    assert.equal(out.runtime.components.server.listenerDiscoverySupported, false);
    assert.deepEqual(out.runtime.components.server.ownedListenerPids, []);
  } finally {
    restore();
    await rm(tmp, { recursive: true, force: true });
  }
});

test('readStackInfoSnapshot reports proxy and active backend separately in proxy mode', async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-info-proxy-mode-'));
  const storageDir = join(tmp, 'storage');
  const stackName = 'dev-auth';
  const baseDir = join(storageDir, stackName);

  await mkdir(baseDir, { recursive: true });
  await writeFile(join(baseDir, 'env'), 'HAPPIER_STACK_SERVER_PORT=4101\nHAPPIER_STACK_DAEMON=0\n', 'utf-8');
  await writeFile(
    join(baseDir, 'stack.runtime.json'),
    JSON.stringify({
      version: 1,
      stackName,
      ownerPid: 999_999_999,
      processes: {
        proxyPid: process.pid,
        serverPid: process.pid,
        serverBackendPid: process.pid,
      },
      ports: {
        server: 4101,
        serverBackend: 5101,
      },
      serverProxy: {
        enabled: true,
        mode: 'proxy',
        restartMode: 'exclusiveDb',
      },
    }) + '\n',
    'utf-8',
  );

  const restore = withPatchedProcessEnv(t, { HAPPIER_STACK_STORAGE_DIR: storageDir });
  try {
    const out = await readStackInfoSnapshot({
      rootDir: process.cwd(),
      stackName,
      listListenPidsWithStatusImpl: async () => ({
        supported: false,
        pids: [],
        reason: 'unsupported-test',
      }),
      isTcpPortListeningImpl: async () => true,
    });
    assert.equal(out.runtime.components.server.pid, process.pid);
    assert.equal(out.runtime.components.server.running, true);
    assert.equal(out.runtime.components.serverBackend.pid, process.pid);
    assert.equal(out.runtime.components.serverBackend.running, true);
    assert.equal(out.ports.server, 4101);
    assert.equal(out.ports.serverBackend, 5101);
    assert.deepEqual(out.runtime.serverProxy, {
      enabled: true,
      mode: 'proxy',
      restartMode: 'exclusiveDb',
    });
    assert.equal(out.runtime.health.status, 'healthy');
  } finally {
    restore();
    await rm(tmp, { recursive: true, force: true });
  }
});

test('readStackInfoSnapshot does not report running when stale metadata points at an unrelated server port listener', async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-info-running-port-'));
  const storageDir = join(tmp, 'storage');
  const stackName = 'dev-auth';
  const baseDir = join(storageDir, stackName);

  await mkdir(baseDir, { recursive: true });

  const listener = await withListeningServer();
  await writeFile(join(baseDir, 'env'), `HAPPIER_STACK_SERVER_PORT=${listener.port}\n`, 'utf-8');
  await writeFile(
    join(baseDir, 'stack.runtime.json'),
    JSON.stringify({
      version: 1,
      stackName,
      ownerPid: 999_999_999,
      processes: { serverPid: 999_999_998 },
      ports: { server: listener.port },
    }) + '\n',
    'utf-8'
  );

  const restore = withPatchedProcessEnv(t, { HAPPIER_STACK_STORAGE_DIR: storageDir });
  try {
    const out = await readStackInfoSnapshot({ rootDir: process.cwd(), stackName });
    assert.equal(out.runtime.running, false);
    assert.equal(out.runtime.components.server.running, false);
    assert.equal(out.runtime.components.server.portListening, true);
    assert.equal(out.runtime.health.status, 'stopped');
    assert.deepEqual(out.runtime.health.issues, ['server_down']);
  } finally {
    restore();
    await listener.close();
    await rm(tmp, { recursive: true, force: true });
  }
});

test('readStackInfoSnapshot resolves stale server and UI pids from stack-owned listener pids', async (t) => {
  if (process.platform === 'win32') {
    t.skip('listener pid ownership discovery is not available on Windows');
    return;
  }

  const tmp = await mkdtemp(join(tmpdir(), 'hstack-info-owned-listener-'));
  const storageDir = join(tmp, 'storage');
  const stackName = 'dev-auth';
  const baseDir = join(storageDir, stackName);
  const envPath = join(baseDir, 'env');
  const cliHomeDir = join(baseDir, 'cli');
  const serverReadyPath = join(tmp, 'server-ready.json');
  const uiReadyPath = join(tmp, 'ui-ready.json');
  let serverListener = null;
  let uiListener = null;

  await mkdir(baseDir, { recursive: true });
  await mkdir(cliHomeDir, { recursive: true });

  try {
    const ownedEnv = baseListenerEnv({
      HAPPIER_STACK_STACK: stackName,
      HAPPIER_STACK_ENV_FILE: envPath,
      HAPPIER_STACK_PROCESS_KIND: 'infra',
    });
    serverListener = await spawnTcpListener({ readyPath: serverReadyPath, env: ownedEnv });
    uiListener = await spawnTcpListener({ readyPath: uiReadyPath, env: ownedEnv });

    await writeFile(
      envPath,
      [
        `HAPPIER_STACK_SERVER_PORT=${serverListener.port}`,
        'HAPPIER_STACK_DAEMON=0',
        '',
      ].join('\n'),
      'utf-8',
    );
    await writeFile(
      join(baseDir, 'stack.runtime.json'),
      JSON.stringify({
        version: 1,
        stackName,
        ownerPid: 999_999_999,
        processes: { serverPid: 999_999_998, expoPid: 999_999_997 },
        ports: { server: serverListener.port },
        expo: { webPort: uiListener.port, webEnabled: true },
      }) + '\n',
      'utf-8',
    );

    const restore = withPatchedProcessEnv(t, { HAPPIER_STACK_STORAGE_DIR: storageDir });
    try {
      const out = await readStackInfoSnapshot({ rootDir: process.cwd(), stackName });
      assert.equal(out.runtime.running, true);
      assert.ok([serverListener.pid, uiListener.pid].includes(out.runtime.runningPid));
      assert.equal(out.runtime.health.status, 'healthy');
      assert.deepEqual(out.runtime.health.issues, []);
      assert.equal(out.runtime.components.server.pid, serverListener.pid);
      assert.equal(out.runtime.components.server.running, true);
      assert.equal(out.runtime.components.server.pidAlive, true);
      assert.equal(out.runtime.components.server.portListening, true);
      assert.equal(out.runtime.components.ui.pid, uiListener.pid);
      assert.equal(out.runtime.components.ui.running, true);
      assert.equal(out.runtime.components.ui.pidAlive, true);
      assert.equal(out.runtime.components.ui.portListening, true);
    } finally {
      restore();
    }
  } finally {
    await serverListener?.close();
    await uiListener?.close();
    await rm(tmp, { recursive: true, force: true });
  }
});

test('readStackInfoSnapshot marks UI as down when expo runtime metadata is stale', async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-info-ui-stale-'));
  const storageDir = join(tmp, 'storage');
  const stackName = 'dev-auth';
  const baseDir = join(storageDir, stackName);

  await mkdir(baseDir, { recursive: true });

  const serverListener = await withListeningServer();
  const staleUiPort = await reserveUnusedPort();
  await writeFile(join(baseDir, 'env'), `HAPPIER_STACK_SERVER_PORT=${serverListener.port}\n`, 'utf-8');
  await writeFile(
    join(baseDir, 'stack.runtime.json'),
    JSON.stringify({
      version: 1,
      stackName,
      ownerPid: 999_999_999,
      processes: { serverPid: process.pid, expoPid: 999_999_998 },
      ports: { server: serverListener.port },
      expo: { webPort: staleUiPort, webEnabled: true },
    }) + '\n',
    'utf-8'
  );

  const restore = withPatchedProcessEnv(t, { HAPPIER_STACK_STORAGE_DIR: storageDir });
  try {
    const out = await readStackInfoSnapshot({ rootDir: process.cwd(), stackName });
    assert.equal(out.runtime.running, true);
    assert.equal(out.runtime.components.server.running, true);
    assert.equal(out.runtime.components.ui.running, false);
    assert.equal(out.runtime.health.status, 'degraded');
    assert.deepEqual(out.runtime.health.issues, ['ui_down', 'daemon_down']);
  } finally {
    restore();
    await serverListener.close();
    await rm(tmp, { recursive: true, force: true });
  }
});

test('readStackInfoSnapshot requires UI port reachability even when expo pid is alive', async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-info-ui-unreachable-'));
  const storageDir = join(tmp, 'storage');
  const stackName = 'dev-auth';
  const baseDir = join(storageDir, stackName);

  await mkdir(baseDir, { recursive: true });

  const serverListener = await withListeningServer();
  const staleUiPort = await reserveUnusedPort();
  await writeFile(join(baseDir, 'env'), `HAPPIER_STACK_SERVER_PORT=${serverListener.port}\n`, 'utf-8');
  await writeFile(
    join(baseDir, 'stack.runtime.json'),
    JSON.stringify({
      version: 1,
      stackName,
      ownerPid: 999_999_999,
      processes: { serverPid: process.pid, expoPid: process.pid },
      ports: { server: serverListener.port },
      expo: { webPort: staleUiPort, webEnabled: true },
    }) + '\n',
    'utf-8'
  );

  const restore = withPatchedProcessEnv(t, { HAPPIER_STACK_STORAGE_DIR: storageDir });
  try {
    const out = await readStackInfoSnapshot({ rootDir: process.cwd(), stackName });
    assert.equal(out.runtime.running, true);
    assert.equal(out.runtime.components.ui.pidAlive, true);
    assert.equal(out.runtime.components.ui.running, false);
    assert.equal(out.runtime.health.status, 'degraded');
    assert.deepEqual(out.runtime.health.issues, ['ui_down', 'daemon_down']);
  } finally {
    restore();
    await serverListener.close();
    await rm(tmp, { recursive: true, force: true });
  }
});

test('readStackInfoSnapshot refreshes stale runtime daemonPid from daemon.state.json', async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-info-daemon-sync-'));
  const storageDir = join(tmp, 'storage');
  const stackName = 'dev-auth';
  const baseDir = join(storageDir, stackName);
  const cliServerDir = join(baseDir, 'cli', 'servers', 'stack_dev-auth__id_default');
  const envPath = join(baseDir, 'env');
  const daemonControlServer = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/ping' && req.headers['x-happier-daemon-token'] === 'state-token') {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.statusCode = 401;
    res.end();
  });
  await new Promise((resolve) => daemonControlServer.listen(0, '127.0.0.1', resolve));

  await mkdir(cliServerDir, { recursive: true });
  await writeFile(envPath, 'HAPPIER_STACK_SERVER_PORT=3009\n', 'utf-8');
  const daemonProcess = spawnDetachedInlineNodeTestProcess('setInterval(() => {}, 1000)', {
    env: {
      ...process.env,
      HAPPIER_STACK_STACK: stackName,
      HAPPIER_STACK_ENV_FILE: envPath,
      HAPPIER_STACK_PROCESS_KIND: 'daemon',
    },
  });
  t.after(() => {
    try {
      process.kill(-daemonProcess.pid, 'SIGTERM');
    } catch {
      // ignore
    }
  });
  await waitForProcessAlive(daemonProcess.pid);
  await writeFile(
    join(baseDir, 'stack.runtime.json'),
    JSON.stringify({
      version: 1,
      stackName,
      ownerPid: 999_999_999,
      processes: { daemonPid: 111 },
      ports: { server: 3009 },
    }) + '\n',
    'utf-8'
  );
  await writeFile(
    join(cliServerDir, 'daemon.state.json'),
    JSON.stringify({
      pid: daemonProcess.pid,
      httpPort: daemonControlServer.address().port,
      controlToken: 'state-token',
      startedAt: Date.now(),
      startedWithCliVersion: 'test',
    }) + '\n',
    'utf-8',
  );

  const restore = withPatchedProcessEnv(t, { HAPPIER_STACK_STORAGE_DIR: storageDir });
  try {
    const out = await readStackInfoSnapshot({ rootDir: process.cwd(), stackName });
    assert.equal(out.runtime.processes?.daemonPid, daemonProcess.pid);
  } finally {
    restore();
    await new Promise((resolve) => daemonControlServer.close(resolve));
    await rm(tmp, { recursive: true, force: true });
  }
});

test('readStackInfoSnapshot reports runtime daemonPids without treating them as ping-confirmed running', async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-info-daemon-pid-set-'));
  const storageDir = join(tmp, 'storage');
  const stackName = 'dev-auth';
  const baseDir = join(storageDir, stackName);
  const envPath = join(baseDir, 'env');
  await mkdir(baseDir, { recursive: true });
  await writeFile(envPath, 'HAPPIER_STACK_DAEMON=1\n', 'utf-8');
  const daemonProcess = spawnDetachedInlineNodeTestProcess('setInterval(() => {}, 1000)', {
    env: {
      ...process.env,
      HAPPIER_STACK_STACK: stackName,
      HAPPIER_STACK_ENV_FILE: envPath,
      HAPPIER_STACK_PROCESS_KIND: 'daemon',
    },
  });
  t.after(() => {
    try {
      process.kill(-daemonProcess.pid, 'SIGTERM');
    } catch {
      // ignore
    }
  });
  await waitForProcessAlive(daemonProcess.pid);
  await writeFile(
    join(baseDir, 'stack.runtime.json'),
    JSON.stringify({
      version: 1,
      stackName,
      ownerPid: 999_999_999,
      processes: { daemonPid: null, daemonPids: [daemonProcess.pid] },
      ports: {},
    }) + '\n',
    'utf-8'
  );

  const restore = withPatchedProcessEnv(t, { HAPPIER_STACK_STORAGE_DIR: storageDir });
  try {
    const out = await readStackInfoSnapshot({ rootDir: process.cwd(), stackName });
    assert.equal(out.runtime.components.daemon.running, false);
    assert.equal(out.runtime.components.daemon.pid, daemonProcess.pid);
    assert.equal(out.runtime.components.daemon.source, 'runtime_pid');
    assert.equal(out.runtime.health.issues.includes('daemon_down'), true);
  } finally {
    restore();
    await rm(tmp, { recursive: true, force: true });
  }
});

test('readStackInfoSnapshot marks daemon as down when stack runtime is otherwise running and daemon is expected', async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-info-daemon-down-'));
  const storageDir = join(tmp, 'storage');
  const stackName = 'dev-auth';
  const baseDir = join(storageDir, stackName);

  await mkdir(baseDir, { recursive: true });

  const serverListener = await withListeningServer();
  await writeFile(join(baseDir, 'env'), `HAPPIER_STACK_SERVER_PORT=${serverListener.port}\n`, 'utf-8');
  await writeFile(
    join(baseDir, 'stack.runtime.json'),
    JSON.stringify({
      version: 1,
      stackName,
      ownerPid: 999_999_999,
      processes: { serverPid: process.pid },
      ports: { server: serverListener.port },
    }) + '\n',
    'utf-8'
  );

  const restore = withPatchedProcessEnv(t, { HAPPIER_STACK_STORAGE_DIR: storageDir });
  try {
    const out = await readStackInfoSnapshot({ rootDir: process.cwd(), stackName });
    assert.equal(out.runtime.running, true);
    assert.equal(out.runtime.components.server.running, true);
    assert.equal(out.runtime.components.daemon.running, false);
    assert.equal(out.runtime.health.status, 'degraded');
    assert.deepEqual(out.runtime.health.issues, ['daemon_down']);
  } finally {
    restore();
    await serverListener.close();
    await rm(tmp, { recursive: true, force: true });
  }
});
