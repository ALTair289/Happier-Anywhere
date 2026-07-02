import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { ensureDepsInstalled, pmSpawnScript } from '../proc/pm.mjs';
import { killProcessTree, markSpawnedProcessPlannedExit, run } from '../proc/proc.mjs';
import {
  isDevRuntimeReloadIgnoredPath,
  readDevReloadWatchChangeSignature,
  resolveDevReloadPollIntervalMs,
} from './devReloadCoordinator.mjs';
import { applyHappyServerMigrations, ensureHappyServerManagedInfra } from '../server/infra/happy_server_infra.mjs';
import { applyServerLightEnvDefaults } from '../server/apply_server_light_env_defaults.mjs';
import { resolveServerDevScript } from '../server/flavor_scripts.mjs';
import { applyStackServerLoggingDefaults } from '../server/logging_env.mjs';
import { resolveStackOwnedListenPid } from '../server/listener_ownership.mjs';
import { resolveServerReadyTimeoutMs, waitForServerReady } from '../server/server.mjs';
import { isTcpPortFree, listListenPids, listListenPidsWithStatus, pickNextFreeTcpPort, waitForTcpPortFree } from '../net/ports.mjs';
import {
  createStackDevProxyRuntimePatch,
  createStackServerRuntimeProcessPatch,
  isPidAlive,
  readStackRuntimeStateFile,
  recordStackRuntimeUpdate,
} from '../stack/runtime_state.mjs';
import { getProcessGroupId, isPidOwnedByStack, killProcessGroupOwnedByStack } from '../proc/ownership.mjs';
import { watchDebounced } from '../proc/watch.mjs';
import { pickMetroPort, resolveStablePortStart } from '../expo/metro_ports.mjs';
import { waitForPgliteDirLockRelease } from '../pglite_lock.mjs';

function readPackageScripts(dir) {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8'));
    return pkg?.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {};
  } catch {
    return {};
  }
}

function getDbProviderFromServerEnv(serverEnv = {}) {
  return String(serverEnv.HAPPIER_DB_PROVIDER ?? serverEnv.HAPPY_DB_PROVIDER ?? '').trim().toLowerCase();
}

function getPgliteDbDirFromServerEnv(serverEnv = {}) {
  return String(serverEnv.HAPPIER_SERVER_LIGHT_DB_DIR ?? serverEnv.HAPPY_SERVER_LIGHT_DB_DIR ?? '').trim();
}

export function selectDevServerRestartMode({
  dbProvider,
  migrationsChanged,
  sqliteRuntimeMigrationsNoop = false,
  overlapSafeStartup = false,
} = {}) {
  const provider = String(dbProvider ?? '').trim().toLowerCase();
  if (
    provider === 'sqlite' &&
    migrationsChanged === false &&
    sqliteRuntimeMigrationsNoop === true &&
    overlapSafeStartup === true
  ) {
    return 'blueGreen';
  }
  return 'exclusiveDb';
}

const DEFAULT_SERVER_RESTART_FAILURE_POLICY = {
  maxFailures: 3,
  windowMs: 60_000,
  backoffMs: 30_000,
  recentLineLimit: 8,
};

function normalizeServerRestartFailurePolicy(policy = {}) {
  const readPositive = (name) => {
    const value = Number(policy?.[name] ?? DEFAULT_SERVER_RESTART_FAILURE_POLICY[name]);
    return Number.isFinite(value) && value > 0 ? Math.trunc(value) : DEFAULT_SERVER_RESTART_FAILURE_POLICY[name];
  };

  return {
    maxFailures: readPositive('maxFailures'),
    windowMs: readPositive('windowMs'),
    backoffMs: readPositive('backoffMs'),
    recentLineLimit: readPositive('recentLineLimit'),
  };
}

function createRecentLineBuffer(limit) {
  const max = Math.max(0, Number(limit) || 0);
  const lines = [];
  return {
    onLine({ stream, line } = {}) {
      if (max <= 0) return;
      const normalizedLine = String(line ?? '').trimEnd();
      if (!normalizedLine) return;
      lines.push({ stream: stream === 'stdout' ? 'stdout' : 'stderr', line: normalizedLine });
      while (lines.length > max) lines.shift();
    },
    snapshot() {
      return lines.slice();
    },
  };
}

function formatRecentServerOutput(lines) {
  if (!Array.isArray(lines) || lines.length === 0) return '';
  return [
    '[local] recent server output:',
    ...lines.map((entry) => `[local]   [${entry.stream}] ${entry.line}`),
  ].join('\n');
}

function createServerRestartFailureTracker({ policy, nowImpl }) {
  const normalizedPolicy = normalizeServerRestartFailurePolicy(policy);
  let failures = [];
  let backoffUntilMs = 0;

  const now = () => {
    const value = Number(nowImpl?.());
    return Number.isFinite(value) ? value : Date.now();
  };

  return {
    policy: normalizedPolicy,
    getBackoffRemainingMs() {
      return Math.max(0, backoffUntilMs - now());
    },
    reset() {
      failures = [];
      backoffUntilMs = 0;
    },
    record(failure) {
      if (!failure?.countsTowardBackoff) {
        return { count: failures.length, thresholdReached: false, backoffMs: 0 };
      }

      const currentTime = now();
      const windowStart = currentTime - normalizedPolicy.windowMs;
      failures = failures.filter((timestamp) => timestamp >= windowStart);
      failures.push(currentTime);

      if (failures.length < normalizedPolicy.maxFailures) {
        return { count: failures.length, thresholdReached: false, backoffMs: 0 };
      }

      backoffUntilMs = currentTime + normalizedPolicy.backoffMs;
      failures = [];
      return {
        count: normalizedPolicy.maxFailures,
        thresholdReached: true,
        backoffMs: normalizedPolicy.backoffMs,
      };
    },
  };
}

function classifyServerRestartFailure({ error, stage, child, oldServerStopped, recentLines }) {
  const message = error instanceof Error ? error.message : String(error);
  const exitCode = child?.exitCode;
  const signalCode = child?.signalCode;
  let kind = stage || 'restart';
  if (exitCode === 1) {
    kind = 'early_exit';
  } else if (stage === 'spawn') {
    kind = 'spawn';
  } else if (stage === 'readiness' || stage === 'ownership') {
    kind = 'readiness';
  }

  return {
    kind,
    message,
    oldServerStopped: Boolean(oldServerStopped),
    exitCode,
    signalCode,
    recentLines: Array.isArray(recentLines) ? recentLines : [],
    countsTowardBackoff: kind === 'spawn' || kind === 'readiness' || kind === 'early_exit',
  };
}

function annotateServerRestartError(error, failure) {
  const annotated = error instanceof Error ? error : new Error(String(error));
  Object.defineProperty(annotated, 'serverRestartFailure', {
    value: failure,
    enumerable: false,
    configurable: true,
  });
  return annotated;
}

async function waitForProviderDbReleaseIfNeeded(serverEnv, { waitForPgliteDirLockReleaseImpl = waitForPgliteDirLockRelease } = {}) {
  if (getDbProviderFromServerEnv(serverEnv) !== 'pglite') return;
  const dbDir = getPgliteDbDirFromServerEnv(serverEnv);
  if (!dbDir) return;
  const released = await waitForPgliteDirLockReleaseImpl(dbDir, { timeoutMs: 5_000, intervalMs: 100 });
  if (released === false) {
    throw new Error(`[local] restart refused: pglite DB lock did not release for ${dbDir}.`);
  }
}

function hasPackageScript(dir, scriptName) {
  const script = readPackageScripts(dir)?.[scriptName];
  return typeof script === 'string' && script.trim().length > 0;
}

