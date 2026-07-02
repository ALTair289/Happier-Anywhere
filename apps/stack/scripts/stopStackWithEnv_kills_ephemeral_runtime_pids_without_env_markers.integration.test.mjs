import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { stopStackWithEnv } from './utils/stack/stop.mjs';
import { isAlive, spawnOwnedSleep, waitForProcessAlive, waitForProcessExit } from './testkit/stack_stop_sweeps_testkit.mjs';

test('stopStackWithEnv kills runtime-tracked pids for ephemeral stacks even when env/home markers are missing', async (t) => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptsDir);

  const tmp = await mkdtemp(join(tmpdir(), 'hstack-stop-ephemeral-runtime-'));
  const storageDir = join(tmp, 'storage');
  await mkdir(storageDir, { recursive: true });

  const stackName = 'repo-dev-test';
  const baseDir = join(storageDir, stackName);
  const envPath = join(baseDir, 'env');
  await mkdir(baseDir, { recursive: true });

  // Minimal env file to make the stack "exist".
  const repoDir = dirname(rootDir);
  await writeFile(
    envPath,
    [
      `HAPPIER_STACK_STACK=${stackName}`,
      `HAPPIER_STACK_SERVER_COMPONENT=happier-server-light`,
      `HAPPIER_STACK_CLI_HOME_DIR=${join(baseDir, 'cli')}`,
      `HAPPIER_STACK_REPO_DIR=${repoDir}`,
      '',
    ].join('\n'),
    'utf-8'
  );

  /** @type {ReturnType<typeof spawnOwnedSleep> | null} */
  let child = null;
  /** @type {ReturnType<typeof spawnOwnedSleep> | null} */
  let drainingChild = null;
  t.after(async () => {
    for (const pid of [child?.pid, drainingChild?.pid]) {
      if (pid && isAlive(pid)) {
        try {
          process.kill(-pid, 'SIGKILL');
        } catch {
          // ignore
        }
      }
    }
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  });

  // Simulate older stackless infra: stack name set, but no env/home markers.
  child = spawnOwnedSleep({
    env: {
      ...process.env,
      HAPPIER_HOME_DIR: undefined,
      HAPPIER_STACK_CLI_HOME_DIR: undefined,
      HAPPIER_STACK_ENV_FILE: undefined,
      HAPPIER_STACK_STACK: stackName,
      HAPPIER_STACK_PROCESS_KIND: 'infra',
    },
  });
  drainingChild = spawnOwnedSleep({
    env: {
      ...process.env,
      HAPPIER_HOME_DIR: undefined,
      HAPPIER_STACK_CLI_HOME_DIR: undefined,
      HAPPIER_STACK_ENV_FILE: undefined,
      HAPPIER_STACK_STACK: stackName,
      HAPPIER_STACK_PROCESS_KIND: 'infra',
    },
  });
  assert.ok(Number(child.pid) > 1, 'expected child pid');
  assert.ok(Number(drainingChild.pid) > 1, 'expected draining child pid');
  await waitForProcessAlive({ pid: child.pid, timeoutMs: 2_000, intervalMs: 25, label: 'ephemeral runtime child (pre-stop)' });
  await waitForProcessAlive({ pid: drainingChild.pid, timeoutMs: 2_000, intervalMs: 25, label: 'ephemeral draining runtime child (pre-stop)' });
  assert.ok(isAlive(child.pid), 'expected child to be alive');
  assert.ok(isAlive(drainingChild.pid), 'expected draining child to be alive');

  // Runtime state file records the pid under this stack, and marks it ephemeral.
  await writeFile(
    join(baseDir, 'stack.runtime.json'),
    JSON.stringify(
      {
        version: 1,
        stackName,
        script: 'dev.mjs',
        ephemeral: true,
        ownerPid: null,
        ports: {},
        processes: {
          serverPid: child.pid,
          serverWrapperPid: child.pid,
          serverBackendPid: child.pid,
          serverDrainingPid: drainingChild.pid,
          proxyPid: null,
        },
      },
      null,
      2
    ) + '\n',
    'utf-8'
  );

  await stopStackWithEnv({
    rootDir,
    stackName,
    baseDir,
    env: {
      ...process.env,
      HAPPIER_STACK_STORAGE_DIR: storageDir,
      HAPPIER_STACK_STACK: stackName,
      HAPPIER_STACK_ENV_FILE: envPath,
      HAPPIER_STACK_REPO_DIR: repoDir,
    },
    json: true,
    noDocker: true,
    aggressive: false,
    sweepOwned: false,
    autoSweep: false,
  });

  await waitForProcessExit({ pid: child.pid, timeoutMs: 20_000, intervalMs: 50, label: 'ephemeral runtime child (post-stop)' });
  await waitForProcessExit({ pid: drainingChild.pid, timeoutMs: 20_000, intervalMs: 50, label: 'ephemeral draining runtime child (post-stop)' });
  assert.ok(!isAlive(child.pid), `expected pid ${child.pid} to be killed by stopStackWithEnv fallback`);
  assert.ok(!isAlive(drainingChild.pid), `expected pid ${drainingChild.pid} to be killed by stopStackWithEnv fallback`);
});

