import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';

import {
  applyDaemonDistClosureRuntimeEnv,
  createDaemonStartAttemptLogPath,
  resolveDaemonDistRestartReason,
  resolveGuardedLocalCliDistEntrypoint,
  startLocalDaemonWithAuth,
  stopLocalDaemon,
} from './daemon.mjs';
import { writeStubHappierCliFiles } from './testkit/core/stub_happier_cli_files.mjs';

function runGit(args, cwd) {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

function buildDaemonDistGuardEnv(overrides = {}) {
  return {
    ...process.env,
    HAPPIER_STACK_REPO_DIR: '',
    HAPPIER_STACK_AUTO_AUTH_SEED: '0',
    HAPPIER_STACK_MIGRATE_CREDENTIALS: '0',
    ...overrides,
  };
}

test('applyDaemonDistClosureRuntimeEnv exposes the current stack dist fingerprint to source daemon child spawns', () => {
  const env = { KEEP_ME: '1' };

  const nextEnv = applyDaemonDistClosureRuntimeEnv(env, {
    runtimeStatePath: '/tmp/happier/stack.runtime.json',
    distEntrypoint: '/repo/apps/cli/dist/index.mjs',
    distClosureFingerprint: 'abc123def4567890',
  });

  assert.equal(nextEnv, env);
  assert.equal(nextEnv.KEEP_ME, '1');
  assert.equal(nextEnv.HAPPIER_CLI_SUBPROCESS_STACK_RUNTIME_STATE_PATH, '/tmp/happier/stack.runtime.json');
  assert.equal(nextEnv.HAPPIER_CLI_SUBPROCESS_DIST_ENTRYPOINT, '/repo/apps/cli/dist/index.mjs');
  assert.equal(nextEnv.HAPPIER_CLI_SUBPROCESS_DAEMON_DIST_CLOSURE_FINGERPRINT, 'abc123def4567890');
});

test('applyDaemonDistClosureRuntimeEnv clears the dist runner fast path when the fingerprint is missing', () => {
  const env = {
    HAPPIER_CLI_SUBPROCESS_STACK_RUNTIME_STATE_PATH: '/tmp/happier/stack.runtime.json',
    HAPPIER_CLI_SUBPROCESS_DIST_ENTRYPOINT: '/repo/apps/cli/dist/index.mjs',
    HAPPIER_CLI_SUBPROCESS_DAEMON_DIST_CLOSURE_FINGERPRINT: 'abc123def4567890',
  };

  applyDaemonDistClosureRuntimeEnv(env, {
    runtimeStatePath: '/tmp/happier/stack.runtime.json',
    distEntrypoint: '/repo/apps/cli/dist/index.mjs',
    distClosureFingerprint: null,
  });

  assert.equal(env.HAPPIER_CLI_SUBPROCESS_STACK_RUNTIME_STATE_PATH, undefined);
  assert.equal(env.HAPPIER_CLI_SUBPROCESS_DIST_ENTRYPOINT, undefined);
  assert.equal(env.HAPPIER_CLI_SUBPROCESS_DAEMON_DIST_CLOSURE_FINGERPRINT, undefined);
});

test('daemon dist guard does not restart when only dist mtimes are newer than daemon startup', async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-dist-mtime-'));
  t.after(async () => {
    await rm(tmp, { recursive: true, force: true });
  });
  const runtimeStatePath = join(tmp, 'stack.runtime.json');
  const cliHomeDir = join(tmp, 'home');
  const statePath = join(cliHomeDir, 'daemon.state.json');
  const fingerprint = 'abc123def4567890';
  await mkdir(dirname(statePath), { recursive: true });
  await writeFile(
    runtimeStatePath,
    JSON.stringify({ daemon: { distClosureFingerprint: fingerprint } }),
    'utf-8',
  );
  await writeFile(
    statePath,
    JSON.stringify({ startedAt: 1_000 }),
    'utf-8',
  );

  const reason = resolveDaemonDistRestartReason({
    distEntrypoint: join(tmp, 'cli', 'dist', 'index.mjs'),
    distClosure: {
      ok: true,
      fingerprint,
      maxMtimeMs: 2_000,
    },
    runtimeStatePath,
    cliHomeDir,
    env: {
      HAPPIER_STACK_DAEMON_STATE_PATH: statePath,
    },
  });

  assert.equal(reason, null);
});

async function reserveLoopbackServerUrls() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string', 'expected loopback listener to expose a numeric port');
  const port = address.port;
  await new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
  return {
    internalServerUrl: `http://127.0.0.1:${port}`,
    publicServerUrl: `http://localhost:${port}`,
  };
}

function overrideProcessReleaseNameForTest(nextName) {
  const descriptor = Object.getOwnPropertyDescriptor(process.release, 'name');
  assert.ok(descriptor?.configurable, 'process.release.name must be configurable for test');
  Object.defineProperty(process.release, 'name', {
    configurable: true,
    enumerable: descriptor.enumerable ?? true,
    writable: descriptor.writable ?? false,
    value: nextName,
  });
  return () => {
    Object.defineProperty(process.release, 'name', {
      configurable: true,
      enumerable: descriptor.enumerable ?? true,
      writable: descriptor.writable ?? false,
      value: descriptor.value,
    });
  };
}

const FAKE_PING_AWARE_DAEMON_CHILD_SCRIPT = `
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const statePath = process.argv[1];
if (!statePath) process.exit(2);

const server = http.createServer((req, res) => {
  if (req.url === '/ping') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'not-found' }));
});

server.listen(0, '127.0.0.1', () => {
  const address = server.address();
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(
    statePath,
    JSON.stringify({
      pid: process.pid,
      httpPort: address.port,
      controlToken: '',
      startTime: new Date().toISOString(),
    }),
    'utf-8',
  );
});

process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 50).unref();
});

setInterval(() => {}, 1000);
`;

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function fakePingAwareDaemonSpawnerSource() {
  return `
const FAKE_PING_AWARE_DAEMON_CHILD_SCRIPT = ${JSON.stringify(FAKE_PING_AWARE_DAEMON_CHILD_SCRIPT)};

function startFakePingAwareDaemon(statePath) {
  const child = spawn(process.execPath, ['-e', FAKE_PING_AWARE_DAEMON_CHILD_SCRIPT, statePath, 'daemon', 'start'], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  return child.pid;
}
`;
}

async function writeStubHappyCli({ cliDir }) {
  // Dist entrypoint exists, but package.json intentionally has no build script.
  // startLocalDaemonWithAuth should launch the daemon via dist (not via bin/happier.mjs).
  const distScript = `
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
if (args[0] !== 'daemon') process.exit(0);
const home = process.env.HAPPIER_HOME_DIR || process.env.HAPPIER_STACK_CLI_HOME_DIR;
if (!home) process.exit(2);
const state = join(home, 'daemon.state.json');

${fakePingAwareDaemonSpawnerSource()}

const sub = args[1] || '';

if (sub === 'stop') {
  if (existsSync(state)) {
    try {
      const pid = Number(JSON.parse(readFileSync(state, 'utf-8')).pid);
      if (Number.isFinite(pid) && pid > 1) {
        try { process.kill(pid, 'SIGTERM'); } catch {}
      }
    } catch {}
    try { rmSync(state); } catch {}
  }
  process.exit(0);
}

if (sub === 'start') {
  startFakePingAwareDaemon(state);
  process.exit(0);
}

if (sub === 'status') {
  let ok = false;
  if (existsSync(state)) {
    try {
      const pid = Number(JSON.parse(readFileSync(state, 'utf-8')).pid);
      if (Number.isFinite(pid) && pid > 1) {
        try { process.kill(pid, 0); ok = true; } catch {}
      }
    } catch {}
  }
  console.log(ok ? 'daemon: running' : 'daemon: stopped');
  process.exit(0);
}

process.exit(0);
`;
  const monoRoot = join(cliDir, '..', '..');
  const { cliBinDir } = await writeStubHappierCliFiles(monoRoot, {
    packageJsonContent: '{}\n',
    distIndexScript: distScript.trimStart(),
    // If the implementation accidentally invokes bin/happier.mjs instead of dist/index.mjs, fail loudly.
    binHappierScript: 'process.exit(42);\n',
  });
  return join(cliBinDir, 'happier.mjs');
}

