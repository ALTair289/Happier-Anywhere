import test from 'node:test';
import assert from 'node:assert/strict';

import { buildStackHarnessEnv, writeFakeBin } from '../../testkit/core/fake_bin_harness.mjs';
import { withPatchedProcessEnv } from '../../testkit/core/env_scope.mjs';
import { pickLanIpv4 } from '../net/lan_ip.mjs';

function killChildren(children) {
  for (const child of children) {
    if (child?.pid) {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        try {
          process.kill(child.pid, 'SIGKILL');
        } catch {
          // ignore
        }
      }
    }
  }
}

async function allocateTestPort() {
  const net = await import('node:net');
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      server.close(() => {
        if (!addr || typeof addr === 'string') {
          reject(new Error('failed to allocate test port'));
        } else {
          resolve(Number(addr.port));
        }
      });
    });
  });
}

function buildListenerDiscoveryFixtureEnv(t, { root, extraEnv }) {
  const { binDir } = writeFakeBin({
    root,
    name: 'lsof',
    content: `#!/bin/sh
port=''
for arg in "$@"; do case "$arg" in -iTCP:*) port="\${arg#-iTCP:}" ;; esac; done
owner_file="\${TEST_EXPO_LISTENER_DIR:-}/listener-$port"
if [ -f "$owner_file" ]; then
  /bin/cat "$owner_file"
  exit 0
fi
exit 1
`,
  });
  const env = buildStackHarnessEnv({
    baseEnv: process.env,
    binDirs: [binDir],
    extraEnv: {
      TEST_EXPO_LISTENER_DIR: root,
      HAPPIER_STACK_SKIP_REFRESH_DEPS: '1',
      HAPPIER_STACK_EXPO_METRO_WAIT_TIMEOUT_MS: '3000',
      HAPPIER_STACK_EXPO_METRO_WAIT_INTERVAL_MS: '25',
      ...extraEnv,
    },
  });
  withPatchedProcessEnv(t, { PATH: env.PATH });
  return env;
}

function installProcessIdentityFixture(t, { root, pid, expoHomeDir }) {
  const { binDir } = writeFakeBin({
    root,
    name: 'ps',
    content: `#!/bin/sh
if [ "\${1:-}" = "eww" ] && [ "\${2:-}" = "-p" ] && [ "\${3:-}" = "\${TEST_EXPO_IDENTITY_PID:-}" ]; then
  printf 'PID COMMAND\\n%s node __UNSAFE_EXPO_HOME_DIRECTORY=%s\\n' "\${TEST_EXPO_IDENTITY_PID}" "\${TEST_EXPO_IDENTITY_HOME}"
  exit 0
fi
exec /bin/ps "$@"
`,
  });
  const env = buildStackHarnessEnv({
    baseEnv: process.env,
    binDirs: [binDir],
    extraEnv: {
      TEST_EXPO_IDENTITY_PID: String(pid),
      TEST_EXPO_IDENTITY_HOME: expoHomeDir,
    },
  });
  withPatchedProcessEnv(t, {
    PATH: env.PATH,
    TEST_EXPO_IDENTITY_PID: String(pid),
    TEST_EXPO_IDENTITY_HOME: expoHomeDir,
  });
}

function createLineSignal(prefix, { timeoutMs = 30_000 } = {}) {
  let settled = false;
  let timer = null;
  let finish = () => {};
  const promise = new Promise((resolve, reject) => {
    finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };
    timer = setTimeout(() => finish(new Error(`Timed out waiting for process line: ${prefix}`)), timeoutMs);
    timer.unref?.();
  });
  return {
    promise,
    observe: (event) => {
      const line = String(event?.line ?? '');
      if (line.startsWith(prefix)) finish(null, line.slice(prefix.length));
    },
    cancel: () => finish(null, ''),
  };
}