test('stopStackWithEnv preserves runtime-tracked session pids after canonical ownership rejects them', async (t) => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptsDir);

  const tmp = await mkdtemp(join(tmpdir(), 'hstack-stop-ephemeral-session-'));
  const storageDir = join(tmp, 'storage');
  await mkdir(storageDir, { recursive: true });

  const stackName = 'repo-dev-session';
  const baseDir = join(storageDir, stackName);
  const envPath = join(baseDir, 'env');
  await mkdir(baseDir, { recursive: true });

  const repoDir = dirname(rootDir);
  await writeFile(
    envPath,
    [
      `HAPPIER_STACK_STACK=${stackName}`,
      `HAPPIER_STACK_SERVER_COMPONENT=happier-server-light`,
      `HAPPIER_STACK_CLI_HOME_DIR=${join(baseDir, 'cli')}`,
      `HAPPIER_STACK_REPO_DIR=${repoDir}`,
      '',
    ].join('\n'),
    'utf-8'
  );

  let child = null;
  t.after(async () => {
    if (child?.pid && isAlive(child.pid)) {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        // ignore cleanup races
      }
    }
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  });

  child = spawnOwnedSleep({
    env: {
      ...process.env,
      HAPPIER_HOME_DIR: undefined,
      HAPPIER_STACK_CLI_HOME_DIR: undefined,
      HAPPIER_STACK_ENV_FILE: undefined,
      HAPPIER_STACK_STACK: stackName,
      HAPPIER_STACK_PROCESS_KIND: 'session',
    },
  });
  assert.ok(Number(child.pid) > 1, 'expected child pid');
  await waitForProcessAlive({ pid: child.pid, timeoutMs: 2_000, intervalMs: 25, label: 'session runtime child (pre-stop)' });

  await writeFile(
    join(baseDir, 'stack.runtime.json'),
    JSON.stringify(
      {
        version: 1,
        stackName,
        script: 'dev.mjs',
        ephemeral: true,
        ownerPid: null,
        ports: {},
        processes: {
          serverPid: child.pid,
        },
      },
      null,
      2
    ) + '\n',
    'utf-8'
  );

  await stopStackWithEnv({
    rootDir,
    stackName,
    baseDir,
    env: {
      ...process.env,
      HAPPIER_STACK_STORAGE_DIR: storageDir,
      HAPPIER_STACK_STACK: stackName,
      HAPPIER_STACK_ENV_FILE: envPath,
      HAPPIER_STACK_REPO_DIR: repoDir,
    },
    json: true,
    noDocker: true,
    aggressive: false,
    sweepOwned: false,
    autoSweep: false,
  });

  assert.ok(isAlive(child.pid), `expected session pid ${child.pid} to survive stopStackWithEnv fallback`);
});

