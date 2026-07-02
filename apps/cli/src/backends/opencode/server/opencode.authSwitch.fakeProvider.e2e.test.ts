import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { access, chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, describe, expect, it } from 'vitest';

import { configuration } from '@/configuration';
import { prepareIsolatedDaemonTestHome, type PreparedDaemonTestHome } from '@/daemon/testkit/realIntegration.testkit';
import { removeSessionMarker, writeSessionMarker } from '@/daemon/sessionRegistry';
import { waitForCondition } from '@/testkit/async/waitFor';
import { spawnDetachedInlineNodeTestProcess, waitForProcessExit } from '@/testkit/process/spawn';

import { createOpenCodeConnectedServiceRuntimeAuthAdapter } from '../connectedServices/createOpenCodeConnectedServiceRuntimeAuthAdapter';
import { setOpenCodeConnectedServiceInFlightTurnProvider } from '@/daemon/connectedServices/sessionAuthSwitch/openCodeConnectedServiceInFlightTurnRegistry';
import { startManagedOpenCodeServer } from './openCodeManagedServer';
import { resolveOpenCodeManagedServerLaunchFingerprint } from './openCodeManagedServerEnv';
import {
  ensureSharedManagedOpenCodeServerBaseUrl,
  isLoopbackManagedOpenCodeBaseUrl,
  type SharedManagedOpenCodeServerState,
} from './sharedManagedServer';
import { getOpenCodeServerProcessInfoBestEffort, isOpenCodeServerPidAlive } from './openCodeServerProcessState';

type StartedManagedServer = Awaited<ReturnType<typeof startManagedOpenCodeServer>>;

function hashCommandLine(rawCommandLine: string): string {
  return createHash('sha256').update(rawCommandLine).digest('hex');
}

