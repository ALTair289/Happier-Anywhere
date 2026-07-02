import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { stopStackWithEnv } from './utils/stack/stop.mjs';
import { isAlive, spawnOwnedSleep, waitForProcessAlive, waitForProcessExit } from './testkit/stack_stop_sweeps_testkit.mjs';

async function createStopFixture(t, { stackName = 'test-stack' } = {}) {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptsDir);
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-stop-daemon-pid-set-'));
  const repoRoot = join(tmp, 'repo');
  const baseDir = join(tmp, 'stack');
  const envPath = join(baseDir, 'env');
  const cliHomeDir = join(baseDir, 'cli');

  await mkdir(join(repoRoot, 'apps', 'ui'), { recursive: true });
  await mkdir(join(repoRoot, 'apps', 'cli'), { recursive: true });
  await mkdir(join(repoRoot, 'apps', 'server'), { recursive: true });
  await writeFile(join(repoRoot, 'apps', 'ui', 'package.json'), '{}\n', 'utf8');
  await writeFile(join(repoRoot, 'apps', 'cli', 'package.json'), '{}\n', 'utf8');
  await writeFile(join(repoRoot, 'apps', 'server', 'package.json'), '{}\n', 'utf8');

  await mkdir(cliHomeDir, { recursive: true });
  await writeFile(
    envPath,
    [
      `HAPPIER_STACK_STACK=${stackName}`,
      'HAPPIER_STACK_SERVER_COMPONENT=happier-server-light',
      `HAPPIER_STACK_CLI_HOME_DIR=${cliHomeDir}`,
      `HAPPIER_STACK_REPO_DIR=${repoRoot}`,
      '',
    ].join('\n'),
    'utf8',
  );

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

  const spawnDaemon = async (label) => {
    const child = spawnOwnedSleep({
      env: {
        ...process.env,
        HAPPIER_STACK_STACK: stackName,
        HAPPIER_STACK_ENV_FILE: envPath,
        HAPPIER_STACK_CLI_HOME_DIR: cliHomeDir,
        HAPPIER_HOME_DIR: cliHomeDir,
        HAPPIER_STACK_PROCESS_KIND: 'infra',
        HAPPIER_TEST_LABEL: label,
      },
    });
    children.push(child);
    assert.ok(Number(child.pid) > 1, `expected ${label} pid`);
    await waitForProcessAlive({ pid: child.pid, timeoutMs: 2_000, intervalMs: 25, label });
    return child;
  };

  return {
    rootDir,
    repoRoot,
    baseDir,
    cliHomeDir,
    envPath,
    stackName,
    runtimeStatePath: join(baseDir, 'stack.runtime.json'),
    spawnDaemon,
  };
}

async function writeRuntimeState(path, state) {
  await writeFile(path, JSON.stringify(state, null, 2) + '\n', 'utf8');
}

test('stopStackWithEnv stops every recorded daemon pid in daemonPids', async (t) => {
  const fixture = await createStopFixture(t);
  const first = await fixture.spawnDaemon('daemon-a');
  const second = await fixture.spawnDaemon('daemon-b');

  await writeRuntimeState(fixture.runtimeStatePath, {
    version: 1,
    stackName: fixture.stackName,
    ownerPid: 999999,
    processes: {
      daemonPid: first.pid,
      daemonPids: [first.pid, second.pid],
    },
  });

  const res = await stopStackWithEnv({
    rootDir: fixture.repoRoot,
    stackName: fixture.stackName,
    baseDir: fixture.baseDir,
    env: {
      ...process.env,
      HAPPIER_STACK_STACK: fixture.stackName,
      HAPPIER_STACK_ENV_FILE: fixture.envPath,
      HAPPIER_STACK_CLI_HOME_DIR: fixture.cliHomeDir,
      HAPPIER_STACK_REPO_DIR: fixture.repoRoot,
    },
    json: true,
    noDocker: true,
  });

  const killedPids = new Set((res.processes?.killed ?? []).map((entry) => Number(entry.pid)));
  assert.equal(killedPids.has(first.pid), true);
  assert.equal(killedPids.has(second.pid), true);

  await waitForProcessExit({ pid: first.pid, timeoutMs: 10_000, intervalMs: 50, label: 'first daemon pid' });
  await waitForProcessExit({ pid: second.pid, timeoutMs: 10_000, intervalMs: 50, label: 'second daemon pid' });
});

test('stopStackWithEnv preserveDaemon preserves daemonPids and keeps runtime state while they are alive', async (t) => {
  const fixture = await createStopFixture(t);
  const first = await fixture.spawnDaemon('daemon-preserve-a');
  const second = await fixture.spawnDaemon('daemon-preserve-b');

  await writeRuntimeState(fixture.runtimeStatePath, {
    version: 1,
    stackName: fixture.stackName,
    ownerPid: 999999,
    processes: {
      daemonPids: [first.pid, second.pid],
    },
  });

  const res = await stopStackWithEnv({
    rootDir: fixture.repoRoot,
    stackName: fixture.stackName,
    baseDir: fixture.baseDir,
    env: {
      ...process.env,
      HAPPIER_STACK_STACK: fixture.stackName,
      HAPPIER_STACK_ENV_FILE: fixture.envPath,
      HAPPIER_STACK_CLI_HOME_DIR: fixture.cliHomeDir,
      HAPPIER_STACK_REPO_DIR: fixture.repoRoot,
    },
    json: true,
    noDocker: true,
    preserveDaemon: true,
  });

  assert.deepEqual(res.processes?.killed ?? [], []);
  assert.equal(isAlive(first.pid), true);
  assert.equal(isAlive(second.pid), true);
  await access(fixture.runtimeStatePath);
});