test('ensureDevExpoServer exports the Tailscale proxy URL before spawning Expo', async (t) => {
  const { mkdtemp, mkdir, rm, writeFile, chmod } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { ensureDevExpoServer } = await import('./expo_dev.mjs');

  const tmp = await mkdtemp(join(tmpdir(), 'hstack-expo-ts-proxy-'));
  const children = [];

  try {
    const metroPort = await allocateTestPort();
    const uiDir = join(tmp, 'ui');
    const expoBin = join(uiDir, 'node_modules', '.bin', 'expo');
    const tailscaleBin = join(tmp, 'tailscale');
    const bindableForwarderIp = pickLanIpv4();
    assert.ok(bindableForwarderIp, 'expected a bindable non-loopback fixture address');
    await mkdir(join(uiDir, 'node_modules', '.bin'), { recursive: true });
    await writeFile(join(uiDir, 'package.json'), JSON.stringify({ name: 'fake-ui', private: true }) + '\n', 'utf-8');
    await writeFile(
      expoBin,
      `#!${process.execPath}
console.log('test-expo-env:' + JSON.stringify({
  EXPO_PACKAGER_PROXY_URL: process.env.EXPO_PACKAGER_PROXY_URL ?? '',
  EXPO_PUBLIC_HAPPIER_SERVER_URL: process.env.EXPO_PUBLIC_HAPPIER_SERVER_URL ?? ''
}));
const http = require('node:http');
const port = Number(process.env.RCT_METRO_PORT);
http.createServer((req, res) => res.end(req.url === '/status' ? 'packager-status:running' : 'ok'))
  .listen(port, '127.0.0.1', () => require('node:fs').writeFileSync(process.env.TEST_EXPO_LISTENER_DIR + '/listener-' + port, String(process.pid)));
`,
      'utf-8'
    );
    await writeFile(
      tailscaleBin,
      `#!/bin/sh\nif [ "\${1:-}" = "ip" ] && [ "\${2:-}" = "-4" ]; then\n  printf '${bindableForwarderIp}\\n'\n  exit 0\nfi\nexit 1\n`,
      'utf-8'
    );
    if (process.platform !== 'win32') {
      await chmod(expoBin, 0o755);
      await chmod(tailscaleBin, 0o755);
    }

    const expoEnvSignal = createLineSignal('test-expo-env:');
    let result;
    try {
      result = await ensureDevExpoServer({
        startUi: false,
        startMobile: true,
        uiDir,
        autostart: { baseDir: tmp },
        baseEnv: buildListenerDiscoveryFixtureEnv(t, {
          root: tmp,
          extraEnv: {
            HAPPIER_TAILSCALE_BIN: tailscaleBin,
            HAPPIER_STACK_EXPO_DEV_PORT: String(metroPort),
            HAPPIER_STACK_EXPO_DEV_PORT_STRATEGY: 'stable',
            HAPPIER_STACK_EXPO_HOST: 'localhost',
          },
        }),
        apiServerUrl: 'http://localhost:3005',
        restart: false,
        stackMode: true,
        runtimeStatePath: null,
        stackName: 'qa-agent-tailscale',
        envPath: join(tmp, 'stack.env'),
        children,
        spawnOptions: { onLine: expoEnvSignal.observe },
        expoTailscale: true,
        quiet: true,
      });

      assert.equal(result.ok, true);
      const envSnapshotRaw = await expoEnvSignal.promise;
      const envSnapshot = JSON.parse(envSnapshotRaw);
      assert.equal(envSnapshot.EXPO_PACKAGER_PROXY_URL, `http://${bindableForwarderIp}:${metroPort}`);
      assert.equal(envSnapshot.EXPO_PUBLIC_HAPPIER_SERVER_URL, `http://${bindableForwarderIp}:3005`);
    } finally {
      expoEnvSignal.cancel();
    }
  } finally {
    killChildren(children);
    await rm(tmp, { recursive: true, force: true });
  }
});