export function createDevServerReloadDescriptors({ serverDir, existsSyncImpl = existsSync } = {}) {
  const repoRoot = resolve(serverDir, '..', '..');
  const sharedPackages = ['agents', 'cli-common', 'protocol'];
  const serverAppPaths = [
    join(serverDir, 'sources'),
    join(serverDir, 'scripts'),
    join(serverDir, 'package.json'),
    join(serverDir, 'tsconfig.json'),
    join(serverDir, 'tsconfig.build.json'),
  ];
  const serverPrismaPaths = [
    join(serverDir, 'prisma'),
  ];
  const makeDescriptor = (id, target, paths) => {
    const existingPaths = paths.filter((p) => existsSyncImpl(p));
    return {
      id,
      target,
      paths: existingPaths,
      readSignature: () => readDevServerWatchChangeSignature(existingPaths),
    };
  };

  return [
    makeDescriptor('server:app', 'server', serverAppPaths),
    makeDescriptor('server:prisma', 'server', serverPrismaPaths),
    ...sharedPackages.map((pkg) => makeDescriptor(
      `shared:${pkg}`,
      'shared',
      [
        join(repoRoot, 'packages', pkg, 'src'),
        join(repoRoot, 'packages', pkg, 'package.json'),
        join(repoRoot, 'packages', pkg, 'tsconfig.json'),
      ],
    )),
  ].filter((descriptor) => descriptor.paths.length > 0);
}

function resolveDevServerWatchPaths({ serverDir, existsSyncImpl = existsSync }) {
  return createDevServerReloadDescriptors({ serverDir, existsSyncImpl }).flatMap((descriptor) => descriptor.paths);
}

function readDevServerWatchChangeSignature(paths) {
  return readDevReloadWatchChangeSignature(paths, { ignorePath: isDevRuntimeReloadIgnoredPath });
}

function deriveServerRestartModeContext(baseContext = {}, reloadContext = {}) {
  const changedDescriptors = Array.isArray(reloadContext?.changedDescriptors)
    ? reloadContext.changedDescriptors
    : null;
  const migrationsChanged =
    typeof baseContext.migrationsChanged === 'boolean'
      ? baseContext.migrationsChanged
      : changedDescriptors
        ? changedDescriptors.includes('server:prisma')
        : undefined;

  return {
    ...baseContext,
    ...(typeof migrationsChanged === 'boolean' ? { migrationsChanged } : {}),
    sqliteRuntimeMigrationsNoop:
      typeof baseContext.sqliteRuntimeMigrationsNoop === 'boolean'
        ? baseContext.sqliteRuntimeMigrationsNoop
        : migrationsChanged === false,
    overlapSafeStartup:
      typeof baseContext.overlapSafeStartup === 'boolean'
        ? baseContext.overlapSafeStartup
        : migrationsChanged === false,
  };
}

export async function resolveStackOwnedServerListenPid(
  { serverPort, stackName, envPath },
  {
    listListenPidsImpl = listListenPids,
    isPidOwnedByStackImpl = isPidOwnedByStack,
    getProcessGroupIdImpl = getProcessGroupId,
  } = {},
) {
  return await resolveStackOwnedListenPid(
    { port: serverPort, stackName, envPath },
    { listListenPidsImpl, isPidOwnedByStackImpl, getProcessGroupIdImpl },
  );
}

async function readListenPidsForOwnership({
  serverPort,
  listListenPidsImpl = listListenPids,
  listListenPidsWithStatusImpl = listListenPidsWithStatus,
}) {
  if (typeof listListenPidsWithStatusImpl === 'function' && listListenPidsImpl === listListenPids) {
    const out = await listListenPidsWithStatusImpl(serverPort, { timeoutMs: 1000 }).catch((error) => ({
      supported: false,
      pids: [],
      reason: error instanceof Error ? error.message : 'listener-discovery-error',
    }));
    return {
      supported: out?.supported !== false,
      pids: Array.isArray(out?.pids) ? out.pids : [],
      reason: out?.reason,
    };
  }

  const pids = await listListenPidsImpl(serverPort, { timeoutMs: 1000 }).catch(() => null);
  return {
    supported: Array.isArray(pids),
    pids: Array.isArray(pids) ? pids : [],
    reason: Array.isArray(pids) ? undefined : 'listener-discovery-error',
  };
}

async function assertServerPortOwnedBySpawnedProcessGroup({
  serverPort,
  spawnedPid,
  listListenPidsImpl = listListenPids,
  listListenPidsWithStatusImpl = listListenPidsWithStatus,
  getProcessGroupIdImpl = getProcessGroupId,
}) {
  const rootPid = Number(spawnedPid);
  const listenResult = await readListenPidsForOwnership({
    serverPort,
    listListenPidsImpl,
    listListenPidsWithStatusImpl,
  });
  if (!listenResult.supported) {
    throw new Error(
      `[local] server readiness ownership could not be proven on port ${serverPort}: listener discovery unavailable` +
        (listenResult.reason ? ` (${listenResult.reason})` : '')
    );
  }

  const listenPids = listenResult.pids;
  if (!listenPids.length) {
    throw new Error(
      `[local] server readiness ownership could not be proven on port ${serverPort}: no listener PID was discovered`
    );
  }

  let rootPgid = null;

  for (const listenPid of listenPids) {
    if (Number(listenPid) === rootPid) {
      continue;
    }
    if (!rootPgid) {
      // eslint-disable-next-line no-await-in-loop
      rootPgid = await getProcessGroupIdImpl(spawnedPid).catch(() => null);
      if (!rootPgid) {
        throw new Error(
          `[local] server readiness ownership could not be proven on port ${serverPort}: ` +
            `process group unavailable for pid=${spawnedPid}, listeners=${listenPids.join(', ')}`
        );
      }
    }
    // eslint-disable-next-line no-await-in-loop
    const listenPgid = await getProcessGroupIdImpl(listenPid).catch(() => null);
    if (!listenPgid || listenPgid !== rootPgid) {
      throw new Error(
        `[local] server readiness was answered by another process on port ${serverPort}; ` +
          `spawned pid=${spawnedPid}, listeners=${listenPids.join(', ')}`
      );
    }
  }

  return Number(listenPids[0]);
}

async function isServerPortOwnedByProcessGroup({
  serverPort,
  rootPid,
  listListenPidsImpl = listListenPids,
  listListenPidsWithStatusImpl = listListenPidsWithStatus,
  getProcessGroupIdImpl = getProcessGroupId,
}) {
  try {
    await assertServerPortOwnedBySpawnedProcessGroup({
      serverPort,
      spawnedPid: rootPid,
      listListenPidsImpl,
      listListenPidsWithStatusImpl,
      getProcessGroupIdImpl,
    });
    return true;
  } catch {
    return false;
  }
}

export async function resolveStackOwnedServerRuntimePid(
  { runtimeStatePath, serverPort, stackName, envPath },
  {
    readStackRuntimeStateFileImpl = readStackRuntimeStateFile,
    isPidAliveImpl = isPidAlive,
    isPidOwnedByStackImpl = isPidOwnedByStack,
    resolveStackOwnedServerListenPidImpl = resolveStackOwnedServerListenPid,
    listListenPidsImpl = listListenPids,
    listListenPidsWithStatusImpl = listListenPidsWithStatus,
    getProcessGroupIdImpl = getProcessGroupId,
  } = {}
) {
  const state = await readStackRuntimeStateFileImpl(runtimeStatePath);
  const runtimePid = Number(state?.processes?.serverPid);
  if (Number.isFinite(runtimePid) && runtimePid > 1 && isPidAliveImpl(runtimePid)) {
    const owned = await isPidOwnedByStackImpl(runtimePid, { stackName, envPath }).catch(() => false);
    if (owned) {
      const listenerPid = await assertServerPortOwnedBySpawnedProcessGroup({
        serverPort,
        spawnedPid: runtimePid,
        listListenPidsImpl,
        listListenPidsWithStatusImpl,
        getProcessGroupIdImpl,
      }).catch(() => null);
      if (Number.isFinite(Number(listenerPid)) && Number(listenerPid) > 1) {
        return Number(listenerPid);
      }
    }
  }

  const listenPid = await resolveStackOwnedServerListenPidImpl({ serverPort, stackName, envPath });
  return Number.isFinite(Number(listenPid)) && Number(listenPid) > 1 ? Number(listenPid) : null;
}