async function writeSlowStartStubHappyCli({ cliDir }) {
  const distScript = `
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const args = process.argv.slice(2);
const home = process.env.HAPPIER_HOME_DIR || process.env.HAPPIER_STACK_CLI_HOME_DIR;
const eventsPath = process.env.HAPPIER_TEST_DAEMON_EVENTS_PATH;
if (!home) process.exit(2);
const state = join(home, 'daemon.state.json');

${fakePingAwareDaemonSpawnerSource()}

function event(name) {
  if (eventsPath) appendFileSync(eventsPath, name + '\\n', 'utf-8');
}

if (args[0] !== 'daemon') process.exit(0);
const sub = args[1] || '';

if (sub === 'stop') {
  event('stop');
  if (existsSync(state)) {
    try {
      const pid = Number(JSON.parse(readFileSync(state, 'utf-8')).pid);
      if (Number.isFinite(pid) && pid > 1) {
        try { process.kill(pid, 'SIGTERM'); } catch {}
      }
    } catch {}
    try { rmSync(state); } catch {}
  }
  process.exit(0);
}

if (sub === 'start') {
  event('start');
  await delay(400);
  startFakePingAwareDaemon(state);
  await delay(100);
  process.exit(0);
}

process.exit(0);
`;
  const monoRoot = join(cliDir, '..', '..');
  const { cliBinDir } = await writeStubHappierCliFiles(monoRoot, {
    packageJsonContent: '{}\n',
    distIndexScript: distScript.trimStart(),
    binHappierScript: 'process.exit(42);\n',
  });
  return join(cliBinDir, 'happier.mjs');
}

async function writeDelayedStopStubHappyCli({ cliDir }) {
  const distScript = `
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const args = process.argv.slice(2);
const home = process.env.HAPPIER_HOME_DIR || process.env.HAPPIER_STACK_CLI_HOME_DIR;
const eventsPath = process.env.HAPPIER_TEST_DAEMON_EVENTS_PATH;
if (!home) process.exit(2);
const state = join(home, 'daemon.state.json');

${fakePingAwareDaemonSpawnerSource()}

function event(name) {
  if (eventsPath) appendFileSync(eventsPath, name + '\\n', 'utf-8');
}

if (args[0] !== 'daemon') process.exit(0);
const sub = args[1] || '';

if (sub === 'stop') {
  event('stop');
  await delay(250);
  if (existsSync(state)) {
    try {
      const pid = Number(JSON.parse(readFileSync(state, 'utf-8')).pid);
      if (Number.isFinite(pid) && pid > 1) {
        try { process.kill(pid, 'SIGTERM'); } catch {}
      }
    } catch {}
    try { rmSync(state); } catch {}
  }
  process.exit(0);
}

if (sub === 'start') {
  event('start');
  startFakePingAwareDaemon(state);
  process.exit(0);
}

if (sub === 'status') {
  let ok = false;
  if (existsSync(state)) {
    try {
      const pid = Number(JSON.parse(readFileSync(state, 'utf-8')).pid);
      if (Number.isFinite(pid) && pid > 1) {
        try { process.kill(pid, 0); ok = true; } catch {}
      }
    } catch {}
  }
  console.log(ok ? 'daemon: running' : 'daemon: stopped');
  process.exit(0);
}

process.exit(0);
`;
  const monoRoot = join(cliDir, '..', '..');
  const { cliBinDir } = await writeStubHappierCliFiles(monoRoot, {
    packageJsonContent: '{}\n',
    distIndexScript: distScript.trimStart(),
    binHappierScript: 'process.exit(42);\n',
  });
  return join(cliBinDir, 'happier.mjs');
}

async function writePidOnlyFalseReadyStubHappyCli({ cliDir }) {
  const distScript = `
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const home = process.env.HAPPIER_HOME_DIR || process.env.HAPPIER_STACK_CLI_HOME_DIR;
if (!home) process.exit(2);
const state = join(home, 'daemon.state.json');

if (args[0] !== 'daemon') process.exit(0);
const sub = args[1] || '';

if (sub === 'stop') {
  if (existsSync(state)) {
    try {
      const pid = Number(JSON.parse(readFileSync(state, 'utf-8')).pid);
      if (Number.isFinite(pid) && pid > 1) {
        try { process.kill(pid, 'SIGTERM'); } catch {}
      }
    } catch {}
    try { rmSync(state); } catch {}
  }
  process.exit(0);
}

if (sub === 'start') {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
  child.unref();
  writeFileSync(state, JSON.stringify({ pid: child.pid, httpPort: 0, startTime: new Date().toISOString() }), 'utf-8');
  process.exit(0);
}

process.exit(0);
`;
  const monoRoot = join(cliDir, '..', '..');
  const { cliBinDir } = await writeStubHappierCliFiles(monoRoot, {
    packageJsonContent: '{}\n',
    distIndexScript: distScript.trimStart(),
    binHappierScript: 'process.exit(42);\n',
  });
  return join(cliBinDir, 'happier.mjs');
}

async function writeRuntimeSnapshotHappyCli({ snapshotDir }) {
  const cliDir = join(snapshotDir, 'cli');
  await mkdir(cliDir, { recursive: true });
  const implPath = join(cliDir, 'runtime-cli.mjs');
  const cliBin = join(cliDir, 'happier');

  const distScript = `
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const home = process.env.HAPPIER_HOME_DIR || process.env.HAPPIER_STACK_CLI_HOME_DIR;
if (!home) process.exit(2);
const state = join(home, 'daemon.state.json');

${fakePingAwareDaemonSpawnerSource()}

if (args[0] !== 'daemon') process.exit(0);
const sub = args[1] || '';

if (sub === 'stop') {
  if (existsSync(state)) {
    try {
      const pid = Number(JSON.parse(readFileSync(state, 'utf-8')).pid);
      if (Number.isFinite(pid) && pid > 1) {
        try { process.kill(pid, 'SIGTERM'); } catch {}
      }
    } catch {}
    try { rmSync(state); } catch {}
  }
  process.exit(0);
}

if (sub === 'start') {
  startFakePingAwareDaemon(state);
  process.exit(0);
}

if (sub === 'status') {
  let ok = false;
  if (existsSync(state)) {
    try {
      const pid = Number(JSON.parse(readFileSync(state, 'utf-8')).pid);
      if (Number.isFinite(pid) && pid > 1) {
        try { process.kill(pid, 0); ok = true; } catch {}
      }
    } catch {}
  }
  console.log(ok ? 'daemon: running' : 'daemon: stopped');
  process.exit(0);
}

process.exit(0);
  `;
  await writeFile(implPath, distScript.trimStart(), 'utf-8');
  await writeFile(cliBin, `#!/bin/sh\nexec "${process.execPath}" "${implPath}" "$@"\n`, 'utf-8');
  await chmod(cliBin, 0o755);
  return cliBin;
}