test('ensureDevExpoServer keeps existing Expo when requested Tailscale is unavailable', async (t) => {
  const { mkdtemp, mkdir, rm, writeFile, chmod, access } = await import('node:fs/promises');
  const { constants } = await import('node:fs');
  const { spawn } = await import('node:child_process');
  const { once } = await import('node:events');
  const { tmpdir } = await import('node:os');
  const { dirname, join } = await import('node:path');
  const { ensureDevExpoServer } = await import('./expo_dev.mjs');
  const { getExpoStatePaths } = await import('../expo/expo.mjs');

  const tmp = await mkdtemp(join(tmpdir(), 'hstack-expo-ts-unavailable-'));
  const children = [];

  try {
    const metroPort = await allocateTestPort();
    const uiDir = join(tmp, 'ui');
    const expoBin = join(uiDir, 'node_modules', '.bin', 'expo');
    const existingExpoScript = join(uiDir, 'existing-expo.mjs');
    const tailscaleBin = join(tmp, 'tailscale');
    const spawnOut = join(tmp, 'expo-spawned');
    await mkdir(join(uiDir, 'node_modules', '.bin'), { recursive: true });
    await writeFile(join(uiDir, 'package.json'), JSON.stringify({ name: 'fake-ui', private: true }) + '\n', 'utf-8');
    await writeFile(
      expoBin,
      `#!${process.execPath}
const { writeFileSync } = require('node:fs');
writeFileSync(process.env.TEST_EXPO_SPAWN_OUT, 'spawned');
setInterval(() => {}, 1000);
`,
      'utf-8'
    );
    await writeFile(existingExpoScript, "process.stdout.write('ready\\n');\nsetInterval(() => {}, 1000);\n", 'utf-8');
    await writeFile(
      tailscaleBin,
      '#!/bin/sh\nexit 1\n',
      'utf-8'
    );
    if (process.platform !== 'win32') {
      await chmod(expoBin, 0o755);
      await chmod(tailscaleBin, 0o755);
    }

    const paths = getExpoStatePaths({
      baseDir: tmp,
      kind: 'expo-dev',
      projectDir: uiDir,
      stateFileName: 'expo.state.json',
    });
    const existingExpo = spawn(process.execPath, [existingExpoScript], {
      stdio: ['ignore', 'pipe', 'ignore'],
      detached: process.platform !== 'win32',
      env: {
        ...process.env,
        __UNSAFE_EXPO_HOME_DIRECTORY: paths.expoHomeDir,
      },
    });
    children.push(existingExpo);
    const existingExpoReady = once(existingExpo.stdout, 'data');
    await once(existingExpo, 'spawn');
    await existingExpoReady;
    installProcessIdentityFixture(t, {
      root: tmp,
      pid: existingExpo.pid,
      expoHomeDir: paths.expoHomeDir,
    });

    await mkdir(dirname(paths.statePath), { recursive: true });
    await writeFile(
      paths.statePath,
      JSON.stringify(
        {
          pid: existingExpo.pid,
          port: metroPort,
          uiDir,
          projectDir: uiDir,
          startedAt: new Date().toISOString(),
          webEnabled: false,
          devClientEnabled: true,
          host: 'localhost',
          apiServerUrl: 'http://192.0.2.1:3005',
          scheme: 'happy',
          tailscaleEnabled: false,
        },
        null,
        2
      ) + '\n',
      'utf-8'
    );

    const result = await ensureDevExpoServer({
      startUi: false,
      startMobile: true,
      uiDir,
      autostart: { baseDir: tmp },
      baseEnv: buildListenerDiscoveryFixtureEnv(t, {
        root: tmp,
        extraEnv: {
          HAPPIER_TAILSCALE_BIN: tailscaleBin,
          HAPPIER_STACK_LAN_IP: '192.0.2.1',
          HAPPIER_STACK_EXPO_DEV_PORT: String(metroPort),
          HAPPIER_STACK_EXPO_DEV_PORT_STRATEGY: 'stable',
          HAPPIER_STACK_EXPO_HOST: 'localhost',
          TEST_EXPO_SPAWN_OUT: spawnOut,
        },
      }),
      apiServerUrl: 'http://localhost:3005',
      restart: false,
      stackMode: true,
      runtimeStatePath: null,
      stackName: 'qa-agent-tailscale-unavailable',
      envPath: join(tmp, 'stack.env'),
      children,
      expoTailscale: true,
      quiet: true,
    });

    assert.equal(result.ok, true);
    assert.equal(result.skipped, true);
    assert.equal(result.reason, 'already_running');
    await assert.rejects(() => access(spawnOut, constants.F_OK));
  } finally {
    killChildren(children);
    await rm(tmp, { recursive: true, force: true });
  }
});