export async function stopStackOwnedServerForRestart(
  { serverPort, runtimeStatePath, stackName, envPath },
  {
    readStackRuntimeStateFileImpl = readStackRuntimeStateFile,
    killProcessGroupOwnedByStackImpl = killProcessGroupOwnedByStack,
    isPidAliveImpl = isPidAlive,
    isPidOwnedByStackImpl = isPidOwnedByStack,
    isTcpPortFreeImpl = isTcpPortFree,
    resolveStackOwnedServerListenPidImpl = resolveStackOwnedServerListenPid,
    recordStackRuntimeUpdateImpl = recordStackRuntimeUpdate,
    waitForTcpPortFreeImpl = waitForTcpPortFree,
    listListenPidsImpl = listListenPids,
    listListenPidsWithStatusImpl = listListenPidsWithStatus,
    getProcessGroupIdImpl = getProcessGroupId,
  } = {}
) {
  const st = await readStackRuntimeStateFileImpl(runtimeStatePath);
  const pid = Number(st?.processes?.serverPid);
  let stopPid = null;
  let recordedPidAliveAndOwned = false;

  if (pid > 1 && isPidAliveImpl(pid)) {
    const owned = await isPidOwnedByStackImpl(pid, { stackName, envPath }).catch(() => false);
    recordedPidAliveAndOwned = owned;
    if (
      owned &&
      (await isServerPortOwnedByProcessGroup({
        serverPort,
        rootPid: pid,
        listListenPidsImpl,
        listListenPidsWithStatusImpl,
        getProcessGroupIdImpl,
      }))
    ) {
      stopPid = pid;
    }
  }

  if (!stopPid) {
    const free = await isTcpPortFreeImpl(serverPort, { host: '127.0.0.1' });
    if (!free) {
      const listenPid = await resolveStackOwnedServerListenPidImpl(
        { serverPort, stackName, envPath },
        { listListenPidsImpl, isPidOwnedByStackImpl, getProcessGroupIdImpl }
      );
      if (!(Number.isFinite(Number(listenPid)) && Number(listenPid) > 1)) {
        throw new Error(
          `[local] restart refused: server port ${serverPort} is occupied and the PID is not provably stack-owned.\n` +
            `[local] Fix: run 'hstack stack stop ${stackName}' then re-run, or re-run without --restart.`
        );
      }

      stopPid = Number(listenPid);
      await recordStackRuntimeUpdateImpl(
        runtimeStatePath,
        createStackServerRuntimeProcessPatch({
          listenerPid: Number(listenPid),
          wrapperPid: null,
          serverPort,
          clearProxyState: true,
        }),
      ).catch(() => {});
    } else if (recordedPidAliveAndOwned) {
      throw new Error(
        `[local] restart refused: recorded server pid ${pid} is still alive, but server port ${serverPort} has no listener proof for it.\n` +
          `[local] Fix: run 'hstack stack stop ${stackName}' then re-run, or re-run without --restart.`
      );
    }
  }

  if (stopPid) {
    const res = await killProcessGroupOwnedByStackImpl(Number(stopPid), {
      stackName,
      envPath,
      label: 'server',
      json: true,
    });
    if (!res?.killed) {
      throw new Error(
        `[local] restart refused: server port ${serverPort} is occupied by a process that could not be stopped safely.\n` +
          `[local] Fix: run 'hstack stack stop ${stackName}' then re-run, or re-run without --restart.`
      );
    }
  }

  const released = await waitForTcpPortFreeImpl(serverPort, { host: '127.0.0.1', timeoutMs: 5_000, intervalMs: 100 });
  if (!released) {
    throw new Error(`[local] restart refused: server port ${serverPort} did not release after stopping the previous server.`);
  }
}

function removeChildFromChildren(children, child) {
  const index = children.indexOf(child);
  if (index >= 0) {
    children.splice(index, 1);
  }
}

function hasChildExited(child) {
  return (
    (child?.exitCode !== null && child?.exitCode !== undefined) ||
    (child?.signalCode !== null && child?.signalCode !== undefined)
  );
}

async function recordServerRuntimePids(
  statePath,
  { listenerPid, wrapperPid, serverPort, clearProxyState = false },
  { recordStackRuntimeUpdateImpl, recordStackRuntimeServerPidsImpl } = {},
) {
  if (typeof recordStackRuntimeServerPidsImpl === 'function') {
    return await recordStackRuntimeServerPidsImpl(statePath, { listenerPid, wrapperPid, serverPort, clearProxyState });
  }
  return await recordStackRuntimeUpdateImpl(
    statePath,
    createStackServerRuntimeProcessPatch({ listenerPid, wrapperPid, serverPort, clearProxyState }),
  );
}

function mergeRuntimePatches(...patches) {
  const out = {};
  for (const patch of patches) {
    if (!patch || typeof patch !== 'object') continue;
    for (const [key, value] of Object.entries(patch)) {
      if (
        value &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        out[key] &&
        typeof out[key] === 'object' &&
        !Array.isArray(out[key])
      ) {
        out[key] = { ...out[key], ...value };
      } else {
        out[key] = value;
      }
    }
  }
  return out;
}

async function recordServerProxyRuntimeState(
  statePath,
  {
    stablePort,
    backendPort,
    proxyPid,
    listenerPid,
    wrapperPid,
    drainingPid = null,
    mode = 'proxy',
    restartMode = 'exclusiveDb',
    fallbackReason,
  },
  { recordStackRuntimeUpdateImpl, recordStackRuntimeServerPidsImpl } = {},
) {
  if (typeof recordStackRuntimeServerPidsImpl === 'function') {
    await recordStackRuntimeServerPidsImpl(statePath, { listenerPid, wrapperPid });
  }
  const serverPidPatch = createStackServerRuntimeProcessPatch({ listenerPid, wrapperPid });
  const proxyPatch = createStackDevProxyRuntimePatch({
    stablePort,
    backendPort,
    proxyPid,
    backendPid: listenerPid,
    drainingPid,
    mode,
    restartMode,
    fallbackReason,
  });
  return await recordStackRuntimeUpdateImpl(statePath, mergeRuntimePatches(serverPidPatch, proxyPatch));
}

function localServerUrlForPort(port) {
  return `http://127.0.0.1:${Number(port)}`;
}

function resolveDevProxyDrainMs(serverEnv = {}) {
  const rawValue = serverEnv.HAPPIER_STACK_DEV_PROXY_DRAIN_MS;
  if (rawValue === undefined || rawValue === null || String(rawValue).trim() === '') {
    return 2000;
  }
  const raw = Number(rawValue);
  return Number.isFinite(raw) && raw >= 0 ? Math.trunc(raw) : 2000;
}

function sleepMs(ms) {
  const delayMs = Math.max(0, Number(ms) || 0);
  if (delayMs <= 0) return Promise.resolve();
  return new Promise((resolvePromise) => setTimeout(resolvePromise, delayMs));
}

async function waitForChildExit(child, timeoutMs) {
  if (hasChildExited(child)) return true;
  if (!child || typeof child.once !== 'function') return false;

  return await new Promise((resolvePromise) => {
    let settled = false;
    let timeout = null;
    const done = (value) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      resolvePromise(value);
    };

    timeout = setTimeout(() => done(false), timeoutMs);
    child.once('exit', () => done(true));
    child.once('close', () => done(true));
  });
}

async function killServerProcessGroupForPlannedReload({
  child,
  pid,
  stackName,
  envPath,
  killProcessGroupOwnedByStackImpl,
}) {
  const clearPlannedExit = markSpawnedProcessPlannedExit(child, 'dev-reload');
  let result = null;
  try {
    result = await killProcessGroupOwnedByStackImpl(pid, { stackName, envPath, label: 'server', json: false });
  } catch (error) {
    clearPlannedExit();
    throw error;
  }
  if (!result?.killed) {
    clearPlannedExit();
  }
  return result;
}

function signalSpawnedProcessGroup(child, signal) {
  const pid = Number(child?.pid);
  if (Number.isFinite(pid) && pid > 1) {
    try {
      if (process.platform !== 'win32') {
        process.kill(-pid, signal);
      } else {
        child.kill?.(signal);
      }
      return;
    } catch {
      // Fall back to ChildProcess.kill below.
    }
  }
  try {
    child?.kill?.(signal);
  } catch {
    // ignore
  }
}

