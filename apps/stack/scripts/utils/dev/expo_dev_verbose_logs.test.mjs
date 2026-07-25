import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, chmod, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { ensureDevExpoServer } from './expo_dev.mjs';
import { buildStackFixtureEnv } from '../../testkit/core/env_scope.mjs';

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGTERM');
  await Promise.race([exited, delay(3000)]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
    await exited;
  }
}

test('ensureDevExpoServer does not drop Expo output when spawnOptions stdio is ignore', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-expo-verbose-'));
  const children = [];
  try {
    const uiDir = join(tmp, 'ui');
    await mkdir(join(uiDir, 'node_modules', '.bin'), { recursive: true });
    await mkdir(join(uiDir, 'node_modules'), { recursive: true });
    await writeFile(join(uiDir, 'package.json'), JSON.stringify({ name: 'fake-ui', private: true }) + '\n', 'utf-8');

    const expoBin = join(uiDir, 'node_modules', '.bin', 'expo');
    await writeFile(
      expoBin,
      [
        '#!/usr/bin/env node',
        "const http = require('node:http');",
        "console.log('hello-from-fake-expo');",
        "http.createServer((req, res) => res.end(req.url === '/status' ? 'packager-status:running' : 'ok')).listen(Number(process.env.RCT_METRO_PORT), '127.0.0.1');",
      ].join('\n') + '\n',
      'utf-8'
    );
    await chmod(expoBin, 0o755);

    const teeFile = join(tmp, 'expo.log');
    await ensureDevExpoServer({
      startUi: true,
      startMobile: false,
      uiDir,
      autostart: { baseDir: tmp },
      baseEnv: buildStackFixtureEnv({
        baseEnv: process.env,
        stripStackEnv: true,
        extraEnv: {
          HAPPIER_STACK_VERBOSE: '1',
          HAPPIER_STACK_SKIP_REFRESH_DEPS: '1',
        },
      }),
      apiServerUrl: 'http://127.0.0.1:1',
      restart: true,
      stackMode: false,
      runtimeStatePath: null,
      stackName: 'test',
      envPath: '',
      children,
      spawnOptions: {
        stdio: ['ignore', 'ignore', 'ignore'],
        silent: true,
        teeFile,
        teeLabel: 'expo',
      },
      quiet: true,
    });

    // CI and local stacks can be noisy/slow (Corepack/Yarn probes, filesystem contention),
    // so wait deterministically for the tee output instead of using a fixed delay.
    const deadlineMs = Date.now() + 3000;
    let log = '';
    while (Date.now() < deadlineMs) {
      log = await readFile(teeFile, 'utf-8').catch(() => '');
      if (/hello-from-fake-expo/.test(log)) break;
      await delay(100);
    }
    assert.match(log, /hello-from-fake-expo/);
  } finally {
    await Promise.all(children.map(stopChild));
    await rm(tmp, { recursive: true, force: true });
  }
});