test('stopStackWithEnv preserves marker-light runtime pids without an infra/server signature', async (t) => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptsDir);

  const tmp = await mkdtemp(join(tmpdir(), 'hstack-stop-ephemeral-marker-light-'));
  const storageDir = join(tmp, 'storage');
  await mkdir(storageDir, { recursive: true });

  const stackName = 'repo-dev-marker-light';
  const baseDir = join(storageDir, stackName);
  const envPath = join(baseDir, 'env');
  await mkdir(baseDir, { recursive: true });

  const repoDir = dirname(rootDir);
  await writeFile(
    envPath,
    [
      `HAPPIER_STACK_STACK=${stackName}`,
      `HAPPIER_STACK_SERVER_COMPONENT=happier-server-light`,
      `HAPPIER_STACK_CLI_HOME_DIR=${join(baseDir, 'cli')}`,
      `HAPPIER_STACK_REPO_DIR=${repoDir}`,
      '',
    ].join('\n'),
    'utf-8'
  );

  let child = null;
  t.after(async () => {
    if (child?.pid && isAlive(child.pid)) {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        // ignore cleanup races
      }
    }
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  });

  child = spawnOwnedSleep({
    env: {
      ...process.env,
      HAPPIER_HOME_DIR: undefined,
      HAPPIER_STACK_CLI_HOME_DIR: undefined,
      HAPPIER_STACK_ENV_FILE: undefined,
      HAPPIER_STACK_STACK: stackName,
      HAPPIER_STACK_PROCESS_KIND: '',
    },
  });
  assert.ok(Number(child.pid) > 1, 'expected child pid');
  await waitForProcessAlive({ pid: child.pid, timeoutMs: 2_000, intervalMs: 25, label: 'marker-light runtime child (pre-stop)' });

  await writeFile(
    join(baseDir, 'stack.runtime.json'),
    JSON.stringify(
      {
        version: 1,
        stackName,
        script: 'dev.mjs',
        ephemeral: true,
        ownerPid: null,
        ports: {},
        processes: {
          serverPid: child.pid,
        },
      },
      null,
      2
    ) + '\n',
    'utf-8'
  );

  await stopStackWithEnv({
    rootDir,
    stackName,
    baseDir,
    env: {
      ...process.env,
      HAPPIER_STACK_STORAGE_DIR: storageDir,
      HAPPIER_STACK_STACK: stackName,
      HAPPIER_STACK_ENV_FILE: envPath,
      HAPPIER_STACK_REPO_DIR: repoDir,
    },
    json: true,
    noDocker: true,
    aggressive: false,
    sweepOwned: false,
    autoSweep: false,
  });

  assert.ok(isAlive(child.pid), `expected marker-light pid ${child.pid} to survive stopStackWithEnv fallback`);
});

test('stopStackWithEnv rejects stack-name prefix matches in ephemeral runtime fallback', async (t) => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptsDir);

  const tmp = await mkdtemp(join(tmpdir(), 'hstack-stop-ephemeral-prefix-'));
  const storageDir = join(tmp, 'storage');
  await mkdir(storageDir, { recursive: true });

  const stackName = 'repo-dev';
  const baseDir = join(storageDir, stackName);
  const envPath = join(baseDir, 'env');
  await mkdir(baseDir, { recursive: true });

  const repoDir = dirname(rootDir);
  await writeFile(
    envPath,
    [
      `HAPPIER_STACK_STACK=${stackName}`,
      `HAPPIER_STACK_SERVER_COMPONENT=happier-server-light`,
      `HAPPIER_STACK_CLI_HOME_DIR=${join(baseDir, 'cli')}`,
      `HAPPIER_STACK_REPO_DIR=${repoDir}`,
      '',
    ].join('\n'),
    'utf-8'
  );

  let child = null;
  t.after(async () => {
    if (child?.pid && isAlive(child.pid)) {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        // ignore cleanup races
      }
    }
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  });

  child = spawnOwnedSleep({
    env: {
      ...process.env,
      HAPPIER_HOME_DIR: undefined,
      HAPPIER_STACK_CLI_HOME_DIR: undefined,
      HAPPIER_STACK_ENV_FILE: undefined,
      HAPPIER_STACK_STACK: `${stackName}-other`,
      HAPPIER_STACK_PROCESS_KIND: 'infra',
    },
  });
  assert.ok(Number(child.pid) > 1, 'expected child pid');
  await waitForProcessAlive({ pid: child.pid, timeoutMs: 2_000, intervalMs: 25, label: 'prefix runtime child (pre-stop)' });

  await writeFile(
    join(baseDir, 'stack.runtime.json'),
    JSON.stringify(
      {
        version: 1,
        stackName,
        script: 'dev.mjs',
        ephemeral: true,
        ownerPid: null,
        ports: {},
        processes: {
          serverPid: child.pid,
        },
      },
      null,
      2
    ) + '\n',
    'utf-8'
  );

  await stopStackWithEnv({
    rootDir,
    stackName,
    baseDir,
    env: {
      ...process.env,
      HAPPIER_STACK_STORAGE_DIR: storageDir,
      HAPPIER_STACK_STACK: stackName,
      HAPPIER_STACK_ENV_FILE: envPath,
      HAPPIER_STACK_REPO_DIR: repoDir,
    },
    json: true,
    noDocker: true,
    aggressive: false,
    sweepOwned: false,
    autoSweep: false,
  });

  assert.ok(isAlive(child.pid), `expected prefix-collision pid ${child.pid} to survive stopStackWithEnv fallback`);
});