async function terminateSpawnedChildForCleanup(
  child,
  {
    killSpawnedChildImpl = killProcessTree,
    signalSpawnedProcessGroupImpl = signalSpawnedProcessGroup,
    gracefulMs = 800,
    forceMs = 300,
  } = {}
) {
  if (!child) return true;

  try {
    signalSpawnedProcessGroupImpl(child, 'SIGTERM');
  } catch {
    try {
      killSpawnedChildImpl(child, 'SIGTERM');
    } catch {
      // ignore
    }
  }
  if (hasChildExited(child)) return true;
  if (await waitForChildExit(child, gracefulMs)) return true;

  try {
    signalSpawnedProcessGroupImpl(child, 'SIGKILL');
  } catch {
    try {
      killSpawnedChildImpl(child, 'SIGKILL');
    } catch {
      // ignore
    }
  }
  return await waitForChildExit(child, forceMs);
}

async function cleanupStackSpawnedChild({
  child,
  children,
  authoritativeChild = null,
  killProcessGroupOwnedByStackImpl = killProcessGroupOwnedByStack,
  killSpawnedChildImpl = killProcessTree,
  signalSpawnedProcessGroupImpl = signalSpawnedProcessGroup,
  terminateSpawnedChildImpl,
  stackName,
  envPath,
}) {
  if (!child || authoritativeChild === child) return;
  const pid = Number(child?.pid);
  if (!Number.isFinite(pid) || pid <= 1) {
    const terminated = await (terminateSpawnedChildImpl
      ? terminateSpawnedChildImpl(child)
      : terminateSpawnedChildForCleanup(child, { killSpawnedChildImpl, signalSpawnedProcessGroupImpl }));
    if (terminated) {
      removeChildFromChildren(children, child);
    }
    return;
  }

  const res = await killProcessGroupOwnedByStackImpl(pid, {
    stackName,
    envPath,
    label: 'server',
    json: false,
  }).catch(() => ({ killed: false }));
  if (!res?.killed || res?.reason === 'killed_pid_only') {
    const terminated = await (terminateSpawnedChildImpl
      ? terminateSpawnedChildImpl(child)
      : terminateSpawnedChildForCleanup(child, { killSpawnedChildImpl, signalSpawnedProcessGroupImpl }));
    if (!terminated) return;
  }
  removeChildFromChildren(children, child);
}

export async function preflightDevServerRestart(
  { serverDir, serverEnv = {}, logger = console },
  { runImpl = run } = {},
) {
  const enabled = String(serverEnv.HAPPIER_STACK_SERVER_RESTART_PREFLIGHT ?? '').trim() !== '0';
  if (!enabled) return { ran: false, reason: 'disabled' };
  if (String(serverEnv.HAPPIER_STACK_SERVER_RESTART_PREFLIGHT_ALREADY_DONE ?? '').trim() === '1') {
    return { ran: false, reason: 'already-done' };
  }
  if (!hasPackageScript(serverDir, 'build')) return { ran: false, reason: 'missing-build-script' };

  logger.log('[local] watch: server changed → preflight build...');
  await runImpl('yarn', ['-s', 'build'], {
    cwd: serverDir,
    env: {
      ...serverEnv,
      HAPPIER_STACK_SKIP_REFRESH_DEPS: serverEnv.HAPPIER_STACK_SKIP_REFRESH_DEPS ?? '1',
    },
    stdio: 'inherit',
  });
  return { ran: true, reason: 'build-ok' };
}

export function resolveStackUiDevPortStart({ env = process.env, stackName }) {
  return resolveStablePortStart({
    env: {
      ...env,
      HAPPIER_STACK_UI_DEV_PORT_BASE: (env.HAPPIER_STACK_UI_DEV_PORT_BASE ?? '8081').toString(),
      HAPPIER_STACK_UI_DEV_PORT_RANGE: (env.HAPPIER_STACK_UI_DEV_PORT_RANGE ?? '1000').toString(),
    },
    stackName,
    baseKey: 'HAPPIER_STACK_UI_DEV_PORT_BASE',
    rangeKey: 'HAPPIER_STACK_UI_DEV_PORT_RANGE',
    defaultBase: 8081,
    defaultRange: 1000,
  });
}

export async function pickDevMetroPort({ startPort, reservedPorts = new Set(), host = '127.0.0.1' } = {}) {
  const forcedPort = (process.env.HAPPIER_STACK_UI_DEV_PORT ?? '').toString().trim();
  return await pickMetroPort({ startPort, forcedPort, reservedPorts, host });
}

export async function startDevServer({
  serverComponentName,
  serverDir,
  autostart,
  baseEnv,
  serverPort,
  serverBindPort = serverPort,
  internalServerUrl,
  publicServerUrl,
  envPath,
  stackMode,
  runtimeStatePath,
  serverAlreadyRunning,
  restart,
  children,
  spawnOptions = {},
  quiet = false,
  serverProxyRuntime = null,
}, {
  ensureDepsInstalledImpl = ensureDepsInstalled,
  preflightDevServerRestartImpl = preflightDevServerRestart,
  stopStackOwnedServerForRestartImpl = stopStackOwnedServerForRestart,
  pmSpawnScriptImpl = pmSpawnScript,
  waitForServerReadyImpl = waitForServerReady,
  listListenPidsImpl = listListenPids,
  getProcessGroupIdImpl = getProcessGroupId,
  recordStackRuntimeUpdateImpl = recordStackRuntimeUpdate,
  recordStackRuntimeServerPidsImpl = null,
  killProcessGroupOwnedByStackImpl = killProcessGroupOwnedByStack,
  killSpawnedChildImpl = killProcessTree,
  signalSpawnedProcessGroupImpl = signalSpawnedProcessGroup,
  terminateSpawnedChildImpl,
  waitForPgliteDirLockReleaseImpl = waitForPgliteDirLockRelease,
} = {}) {
  const bindPort = Number(serverBindPort || serverPort);
  const serverReadyUrl = localServerUrlForPort(bindPort);
  const serverEnv = {
    ...baseEnv,
    PORT: String(bindPort),
    PUBLIC_URL: publicServerUrl,
    // Avoid noisy failures if a previous run left the metrics port busy.
    METRICS_ENABLED: baseEnv.METRICS_ENABLED ?? 'false',
  };
  applyStackServerLoggingDefaults({ baseEnv, serverEnv });

  if (serverComponentName === 'happier-server-light') {
    applyServerLightEnvDefaults({ baseEnv, serverEnv, baseDir: autostart.baseDir });
  }

  if (serverComponentName === 'happier-server') {
    const managed = (baseEnv.HAPPIER_STACK_MANAGED_INFRA ?? '1') !== '0';
    if (managed) {
      const infra = await ensureHappyServerManagedInfra({
        stackName: autostart.stackName,
        baseDir: autostart.baseDir,
        serverPort,
        publicServerUrl,
        envPath,
        env: baseEnv,
      });
      Object.assign(serverEnv, infra.env);
    }

    const autoMigrate = (baseEnv.HAPPIER_STACK_PRISMA_MIGRATE ?? '1') !== '0';
    if (autoMigrate) {
      await applyHappyServerMigrations({ serverDir, env: serverEnv });
    }
  }

  // Ensure server deps exist before any Prisma/docker work.
  await ensureDepsInstalledImpl(serverDir, serverComponentName, { quiet, env: serverEnv });

  const prismaPush = (baseEnv.HAPPIER_STACK_PRISMA_PUSH ?? '1').toString().trim() !== '0';
  const serverScript = resolveServerDevScript({ serverComponentName, serverDir, prismaPush });

  // Restart behavior (stack-safe): only kill when we can prove ownership via runtime state.
  if (restart && stackMode && runtimeStatePath) {
    await preflightDevServerRestartImpl({ serverDir, serverComponentName, serverEnv, logger: console });
    await stopStackOwnedServerForRestartImpl(
      {
        serverPort,
        runtimeStatePath,
        stackName: autostart.stackName,
        envPath,
      },
      { killProcessGroupOwnedByStackImpl, recordStackRuntimeUpdateImpl }
    );
    await waitForProviderDbReleaseIfNeeded(serverEnv, { waitForPgliteDirLockReleaseImpl });
  }

  if (serverAlreadyRunning && !restart) {
    return { serverEnv, serverScript, serverProc: null };
  }

  const server = await pmSpawnScriptImpl({
    label: 'server',
    dir: serverDir,
    script: serverScript,
    env: serverEnv,
    options: spawnOptions,
    quiet,
  });
  children.push(server);
  let listenerPid = null;
  try {
    await waitForServerReadyImpl(internalServerUrl, {
      timeoutMs: resolveServerReadyTimeoutMs({ serverComponentName, env: serverEnv }),
      childProcess: server,
    });
    if (serverReadyUrl !== internalServerUrl) {
      await waitForServerReadyImpl(serverReadyUrl, {
        timeoutMs: resolveServerReadyTimeoutMs({ serverComponentName, env: serverEnv }),
        childProcess: server,
      });
    }
    listenerPid = await assertServerPortOwnedBySpawnedProcessGroup({
      serverPort: bindPort,
      spawnedPid: server.pid,
      listListenPidsImpl,
      getProcessGroupIdImpl,
    });
    if (hasChildExited(server)) {
      throw new Error(
        `[local] server process exited after readiness check ` +
          `(pid=${server.pid}, code=${server.exitCode ?? 'null'}, signal=${server.signalCode ?? 'null'})`
      );
    }
  } catch (error) {
    await cleanupStackSpawnedChild({
      child: server,
      children,
      killProcessGroupOwnedByStackImpl,
      killSpawnedChildImpl,
      signalSpawnedProcessGroupImpl,
      terminateSpawnedChildImpl,
      stackName: autostart.stackName,
      envPath,
    });
    throw error;
  }
  if (stackMode && runtimeStatePath) {
    if (serverProxyRuntime?.enabled) {
      await recordServerProxyRuntimeState(
        runtimeStatePath,
        {
          stablePort: serverPort,
          backendPort: bindPort,
          proxyPid: serverProxyRuntime.proxyPid,
          listenerPid,
          wrapperPid: server.pid,
          mode: serverProxyRuntime.mode ?? 'proxy',
          restartMode: serverProxyRuntime.restartMode ?? 'exclusiveDb',
          fallbackReason: serverProxyRuntime.fallbackReason,
        },
        { recordStackRuntimeUpdateImpl, recordStackRuntimeServerPidsImpl },
      ).catch(() => {});
    } else {
      await recordServerRuntimePids(
        runtimeStatePath,
        {
          listenerPid,
          wrapperPid: server.pid,
          serverPort,
          clearProxyState: true,
        },
        { recordStackRuntimeUpdateImpl, recordStackRuntimeServerPidsImpl },
      ).catch(() => {});
    }
  }
  return { serverEnv, serverScript, serverProc: server };
}