async function writeRuntimeSnapshotHappyCliWithNodeEntrypoint({ snapshotDir }) {
  const cliDir = join(snapshotDir, 'cli');
  const packageDistDir = join(cliDir, 'package-dist');
  await mkdir(packageDistDir, { recursive: true });
  const cliBin = join(cliDir, 'happier');

  const distScript = `
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const home = process.env.HAPPIER_HOME_DIR || process.env.HAPPIER_STACK_CLI_HOME_DIR;
if (!home) process.exit(2);
const state = join(home, 'daemon.state.json');

${fakePingAwareDaemonSpawnerSource()}

if (args[0] !== 'daemon') process.exit(0);
const sub = args[1] || '';

if (sub === 'stop') {
  if (existsSync(state)) {
    try {
      const pid = Number(JSON.parse(readFileSync(state, 'utf-8')).pid);
      if (Number.isFinite(pid) && pid > 1) {
        try { process.kill(pid, 'SIGTERM'); } catch {}
      }
    } catch {}
    try { rmSync(state); } catch {}
  }
  process.exit(0);
}

if (sub === 'start-sync' || sub === 'start') {
  startFakePingAwareDaemon(state);
  process.exit(0);
}

if (sub === 'status') {
  let ok = false;
  if (existsSync(state)) {
    try {
      const pid = Number(JSON.parse(readFileSync(state, 'utf-8')).pid);
      if (Number.isFinite(pid) && pid > 1) {
        try { process.kill(pid, 0); ok = true; } catch {}
      }
    } catch {}
  }
  console.log(ok ? 'daemon: running' : 'daemon: stopped');
  process.exit(0);
}

process.exit(0);
  `;

  await writeFile(join(packageDistDir, 'index.mjs'), distScript.trimStart(), 'utf-8');
  await writeFile(cliBin, 'exit 42\n', 'utf-8');
  await chmod(cliBin, 0o755);
  return {
    cliBin,
    cliNodeEntrypoint: join(packageDistDir, 'index.mjs'),
  };
}

async function writeRuntimeSnapshotHappyCliJsCommand({ snapshotDir }) {
  const cliDir = join(snapshotDir, 'cli');
  await mkdir(cliDir, { recursive: true });
  const cliBin = join(cliDir, 'happier');
  const cliCommand = join(cliDir, 'happier.mjs');

  const distScript = `
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const home = process.env.HAPPIER_HOME_DIR || process.env.HAPPIER_STACK_CLI_HOME_DIR;
if (!home) process.exit(2);
const state = join(home, 'daemon.state.json');

${fakePingAwareDaemonSpawnerSource()}

if (args[0] !== 'daemon') process.exit(0);
const sub = args[1] || '';

if (sub === 'start-sync' || sub === 'start') {
  startFakePingAwareDaemon(state);
  process.exit(0);
}

if (sub === 'status') {
  let ok = false;
  if (existsSync(state)) {
    try {
      const pid = Number(JSON.parse(readFileSync(state, 'utf-8')).pid);
      if (Number.isFinite(pid) && pid > 1) {
        try { process.kill(pid, 0); ok = true; } catch {}
      }
    } catch {}
  }
  console.log(ok ? 'daemon: running' : 'daemon: stopped');
  process.exit(0);
}

process.exit(0);
  `;

  await writeFile(cliCommand, distScript.trimStart(), 'utf-8');
  await writeFile(cliBin, 'exit 42\n', 'utf-8');
  await chmod(cliBin, 0o755);
  return {
    cliBin,
    cliCommand,
  };
}

async function writePathResolvedRuntimeCommand({ binDir, stopMode = 'kill-state' } = {}) {
  await mkdir(binDir, { recursive: true });
  const commandPath = join(binDir, 'happier-runtime-cmd');
  const script = `#!/bin/sh
HOME_DIR="${'$'}{HAPPIER_HOME_DIR:-${'$'}{HAPPIER_STACK_CLI_HOME_DIR:-}}"
if [ -z "$HOME_DIR" ]; then
  exit 2
fi
STATE="$HOME_DIR/daemon.state.json"
case "$1" in
  daemon)
    case "$2" in
      start)
        "${process.execPath}" -e ${shellQuote(FAKE_PING_AWARE_DAEMON_CHILD_SCRIPT)} "$STATE" daemon start >/dev/null 2>&1 &
        exit 0
        ;;
      stop)
        if [ "${stopMode}" = "kill-state" ] && [ -f "$STATE" ]; then
          pid=$("${process.execPath}" -e "const fs=require('node:fs');const raw=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));process.stdout.write(String(raw.pid ?? ''));" "$STATE")
          if [ -n "$pid" ]; then
            kill "$pid" >/dev/null 2>&1 || true
          fi
          rm -f "$STATE"
        fi
        exit 0
        ;;
      *)
        exit 0
        ;;
    esac
    ;;
  *)
    exit 0
    ;;
esac
`;
  await writeFile(commandPath, script, 'utf-8');
  await chmod(commandPath, 0o755);
  return { cliCommand: 'happier-runtime-cmd', commandPath };
}

async function readDaemonPid(statePath) {
  return Number(JSON.parse(await readFile(statePath, 'utf-8')).pid);
}

async function writeDistBuildManifestForTest(distEntrypoint, fingerprint) {
  await writeFile(
    join(dirname(distEntrypoint), '.build-manifest.json'),
    JSON.stringify({
      fingerprint,
      builtAt: '2026-07-09T00:00:00.000Z',
      fileCount: 1,
      toolVersion: '1',
    }) + '\n',
    'utf-8',
  );
}

