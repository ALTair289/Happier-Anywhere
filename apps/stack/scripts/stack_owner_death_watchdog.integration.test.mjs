import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { runNodeCapture as runNode } from './testkit/core/run_node_capture.mjs';
import {
  isAlive,
  setupStackStopSweepFixture,
  spawnOwnedSleep,
  waitForProcessAlive,
  waitForProcessExit,
} from './testkit/stack_stop_sweeps_testkit.mjs';
import { writeStubHappierCliFiles } from './testkit/core/stub_happier_cli_files.mjs';
import { withJsonOwnerFileLock } from './utils/proc/jsonOwnerFileLock.mjs';
import { spawnStackOwnerDeathWatchdog } from './utils/stack/owner_death_watchdog.mjs';
import { recordStackRuntimeStart } from './utils/stack/runtime_state.mjs';

function terminateProcessTree(pid) {
  if (!Number.isFinite(pid) || pid <= 1) return;
  try {
    process.kill(-pid, 'SIGKILL');
    return;
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // ignore
    }
  }
}

async function waitForLogMatch(path, pattern, { timeoutMs = 5_000, intervalMs = 50 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const raw = await readFile(path, 'utf-8');
      if (pattern.test(raw)) {
        return raw;
      }
    } catch {
      // ignore
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return await readFile(path, 'utf-8');
}

test('stack owner-death watchdog spawn fails closed without owner startedAt', () => {
  const input = {
    rootDir: '/tmp/root',
    stackName: 'missing-incarnation',
    baseDir: '/tmp/base',
    runtimeStatePath: '/tmp/base/stack.runtime.json',
    ownerPid: process.pid,
  };
  assert.equal(spawnStackOwnerDeathWatchdog(input), null);
  assert.equal(spawnStackOwnerDeathWatchdog({ ...input, ownerStartedAt: 'not-a-timestamp' }), null);
  assert.equal(spawnStackOwnerDeathWatchdog({ ...input, ownerStartedAt: '2026-07-17T08:04:00Z' }), null);
});

test('owner-death sweep no-ops when a successor publishes after the watched owner was observed', async (t) => {
  const fixture = await setupStackStopSweepFixture({
    importMetaUrl: import.meta.url,
    t,
    tmpPrefix: 'hstack-owner-death-watchdog-successor-race-',
  });
  const runtimeStatePath = join(fixture.baseDir, 'stack.runtime.json');
  const watchdogLogPath = join(fixture.baseDir, 'logs', 'owner-death-watchdog.log');
  const ownedEnv = {
    ...process.env,
    HAPPIER_STACK_STACK: fixture.stackName,
    HAPPIER_STACK_ENV_FILE: fixture.envPath,
    HAPPIER_STACK_PROCESS_KIND: 'infra',
  };
  const oldOwner = fixture.trackChild(spawnOwnedSleep({ env: ownedEnv }));
  let successor = null;

  await waitForProcessAlive({ pid: oldOwner.pid, timeoutMs: 2_000, intervalMs: 25, label: 'old lifecycle owner' });
  const watchedRuntime = await recordStackRuntimeStart(runtimeStatePath, {
    stackName: fixture.stackName,
    script: 'owner-watchdog-successor-race-test',
    ephemeral: true,
    ownerPid: oldOwner.pid,
    processes: { serverPid: oldOwner.pid },
    ports: {},
  });
  fixture.trackChild(spawnStackOwnerDeathWatchdog({
    rootDir: fixture.rootDir,
    stackName: fixture.stackName,
    baseDir: fixture.baseDir,
    envPath: fixture.envPath,
    runtimeStatePath,
    ownerPid: oldOwner.pid,
    ownerStartedAt: watchedRuntime.startedAt,
    env: fixture.baseEnv,
    pollMs: 25,
    logFile: watchdogLogPath,
  }));

  await withJsonOwnerFileLock(async () => {
    terminateProcessTree(oldOwner.pid);
    await waitForProcessExit({ pid: oldOwner.pid, timeoutMs: 2_000, intervalMs: 25, label: 'old lifecycle owner' });
    await waitForLogMatch(watchdogLogPath, /owner pid .* is gone; sweeping stack-owned runtime/i);

    successor = fixture.trackChild(spawnOwnedSleep({ env: ownedEnv }));
    await waitForProcessAlive({ pid: successor.pid, timeoutMs: 2_000, intervalMs: 25, label: 'successor lifecycle owner' });
    const observed = JSON.parse(await readFile(runtimeStatePath, 'utf-8'));
    await writeFile(runtimeStatePath, `${JSON.stringify({
      ...observed,
      ownerPid: successor.pid,
      processes: { serverPid: successor.pid },
      stopRequest: null,
      updatedAt: new Date().toISOString(),
    }, null, 2)}\n`, 'utf-8');
  }, {
    lockPath: `${runtimeStatePath}.lock`,
    timeoutMs: 5_000,
    pollIntervalMs: 5,
    staleAfterMs: 10_000,
    errorLabel: 'test runtime-state mutation lock',
  });

  const watchdogLog = await waitForLogMatch(watchdogLogPath, /successor runtime detected; no-op/i, { timeoutMs: 10_000 });
  assert.ok(isAlive(successor.pid), `expected successor owner ${successor.pid} to remain alive`);
  const current = JSON.parse(await readFile(runtimeStatePath, 'utf-8'));
  assert.equal(current.ownerPid, successor.pid);
  assert.deepEqual(current.processes, { serverPid: successor.pid });
  assert.equal(current.stopRequest, null);
  const structuredLine = watchdogLog.split('\n').find((line) => line.startsWith('[owner-watchdog-json] '));
  assert.ok(structuredLine, `expected structured watchdog no-op line:\n${watchdogLog}`);
  const structured = JSON.parse(structuredLine.slice('[owner-watchdog-json] '.length));
  assert.equal(structured.event, 'owner_death_sweep_noop');
  assert.equal(structured.actions?.stopAuthorization?.reason, 'successor_owner');
  assert.equal(structured.killedCount, 0);
});

test('owner-death sweep no-ops when a successor reuses the watched pid with a new startedAt', async (t) => {
  const fixture = await setupStackStopSweepFixture({
    importMetaUrl: import.meta.url,
    t,
    tmpPrefix: 'hstack-owner-death-watchdog-pid-reuse-',
  });
  const runtimeStatePath = join(fixture.baseDir, 'stack.runtime.json');
  const watchdogLogPath = join(fixture.baseDir, 'logs', 'owner-death-watchdog.log');
  const ownedEnv = {
    ...process.env,
    HAPPIER_STACK_STACK: fixture.stackName,
    HAPPIER_STACK_ENV_FILE: fixture.envPath,
    HAPPIER_STACK_PROCESS_KIND: 'infra',
  };
  const oldOwner = fixture.trackChild(spawnOwnedSleep({ env: ownedEnv }));
  let successor = null;

  await waitForProcessAlive({ pid: oldOwner.pid, timeoutMs: 2_000, intervalMs: 25, label: 'old lifecycle owner' });
  const watchedRuntime = await recordStackRuntimeStart(runtimeStatePath, {
    stackName: fixture.stackName,
    script: 'owner-watchdog-pid-reuse-test',
    ephemeral: true,
    ownerPid: oldOwner.pid,
    processes: { serverPid: oldOwner.pid },
    ports: {},
  });
  fixture.trackChild(spawnStackOwnerDeathWatchdog({
    rootDir: fixture.rootDir,
    stackName: fixture.stackName,
    baseDir: fixture.baseDir,
    envPath: fixture.envPath,
    runtimeStatePath,
    ownerPid: oldOwner.pid,
    ownerStartedAt: watchedRuntime.startedAt,
    env: fixture.baseEnv,
    pollMs: 25,
    logFile: watchdogLogPath,
  }));

  const successorStartedAt = '2026-07-17T08:03:00.000Z';
  await withJsonOwnerFileLock(async () => {
    terminateProcessTree(oldOwner.pid);
    await waitForProcessExit({ pid: oldOwner.pid, timeoutMs: 2_000, intervalMs: 25, label: 'old lifecycle owner' });
    await waitForLogMatch(watchdogLogPath, /owner pid .* is gone; sweeping stack-owned runtime/i);

    successor = fixture.trackChild(spawnOwnedSleep({ env: ownedEnv }));
    await waitForProcessAlive({ pid: successor.pid, timeoutMs: 2_000, intervalMs: 25, label: 'successor infra' });
    const observed = JSON.parse(await readFile(runtimeStatePath, 'utf-8'));
    await writeFile(runtimeStatePath, `${JSON.stringify({
      ...observed,
      ownerPid: oldOwner.pid,
      startedAt: successorStartedAt,
      processes: { serverPid: successor.pid },
      serverProxy: { reloadGeneration: 2 },
      stopRequest: null,
      updatedAt: new Date().toISOString(),
    }, null, 2)}\n`, 'utf-8');
  }, {
    lockPath: `${runtimeStatePath}.lock`,
    timeoutMs: 5_000,
    pollIntervalMs: 5,
    staleAfterMs: 10_000,
    errorLabel: 'test runtime-state mutation lock',
  });

  const watchdogLog = await waitForLogMatch(
    watchdogLogPath,
    /runtime stop not authorized \(successor_owner_incarnation\); no-op/i,
    { timeoutMs: 10_000 },
  );
  assert.ok(isAlive(successor.pid), `expected successor infra ${successor.pid} to remain alive`);
  const current = JSON.parse(await readFile(runtimeStatePath, 'utf-8'));
  assert.equal(current.ownerPid, oldOwner.pid);
  assert.equal(current.startedAt, successorStartedAt);
  assert.deepEqual(current.processes, { serverPid: successor.pid });
  assert.equal(current.serverProxy.reloadGeneration, 2);
  assert.equal(current.stopRequest, null);
  const structuredLine = watchdogLog.split('\n').find((line) => line.startsWith('[owner-watchdog-json] '));
  assert.ok(structuredLine, `expected structured watchdog no-op line:\n${watchdogLog}`);
  const structured = JSON.parse(structuredLine.slice('[owner-watchdog-json] '.length));
  assert.equal(structured.event, 'owner_death_sweep_noop');
  assert.equal(structured.actions?.stopAuthorization?.reason, 'successor_owner_incarnation');
  assert.equal(structured.killedCount, 0);
});

test('stack owner-death watchdog reaps stale infra and preserves session processes', async (t) => {
  const fixture = await setupStackStopSweepFixture({
    importMetaUrl: import.meta.url,
    t,
    tmpPrefix: 'hstack-owner-death-watchdog-',
  });

  const sessionLike = fixture.trackChild(
    spawnOwnedSleep({
      env: {
        ...process.env,
        HAPPIER_STACK_STACK: fixture.stackName,
        HAPPIER_STACK_ENV_FILE: fixture.envPath,
        HAPPIER_STACK_PROCESS_KIND: 'session',
      },
    }),
  );
  assert.ok(Number(sessionLike.pid) > 1, 'expected session-like child pid');
  await waitForProcessAlive({ pid: sessionLike.pid, timeoutMs: 2_000, intervalMs: 25, label: 'session-like process' });

  const parentPath = join(fixture.tmp, 'owner-watchdog-parent.mjs');
  const runtimeStatePath = join(fixture.baseDir, 'stack.runtime.json');
  const watchdogLogPath = join(fixture.baseDir, 'logs', 'owner-death-watchdog.log');
  const ownerWatchdogUrl = pathToFileURL(join(fixture.rootDir, 'scripts', 'utils', 'stack', 'owner_death_watchdog.mjs')).toString();
  const runtimeStateUrl = pathToFileURL(join(fixture.rootDir, 'scripts', 'utils', 'stack', 'runtime_state.mjs')).toString();

  await mkdir(join(fixture.repoDir, 'apps', 'ui'), { recursive: true });
  await mkdir(join(fixture.repoDir, 'apps', 'server'), { recursive: true });
  await writeFile(join(fixture.repoDir, 'apps', 'ui', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(fixture.repoDir, 'apps', 'server', 'package.json'), '{}\n', 'utf-8');
  await writeStubHappierCliFiles(fixture.repoDir, {
    packageJsonContent: '{}\n',
    distIndexScript: `
setInterval(() => {}, 1000);
`.trimStart(),
    binHappierScript: 'process.exit(0);\n',
  });

  await writeFile(
    parentPath,
    [
      `import { spawn } from 'node:child_process';`,
      `import { recordStackRuntimeStart, recordStackRuntimeUpdate } from ${JSON.stringify(runtimeStateUrl)};`,
      `import { spawnStackOwnerDeathWatchdog } from ${JSON.stringify(ownerWatchdogUrl)};`,
      `const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {`,
      `  detached: true,`,
      `  stdio: 'ignore',`,
      `  env: {`,
      `    ...process.env,`,
      `    HAPPIER_STACK_STACK: ${JSON.stringify(fixture.stackName)},`,
      `    HAPPIER_STACK_ENV_FILE: ${JSON.stringify(fixture.envPath)},`,
      `    HAPPIER_STACK_PROCESS_KIND: 'infra',`,
      `  },`,
      `});`,
      `child.unref();`,
      `const runtime = await recordStackRuntimeStart(${JSON.stringify(runtimeStatePath)}, {`,
      `  stackName: ${JSON.stringify(fixture.stackName)},`,
      `  script: 'owner-watchdog-test',`,
      `  ephemeral: true,`,
      `  ownerPid: process.pid,`,
      `  ports: {},`,
      `});`,
      `await recordStackRuntimeUpdate(${JSON.stringify(runtimeStatePath)}, { processes: { serverPid: child.pid } });`,
      `spawnStackOwnerDeathWatchdog({`,
      `  rootDir: ${JSON.stringify(fixture.rootDir)},`,
      `  stackName: ${JSON.stringify(fixture.stackName)},`,
      `  baseDir: ${JSON.stringify(fixture.baseDir)},`,
      `  envPath: ${JSON.stringify(fixture.envPath)},`,
      `  runtimeStatePath: ${JSON.stringify(runtimeStatePath)},`,
      `  ownerPid: process.pid,`,
      `  ownerStartedAt: runtime.startedAt,`,
      `  env: process.env,`,
      `  pollMs: 25,`,
      `  logFile: ${JSON.stringify(watchdogLogPath)},`,
      `});`,
      `console.log(String(child.pid));`,
      `setTimeout(() => process.exit(0), 100);`,
      `setInterval(() => {}, 1000);`,
      ``,
    ].join('\n'),
    'utf-8',
  );

  let infraPid = null;
  try {
    const res = await runNode([parentPath], {
      cwd: fixture.rootDir,
      env: {
        ...fixture.baseEnv,
        HAPPIER_STACK_STACK: fixture.stackName,
        HAPPIER_STACK_ENV_FILE: fixture.envPath,
        HAPPIER_STACK_DAEMON_STOP_TIMEOUT_MS: '100',
        HAPPIER_STACK_DAEMON_STOP_TERMINATE_GRACE_MS: '50',
      },
    });
    assert.equal(res.code, 0, `expected clean parent exit\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);

    infraPid = Number(res.stdout.trim().split('\n')[0]);
    assert.ok(Number.isFinite(infraPid) && infraPid > 1, `expected infra pid in stdout, got: ${res.stdout}`);
    await waitForProcessAlive({ pid: infraPid, timeoutMs: 2_000, intervalMs: 25, label: 'infra process (pre-watchdog)' });

    await waitForProcessExit({ pid: infraPid, timeoutMs: 10_000, intervalMs: 50, label: 'infra process (owner watchdog)' });
    assert.ok(!isAlive(infraPid), `expected infra pid ${infraPid} to be stopped`);
    assert.ok(isAlive(sessionLike.pid), `expected session-like pid ${sessionLike.pid} to still be alive`);

    const watchdogLog = await waitForLogMatch(
      watchdogLogPath,
      /sweep complete \(killed=\d+, errors=1\)/i,
      { timeoutMs: 10_000 },
    );
    assert.match(watchdogLog, /owner pid .* is gone; sweeping stack-owned runtime/i);
    assert.match(watchdogLog, /sweep complete \(killed=\d+, errors=1\)/i);
    const structuredLine = watchdogLog
      .split('\n')
      .find((line) => line.startsWith('[owner-watchdog-json] '));
    assert.ok(structuredLine, `expected structured owner-watchdog-json line in log:\n${watchdogLog}`);
    const structured = JSON.parse(structuredLine.slice('[owner-watchdog-json] '.length));
    assert.equal(structured.event, 'owner_death_sweep_complete');
    assert.equal(structured.stackName, fixture.stackName);
    assert.equal(structured.errorCount, 1);
    assert.deepEqual(structured.actions?.stopAttribution, {
      requestedBy: 'owner death watchdog',
      reason: 'lifecycle owner exited; sweeping stack-owned runtime',
    });
    assert.ok(structured.killedCount >= 1, `expected at least one killed process, got ${structured.killedCount}`);
    assert.equal(structured.actions?.errors?.[0]?.step, 'daemon');
    assert.equal(structured.actions?.errors?.[0]?.error, 'daemon stop timed out after 100ms');
    assert.equal(structured.actions?.errors?.[0]?.code, 'ETIMEDOUT');
    assert.equal(structured.actions?.errors?.[0]?.processGroupTerminated, true);
    const stopChildPid = Number(structured.actions?.errors?.[0]?.childPid);
    assert.ok(Number.isFinite(stopChildPid) && stopChildPid > 1, 'structured timeout should identify the stop child');
    assert.ok(!isAlive(stopChildPid), `expected timed-out daemon stop child ${stopChildPid} to be terminated`);
    const directlyKilledPids = structured.actions?.processes?.killed?.map((entry) => entry.pid) ?? [];
    const sweptPids = structured.actions?.sweep?.pids?.map((entry) => entry.pid) ?? [];
    assert.ok(
      [...directlyKilledPids, ...sweptPids].includes(infraPid),
      `expected structured log to include infra pid ${infraPid}: ${structuredLine}`,
    );
  } finally {
    terminateProcessTree(infraPid);
    await fixture.cleanup();
  }
});