export function createDevServerReloadExecutor({
  enabled,
  stackMode,
  serverComponentName,
  serverDir,
  serverPort,
  serverBindPort = serverPort,
  internalServerUrl,
  serverScript,
  serverEnv,
  runtimeStatePath,
  stackName,
  envPath,
  children,
  serverProcRef,
  isShuttingDown,
  proxyController = null,
  serverRestartModeContext = {},
}, {
  killProcessGroupOwnedByStackImpl = killProcessGroupOwnedByStack,
  isTcpPortFreeImpl = isTcpPortFree,
  waitForTcpPortFreeImpl = waitForTcpPortFree,
  pmSpawnScriptImpl = pmSpawnScript,
  recordStackRuntimeUpdateImpl = recordStackRuntimeUpdate,
  recordStackRuntimeServerPidsImpl = null,
  waitForServerReadyImpl = waitForServerReady,
  listListenPidsImpl = listListenPids,
  getProcessGroupIdImpl = getProcessGroupId,
  isPidAliveImpl = isPidAlive,
  killSpawnedChildImpl = killProcessTree,
  signalSpawnedProcessGroupImpl = signalSpawnedProcessGroup,
  terminateSpawnedChildImpl,
  preflightDevServerRestartImpl = preflightDevServerRestart,
  waitForPgliteDirLockReleaseImpl = waitForPgliteDirLockRelease,
  pickNextFreeTcpPortImpl = pickNextFreeTcpPort,
  nowImpl = Date.now,
  restartFailurePolicy,
  logger = console,
  sleepImpl = sleepMs,
} = {}) {
  let activeBackendPort = Number(serverBindPort || serverPort);
  const restartFailureTracker = createServerRestartFailureTracker({
    policy: restartFailurePolicy,
    nowImpl,
  });

  const cleanupProvisionalChild = async (child) => {
    await cleanupStackSpawnedChild({
      child,
      children,
      authoritativeChild: serverProcRef.current,
      killProcessGroupOwnedByStackImpl,
      killSpawnedChildImpl,
      signalSpawnedProcessGroupImpl,
      terminateSpawnedChildImpl,
      stackName,
      envPath,
    });
  };

  const spawnServerBackend = async ({ port, recentLineBuffer, envOverrides = {} }) => {
    const nextEnv = { ...serverEnv, ...envOverrides, PORT: String(port) };
    let next = null;
    try {
      next = await pmSpawnScriptImpl({
        label: 'server',
        dir: serverDir,
        script: serverScript,
        env: nextEnv,
        options: { onLine: recentLineBuffer.onLine },
      });
      children.push(next);
      const readyUrl = localServerUrlForPort(port);
      await waitForServerReadyImpl(readyUrl, {
        timeoutMs: resolveServerReadyTimeoutMs({ serverComponentName, env: nextEnv }),
        childProcess: next,
      });
      const listenerPid = await assertServerPortOwnedBySpawnedProcessGroup({
        serverPort: port,
        spawnedPid: next.pid,
        listListenPidsImpl,
        getProcessGroupIdImpl,
      });
      if (hasChildExited(next)) {
        throw new Error(
          `[local] server process exited after readiness check ` +
            `(pid=${next.pid}, code=${next.exitCode ?? 'null'}, signal=${next.signalCode ?? 'null'})`
        );
      }
      return { child: next, listenerPid, readyUrl };
    } catch (error) {
      await cleanupProvisionalChild(next);
      throw error;
    }
  };

  const recordProxyBackend = async ({ backendPort, listenerPid, wrapperPid, restartMode, drainingPid = null }) => {
    if (!(stackMode && runtimeStatePath)) return;
    await recordServerProxyRuntimeState(
      runtimeStatePath,
      {
        stablePort: serverPort,
        backendPort,
        proxyPid: proxyController?.pid,
        listenerPid,
        wrapperPid,
        drainingPid,
        mode: 'proxy',
        restartMode,
      },
      { recordStackRuntimeUpdateImpl, recordStackRuntimeServerPidsImpl },
    ).catch(() => {});
  };

  const backendDrainTarget = (targetPort) => ({
    targetHost: '127.0.0.1',
    targetPort: Number(targetPort),
  });

  const normalizeDrainTarget = (target) => {
    const targetPort = Number(target?.targetPort ?? target?.port);
    if (!Number.isInteger(targetPort) || targetPort <= 0 || targetPort > 65535) return null;
    const targetHost = String(target?.targetHost ?? target?.host ?? '127.0.0.1').trim();
    return {
      targetHost: targetHost || '127.0.0.1',
      targetPort,
    };
  };

  const drainProxyTargets = async (targets, { graceMs = 0 } = {}) => {
    const seen = new Set();
    for (const target of targets) {
      const normalized = normalizeDrainTarget(target);
      if (!normalized) continue;
      const key = `${normalized.targetHost}:${normalized.targetPort}`;
      if (seen.has(key)) continue;
      seen.add(key);
      await proxyController.drainConnections?.({
        graceMs,
        targetHost: normalized.targetHost,
        targetPort: normalized.targetPort,
      });
    }
  };

  const flipProxyUpstreamAndDrainTargets = async ({
    targetPort,
    drainTargets = [],
    graceMs = resolveDevProxyDrainMs(serverEnv),
  }) => {
    proxyController.flipUpstream?.({ targetPort });
    await drainProxyTargets(drainTargets, { graceMs });
  };

  const restartWithExclusiveDbProxy = async () => {
    const currentServerProc = serverProcRef?.current;
    const pid = Number(currentServerProc?.pid);
    if (!Number.isFinite(pid) || pid <= 1) return false;

    const restartMode = 'exclusiveDb';
    const recentLineBuffer = createRecentLineBuffer(restartFailureTracker.policy.recentLineLimit);
    const oldBackendPort = activeBackendPort;
    let oldServerStopped = false;
    let replacement = null;
    let maintenanceEntered = false;
    let maintenanceTarget = null;
    let attemptedReplacementBackendPort = null;

    const enterMaintenance = async () => {
      if (maintenanceEntered) return;
      maintenanceTarget = await proxyController.enterMaintenance?.({
        retryAfterMs: Math.max(1, resolveDevProxyDrainMs(serverEnv)),
        message: 'Server reload in progress',
      });
      maintenanceEntered = true;
    };

    const ownsCurrentListener = await isServerPortOwnedByProcessGroup({
      serverPort: oldBackendPort,
      rootPid: pid,
      listListenPidsImpl,
      getProcessGroupIdImpl,
    });
    if (!ownsCurrentListener) {
      const free = await isTcpPortFreeImpl(oldBackendPort, { host: '127.0.0.1' });
      const currentPidStillAlive = !hasChildExited(currentServerProc) && isPidAliveImpl(pid);
      if (currentPidStillAlive || !free) {
        throw new Error(
          `[local] watch restart refused: server backend port ${oldBackendPort} is not provably stack-owned.\n` +
            `[local] Fix: run 'hstack stack stop ${stackName}' then re-run.`
        );
      }
      await enterMaintenance();
    } else {
      await enterMaintenance();
      const killResult = await killServerProcessGroupForPlannedReload({
        child: currentServerProc,
        pid,
        stackName,
        envPath,
        killProcessGroupOwnedByStackImpl,
      });
      if (!killResult.killed) {
        await flipProxyUpstreamAndDrainTargets({
          targetPort: oldBackendPort,
          drainTargets: [maintenanceTarget],
        });
        throw new Error(
          `[local] watch restart refused: server pid ${pid} owns backend port ${oldBackendPort} but could not be stopped safely.\n` +
            `[local] Fix: run 'hstack stack stop ${stackName}' then re-run.`
        );
      }
      oldServerStopped = true;
    }

    try {
      const released = await waitForTcpPortFreeImpl(oldBackendPort, { host: '127.0.0.1', timeoutMs: 5_000, intervalMs: 100 });
      if (!released) {
        throw new Error(`[local] watch restart refused: server backend port ${oldBackendPort} did not release after stopping pid=${pid}.`);
      }
      await waitForProviderDbReleaseIfNeeded(serverEnv, { waitForPgliteDirLockReleaseImpl });

      const nextBackendPort = await pickNextFreeTcpPortImpl(oldBackendPort + 1, {
        host: '127.0.0.1',
        reservedPorts: new Set([Number(serverPort), oldBackendPort]),
      });
      attemptedReplacementBackendPort = nextBackendPort;

      replacement = await spawnServerBackend({ port: nextBackendPort, recentLineBuffer });
      serverProcRef.current = replacement.child;
      activeBackendPort = nextBackendPort;
      await flipProxyUpstreamAndDrainTargets({
        targetPort: nextBackendPort,
        drainTargets: [maintenanceTarget, backendDrainTarget(oldBackendPort)],
      });
      await recordProxyBackend({
        backendPort: nextBackendPort,
        listenerPid: replacement.listenerPid,
        wrapperPid: replacement.child.pid,
        restartMode,
      });
      logger.log(`[local] watch: server restarted behind proxy (pid=${replacement.child.pid}, backendPort=${nextBackendPort})`);
      return true;
    } catch (error) {
      if (oldServerStopped) {
        try {
          const rollback = await spawnServerBackend({ port: oldBackendPort, recentLineBuffer });
          serverProcRef.current = rollback.child;
          activeBackendPort = oldBackendPort;
          await flipProxyUpstreamAndDrainTargets({
            targetPort: oldBackendPort,
            drainTargets: [
              maintenanceTarget,
              attemptedReplacementBackendPort ? backendDrainTarget(attemptedReplacementBackendPort) : null,
            ],
          });
          await recordProxyBackend({
            backendPort: oldBackendPort,
            listenerPid: rollback.listenerPid,
            wrapperPid: rollback.child.pid,
            restartMode,
          });
        } catch (rollbackError) {
          const rollbackMessage = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
          throw annotateServerRestartError(
            error,
            classifyServerRestartFailure({
              error: new Error(`${error instanceof Error ? error.message : String(error)}; rollback failed: ${rollbackMessage}`),
              stage: 'rollback',
              child: null,
              oldServerStopped: true,
              recentLines: recentLineBuffer.snapshot(),
            })
          );
        }
      }
      throw annotateServerRestartError(
        error,
        classifyServerRestartFailure({
          error,
          stage: 'readiness',
          child: replacement?.child ?? null,
          oldServerStopped,
          recentLines: recentLineBuffer.snapshot(),
        })
      );
    }
  };

  const restartWithBlueGreenProxy = async () => {
    const currentServerProc = serverProcRef?.current;
    const pid = Number(currentServerProc?.pid);
    if (!Number.isFinite(pid) || pid <= 1) return false;

    const restartMode = 'blueGreen';
    const recentLineBuffer = createRecentLineBuffer(restartFailureTracker.policy.recentLineLimit);
    const oldBackendPort = activeBackendPort;
    let oldListenerPid = null;

    oldListenerPid = await assertServerPortOwnedBySpawnedProcessGroup({
      serverPort: oldBackendPort,
      spawnedPid: pid,
      listListenPidsImpl,
      getProcessGroupIdImpl,
    }).catch(() => null);

    if (!(Number.isFinite(Number(oldListenerPid)) && Number(oldListenerPid) > 1)) {
      const free = await isTcpPortFreeImpl(oldBackendPort, { host: '127.0.0.1' });
      const currentPidStillAlive = !hasChildExited(currentServerProc) && isPidAliveImpl(pid);
      if (currentPidStillAlive || !free) {
        throw new Error(
          `[local] watch restart refused: server backend port ${oldBackendPort} is not provably stack-owned.\n` +
            `[local] Fix: run 'hstack stack stop ${stackName}' then re-run.`
        );
      }
      oldListenerPid = null;
    }

    const nextBackendPort = await pickNextFreeTcpPortImpl(oldBackendPort + 1, {
      host: '127.0.0.1',
      reservedPorts: new Set([Number(serverPort), oldBackendPort]),
    });

    let replacement = null;
    try {
      replacement = await spawnServerBackend({
        port: nextBackendPort,
        recentLineBuffer,
        envOverrides: { HAPPIER_STACK_MIGRATE_MODE: 'skip' },
      });
    } catch (error) {
      throw annotateServerRestartError(
        error,
        classifyServerRestartFailure({
          error,
          stage: 'readiness',
          child: replacement?.child ?? null,
          oldServerStopped: false,
          recentLines: recentLineBuffer.snapshot(),
        })
      );
    }

    serverProcRef.current = replacement.child;
    activeBackendPort = nextBackendPort;
    proxyController.flipUpstream?.({ targetPort: nextBackendPort });

    await recordProxyBackend({
      backendPort: nextBackendPort,
      listenerPid: replacement.listenerPid,
      wrapperPid: replacement.child.pid,
      drainingPid: oldListenerPid,
      restartMode,
    });

    await drainProxyTargets([backendDrainTarget(oldBackendPort)], {
      graceMs: resolveDevProxyDrainMs(serverEnv),
    });

    if (oldListenerPid) {
      const killResult = await killServerProcessGroupForPlannedReload({
        child: currentServerProc,
        pid,
        stackName,
        envPath,
        killProcessGroupOwnedByStackImpl,
      })
        .catch(() => ({ killed: false }));
      if (killResult?.killed) {
        removeChildFromChildren(children, currentServerProc);
        await recordProxyBackend({
          backendPort: nextBackendPort,
          listenerPid: replacement.listenerPid,
          wrapperPid: replacement.child.pid,
          drainingPid: null,
          restartMode,
        });
      } else {
        logger.error?.(
          `[local] watch: old server backend pid ${pid} did not stop after blue-green flip; ` +
            'leaving serverDrainingPid in runtime state for stack stop cleanup.'
        );
      }
    } else {
      removeChildFromChildren(children, currentServerProc);
      await recordProxyBackend({
        backendPort: nextBackendPort,
        listenerPid: replacement.listenerPid,
        wrapperPid: replacement.child.pid,
        drainingPid: null,
        restartMode,
      });
    }

    logger.log(`[local] watch: server blue-green restarted behind proxy (pid=${replacement.child.pid}, backendPort=${nextBackendPort})`);
    return true;
  };

  const restartOnce = async (context = {}) => {
    if (proxyController) {
      const restartMode = selectDevServerRestartMode({
        dbProvider: getDbProviderFromServerEnv(serverEnv),
        ...deriveServerRestartModeContext(serverRestartModeContext, context),
      });
      if (restartMode === 'blueGreen') {
        return await restartWithBlueGreenProxy();
      }
      return await restartWithExclusiveDbProxy();
    }

    const currentServerProc = serverProcRef?.current;
    const pid = Number(currentServerProc?.pid);
    if (!Number.isFinite(pid) || pid <= 1) return false;

    let restartStage = 'stopping-old';
    let oldServerStopped = false;
    const recentLineBuffer = createRecentLineBuffer(restartFailureTracker.policy.recentLineLimit);

    logger.log('[local] watch: server preflight passed → restarting...');
    const ownsCurrentListener = await isServerPortOwnedByProcessGroup({
      serverPort,
      rootPid: pid,
      listListenPidsImpl,
      getProcessGroupIdImpl,
    });
    if (ownsCurrentListener) {
      const killResult = await killServerProcessGroupForPlannedReload({
        child: currentServerProc,
        pid,
        stackName,
        envPath,
        killProcessGroupOwnedByStackImpl,
      });
      if (!killResult.killed) {
        throw new Error(
          `[local] watch restart refused: server pid ${pid} owns port ${serverPort} but could not be stopped safely.\n` +
          `[local] Fix: run 'hstack stack stop ${stackName}' then re-run.`
        );
      }
      oldServerStopped = true;
    } else {
      const free = await isTcpPortFreeImpl(serverPort, { host: '127.0.0.1' });
      const currentPidStillAlive = !hasChildExited(currentServerProc) && isPidAliveImpl(pid);
      if (currentPidStillAlive) {
        throw new Error(
          `[local] watch restart refused: server pid ${pid} is still alive, but port ${serverPort} has no listener proof for it.\n` +
            `[local] Fix: run 'hstack stack stop ${stackName}' then re-run.`
        );
      }
      if (!free) {
        throw new Error(
          `[local] watch restart refused: server port ${serverPort} is occupied and the running PID does not own it.\n` +
            `[local] Fix: run 'hstack stack stop ${stackName}' then re-run.`
        );
      }
    }
    const released = await waitForTcpPortFreeImpl(serverPort, { host: '127.0.0.1', timeoutMs: 5_000, intervalMs: 100 });
    if (!released) {
      const error = new Error(`[local] watch restart refused: server port ${serverPort} did not release after stopping pid=${pid}.`);
      throw annotateServerRestartError(
        error,
        classifyServerRestartFailure({
          error,
          stage: 'post-stop',
          child: null,
          oldServerStopped,
          recentLines: recentLineBuffer.snapshot(),
        })
      );
    }
    try {
      await waitForProviderDbReleaseIfNeeded(serverEnv, { waitForPgliteDirLockReleaseImpl });
    } catch (error) {
      throw annotateServerRestartError(
        error,
        classifyServerRestartFailure({
          error,
          stage: 'post-stop',
          child: null,
          oldServerStopped,
          recentLines: recentLineBuffer.snapshot(),
        })
      );
    }

    let next = null;
    let listenerPid = null;
    try {
      restartStage = 'spawn';
      next = await pmSpawnScriptImpl({
        label: 'server',
        dir: serverDir,
        script: serverScript,
        env: serverEnv,
        options: { onLine: recentLineBuffer.onLine },
      });
      children.push(next);
      restartStage = 'readiness';
      await waitForServerReadyImpl(internalServerUrl, {
        timeoutMs: resolveServerReadyTimeoutMs({ serverComponentName, env: serverEnv }),
        childProcess: next,
      });
      restartStage = 'ownership';
      listenerPid = await assertServerPortOwnedBySpawnedProcessGroup({
        serverPort,
        spawnedPid: next.pid,
        listListenPidsImpl,
        getProcessGroupIdImpl,
      });
      if (hasChildExited(next)) {
        throw new Error(
          `[local] server process exited after readiness check ` +
            `(pid=${next.pid}, code=${next.exitCode ?? 'null'}, signal=${next.signalCode ?? 'null'})`
        );
      }
    } catch (error) {
      await cleanupProvisionalChild(next);
      throw annotateServerRestartError(
        error,
        classifyServerRestartFailure({
          error,
          stage: restartStage,
          child: next,
          oldServerStopped,
          recentLines: recentLineBuffer.snapshot(),
        })
      );
    }
    serverProcRef.current = next;
    if (stackMode && runtimeStatePath) {
      await recordServerRuntimePids(
        runtimeStatePath,
        {
          listenerPid,
          wrapperPid: next.pid,
          serverPort,
          clearProxyState: true,
        },
        { recordStackRuntimeUpdateImpl, recordStackRuntimeServerPidsImpl },
      ).catch(() => {});
    }
    logger.log(`[local] watch: server restarted (pid=${next.pid}, port=${serverPort})`);
    return true;
  };

  return {
    target: 'server',
    getBackoffRemainingMs() {
      return restartFailureTracker.getBackoffRemainingMs();
    },
    recordFailure(failure) {
      return restartFailureTracker.record(failure);
    },
    resetFailureBackoff() {
      restartFailureTracker.reset();
    },
    async build() {
      if (!enabled || isShuttingDown?.()) return { skipped: true };
      await preflightDevServerRestartImpl({ serverDir, serverComponentName, serverEnv, logger });
      return { ok: true };
    },
    async restart(context = {}) {
      if (!enabled || isShuttingDown?.()) return { skipped: true };
      const backoffRemainingMs = restartFailureTracker.getBackoffRemainingMs();
      if (backoffRemainingMs > 0) {
        logger.error(
          `[local] watch: server restart suppressed; backing off for ${backoffRemainingMs}ms after repeated startup failures.`
        );
        return { skipped: true, reason: 'backoff' };
      }

      try {
        const restarted = await restartOnce(context);
        if (restarted) restartFailureTracker.reset();
        return { restarted };
      } catch (e) {
        const failure = e?.serverRestartFailure;
        if (failure?.oldServerStopped) {
          logger.error(
            '[local] watch: server restart failed after the old direct-mode server was stopped; ' +
              'direct mode cannot keep the old server serving after this point.'
          );
        } else {
          logger.error('[local] watch: server restart failed; keeping existing process as-is (will retry on next change).');
        }
        const recentOutput = formatRecentServerOutput(failure?.recentLines);
        if (recentOutput) logger.error(recentOutput);
        const backoff = restartFailureTracker.record(failure);
        if (backoff.thresholdReached) {
          logger.error(
            `[local] watch: server failed to start ${backoff.count} times within ` +
              `${restartFailureTracker.policy.windowMs}ms; backing off for ${backoff.backoffMs}ms.`
          );
        }
        throw e;
      }
    },
  };
}