function readProcessStartTimeMsBestEffort(pid: number): number | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    const output = execFileSync(
      'ps',
      ['-o', 'lstart=', '-p', String(Math.floor(pid))],
      { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' },
    )
      .trim();
    if (!output) return null;
    const line = output.split('\n').map((entry) => entry.trim()).find((entry) => entry.length > 0) ?? '';
    if (!line) return null;
    const parsed = Date.parse(line);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function currentManagedServerDirs(): Readonly<{
  managedServersDir: string;
  currentStatePath: string;
}> {
  return {
    managedServersDir: join(configuration.happyHomeDir, 'opencode', 'managed-servers'),
    currentStatePath: join(configuration.happyHomeDir, 'opencode', 'current-managed-server.json'),
  };
}

async function writeManagedState(statePath: string, state: SharedManagedOpenCodeServerState): Promise<void> {
  await mkdir(dirname(statePath), { recursive: true });
  await writeFile(statePath, JSON.stringify(state), 'utf8');
}

async function readManagedState(statePath: string): Promise<SharedManagedOpenCodeServerState | null> {
  try {
    const raw = await readFile(statePath, 'utf8');
    const parsed = JSON.parse(raw) as SharedManagedOpenCodeServerState;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function killPidBestEffort(pid: number): void {
  if (!Number.isInteger(pid) || pid <= 0) return;
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    // ignore
  }
}

async function buildTrustedManagedState(params: Readonly<{
  launchFingerprint: string;
  ownerToken: string;
  server: StartedManagedServer;
}>): Promise<SharedManagedOpenCodeServerState> {
  const processInfo = getOpenCodeServerProcessInfoBestEffort(params.server.pid);
  if (!processInfo?.cmd) {
    throw new Error(`Missing process command line for PID ${params.server.pid}`);
  }
  const observedStartTimeMs = readProcessStartTimeMsBestEffort(params.server.pid);
  if (!Number.isFinite(observedStartTimeMs) || observedStartTimeMs === null || observedStartTimeMs <= 0) {
    throw new Error(`Missing process start time for PID ${params.server.pid}`);
  }
  return {
    v: 2,
    baseUrl: params.server.baseUrl,
    pid: params.server.pid,
    startedAtMs: Date.now(),
    status: 'ready',
    launchEnvFingerprint: params.launchFingerprint,
    ownerToken: params.ownerToken,
    startTimeMs: Math.floor(observedStartTimeMs),
    expectedCmdlineHash: hashCommandLine(processInfo.cmd),
    activeServerDir: configuration.activeServerDir,
    daemonInstanceId: configuration.activeServerId,
  };
}

async function createFakeOpenCodeBinary(scriptPath: string): Promise<void> {
  await writeFile(
    scriptPath,
    `#!/usr/bin/env node
const http = require('http');

function parseArg(name) {
  const prefix = name + '=';
  const raw = process.argv.find((arg) => typeof arg === 'string' && arg.startsWith(prefix)) || '';
  return raw.slice(prefix.length);
}

const hostname = parseArg('--hostname') || '127.0.0.1';
const port = Number(parseArg('--port') || '0');
if (!Number.isFinite(port) || port <= 0) {
  console.error('missing --port');
  process.exit(2);
}

const server = http.createServer((req, res) => {
  if (req.url && req.url.startsWith('/global/health')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ healthy: true, version: 'fake-opencode' }));
    return;
  }
  res.writeHead(404);
  res.end('not found');
});

server.listen(port, hostname);
const shutdown = () => server.close(() => process.exit(0));
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
setInterval(() => {}, 1 << 30);
`,
    'utf8',
  );
  await chmod(scriptPath, 0o755);
}

async function createFakeBinDir(): Promise<string> {
  const dir = join(tmpdir(), `happier-opencode-fake-bin-${randomUUID()}`);
  await rm(dir, { recursive: true, force: true }).catch(() => {});
  await mkdir(dir, { recursive: true });
  return dir;
}

async function startManagedServerResources(params: Readonly<{
  managedServersDir: string;
}>): Promise<Readonly<{
  currentServer: StartedManagedServer;
  orphanServer: StartedManagedServer;
  orphanStatePath: string;
  currentStatePath: string;
  ownerToken: string;
  orphanFingerprint: string;
}>> {
  const currentServer = await startManagedOpenCodeServer({ timeoutMs: 5_000 });
  const orphanServer = await startManagedOpenCodeServer({ timeoutMs: 5_000 });
  const ownerToken = `owner-${randomUUID()}`;
  const orphanFingerprint = `orphan-${randomUUID()}`;
  const orphanStatePath = join(params.managedServersDir, `${orphanFingerprint}.json`);
  const currentStatePath = join(configuration.happyHomeDir, 'opencode', 'current-managed-server.json');
  return {
    currentServer,
    orphanServer,
    orphanStatePath,
    currentStatePath,
    ownerToken,
    orphanFingerprint,
  };
}

describe('OpenCode auth-switch fake-provider e2e', () => {
  let preparedHome: PreparedDaemonTestHome | null = null;
  const startedServers: StartedManagedServer[] = [];
  const markerPids: number[] = [];
  let fakeBinDir: string | null = null;

  afterEach(async () => {
    setOpenCodeConnectedServiceInFlightTurnProvider(null);
    for (const markerPid of markerPids.splice(0)) {
      await removeSessionMarker(markerPid).catch(() => {});
      killPidBestEffort(markerPid);
      await waitForProcessExit(markerPid, { timeoutMs: 5_000 }).catch(() => false);
    }

    while (startedServers.length > 0) {
      const server = startedServers.pop();
      await server?.close().catch(() => {});
    }

    await preparedHome?.restore().catch(() => {});
    preparedHome = null;

    if (fakeBinDir) {
      await rm(fakeBinDir, { recursive: true, force: true }).catch(() => {});
      fakeBinDir = null;
    }
  });

  it('keeps tracked orphan fingerprints on startup scan and reaps them once no tracked claim remains', async () => {
    const localFakeBinDir = await createFakeBinDir();
    fakeBinDir = localFakeBinDir;
    const fakeOpenCodePath = join(localFakeBinDir, 'opencode');
    await createFakeOpenCodeBinary(fakeOpenCodePath);

    const homePreview = await prepareIsolatedDaemonTestHome({
      prefix: 'happier-opencode-auth-switch-startup-scan-',
      extraEnv: ({ homeDir }) => ({
        HAPPIER_OPENCODE_PATH: fakeOpenCodePath,
        HAPPIER_OPENCODE_SERVER_STATE_PATH: join(homeDir, 'opencode', 'current-managed-server.json'),
        HAPPIER_OPENCODE_AUTH_SWITCH_DRAIN_MS: '200',
      }),
    });
    preparedHome = homePreview;

    const { managedServersDir, currentStatePath } = currentManagedServerDirs();
    await mkdir(managedServersDir, { recursive: true });
    const { currentServer, orphanServer, orphanStatePath, ownerToken, orphanFingerprint } = await startManagedServerResources({
      managedServersDir,
    });
    startedServers.push(currentServer, orphanServer);

    const currentLaunchFingerprint = resolveOpenCodeManagedServerLaunchFingerprint({
      baseEnv: process.env,
      xdgRootDir: null,
      isolateConfig: false,
    });

    const currentState = await buildTrustedManagedState({
      launchFingerprint: currentLaunchFingerprint,
      ownerToken: `owner-${randomUUID()}`,
      server: currentServer,
    });
    await writeManagedState(currentStatePath, currentState);

    const orphanState = await buildTrustedManagedState({
      launchFingerprint: orphanFingerprint,
      ownerToken,
      server: orphanServer,
    });
    await writeManagedState(orphanStatePath, orphanState);

    const marker = spawnDetachedInlineNodeTestProcess('setInterval(() => {}, 1 << 30)', {
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    const markerPid = marker.pid ?? -1;
    expect(markerPid).toBeGreaterThan(0);
    markerPids.push(markerPid);
    await writeSessionMarker({
      pid: markerPid,
      happySessionId: `tracked-opencode-${markerPid}`,
      startedBy: 'daemon',
      metadata: {
        flavor: 'opencode',
        opencodeManagedServerLaunchFingerprint: orphanFingerprint,
      },
    });

    const probeHealth = async (baseUrl: string): Promise<boolean> => {
      const response = await fetch(new URL('/global/health', baseUrl).toString(), {
        signal: AbortSignal.timeout(3_000),
      }).catch(() => null);
      return response?.ok === true;
    };

    const baseUrl = await ensureSharedManagedOpenCodeServerBaseUrl({ probeHealth });
    expect(baseUrl).toBe(currentServer.baseUrl);
    expect(isLoopbackManagedOpenCodeBaseUrl(baseUrl)).toBe(true);

    await waitForCondition(async () => {
      const state = await readManagedState(orphanStatePath);
      return state !== null && isOpenCodeServerPidAlive(orphanServer.pid);
    }, { timeoutMs: 10_000, label: 'tracked orphan server to remain alive after startup scan' });

    await removeSessionMarker(markerPid);
    killPidBestEffort(markerPid);
    await waitForProcessExit(markerPid, { timeoutMs: 5_000 }).catch(() => false);

    await ensureSharedManagedOpenCodeServerBaseUrl({ probeHealth });

    await waitForCondition(
      async () => !(await pathExists(orphanStatePath)),
      { timeoutMs: 20_000, label: 'orphan managed-server state file removal after tracked claims clear' },
    );
    await waitForCondition(
      () => !isOpenCodeServerPidAlive(orphanServer.pid),
      { timeoutMs: 20_000, label: 'orphan managed-server process exit after tracked claims clear' },
    );
  }, 120_000);

  it('routes auth-switch detach through runtime adapter with tracked-claim gating before release', async () => {
    const localFakeBinDir = await createFakeBinDir();
    fakeBinDir = localFakeBinDir;
    const fakeOpenCodePath = join(localFakeBinDir, 'opencode');
    await createFakeOpenCodeBinary(fakeOpenCodePath);

    const homePreview = await prepareIsolatedDaemonTestHome({
      prefix: 'happier-opencode-auth-switch-release-',
      extraEnv: {
        HAPPIER_OPENCODE_PATH: fakeOpenCodePath,
        HAPPIER_OPENCODE_AUTH_SWITCH_DRAIN_MS: '200',
      },
    });
    preparedHome = homePreview;

    const { managedServersDir } = currentManagedServerDirs();
    await mkdir(managedServersDir, { recursive: true });

    const orphanServer = await startManagedOpenCodeServer({ timeoutMs: 5_000 });
    startedServers.push(orphanServer);
    const launchFingerprint = `release-${randomUUID()}`;
    const ownerToken = `owner-${randomUUID()}`;
    const statePath = join(managedServersDir, `${launchFingerprint}.json`);
    const state = await buildTrustedManagedState({
      launchFingerprint,
      ownerToken,
      server: orphanServer,
    });
    await writeManagedState(statePath, state);

    const markerA = spawnDetachedInlineNodeTestProcess('setInterval(() => {}, 1 << 30)', {
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    const markerB = spawnDetachedInlineNodeTestProcess('setInterval(() => {}, 1 << 30)', {
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    const markerPidA = markerA.pid ?? -1;
    const markerPidB = markerB.pid ?? -1;
    expect(markerPidA).toBeGreaterThan(0);
    expect(markerPidB).toBeGreaterThan(0);
    markerPids.push(markerPidA, markerPidB);
    for (const pid of [markerPidA, markerPidB]) {
      await writeSessionMarker({
        pid,
        happySessionId: `tracked-release-${pid}`,
        startedBy: 'daemon',
        metadata: {
          flavor: 'opencode',
          opencodeManagedServerLaunchFingerprint: launchFingerprint,
        },
      });
    }

    const runtimeAdapter = createOpenCodeConnectedServiceRuntimeAuthAdapter();
    const blockedResult = await runtimeAdapter.recoverAfterRuntimeAuthSwitch({
      target: { agentId: 'opencode', targetId: 'fake-session' },
      selection: { previousLaunchFingerprint: launchFingerprint, previousOwnerToken: ownerToken },
    }) as { detached?: boolean; detachedReason?: string; recovery?: string };
    expect(blockedResult).toMatchObject({
      detached: false,
      detachedReason: 'tracked_session_claimed',
      recovery: 'restart_rematerialize',
    });
    expect(await pathExists(statePath)).toBe(true);
    expect(isOpenCodeServerPidAlive(orphanServer.pid)).toBe(true);

    await removeSessionMarker(markerPidB);
    killPidBestEffort(markerPidB);
    await waitForProcessExit(markerPidB, { timeoutMs: 5_000 }).catch(() => false);

    const releasedResult = await runtimeAdapter.recoverAfterRuntimeAuthSwitch({
      target: { agentId: 'opencode', targetId: 'fake-session' },
      selection: { previousLaunchFingerprint: launchFingerprint, previousOwnerToken: ownerToken },
    }) as { detached?: boolean; detachedReason?: string; recovery?: string };
    expect(releasedResult).toMatchObject({
      detached: true,
      detachedReason: 'released',
      recovery: 'restart_rematerialize',
    });
    await waitForCondition(async () => !(await pathExists(statePath)), {
      timeoutMs: 20_000,
      label: 'auth-switch release state file removal',
    });
    await waitForCondition(() => !isOpenCodeServerPidAlive(orphanServer.pid), {
      timeoutMs: 20_000,
      label: 'auth-switch release process exit',
    });
  }, 120_000);

  it('defers the auth-switch release while the sole claimant has an in-flight turn, then releases at quiescence', async () => {
    // Lane F prevention end-to-end: a sole-claimant managed server (the switching session) must NOT
    // be torn down while that session still has an in-flight OpenCode turn. The release should report
    // `in_flight_turn` (server + state intact), then succeed once the turn quiesces. Exercises the
    // real wiring: in-flight-turn registry -> session-marker scan (happySessionId) -> release guard ->
    // runtime adapter reason passthrough.
    const localFakeBinDir = await createFakeBinDir();
    fakeBinDir = localFakeBinDir;
    const fakeOpenCodePath = join(localFakeBinDir, 'opencode');
    await createFakeOpenCodeBinary(fakeOpenCodePath);

    const homePreview = await prepareIsolatedDaemonTestHome({
      prefix: 'happier-opencode-auth-switch-inflight-',
      extraEnv: {
        HAPPIER_OPENCODE_PATH: fakeOpenCodePath,
        HAPPIER_OPENCODE_AUTH_SWITCH_DRAIN_MS: '200',
      },
    });
    preparedHome = homePreview;

    const { managedServersDir } = currentManagedServerDirs();
    await mkdir(managedServersDir, { recursive: true });

    const orphanServer = await startManagedOpenCodeServer({ timeoutMs: 5_000 });
    startedServers.push(orphanServer);
    const launchFingerprint = `inflight-${randomUUID()}`;
    const ownerToken = `owner-${randomUUID()}`;
    const statePath = join(managedServersDir, `${launchFingerprint}.json`);
    const state = await buildTrustedManagedState({
      launchFingerprint,
      ownerToken,
      server: orphanServer,
    });
    await writeManagedState(statePath, state);

    // A single tracked claim: the switching session itself (subtracted by allowCurrentSessionClaim,
    // so claim count alone would permit the kill — only the in-flight-turn guard holds it back).
    const marker = spawnDetachedInlineNodeTestProcess('setInterval(() => {}, 1 << 30)', {
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    const markerPid = marker.pid ?? -1;
    expect(markerPid).toBeGreaterThan(0);
    markerPids.push(markerPid);
    const happySessionId = `tracked-inflight-${markerPid}`;
    await writeSessionMarker({
      pid: markerPid,
      happySessionId,
      startedBy: 'daemon',
      metadata: {
        flavor: 'opencode',
        opencodeManagedServerLaunchFingerprint: launchFingerprint,
      },
    });

    // The session's turn is in flight.
    const turnInFlightSessionIds = new Set<string>([happySessionId]);
    setOpenCodeConnectedServiceInFlightTurnProvider((sessionId) => turnInFlightSessionIds.has(sessionId));

    const runtimeAdapter = createOpenCodeConnectedServiceRuntimeAuthAdapter();
    const blockedResult = await runtimeAdapter.recoverAfterRuntimeAuthSwitch({
      target: { agentId: 'opencode', targetId: 'fake-session' },
      selection: { previousLaunchFingerprint: launchFingerprint, previousOwnerToken: ownerToken },
    }) as { detached?: boolean; detachedReason?: string; recovery?: string };
    expect(blockedResult).toMatchObject({
      detached: false,
      detachedReason: 'in_flight_turn',
      recovery: 'restart_rematerialize',
    });
    expect(await pathExists(statePath)).toBe(true);
    expect(isOpenCodeServerPidAlive(orphanServer.pid)).toBe(true);

    // Turn quiesces (boundary reached / turn cancelled): the release now proceeds.
    turnInFlightSessionIds.clear();

    const releasedResult = await runtimeAdapter.recoverAfterRuntimeAuthSwitch({
      target: { agentId: 'opencode', targetId: 'fake-session' },
      selection: { previousLaunchFingerprint: launchFingerprint, previousOwnerToken: ownerToken },
    }) as { detached?: boolean; detachedReason?: string; recovery?: string };
    expect(releasedResult).toMatchObject({
      detached: true,
      detachedReason: 'released',
      recovery: 'restart_rematerialize',
    });
    await waitForCondition(async () => !(await pathExists(statePath)), {
      timeoutMs: 20_000,
      label: 'auth-switch in-flight release state file removal after quiescence',
    });
    await waitForCondition(() => !isOpenCodeServerPidAlive(orphanServer.pid), {
      timeoutMs: 20_000,
      label: 'auth-switch in-flight release process exit after quiescence',
    });
  }, 120_000);
});
