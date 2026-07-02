import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { stopStackWithEnv } from './utils/stack/stop.mjs';
import { isAlive, spawnOwnedSleep, waitForProcessAlive, waitForProcessExit } from './testkit/stack_stop_sweeps_testkit.mjs';

test('stopStackWithEnv repo-local fallback sweeps legacy infra without stopping session processes', async (t) => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptsDir);

  const tmp = await mkdtemp(join(tmpdir(), 'hstack-stop-repo-sweep-'));
  const storageDir = join(tmp, 'storage');
  await mkdir(storageDir, { recursive: true });

  const stackName = 'repo-dev-test-sweep';
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

  /** @type {Array<ReturnType<typeof spawnOwnedSleep>>} */
  const children = [];
  t.after(async () => {
    for (const child of children) {
      const pid = child?.pid;
      if (!pid || !isAlive(pid)) continue;
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        // ignore
      }
    }
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  });

  // No runtime file (simulates a stale/orphan stackless run), and legacy infra omitted
  // HAPPIER_STACK_ENV_FILE / HAPPIER_STACK_PROCESS_KIND while still advertising stack+repo.
  const legacyInfra = spawnOwnedSleep({
    env: {
      ...process.env,
      HAPPIER_STACK_STACK: stackName,
      HAPPIER_STACK_REPO_DIR: repoDir,
      HAPPIER_STACK_PROCESS_KIND: undefined,
      npm_lifecycle_event: 'dev:light',
      npm_package_name: '@happier-dev/server',
    },
  });
  children.push(legacyInfra);
  assert.ok(Number(legacyInfra.pid) > 1, 'expected legacy infra pid');
  await waitForProcessAlive({
    pid: legacyInfra.pid,
    timeoutMs: 2_000,
    intervalMs: 25,
    label: 'repo-local legacy infra (pre-stop)',
  });
  assert.ok(isAlive(legacyInfra.pid), 'expected legacy infra to be alive');

  const sessionLike = spawnOwnedSleep({
    env: {
      ...process.env,
      HAPPIER_STACK_STACK: stackName,
      HAPPIER_STACK_REPO_DIR: repoDir,
      HAPPIER_STACK_PROCESS_KIND: 'session',
    },
  });
  children.push(sessionLike);
  assert.ok(Number(sessionLike.pid) > 1, 'expected session-like pid');
  await waitForProcessAlive({
    pid: sessionLike.pid,
    timeoutMs: 2_000,
    intervalMs: 25,
    label: 'repo-local session-like process (pre-stop)',
  });
  assert.ok(isAlive(sessionLike.pid), 'expected session-like process to be alive');

  const sessionWithLegacyServerMarkers = spawnOwnedSleep({
    env: {
      ...process.env,
      HAPPIER_STACK_STACK: stackName,
      HAPPIER_STACK_REPO_DIR: repoDir,
      HAPPIER_STACK_PROCESS_KIND: 'session',
      npm_lifecycle_event: 'dev:light',
      npm_package_name: '@happier-dev/server',
    },
  });
  children.push(sessionWithLegacyServerMarkers);
  assert.ok(Number(sessionWithLegacyServerMarkers.pid) > 1, 'expected session-with-server-markers pid');
  await waitForProcessAlive({
    pid: sessionWithLegacyServerMarkers.pid,
    timeoutMs: 2_000,
    intervalMs: 25,
    label: 'repo-local session with legacy server markers (pre-stop)',
  });
  assert.ok(isAlive(sessionWithLegacyServerMarkers.pid), 'expected session with legacy server markers to be alive');

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
    autoSweep: true,
  });

  await waitForProcessExit({
    pid: legacyInfra.pid,
    timeoutMs: 20_000,
    intervalMs: 50,
    label: 'repo-local legacy infra (post-stop)',
  });
  assert.ok(!isAlive(legacyInfra.pid), `expected legacy infra pid ${legacyInfra.pid} to be swept by repo-local infra signature`);
  assert.ok(isAlive(sessionLike.pid), `expected session-like pid ${sessionLike.pid} to still be alive`);
  assert.ok(
    isAlive(sessionWithLegacyServerMarkers.pid),
    `expected session-with-server-markers pid ${sessionWithLegacyServerMarkers.pid} to still be alive`,
  );
});