export function watchDevServerAndRestart({
  enabled,
  stackMode,
  serverComponentName,
  serverDir,
  serverPort,
  internalServerUrl,
  serverScript,
  serverEnv,
  runtimeStatePath,
  stackName,
  envPath,
  children,
  serverProcRef,
  isShuttingDown,
}, {
  watchDebouncedImpl = watchDebounced,
  killProcessGroupOwnedByStackImpl = killProcessGroupOwnedByStack,
  isTcpPortFreeImpl = isTcpPortFree,
  waitForTcpPortFreeImpl = waitForTcpPortFree,
  pmSpawnScriptImpl = pmSpawnScript,
  recordStackRuntimeUpdateImpl = recordStackRuntimeUpdate,
  recordStackRuntimeServerPidsImpl = null,
  waitForServerReadyImpl = waitForServerReady,
  listListenPidsImpl = listListenPids,
  getProcessGroupIdImpl = getProcessGroupId,
  isPidAliveImpl = isPidAlive,
  killSpawnedChildImpl = killProcessTree,
  signalSpawnedProcessGroupImpl = signalSpawnedProcessGroup,
  terminateSpawnedChildImpl,
  preflightDevServerRestartImpl = preflightDevServerRestart,
  readWatchChangeSignatureImpl = readDevServerWatchChangeSignature,
  existsSyncImpl = existsSync,
  waitForPgliteDirLockReleaseImpl = waitForPgliteDirLockRelease,
  nowImpl = Date.now,
  restartFailurePolicy,
  logger = console,
} = {}) {
  if (!enabled) return null;

  // Both server flavors are spawned through plain tsx dev scripts; stack watch owns source-change restarts.
  if (serverComponentName !== 'happier-server' && serverComponentName !== 'happier-server-light') return null;

  let inFlight = false;
  let pending = false;
  const watchPaths = resolveDevServerWatchPaths({ serverDir, existsSyncImpl });
  let lastWatchSignature = readWatchChangeSignatureImpl(watchPaths);
  const restartFailureTracker = createServerRestartFailureTracker({
    policy: restartFailurePolicy,
    nowImpl,
  });

  const cleanupProvisionalChild = async (child) => {
    await cleanupStackSpawnedChild({
      child,
      children,
      authoritativeChild: serverProcRef.current,
      killProcessGroupOwnedByStackImpl,
      killSpawnedChildImpl,
      signalSpawnedProcessGroupImpl,
      terminateSpawnedChildImpl,
      stackName,
      envPath,
    });
  };

  const hasRealWatchedChange = () => {
    const nextWatchSignature = readWatchChangeSignatureImpl(watchPaths);
    if (lastWatchSignature && nextWatchSignature && nextWatchSignature === lastWatchSignature) {
      return false;
    }
    if (nextWatchSignature) {
      lastWatchSignature = nextWatchSignature;
    }
    return true;
  };

  const restartOnce = async () => {
    const currentServerProc = serverProcRef?.current;
    const pid = Number(currentServerProc?.pid);
    if (!Number.isFinite(pid) || pid <= 1) return false;

    let restartStage = 'preflight';
    let oldServerStopped = false;
    const recentLineBuffer = createRecentLineBuffer(restartFailureTracker.policy.recentLineLimit);

    await preflightDevServerRestartImpl({ serverDir, serverComponentName, serverEnv, logger });

    logger.log('[local] watch: server preflight passed → restarting...');
    restartStage = 'stopping-old';
    const ownsCurrentListener = await isServerPortOwnedByProcessGroup({
      serverPort,
      rootPid: pid,
      listListenPidsImpl,
      getProcessGroupIdImpl,
    });
    if (ownsCurrentListener) {
      const killResult = await killServerProcessGroupForPlannedReload({
        child: currentServerProc,
        pid,
        stackName,
        envPath,
        killProcessGroupOwnedByStackImpl,
      });
      if (!killResult.killed) {
        throw new Error(
          `[local] watch restart refused: server pid ${pid} owns port ${serverPort} but could not be stopped safely.\n` +
          `[local] Fix: run 'hstack stack stop ${stackName}' then re-run.`
        );
      }
      oldServerStopped = true;
    } else {
      const free = await isTcpPortFreeImpl(serverPort, { host: '127.0.0.1' });
      const currentPidStillAlive = !hasChildExited(currentServerProc) && isPidAliveImpl(pid);
      if (currentPidStillAlive) {
        throw new Error(
          `[local] watch restart refused: server pid ${pid} is still alive, but port ${serverPort} has no listener proof for it.\n` +
            `[local] Fix: run 'hstack stack stop ${stackName}' then re-run.`
        );
      }
      if (!free) {
        throw new Error(
          `[local] watch restart refused: server port ${serverPort} is occupied and the running PID does not own it.\n` +
            `[local] Fix: run 'hstack stack stop ${stackName}' then re-run.`
        );
      }
    }
    const released = await waitForTcpPortFreeImpl(serverPort, { host: '127.0.0.1', timeoutMs: 5_000, intervalMs: 100 });
    if (!released) {
      const error = new Error(`[local] watch restart refused: server port ${serverPort} did not release after stopping pid=${pid}.`);
      throw annotateServerRestartError(
        error,
        classifyServerRestartFailure({
          error,
          stage: 'post-stop',
          child: null,
          oldServerStopped,
          recentLines: recentLineBuffer.snapshot(),
        })
      );
    }
    try {
      await waitForProviderDbReleaseIfNeeded(serverEnv, { waitForPgliteDirLockReleaseImpl });
    } catch (error) {
      throw annotateServerRestartError(
        error,
        classifyServerRestartFailure({
          error,
          stage: 'post-stop',
          child: null,
          oldServerStopped,
          recentLines: recentLineBuffer.snapshot(),
        })
      );
    }

    let next = null;
    let listenerPid = null;
    try {
      restartStage = 'spawn';
      next = await pmSpawnScriptImpl({
        label: 'server',
        dir: serverDir,
        script: serverScript,
        env: serverEnv,
        options: { onLine: recentLineBuffer.onLine },
      });
      children.push(next);
      restartStage = 'readiness';
      await waitForServerReadyImpl(internalServerUrl, {
        timeoutMs: resolveServerReadyTimeoutMs({ serverComponentName, env: serverEnv }),
        childProcess: next,
      });
      restartStage = 'ownership';
      listenerPid = await assertServerPortOwnedBySpawnedProcessGroup({
        serverPort,
        spawnedPid: next.pid,
        listListenPidsImpl,
        getProcessGroupIdImpl,
      });
      if (hasChildExited(next)) {
        throw new Error(
          `[local] server process exited after readiness check ` +
            `(pid=${next.pid}, code=${next.exitCode ?? 'null'}, signal=${next.signalCode ?? 'null'})`
        );
      }
    } catch (error) {
      await cleanupProvisionalChild(next);
      throw annotateServerRestartError(
        error,
        classifyServerRestartFailure({
          error,
          stage: restartStage,
          child: next,
          oldServerStopped,
          recentLines: recentLineBuffer.snapshot(),
        })
      );
    }
    serverProcRef.current = next;
    if (stackMode && runtimeStatePath) {
      await recordServerRuntimePids(
        runtimeStatePath,
        {
          listenerPid,
          wrapperPid: next.pid,
          serverPort,
          clearProxyState: true,
        },
        { recordStackRuntimeUpdateImpl, recordStackRuntimeServerPidsImpl },
      ).catch(() => {});
    }
    logger.log(`[local] watch: server restarted (pid=${next.pid}, port=${serverPort})`);
    return true;
  };

  return watchDebouncedImpl({
    paths: (watchPaths.length ? watchPaths : [serverDir]).map((p) => resolve(p)),
    debounceMs: 600,
    readSignature: () => readWatchChangeSignatureImpl(watchPaths),
    pollIntervalMs: resolveDevReloadPollIntervalMs(serverEnv),
    onChange: async () => {
      if (isShuttingDown?.()) return;
      if (!hasRealWatchedChange()) return;
      const backoffRemainingMs = restartFailureTracker.getBackoffRemainingMs();
      if (backoffRemainingMs > 0) {
        logger.error(
          `[local] watch: server restart suppressed; backing off for ${backoffRemainingMs}ms after repeated startup failures.`
        );
        return;
      }
      if (inFlight) {
        pending = true;
        return;
      }

      inFlight = true;
      try {
        do {
          pending = false;
          if (isShuttingDown?.()) return;
          try {
            const restarted = await restartOnce();
            if (restarted) restartFailureTracker.reset();
            if (!restarted) break;
          } catch (e) {
            const msg = e instanceof Error ? e.stack || e.message : String(e);
            const failure = e?.serverRestartFailure;
            if (failure?.oldServerStopped) {
              logger.error(
                '[local] watch: server restart failed after the old direct-mode server was stopped; ' +
                  'direct mode cannot keep the old server serving after this point.'
              );
            } else {
              logger.error('[local] watch: server restart failed; keeping existing process as-is (will retry on next change).');
            }
            logger.error(msg);
            const recentOutput = formatRecentServerOutput(failure?.recentLines);
            if (recentOutput) logger.error(recentOutput);
            const backoff = restartFailureTracker.record(failure);
            if (backoff.thresholdReached) {
              logger.error(
                `[local] watch: server failed to start ${backoff.count} times within ` +
                  `${restartFailureTracker.policy.windowMs}ms; backing off for ${backoff.backoffMs}ms.`
              );
              pending = false;
            }
            if (pending) continue;
            break;
          }
        } while (pending);
      } finally {
        inFlight = false;
      }
    },
  });
}