test('ensureDevExpoServer records Tailscale disabled when the forwarder is unavailable', async (t) => {
  const { mkdtemp, mkdir, rm, writeFile, chmod, readFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { ensureDevExpoServer } = await import('./expo_dev.mjs');
  const { getExpoStatePaths } = await import('../expo/expo.mjs');

  const tmp = await mkdtemp(join(tmpdir(), 'hstack-expo-ts-state-'));
  const children = [];

  try {
    const metroPort = await allocateTestPort();
    const uiDir = join(tmp, 'ui');
    const expoBin = join(uiDir, 'node_modules', '.bin', 'expo');
    const tailscaleBin = join(tmp, 'tailscale');
    await mkdir(join(uiDir, 'node_modules', '.bin'), { recursive: true });
    await writeFile(join(uiDir, 'package.json'), JSON.stringify({ name: 'fake-ui', private: true }) + '\n', 'utf-8');
    await writeFile(
      expoBin,
      `#!${process.execPath}
const http = require('node:http');
const port = Number(process.env.RCT_METRO_PORT);
http.createServer((req, res) => res.end(req.url === '/status' ? 'packager-status:running' : 'ok'))
  .listen(port, '127.0.0.1', () => require('node:fs').writeFileSync(process.env.TEST_EXPO_LISTENER_DIR + '/listener-' + port, String(process.pid)));
`,
      'utf-8'
    );
    await writeFile(
      tailscaleBin,
      '#!/bin/sh\nexit 1\n',
      'utf-8'
    );
    if (process.platform !== 'win32') {
      await chmod(expoBin, 0o755);
      await chmod(tailscaleBin, 0o755);
    }

    const result = await ensureDevExpoServer({
      startUi: false,
      startMobile: true,
      uiDir,
      autostart: { baseDir: tmp },
      baseEnv: buildListenerDiscoveryFixtureEnv(t, {
        root: tmp,
        extraEnv: {
          HAPPIER_TAILSCALE_BIN: tailscaleBin,
          HAPPIER_STACK_EXPO_DEV_PORT: String(metroPort),
          HAPPIER_STACK_EXPO_DEV_PORT_STRATEGY: 'stable',
          HAPPIER_STACK_EXPO_HOST: 'localhost',
        },
      }),
      apiServerUrl: 'http://localhost:3005',
      restart: false,
      stackMode: true,
      runtimeStatePath: null,
      stackName: 'qa-agent-tailscale-state',
      envPath: join(tmp, 'stack.env'),
      children,
      expoTailscale: true,
      quiet: true,
    });

    assert.equal(result.ok, true);
    assert.equal(result.skipped, false);
    assert.equal(result.tailscale?.ok, false);

    const paths = getExpoStatePaths({
      baseDir: tmp,
      kind: 'expo-dev',
      projectDir: uiDir,
      stateFileName: 'expo.state.json',
    });
    const state = JSON.parse(await readFile(paths.statePath, 'utf-8'));
    assert.equal(state.tailscaleEnabled, false);
    assert.equal(state.tailscaleForwarderPid, null);
    assert.equal(state.tailscaleIp, null);
  } finally {
    killChildren(children);
    await rm(tmp, { recursive: true, force: true });
  }
});
