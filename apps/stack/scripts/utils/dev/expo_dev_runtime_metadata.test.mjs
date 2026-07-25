import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, rm, readFile, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';

import { ensureDevExpoServer } from './expo_dev.mjs';
import { getExpoStatePaths, writePidState } from '../expo/expo.mjs';
import { readStackRuntimeStateFile, recordStackRuntimeUpdate } from '../stack/runtime_state.mjs';
import { buildStackFixtureEnv } from '../../testkit/core/env_scope.mjs';

function listen(server) {
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
}

function close(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

function killProcessTreeByPid(pid) {
  const n = Number(pid);
  if (!Number.isFinite(n) || n <= 1) return;
  try {
    process.kill(-n, 'SIGKILL');
  } catch {
    try {
      process.kill(n, 'SIGKILL');
    } catch {
      // ignore
    }
  }
}

test('ensureDevExpoServer in stack mode starts managed Expo instead of adopting port-fallback state', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-expo-runtime-meta-'));
  const uiDir = join(tmp, 'ui');
  const projectDir = uiDir;
  const runtimeStatePath = join(tmp, 'stack.runtime.json');
  const envPath = join(tmp, 'stack.env');
  const children = [];
  const metro = http.createServer((req, res) => {
    if (req.url === '/status') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('packager-status:running');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
  });

  try {
    await mkdir(join(uiDir, 'node_modules', '.bin'), { recursive: true });
    await mkdir(join(uiDir, 'node_modules'), { recursive: true });
    await writeFile(join(uiDir, 'package.json'), JSON.stringify({ name: 'fake-ui', private: true }) + '\n', 'utf-8');
    const expoBin = join(uiDir, 'node_modules', '.bin', 'expo');
    await writeFile(
      expoBin,
      [
        '#!/usr/bin/env node',
        "const http = require('node:http');",
        "http.createServer((req, res) => res.end(req.url === '/status' ? 'packager-status:running' : 'ok')).listen(Number(process.env.RCT_METRO_PORT));",
      ].join('\n') + '\n',
      'utf-8'
    );
    await chmod(expoBin, 0o755);

    await listen(metro);
    const addr = metro.address();
    assert.ok(addr && typeof addr === 'object' && typeof addr.port === 'number');
    const metroPort = addr.port;

    const paths = getExpoStatePaths({
      baseDir: tmp,
      kind: 'expo-dev',
      projectDir,
      stateFileName: 'expo.state.json',
    });
    await writePidState(paths.statePath, {
      pid: 999999, // intentionally stale
      port: metroPort,
      uiDir,
      projectDir,
      startedAt: new Date().toISOString(),
      webEnabled: true,
      devClientEnabled: false,
      host: 'lan',
      apiServerUrl: 'http://127.0.0.1:3009',
    });

    const result = await ensureDevExpoServer({
      startUi: true,
      startMobile: false,
      uiDir,
      expoProjectDir: projectDir,
      autostart: { baseDir: tmp },
      baseEnv: buildStackFixtureEnv({
        baseEnv: process.env,
        stripStackEnv: true,
        extraEnv: {
          HAPPIER_STACK_SKIP_REFRESH_DEPS: '1',
          HAPPIER_STACK_EXPO_DEV_PORT_STRATEGY: 'stable',
          HAPPIER_STACK_EXPO_DEV_PORT_BASE: '40000',
          HAPPIER_STACK_EXPO_DEV_PORT_RANGE: '10000',
        },
      }),
      apiServerUrl: 'http://127.0.0.1:3009',
      restart: false,
      stackMode: true,
      runtimeStatePath,
      stackName: 'qa-agent-4',
      envPath,
      children,
      quiet: true,
    });

    assert.equal(result.ok, true);
    assert.equal(result.skipped, false);
    assert.equal(Number.isFinite(Number(result.pid)) && Number(result.pid) > 1, true);
    assert.notEqual(result.port, metroPort);

    const runtime = await readStackRuntimeStateFile(runtimeStatePath);
    assert.ok(runtime && typeof runtime === 'object');
    assert.equal(Number.isFinite(Number(runtime?.processes?.expoPid)) && Number(runtime?.processes?.expoPid) > 1, true);
    assert.equal(runtime?.expo?.webPort, result.port);
    assert.notEqual(runtime?.expo?.webPort, metroPort);

    const runtimeBeforeSupersede = runtime;
    await writeFile(
      envPath,
      (await readFile(envPath, 'utf-8')).replace(
        /^HAPPIER_STACK_EXPO_DEV_PORT=.*$/m,
        'HAPPIER_STACK_EXPO_DEV_PORT=49998',
      ),
      'utf-8',
    );
    const envBeforeSupersede = await readFile(envPath, 'utf-8');
    await assert.rejects(
      () => ensureDevExpoServer({
        startUi: true,
        startMobile: false,
        uiDir,
        expoProjectDir: projectDir,
        autostart: { baseDir: tmp },
        baseEnv: buildStackFixtureEnv({
          baseEnv: process.env,
          stripStackEnv: true,
          extraEnv: {
            HAPPIER_STACK_SKIP_REFRESH_DEPS: '1',
            HAPPIER_STACK_EXPO_DEV_PORT_STRATEGY: 'stable',
            HAPPIER_STACK_EXPO_DEV_PORT_BASE: '40000',
            HAPPIER_STACK_EXPO_DEV_PORT_RANGE: '10000',
          },
        }),
        apiServerUrl: 'http://127.0.0.1:3009',
        restart: true,
        stackMode: true,
        runtimeStatePath,
        stackName: 'qa-agent-4',
        envPath,
        children,
        quiet: true,
        stopTailscaleProcessTree: async () => {
          const cleanupError = new Error('injected Tailscale cleanup failure');
          cleanupError.code = 'EEXPOCLEANUP';
          throw cleanupError;
        },
        publicationBarrier: async ({ phase, certificate }) => {
          if (phase !== 'runtime') return;
          await recordStackRuntimeUpdate(runtimeStatePath, { processes: { serverPid: 777777 } });
          const currentEnv = await readFile(envPath, 'utf-8');
          await writeFile(envPath, `${currentEnv}CONCURRENT_KEY=preserved\n`, 'utf-8');
          certificate.currentProc.kill('SIGKILL');
          await once(certificate.currentProc, 'exit');
        },
      }),
      (error) =>
        error instanceof AggregateError
        && error?.code === 'EEXPOREADINESSSTALE'
        && error.errors.some((nested) => nested?.code === 'EEXPOCLEANUP'),
    );
    const runtimeAfterSupersede = await readStackRuntimeStateFile(runtimeStatePath);
    assert.deepEqual(runtimeAfterSupersede?.expo, runtimeBeforeSupersede?.expo);
    assert.equal(runtimeAfterSupersede?.processes?.expoPid, runtimeBeforeSupersede?.processes?.expoPid);
    assert.equal(runtimeAfterSupersede?.processes?.serverPid, 777777);
    const envAfterSupersede = await readFile(envPath, 'utf-8');
    assert.match(envAfterSupersede, /CONCURRENT_KEY=preserved/);
    assert.match(envBeforeSupersede, /HAPPIER_STACK_EXPO_DEV_PORT=49998/);
    assert.match(envAfterSupersede, /HAPPIER_STACK_EXPO_DEV_PORT=49998/);
  } finally {
    for (const child of children) {
      killProcessTreeByPid(child?.pid);
    }
    await close(metro).catch(() => {});
    await rm(tmp, { recursive: true, force: true });
  }
});