test('startLocalDaemonWithAuth requires daemon control ping before accepting running daemon state', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-ping-ready-'));
  try {
    const { internalServerUrl, publicServerUrl } = await reserveLoopbackServerUrls();
    const cliDir = join(tmp, 'apps', 'cli');
    const cliBin = await writePidOnlyFalseReadyStubHappyCli({ cliDir });
    await writeFile(join(tmp, 'package.json'), '{}\n', 'utf-8');
    runGit(['init'], tmp);
    runGit(['config', 'user.email', 'test@example.com'], tmp);
    runGit(['config', 'user.name', 'Test User'], tmp);
    runGit(['add', '.'], tmp);
    runGit(['commit', '-m', 'init'], tmp);

    const cliHomeDir = join(tmp, 'stack', 'cli');
    await mkdir(cliHomeDir, { recursive: true });
    await writeFile(join(cliHomeDir, 'access.key'), 'dummy\n', 'utf-8');
    await writeFile(join(cliHomeDir, 'settings.json'), JSON.stringify({ machineId: 'test-machine' }) + '\n', 'utf-8');

    await assert.rejects(
      () =>
        startLocalDaemonWithAuth({
          cliBin,
          cliHomeDir,
          internalServerUrl,
          publicServerUrl,
          isShuttingDown: () => false,
          forceRestart: true,
          env: buildDaemonDistGuardEnv({
            HAPPIER_STACK_CLI_BUILD: '1',
            HAPPIER_STACK_DAEMON_START_VERIFY_TIMEOUT_MS: '250',
            HAPPIER_STACK_DAEMON_START_VERIFY_POLL_MS: '25',
            HAPPIER_STACK_DAEMON_START_VERIFY_STABLE_MS: '0',
          }),
          stackName: 'dev',
          cliIdentity: 'default',
        }),
      /Failed to start daemon|daemon failed to start/i,
    );

    await stopLocalDaemon({
      cliBin,
      internalServerUrl,
      cliHomeDir,
    });
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('startLocalDaemonWithAuth does not require a second CLI build when dist/index.mjs already exists', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-dist-guard-'));
  try {
    const { internalServerUrl, publicServerUrl } = await reserveLoopbackServerUrls();
    const cliDir = join(tmp, 'apps', 'cli');
    const cliBin = await writeStubHappyCli({ cliDir });
    await writeFile(join(tmp, 'package.json'), '{}\n', 'utf-8');
    runGit(['init'], tmp);
    runGit(['config', 'user.email', 'test@example.com'], tmp);
    runGit(['config', 'user.name', 'Test User'], tmp);
    runGit(['add', '.'], tmp);
    runGit(['commit', '-m', 'init'], tmp);

    const cliHomeDir = join(tmp, 'stack', 'cli');
    await mkdir(cliHomeDir, { recursive: true });
    await writeFile(join(cliHomeDir, 'access.key'), 'dummy\n', 'utf-8');
    await writeFile(join(cliHomeDir, 'settings.json'), JSON.stringify({ machineId: 'test-machine' }) + '\n', 'utf-8');

    const env = buildDaemonDistGuardEnv({
      HAPPIER_STACK_CLI_BUILD: '1',
    });

    // If startLocalDaemonWithAuth tries to rebuild, this will fail because package.json has no build script.
    await startLocalDaemonWithAuth({
      cliBin,
      cliHomeDir,
      internalServerUrl,
      publicServerUrl,
      isShuttingDown: () => false,
      forceRestart: true,
      env,
      stackName: 'dev',
      cliIdentity: 'default',
    });

    await stopLocalDaemon({
      cliBin,
      internalServerUrl,
      cliHomeDir,
    });

    assert.ok(true);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('startLocalDaemonWithAuth ignores unreachable stale dist chunks when the entrypoint closure is complete', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-dist-stale-unused-'));
  try {
    const { internalServerUrl, publicServerUrl } = await reserveLoopbackServerUrls();
    const cliDir = join(tmp, 'apps', 'cli');
    const cliBin = await writeStubHappyCli({ cliDir });
    await writeFile(join(cliDir, 'dist', 'stale-unused.mjs'), "import './missing-old-chunk.mjs';\n", 'utf-8');

    await writeFile(join(tmp, 'package.json'), '{}\n', 'utf-8');
    runGit(['init'], tmp);
    runGit(['config', 'user.email', 'test@example.com'], tmp);
    runGit(['config', 'user.name', 'Test User'], tmp);
    runGit(['add', '.'], tmp);
    runGit(['commit', '-m', 'init'], tmp);

    const cliHomeDir = join(tmp, 'stack', 'cli');
    await mkdir(cliHomeDir, { recursive: true });
    await writeFile(join(cliHomeDir, 'access.key'), 'dummy\n', 'utf-8');
    await writeFile(join(cliHomeDir, 'settings.json'), JSON.stringify({ machineId: 'test-machine' }) + '\n', 'utf-8');

    const env = buildDaemonDistGuardEnv({
      HAPPIER_STACK_CLI_BUILD: '0',
    });

    await startLocalDaemonWithAuth({
      cliBin,
      cliHomeDir,
      internalServerUrl,
      publicServerUrl,
      isShuttingDown: () => false,
      forceRestart: true,
      env,
      stackName: 'dev',
      cliIdentity: 'default',
    });

    const daemonPid = await readDaemonPid(join(cliHomeDir, 'daemon.state.json'));
    assert.ok(daemonPid > 1, 'expected daemon start to ignore unreachable stale dist modules');

    await stopLocalDaemon({
      cliBin,
      internalServerUrl,
      cliHomeDir,
      env,
    });
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('startLocalDaemonWithAuth prefers guarded dist over package-dist when both entrypoints exist', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-dist-preferred-'));
  let daemonPid = null;
  try {
    const { internalServerUrl, publicServerUrl } = await reserveLoopbackServerUrls();
    const cliDir = join(tmp, 'apps', 'cli');
    const monoRoot = join(cliDir, '..', '..');
    const distScript = `
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const home = process.env.HAPPIER_HOME_DIR || process.env.HAPPIER_STACK_CLI_HOME_DIR;
if (!home) process.exit(2);

${fakePingAwareDaemonSpawnerSource()}

if (args[0] !== 'daemon') process.exit(0);
if (args[1] === 'start') {
  startFakePingAwareDaemon(join(home, 'daemon.state.json'));
}
process.exit(0);
`;
    const { cliBinDir } = await writeStubHappierCliFiles(monoRoot, {
      packageJsonContent: '{}\n',
      distIndexScript: distScript.trimStart(),
      binHappierScript: 'process.exit(43);\n',
    });
    await mkdir(join(cliDir, 'package-dist'), { recursive: true });
    await writeFile(join(cliDir, 'package-dist', 'index.mjs'), 'process.exit(42);\n', 'utf-8');

    await writeFile(join(tmp, 'package.json'), '{}\n', 'utf-8');
    runGit(['init'], tmp);
    runGit(['config', 'user.email', 'test@example.com'], tmp);
    runGit(['config', 'user.name', 'Test User'], tmp);
    runGit(['add', '.'], tmp);
    runGit(['commit', '-m', 'init'], tmp);

    const cliHomeDir = join(tmp, 'stack', 'cli');
    await mkdir(cliHomeDir, { recursive: true });
    await writeFile(join(cliHomeDir, 'access.key'), 'dummy\n', 'utf-8');
    await writeFile(join(cliHomeDir, 'settings.json'), JSON.stringify({ machineId: 'test-machine' }) + '\n', 'utf-8');

    const cliBin = join(cliBinDir, 'happier.mjs');
    const env = buildDaemonDistGuardEnv({
      HAPPIER_STACK_CLI_BUILD: '1',
      HAPPIER_STACK_TUI: '0',
    });

    await startLocalDaemonWithAuth({
      cliBin,
      cliHomeDir,
      internalServerUrl,
      publicServerUrl,
      isShuttingDown: () => false,
      forceRestart: true,
      env,
      stackName: 'dev',
      cliIdentity: 'default',
    });

    const daemonState = JSON.parse(await readFile(join(cliHomeDir, 'daemon.state.json'), 'utf-8'));
    daemonPid = Number(daemonState.pid);
    assert.ok(daemonPid > 1, 'expected package-dist daemon to write daemon state');

    await stopLocalDaemon({
      cliBin,
      internalServerUrl,
      cliHomeDir,
      env,
    });
  } finally {
    if (daemonPid) {
      try { process.kill(daemonPid, 'SIGTERM'); } catch {}
    }
    await rm(tmp, { recursive: true, force: true });
  }
});

test('startLocalDaemonWithAuth starts from rebuilt dist when dist is missing at command resolution time', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-dist-rebuild-command-'));
  try {
    const { internalServerUrl, publicServerUrl } = await reserveLoopbackServerUrls();
    const cliDir = join(tmp, 'apps', 'cli');
    const monoRoot = join(cliDir, '..', '..');
    const distScript = `
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
if (args[0] !== 'daemon') process.exit(0);
const home = process.env.HAPPIER_HOME_DIR || process.env.HAPPIER_STACK_CLI_HOME_DIR;
if (!home) process.exit(2);
const state = join(home, 'daemon.state.json');

${fakePingAwareDaemonSpawnerSource()}

const sub = args[1] || '';

if (sub === 'stop') {
  if (existsSync(state)) {
    try {
      const pid = Number(JSON.parse(readFileSync(state, 'utf-8')).pid);
      if (Number.isFinite(pid) && pid > 1) {
        try { process.kill(pid, 'SIGTERM'); } catch {}
      }
    } catch {}
    try { rmSync(state); } catch {}
  }
  process.exit(0);
}

if (sub === 'start') {
  startFakePingAwareDaemon(state);
  process.exit(0);
}

if (sub === 'status') {
  let ok = false;
  if (existsSync(state)) {
    try {
      const pid = Number(JSON.parse(readFileSync(state, 'utf-8')).pid);
      if (Number.isFinite(pid) && pid > 1) {
        try { process.kill(pid, 0); ok = true; } catch {}
      }
    } catch {}
  }
  console.log(ok ? 'daemon: running' : 'daemon: stopped');
  process.exit(0);
}

process.exit(0);
`;
    const { cliBinDir } = await writeStubHappierCliFiles(monoRoot, {
      packageJsonContent: JSON.stringify({ scripts: { build: 'node scripts/build.mjs' } }) + '\n',
      // If daemon command resolution happens before the build creates dist/index.mjs,
      // the stale fallback path invokes this bin wrapper and the test fails.
      binHappierScript: 'process.exit(42);\n',
    });
    await mkdir(join(cliDir, 'scripts'), { recursive: true });
    await writeFile(
      join(cliDir, 'scripts', 'build.mjs'),
      `import { mkdirSync, writeFileSync } from 'node:fs';\n` +
        `import { join } from 'node:path';\n` +
      `const dist = process.env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR || process.env.HAPPIER_CLI_BUILD_OUTPUT_DIR || join(process.cwd(), 'dist');\n` +
      `mkdirSync(dist, { recursive: true });\n` +
        `writeFileSync(join(dist, 'index.mjs'), ${JSON.stringify(distScript.trimStart())}, 'utf-8');\n` +
        `writeFileSync(join(dist, '.build-manifest.json'), JSON.stringify({ fingerprint: '3333333333333333', builtAt: '2026-07-09T00:00:00.000Z', fileCount: 1, toolVersion: '1' }) + '\\n', 'utf-8');\n`,
      'utf-8',
    );

    await writeFile(join(tmp, 'package.json'), '{}\n', 'utf-8');
    runGit(['init'], tmp);
    runGit(['config', 'user.email', 'test@example.com'], tmp);
    runGit(['config', 'user.name', 'Test User'], tmp);
    runGit(['add', '.'], tmp);
    runGit(['commit', '-m', 'init'], tmp);

    const cliHomeDir = join(tmp, 'stack', 'cli');
    await mkdir(cliHomeDir, { recursive: true });
    await writeFile(join(cliHomeDir, 'access.key'), 'dummy\n', 'utf-8');
    await writeFile(join(cliHomeDir, 'settings.json'), JSON.stringify({ machineId: 'test-machine' }) + '\n', 'utf-8');

    const cliBin = join(cliBinDir, 'happier.mjs');
    const env = buildDaemonDistGuardEnv({
      HAPPIER_STACK_CLI_BUILD: '1',
      HAPPIER_STACK_TUI: '0',
    });

    await startLocalDaemonWithAuth({
      cliBin,
      cliHomeDir,
      internalServerUrl,
      publicServerUrl,
      isShuttingDown: () => false,
      forceRestart: true,
      env,
      stackName: 'dev',
      cliIdentity: 'default',
    });
    const daemonState = JSON.parse(await readFile(join(cliHomeDir, 'daemon.state.json'), 'utf-8'));
    assert.ok(Number(daemonState.pid) > 1, 'expected rebuilt dist daemon to write daemon state');

    await stopLocalDaemon({
      cliBin,
      internalServerUrl,
      cliHomeDir,
      env,
    });
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('startLocalDaemonWithAuth coalesces concurrent non-forced starts behind an active restart', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-lifecycle-lock-'));
  try {
    const { internalServerUrl, publicServerUrl } = await reserveLoopbackServerUrls();
    const cliDir = join(tmp, 'apps', 'cli');
    const cliBin = await writeSlowStartStubHappyCli({ cliDir });
    const cliHomeDir = join(tmp, 'stack', 'cli');
    const eventsPath = join(tmp, 'daemon-events.log');
    await mkdir(cliHomeDir, { recursive: true });
    await writeFile(join(cliHomeDir, 'access.key'), 'dummy\n', 'utf-8');
    await writeFile(join(cliHomeDir, 'settings.json'), JSON.stringify({ machineId: 'test-machine' }) + '\n', 'utf-8');

    const env = buildDaemonDistGuardEnv({
      HAPPIER_TEST_DAEMON_EVENTS_PATH: eventsPath,
    });

    await Promise.all([
      startLocalDaemonWithAuth({
        cliBin,
        cliHomeDir,
        internalServerUrl,
        publicServerUrl,
        isShuttingDown: () => false,
        forceRestart: true,
        env,
        stackName: 'dev',
        cliIdentity: 'default',
      }),
      (async () => {
        await new Promise((resolve) => setTimeout(resolve, 25));
        await startLocalDaemonWithAuth({
          cliBin,
          cliHomeDir,
          internalServerUrl,
          publicServerUrl,
          isShuttingDown: () => false,
          forceRestart: false,
          env,
          stackName: 'dev',
          cliIdentity: 'default',
        });
      })(),
    ]);

    const events = (await readFile(eventsPath, 'utf-8')).trim().split(/\n+/).filter(Boolean);
    assert.equal(events.filter((event) => event === 'start').length, 1);

    await stopLocalDaemon({
      cliBin,
      internalServerUrl,
      cliHomeDir,
      env,
    });
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('startLocalDaemonWithAuth keeps a running daemon when a concurrent CLI build removes dist before restart', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-dist-build-race-'));
  let daemonPid = null;
  try {
    const { internalServerUrl, publicServerUrl } = await reserveLoopbackServerUrls();
    const cliDir = join(tmp, 'apps', 'cli');
    const cliBin = await writeDelayedStopStubHappyCli({ cliDir });
    const cliHomeDir = join(tmp, 'stack', 'cli');
    const eventsPath = join(tmp, 'daemon-events.log');
    const lockPath = join(cliDir, '.dist.hstack-build.lock');
    await mkdir(cliHomeDir, { recursive: true });
    await mkdir(dirname(lockPath), { recursive: true });
    await writeFile(join(cliHomeDir, 'access.key'), 'dummy\n', 'utf-8');
    await writeFile(join(cliHomeDir, 'settings.json'), JSON.stringify({ machineId: 'test-machine' }) + '\n', 'utf-8');

    const env = buildDaemonDistGuardEnv({
      HAPPIER_TEST_DAEMON_EVENTS_PATH: eventsPath,
      HAPPIER_STACK_CLI_BUILD: '1',
    });

    await startLocalDaemonWithAuth({
      cliBin,
      cliHomeDir,
      internalServerUrl,
      publicServerUrl,
      isShuttingDown: () => false,
      forceRestart: true,
      env,
      stackName: 'dev',
      cliIdentity: 'default',
    });
    daemonPid = await readDaemonPid(join(cliHomeDir, 'daemon.state.json'));
    await writeFile(eventsPath, '', 'utf-8');

    await writeFile(
      lockPath,
      JSON.stringify({ pid: process.pid, createdAtMs: Date.now(), updatedAtMs: Date.now() }),
      'utf-8',
    );
    const releaseBuildLockAfterDistMove = (async () => {
      await new Promise((resolve) => setTimeout(resolve, 75));
      await rm(join(cliDir, '.dist.hstack-backup'), { recursive: true, force: true });
      await rename(join(cliDir, 'dist'), join(cliDir, '.dist.hstack-backup'));
      await rm(lockPath, { force: true });
    })();

    await startLocalDaemonWithAuth({
      cliBin,
      cliHomeDir,
      internalServerUrl,
      publicServerUrl,
      isShuttingDown: () => false,
      forceRestart: true,
      env,
      stackName: 'dev',
      cliIdentity: 'default',
    });
    await releaseBuildLockAfterDistMove;

    const events = (await readFile(eventsPath, 'utf-8')).trim().split(/\n+/).filter(Boolean);
    assert.deepEqual(events, []);
    assert.doesNotThrow(() => process.kill(daemonPid, 0));
    assert.equal(await readDaemonPid(join(cliHomeDir, 'daemon.state.json')), daemonPid);
  } finally {
    if (daemonPid) {
      try { process.kill(daemonPid, 'SIGTERM'); } catch {}
    }
    await rm(tmp, { recursive: true, force: true });
  }
});

test('startLocalDaemonWithAuth coalesces stale dist restarts until dist is quiescent', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-dist-restart-damper-'));
  let daemonPid = null;
  try {
    const { internalServerUrl, publicServerUrl } = await reserveLoopbackServerUrls();
    const cliDir = join(tmp, 'apps', 'cli');
    const cliBin = await writeStubHappyCli({ cliDir });
    const cliHomeDir = join(tmp, 'stack', 'cli');
    const statePath = join(cliHomeDir, 'daemon.state.json');
    const runtimeStatePath = join(tmp, 'stack.runtime.json');
    const distEntrypoint = join(cliDir, 'dist', 'index.mjs');
    await mkdir(cliHomeDir, { recursive: true });
    await writeFile(join(cliHomeDir, 'access.key'), 'dummy\n', 'utf-8');
    await writeFile(join(cliHomeDir, 'settings.json'), JSON.stringify({ machineId: 'test-machine' }) + '\n', 'utf-8');

    const env = buildDaemonDistGuardEnv({
      HAPPIER_STACK_DAEMON_DIST_RESTART_QUIET_MS: '80',
      HAPPIER_STACK_DAEMON_DIST_RESTART_MIN_INTERVAL_MS: '250',
    });

    await startLocalDaemonWithAuth({
      cliBin,
      cliHomeDir,
      internalServerUrl,
      publicServerUrl,
      runtimeStatePath,
      isShuttingDown: () => false,
      forceRestart: true,
      env,
      stackName: 'dev',
      cliIdentity: 'default',
    });
    daemonPid = await readDaemonPid(statePath);
    const distSource = await readFile(distEntrypoint, 'utf-8');

    await new Promise((resolve) => setTimeout(resolve, 25));
    await writeFile(distEntrypoint, `${distSource}\n// rebuild-one\n`, 'utf-8');
    await writeDistBuildManifestForTest(distEntrypoint, '1111111111111111');
    await startLocalDaemonWithAuth({
      cliBin,
      cliHomeDir,
      internalServerUrl,
      publicServerUrl,
      runtimeStatePath,
      isShuttingDown: () => false,
      forceRestart: false,
      env,
      stackName: 'dev',
      cliIdentity: 'default',
    });

    assert.equal(await readDaemonPid(statePath), daemonPid);

    await new Promise((resolve) => setTimeout(resolve, 100));
    await startLocalDaemonWithAuth({
      cliBin,
      cliHomeDir,
      internalServerUrl,
      publicServerUrl,
      runtimeStatePath,
      isShuttingDown: () => false,
      forceRestart: false,
      env,
      stackName: 'dev',
      cliIdentity: 'default',
    });

    const restartedPid = await readDaemonPid(statePath);
    assert.notEqual(restartedPid, daemonPid);
    daemonPid = restartedPid;

    await new Promise((resolve) => setTimeout(resolve, 25));
    await writeFile(distEntrypoint, `${distSource}\n// rebuild-two\n`, 'utf-8');
    await writeDistBuildManifestForTest(distEntrypoint, '2222222222222222');
    await new Promise((resolve) => setTimeout(resolve, 100));
    await startLocalDaemonWithAuth({
      cliBin,
      cliHomeDir,
      internalServerUrl,
      publicServerUrl,
      runtimeStatePath,
      isShuttingDown: () => false,
      forceRestart: false,
      env,
      stackName: 'dev',
      cliIdentity: 'default',
    });

    assert.equal(await readDaemonPid(statePath), restartedPid);
  } finally {
    if (daemonPid) {
      try { process.kill(daemonPid, 'SIGTERM'); } catch {}
    }
    await rm(tmp, { recursive: true, force: true });
  }
});

test('startLocalDaemonWithAuth rejects incomplete dist when index imports missing chunks', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-dist-incomplete-'));
  try {
    const { internalServerUrl, publicServerUrl } = await reserveLoopbackServerUrls();
    const cliDir = join(tmp, 'apps', 'cli');
    const cliBin = await writeStubHappyCli({ cliDir });

    // Simulate a partially built dist where entrypoint exists but references a missing chunk.
    await writeFile(
      join(cliDir, 'dist', 'index.mjs'),
      "import './doctor-missing-chunk.mjs';\nexport {};\n",
      'utf-8',
    );
    await rm(join(cliDir, 'dist', '.build-manifest.json'), { force: true });

    await writeFile(join(tmp, 'package.json'), '{}\n', 'utf-8');
    runGit(['init'], tmp);
    runGit(['config', 'user.email', 'test@example.com'], tmp);
    runGit(['config', 'user.name', 'Test User'], tmp);
    runGit(['add', '.'], tmp);
    runGit(['commit', '-m', 'init'], tmp);

    const cliHomeDir = join(tmp, 'stack', 'cli');
    await mkdir(cliHomeDir, { recursive: true });
    await writeFile(join(cliHomeDir, 'access.key'), 'dummy\n', 'utf-8');
    await writeFile(join(cliHomeDir, 'settings.json'), JSON.stringify({ machineId: 'test-machine' }) + '\n', 'utf-8');

    const env = buildDaemonDistGuardEnv({
      HAPPIER_STACK_CLI_BUILD: '0',
    });

    await assert.rejects(
      () =>
        startLocalDaemonWithAuth({
          cliBin,
          cliHomeDir,
          internalServerUrl,
          publicServerUrl,
          isShuttingDown: () => false,
          forceRestart: true,
          env,
          stackName: 'dev',
          cliIdentity: 'default',
        }),
      /dist entrypoint is missing or incomplete|missing_module/i,
    );
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('resolveGuardedLocalCliDistEntrypoint rejects local dist outside the active CLI directory', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-active-dist-guard-'));
  try {
    const activeCliDir = join(tmp, 'active', 'apps', 'cli');
    const staleCliDir = join(tmp, 'T', 'hstack-runtime-start-fixture-stale', 'apps', 'cli');
    const activeCliBin = await writeStubHappyCli({ cliDir: activeCliDir });
    const staleCliBin = await writeStubHappyCli({ cliDir: staleCliDir });

    const accepted = resolveGuardedLocalCliDistEntrypoint({
      cliBin: activeCliBin,
      activeCliDir,
    });
    assert.equal(accepted.ok, true);
    assert.equal(accepted.distEntrypoint, join(activeCliDir, 'dist', 'index.mjs'));

    const rejected = resolveGuardedLocalCliDistEntrypoint({
      cliBin: staleCliBin,
      activeCliDir,
    });
    assert.equal(rejected.ok, false);
    assert.match(rejected.reason, /outside_active_cli_dir/);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('resolveGuardedLocalCliDistEntrypoint rejects symlinked active dist outside the active CLI directory', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-active-dist-symlink-'));
  try {
    const activeCliDir = join(tmp, 'active', 'apps', 'cli');
    const staleCliDir = join(tmp, 'T', 'hstack-runtime-start-fixture-stale', 'apps', 'cli');
    const activeCliBin = await writeStubHappyCli({ cliDir: activeCliDir });
    await writeStubHappyCli({ cliDir: staleCliDir });

    await rm(join(activeCliDir, 'dist'), { recursive: true, force: true });
    await symlink(join(staleCliDir, 'dist'), join(activeCliDir, 'dist'), 'dir');

    const rejected = resolveGuardedLocalCliDistEntrypoint({
      cliBin: activeCliBin,
      activeCliDir,
    });
    assert.equal(rejected.ok, false);
    assert.match(rejected.reason, /outside_active_cli_dir/);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('createDaemonStartAttemptLogPath prunes old start-attempt logs while keeping the current one', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-start-attempt-prune-'));
  try {
    const cliHomeDir = join(tmp, 'cli-home');
    const logsDir = join(cliHomeDir, 'logs');
    await mkdir(logsDir, { recursive: true });
    for (let index = 0; index < 4; index += 1) {
      await writeFile(
        join(logsDir, `2026-06-30-10-00-0${index}-pid-100-daemon-start-attempt.log`),
        `old ${index}\n`,
        'utf-8',
      );
    }

    const currentPath = await createDaemonStartAttemptLogPath({
      cliHomeDir,
      nowMs: Date.parse('2026-06-30T10:01:00.000Z'),
      pid: 200,
      keepCount: 2,
    });

    const remaining = (await readdir(logsDir))
      .filter((file) => file.endsWith('-daemon-start-attempt.log'))
      .sort();
    assert.equal(currentPath, join(logsDir, '2026-06-30-10-01-00-pid-200-daemon-start-attempt.log'));
    assert.deepEqual(remaining, [
      '2026-06-30-10-00-03-pid-100-daemon-start-attempt.log',
      '2026-06-30-10-01-00-pid-200-daemon-start-attempt.log',
    ]);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('startLocalDaemonWithAuth accepts a runtime snapshot cli executable without requiring dist/index.mjs', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-runtime-cli-'));
  try {
    const { internalServerUrl, publicServerUrl } = await reserveLoopbackServerUrls();
    const snapshotDir = join(tmp, 'runtime', 'builds', 'snap-auth');
    const cliBin = await writeRuntimeSnapshotHappyCli({ snapshotDir });

    const cliHomeDir = join(tmp, 'stack', 'cli');
    await mkdir(cliHomeDir, { recursive: true });
    await writeFile(join(cliHomeDir, 'access.key'), 'dummy\n', 'utf-8');
    await writeFile(join(cliHomeDir, 'settings.json'), JSON.stringify({ machineId: 'test-machine' }) + '\n', 'utf-8');

    await startLocalDaemonWithAuth({
      cliBin,
      cliHomeDir,
      internalServerUrl,
      publicServerUrl,
      isShuttingDown: () => false,
      forceRestart: true,
      env: buildDaemonDistGuardEnv({
        HAPPIER_STACK_CLI_BUILD: '0',
      }),
      stackName: 'dev',
      cliIdentity: 'default',
    });

    await stopLocalDaemon({
      cliBin,
      internalServerUrl,
      cliHomeDir,
    });

    assert.ok(true);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('startLocalDaemonWithAuth prefers a runtime snapshot node entrypoint over the bundled binary when available', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-runtime-node-entrypoint-'));
  try {
    const { internalServerUrl, publicServerUrl } = await reserveLoopbackServerUrls();
    const snapshotDir = join(tmp, 'runtime', 'builds', 'snap-auth');
    const { cliBin, cliNodeEntrypoint } = await writeRuntimeSnapshotHappyCliWithNodeEntrypoint({ snapshotDir });

    const cliHomeDir = join(tmp, 'stack', 'cli');
    await mkdir(cliHomeDir, { recursive: true });
    await writeFile(join(cliHomeDir, 'access.key'), 'dummy\n', 'utf-8');
    await writeFile(join(cliHomeDir, 'settings.json'), JSON.stringify({ machineId: 'test-machine' }) + '\n', 'utf-8');

    await startLocalDaemonWithAuth({
      cliBin,
      cliNodeEntrypoint,
      cliHomeDir,
      internalServerUrl,
      publicServerUrl,
      isShuttingDown: () => false,
      forceRestart: true,
      env: buildDaemonDistGuardEnv({
        HAPPIER_STACK_CLI_BUILD: '0',
      }),
      stackName: 'dev',
      cliIdentity: 'default',
    });

    await stopLocalDaemon({
      cliBin,
      cliNodeEntrypoint,
      internalServerUrl,
      cliHomeDir,
    });

    assert.ok(true);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('startLocalDaemonWithAuth still prefers a runtime snapshot node entrypoint when the host runtime is bun', async () => {
  const restoreProcessReleaseName = overrideProcessReleaseNameForTest('bun');
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-runtime-bun-node-entrypoint-'));
  try {
    const { internalServerUrl, publicServerUrl } = await reserveLoopbackServerUrls();
    const snapshotDir = join(tmp, 'runtime', 'builds', 'snap-auth');
    const { cliBin, cliNodeEntrypoint } = await writeRuntimeSnapshotHappyCliWithNodeEntrypoint({ snapshotDir });

    const cliHomeDir = join(tmp, 'stack', 'cli');
    await mkdir(cliHomeDir, { recursive: true });
    await writeFile(join(cliHomeDir, 'access.key'), 'dummy\n', 'utf-8');
    await writeFile(join(cliHomeDir, 'settings.json'), JSON.stringify({ machineId: 'test-machine' }) + '\n', 'utf-8');

    await startLocalDaemonWithAuth({
      cliBin,
      cliNodeEntrypoint,
      cliHomeDir,
      internalServerUrl,
      publicServerUrl,
      isShuttingDown: () => false,
      forceRestart: true,
      env: buildDaemonDistGuardEnv({
        HAPPIER_STACK_CLI_BUILD: '0',
      }),
      stackName: 'dev',
      cliIdentity: 'default',
    });

    await stopLocalDaemon({
      cliBin,
      cliNodeEntrypoint,
      internalServerUrl,
      cliHomeDir,
    });

    assert.ok(true);
  } finally {
    restoreProcessReleaseName();
    await rm(tmp, { recursive: true, force: true });
  }
});

test('startLocalDaemonWithAuth runs runtime snapshot JS commands through node when no separate node entrypoint exists', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-runtime-js-command-'));
  try {
    const { internalServerUrl, publicServerUrl } = await reserveLoopbackServerUrls();
    const snapshotDir = join(tmp, 'runtime', 'builds', 'snap-auth');
    const { cliBin, cliCommand } = await writeRuntimeSnapshotHappyCliJsCommand({ snapshotDir });

    const cliHomeDir = join(tmp, 'stack', 'cli');
    await mkdir(cliHomeDir, { recursive: true });
    await writeFile(join(cliHomeDir, 'access.key'), 'dummy\n', 'utf-8');
    await writeFile(join(cliHomeDir, 'settings.json'), JSON.stringify({ machineId: 'test-machine' }) + '\n', 'utf-8');

    await startLocalDaemonWithAuth({
      cliBin,
      cliCommand,
      cliHomeDir,
      internalServerUrl,
      publicServerUrl,
      isShuttingDown: () => false,
      forceRestart: true,
      env: buildDaemonDistGuardEnv({
        HAPPIER_STACK_CLI_BUILD: '0',
      }),
      stackName: 'dev',
      cliIdentity: 'default',
    });

    await stopLocalDaemon({
      cliBin,
      cliCommand,
      internalServerUrl,
      cliHomeDir,
    });

    assert.ok(true);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('startLocalDaemonWithAuth rejects missing runtime snapshot command paths before spawning', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-runtime-missing-command-'));
  try {
    const { internalServerUrl, publicServerUrl } = await reserveLoopbackServerUrls();
    const cliHomeDir = join(tmp, 'stack', 'cli');
    await mkdir(cliHomeDir, { recursive: true });
    await writeFile(join(cliHomeDir, 'access.key'), 'dummy\n', 'utf-8');
    await writeFile(join(cliHomeDir, 'settings.json'), JSON.stringify({ machineId: 'test-machine' }) + '\n', 'utf-8');

    await assert.rejects(
      () => startLocalDaemonWithAuth({
        cliBin: join(tmp, 'runtime', 'builds', 'snap-auth', 'cli', 'happier'),
        cliNodeEntrypoint: join(tmp, 'runtime', 'builds', 'snap-auth', 'cli', 'package-dist', 'index.mjs'),
        cliCommand: join(tmp, 'runtime', 'builds', 'snap-auth', 'cli', 'happier'),
        cliHomeDir,
        internalServerUrl,
        publicServerUrl,
        isShuttingDown: () => false,
        forceRestart: true,
        env: buildDaemonDistGuardEnv({
          HAPPIER_STACK_CLI_BUILD: '0',
        }),
        stackName: 'dev',
        cliIdentity: 'default',
      }),
      /runtime snapshot.*missing|runtime launch path.*missing|missing runtime/i,
    );
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('startLocalDaemonWithAuth restarts PATH-resolved runtime commands instead of treating the command name as a dist path', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-path-runtime-command-'));
  try {
    const { internalServerUrl, publicServerUrl } = await reserveLoopbackServerUrls();
    const cliHomeDir = join(tmp, 'stack', 'cli');
    const binDir = join(tmp, 'bin');
    const { cliCommand } = await writePathResolvedRuntimeCommand({ binDir });

    await mkdir(cliHomeDir, { recursive: true });
    await writeFile(join(cliHomeDir, 'access.key'), 'dummy\n', 'utf-8');
    await writeFile(join(cliHomeDir, 'settings.json'), JSON.stringify({ machineId: 'test-machine' }) + '\n', 'utf-8');
    const statePath = join(cliHomeDir, 'daemon.state.json');

    const env = buildDaemonDistGuardEnv({
      HAPPIER_STACK_CLI_BUILD: '0',
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
    });

    await startLocalDaemonWithAuth({
      cliBin: join(tmp, 'runtime', 'cli', 'happier'),
      cliCommand,
      cliHomeDir,
      internalServerUrl,
      publicServerUrl,
      isShuttingDown: () => false,
      forceRestart: true,
      env,
      stackName: 'dev',
      cliIdentity: 'default',
    });
    const firstPid = await readDaemonPid(statePath);

    await startLocalDaemonWithAuth({
      cliBin: join(tmp, 'runtime', 'cli', 'happier'),
      cliCommand,
      cliHomeDir,
      internalServerUrl,
      publicServerUrl,
      isShuttingDown: () => false,
      forceRestart: true,
      env,
      stackName: 'dev',
      cliIdentity: 'default',
    });
    const secondPid = await readDaemonPid(statePath);

    assert.ok(Number.isFinite(firstPid) && firstPid > 0);
    assert.ok(Number.isFinite(secondPid) && secondPid > 0);
    assert.notEqual(secondPid, firstPid);

    await stopLocalDaemon({
      cliBin: join(tmp, 'runtime', 'cli', 'happier'),
      cliCommand,
      internalServerUrl,
      cliHomeDir,
      env,
    });
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('startLocalDaemonWithAuth kills the daemon from daemon.state.json when daemon stop is a no-op', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-state-fallback-'));
  try {
    const { internalServerUrl, publicServerUrl } = await reserveLoopbackServerUrls();
    const cliHomeDir = join(tmp, 'stack', 'cli');
    const binDir = join(tmp, 'bin');
    const { cliCommand } = await writePathResolvedRuntimeCommand({ binDir, stopMode: 'noop' });

    await mkdir(cliHomeDir, { recursive: true });
    await writeFile(join(cliHomeDir, 'access.key'), 'dummy\n', 'utf-8');
    await writeFile(join(cliHomeDir, 'settings.json'), JSON.stringify({ machineId: 'test-machine' }) + '\n', 'utf-8');
    const statePath = join(cliHomeDir, 'daemon.state.json');

    const env = buildDaemonDistGuardEnv({
      HAPPIER_STACK_CLI_BUILD: '0',
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
    });

    await startLocalDaemonWithAuth({
      cliBin: join(tmp, 'runtime', 'cli', 'happier'),
      cliCommand,
      cliHomeDir,
      internalServerUrl,
      publicServerUrl,
      isShuttingDown: () => false,
      forceRestart: true,
      env,
      stackName: 'dev',
      cliIdentity: 'default',
    });
    const firstPid = await readDaemonPid(statePath);

    await startLocalDaemonWithAuth({
      cliBin: join(tmp, 'runtime', 'cli', 'happier'),
      cliCommand,
      cliHomeDir,
      internalServerUrl,
      publicServerUrl,
      isShuttingDown: () => false,
      forceRestart: true,
      env,
      stackName: 'dev',
      cliIdentity: 'default',
    });
    const secondPid = await readDaemonPid(statePath);

    assert.notEqual(secondPid, firstPid);
    assert.doesNotThrow(() => process.kill(secondPid, 0));
    assert.throws(() => process.kill(firstPid, 0));

    await stopLocalDaemon({
      cliBin: join(tmp, 'runtime', 'cli', 'happier'),
      cliCommand,
      internalServerUrl,
      cliHomeDir,
      env,
    });
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