test('failed non-pinning publication does not roll back an equal-value env successor', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-expo-env-non-pinning-'));
  const uiDir = join(tmp, 'ui');
  const envPath = join(tmp, 'stack.env');
  const children = [];
  let portServer = null;
  try {
    await mkdir(join(uiDir, 'node_modules', '.bin'), { recursive: true });
    await writeFile(join(uiDir, 'package.json'), JSON.stringify({ name: 'fake-ui', private: true }) + '\n', 'utf-8');
    const expoBin = join(uiDir, 'node_modules', '.bin', 'expo');
    await writeFile(expoBin, [
      '#!/usr/bin/env node',
      "const http = require('node:http');",
      "http.createServer((req, res) => res.end(req.url === '/status' ? 'packager-status:running' : 'ok')).listen(Number(process.env.RCT_METRO_PORT));",
    ].join('\n') + '\n', 'utf-8');
    await chmod(expoBin, 0o755);

    portServer = http.createServer();
    await listen(portServer);
    const address = portServer.address();
    assert.ok(address && typeof address === 'object');
    const selectedPort = address.port;
    await close(portServer);
    portServer = null;
    await writeFile(envPath, 'ORIGINAL=1\n', 'utf-8');
    const successorEnv = `HAPPIER_STACK_EXPO_DEV_PORT=${selectedPort}\nSUCCESSOR=same-value\n`;

    await assert.rejects(() => ensureDevExpoServer({
      startUi: true,
      startMobile: false,
      uiDir,
      expoProjectDir: uiDir,
      autostart: { baseDir: tmp },
      baseEnv: buildStackFixtureEnv({
        baseEnv: process.env,
        stripStackEnv: true,
        extraEnv: {
          HAPPIER_STACK_SKIP_REFRESH_DEPS: '1',
          HAPPIER_STACK_EXPO_DEV_PORT: String(selectedPort),
        },
      }),
      apiServerUrl: 'http://127.0.0.1:3009',
      stackMode: true,
      runtimeStatePath: null,
      stackName: 'qa-env-non-pinning',
      envPath,
      children,
      quiet: true,
      publicationBarrier: async ({ phase, certificate }) => {
        if (phase !== 'runtime') return;
        await writeFile(envPath, successorEnv, 'utf-8');
        certificate.currentProc.kill('SIGKILL');
        await once(certificate.currentProc, 'exit');
      },
    }), (error) => error?.code === 'EEXPOREADINESSSTALE');
    assert.equal(await readFile(envPath, 'utf-8'), successorEnv);
  } finally {
    for (const child of children) killProcessTreeByPid(child?.pid);
    await close(portServer).catch(() => {});
    await rm(tmp, { recursive: true, force: true });
  }
});
