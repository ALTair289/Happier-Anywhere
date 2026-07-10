import { join, resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

import { ensureCliBuilt, ensureDepsInstalled } from '../proc/pm.mjs';
import { watchDebounced } from '../proc/watch.mjs';
import {
  isDevRuntimeReloadIgnoredPath,
  readDevReloadWatchChangeSignature,
  resolveDevReloadPollIntervalMs,
  startDevReloadCoordinator,
} from './devReloadCoordinator.mjs';
import { getAccountCountForServerComponent, prepareDaemonAuthSeedIfNeeded } from '../stack/startup.mjs';
import { startLocalDaemonWithAuth } from '../../daemon.mjs';
import {
  isDaemonControlRestartUnavailableError,
  pingDaemon,
  restartDaemonViaControlServer,
} from '../stack/daemonControlClient.mjs';
import {
  normalizeDaemonPid,
  normalizeDaemonPidList,
  syncStackRuntimeDaemonPidFromDaemonState,
} from '../stack/runtime_daemon_state.mjs';
import { isPidAlive, readStackRuntimeStateFile } from '../stack/runtime_state.mjs';
import { collectInternalWorkspaceDependencyNames } from '../proc/workspace_dependencies.mjs';

function collectHappyCliRuntimePackageDirs({ cliDir, repoRoot, existsSyncImpl, readFileSyncImpl, logger }) {
  const packageDirs = [];
  const visited = new Set();

  const visitPackage = (packageJsonPath) => {
    let pkgJson;
    try {
      pkgJson = JSON.parse(readFileSyncImpl(packageJsonPath, 'utf-8'));
    } catch (error) {
      logger.warn?.(
        `[local] watch: cannot read runtime dependency manifest ${packageJsonPath}: ${error instanceof Error ? error.message : String(error)}`
      );
      return;
    }

    const packageName = typeof pkgJson?.name === 'string' ? pkgJson.name : '';
    if (packageName) visited.add(packageName);
    for (const dependencyName of collectInternalWorkspaceDependencyNames(pkgJson, packageName)) {
      if (visited.has(dependencyName)) continue;
      visited.add(dependencyName);
      const packageId = dependencyName.split('/')[1] ?? '';
      const packageDir = join(repoRoot, 'packages', packageId);
      const dependencyManifest = join(packageDir, 'package.json');
      if (!packageId || !existsSyncImpl(dependencyManifest)) {
        logger.warn?.(`[local] watch: runtime dependency ${dependencyName} has no workspace manifest; it will not be watched.`);
        continue;
      }
      packageDirs.push({ id: packageId, dir: packageDir });
      visitPackage(dependencyManifest);
    }
  };

  visitPackage(join(cliDir, 'package.json'));
  return packageDirs;
}

export function createHappyCliReloadDescriptors({
  cliDir,
  existsSyncImpl = existsSync,
  readFileSyncImpl = readFileSync,
  logger = console,
} = {}) {
  const repoRoot = resolve(cliDir, '..', '..');
  const sharedPackages = collectHappyCliRuntimePackageDirs({
    cliDir,
    repoRoot,
    existsSyncImpl,
    readFileSyncImpl,
    logger,
  });
  const cliPaths = [
    join(cliDir, 'src'),
    join(cliDir, 'bin'),
    join(cliDir, 'codex'),
    join(cliDir, 'package.json'),
    join(cliDir, 'tsconfig.json'),
    join(cliDir, 'tsconfig.build.json'),
    join(cliDir, 'pkgroll.config.mjs'),
  ];
  const makeDescriptor = (id, target, paths) => {
    const existingPaths = paths.filter((p) => existsSyncImpl(p));
    return {
      id,
      target,
      paths: existingPaths,
      readSignature: () => readHappyCliWatchChangeSignature(existingPaths),
    };
  };

  return [
    makeDescriptor('daemon:cli', 'daemon', cliPaths),
    ...sharedPackages.map(({ id, dir }) => makeDescriptor(
      `shared:${id}`,
      'shared',
      [
        join(dir, 'src'),
        join(dir, 'package.json'),
        join(dir, 'tsconfig.json'),
      ],
    )),
  ].filter((descriptor) => descriptor.paths.length > 0);
}

function resolveHappyCliWatchPaths({ cliDir, existsSyncImpl = existsSync, logger = console }) {
  return createHappyCliReloadDescriptors({ cliDir, existsSyncImpl, logger }).flatMap((descriptor) => descriptor.paths);
}

function readHappyCliWatchChangeSignature(paths) {
  return readDevReloadWatchChangeSignature(paths, { ignorePath: isDevRuntimeReloadIgnoredPath });
}

function collectRuntimeDaemonPids(runtimeState) {
  const pids = [];
  const add = (value) => {
    const pid = normalizeDaemonPid(value);
    if (pid && !pids.includes(pid)) pids.push(pid);
  };
  add(runtimeState?.processes?.daemonPid);
  for (const value of normalizeDaemonPidList(runtimeState?.processes?.daemonPids)) {
    add(value);
  }
  return pids;
}

function resolveCliDistBuildManifestPath(cliDir) {
  return join(cliDir, 'dist', '.build-manifest.json');
}

function hasCliDistBuildOutput(cliDir, existsSyncImpl = existsSync) {
  return existsSyncImpl(join(cliDir, 'dist', 'index.mjs')) && existsSyncImpl(resolveCliDistBuildManifestPath(cliDir));
}

async function hasLiveRuntimeDaemonPid({
  runtimeStatePath,
}, {
  readStackRuntimeStateFileImpl = readStackRuntimeStateFile,
  isPidAliveImpl = isPidAlive,
} = {}) {
  const statePath = String(runtimeStatePath ?? '').trim();
  if (!statePath) return false;
  let runtimeState = null;
  try {
    runtimeState = await readStackRuntimeStateFileImpl(statePath);
  } catch {
    runtimeState = null;
  }
  return collectRuntimeDaemonPids(runtimeState).some((pid) => isPidAliveImpl(pid));
}

async function shouldColdStartAfterDaemonControlMiss({
  ping,
  runtimeStatePath,
}, {
  readStackRuntimeStateFileImpl = readStackRuntimeStateFile,
  isPidAliveImpl = isPidAlive,
} = {}) {
  if (ping?.ok === true) return false;
  const reason = String(ping?.reason ?? '').trim();
  if (reason === 'daemon_not_running') return true;
  if (normalizeDaemonPid(ping?.pid)) return false;
  if (await hasLiveRuntimeDaemonPid(
    { runtimeStatePath },
    { readStackRuntimeStateFileImpl, isPidAliveImpl },
  )) {
    return false;
  }
  return reason === 'missing_state';
}

export async function ensureDevCliReady(
  { cliDir, buildCli, env = process.env },
  { logger = console } = {}
) {
  await ensureDepsInstalled(cliDir, 'happier-cli', { env });
  const distEntrypoint = join(cliDir, 'dist', 'index.mjs');
  const distManifest = resolveCliDistBuildManifestPath(cliDir);

  const keepExistingDistOnBuildFailure = (error) => {
    if (!hasCliDistBuildOutput(cliDir)) return null;
    const msg = error instanceof Error ? error.stack || error.message : String(error);
    logger.warn(
      `[local] happier-cli build failed; keeping previous build output at ${distEntrypoint}.`
    );
    logger.warn(msg);
    return { built: false, reason: 'build_failed_using_existing_dist' };
  };

  let res;
  try {
    res = await ensureCliBuilt(cliDir, { buildCli, env });
  } catch (error) {
    const fallback = keepExistingDistOnBuildFailure(error);
    if (fallback) return fallback;
    throw error;
  }

  // Fail closed: dev mode must never start the daemon without a usable happier-cli build output.
  // Even if the user disabled CLI builds globally (or build mode is "never"), missing dist/manifest
  // will cause an immediate MODULE_NOT_FOUND crash or stale-runner launch when spawning the daemon.
  if (!hasCliDistBuildOutput(cliDir)) {
    // Last-chance recovery: force a build once.
    try {
      await ensureCliBuilt(cliDir, { buildCli: true, env });
    } catch (error) {
      const fallback = keepExistingDistOnBuildFailure(error);
      if (fallback) return fallback;
      throw error;
    }
    if (!hasCliDistBuildOutput(cliDir)) {
      throw new Error(
          `[local] happier-cli build output is missing.\n` +
          `Expected: ${distEntrypoint}\n` +
          `Expected build manifest: ${distManifest}\n` +
          `Fix: run the component build directly and inspect its output:\n` +
          `  cd "${cliDir}" && yarn build`
      );
    }
  }

  return res;
}

export async function prepareDaemonAuthSeed({
  rootDir,
  env,
  stackName,
  cliHomeDir,
  startDaemon,
  isInteractive,
  serverComponentName,
  serverDir,
  serverEnv,
  quiet = false,
}) {
  if (!startDaemon) return { ok: true, skipped: true, reason: 'no_daemon' };
  const acct = await getAccountCountForServerComponent({
    serverComponentName,
    serverDir,
    env: serverEnv,
    // This probe is used only for auth seeding heuristics (and should never block stack startup).
    // For server-light (embedded PGlite), avoid doing anything that could fight for the single-connection DB.
    bestEffort: true,
  });
  return await prepareDaemonAuthSeedIfNeeded({
    rootDir,
    env,
    stackName,
    cliHomeDir,
    startDaemon,
    isInteractive,
    accountCount: typeof acct.accountCount === 'number' ? acct.accountCount : null,
    quiet,
    // IMPORTANT: run auth seeding under the same env used for server probes (includes DATABASE_URL).
    authEnv: serverEnv,
  });
}

export async function startDevDaemon({
  startDaemon,
  cliBin,
  cliHomeDir,
  internalServerUrl,
  publicServerUrl,
  runtimeStatePath = null,
  restart,
  isShuttingDown,
  env = process.env,
  stackName = null,
  cliIdentity = 'default',
}, {
  startLocalDaemonWithAuthImpl = startLocalDaemonWithAuth,
} = {}) {
  if (!startDaemon) return;

  await startLocalDaemonWithAuthImpl({
    cliBin,
    cliHomeDir,
    internalServerUrl,
    publicServerUrl,
    runtimeStatePath,
    isShuttingDown,
    forceRestart: Boolean(restart),
    env,
    stackName,
    cliIdentity,
  });
}

export function createHappyCliReloadExecutor({
  startDaemon,
  buildCli,
  cliDir,
  cliBin,
  cliHomeDir,
  internalServerUrl,
  publicServerUrl,
  runtimeStatePath = null,
  isShuttingDown,
  env = process.env,
  stackName = null,
  cliIdentity = 'default',
}, {
  ensureCliBuiltImpl = ensureCliBuilt,
  startLocalDaemonWithAuthImpl = startLocalDaemonWithAuth,
  pingDaemonImpl = pingDaemon,
  restartDaemonViaControlServerImpl = restartDaemonViaControlServer,
  syncStackRuntimeDaemonPidFromDaemonStateImpl = syncStackRuntimeDaemonPidFromDaemonState,
  readStackRuntimeStateFileImpl = readStackRuntimeStateFile,
  isPidAliveImpl = isPidAlive,
  existsSyncImpl = existsSync,
  logger = console,
} = {}) {
  return {
    target: 'daemon',
    async build() {
      if (!startDaemon) {
        logger.warn('[local] watch: happier-cli reload skipped (daemon-disabled).');
        return { skipped: true, reason: 'daemon-disabled' };
      }
      logger.log('[local] watch: happier-cli changed → rebuilding + restarting daemon...');
      const buildResult = await ensureCliBuiltImpl(cliDir, { buildCli });

      const distEntrypoint = join(cliDir, 'dist', 'index.mjs');
      const distManifest = resolveCliDistBuildManifestPath(cliDir);
      if (!hasCliDistBuildOutput(cliDir, existsSyncImpl)) {
        throw new Error(
          `[local] watch: happier-cli build did not produce ${distEntrypoint} and build manifest ${distManifest}; refusing to restart daemon to avoid downtime.`
        );
      }
      if (buildResult?.built === false && buildResult.reason !== 'concurrent_build_already_completed') {
        logger.warn(
          `[local] watch: happier-cli rebuild skipped (${buildResult.reason ?? 'unknown'}); keeping the current daemon running.`
        );
        return { skipped: true, reason: `cli-build-${buildResult.reason ?? 'unknown'}` };
      }
      return { ok: true };
    },
    async restart() {
      if (!startDaemon || isShuttingDown?.()) return { skipped: true, reason: 'daemon-disabled' };
      const coldStart = async () => {
        await startLocalDaemonWithAuthImpl({
          cliBin,
          cliHomeDir,
          internalServerUrl,
          publicServerUrl,
          runtimeStatePath,
          isShuttingDown,
          forceRestart: false,
          preserveExistingRunning: true,
          env,
          stackName,
          cliIdentity,
        });
        return { restarted: true, mode: 'cold-start' };
      };
      const ping = await pingDaemonImpl({
        cliHomeDir,
        serverUrl: internalServerUrl,
        internalServerUrl,
        env,
        stackName,
      });
      if (ping?.ok === true) {
        try {
          await restartDaemonViaControlServerImpl({
            cliHomeDir,
            internalServerUrl,
            env,
            stackName,
          });
        } catch (error) {
          if (!isDaemonControlRestartUnavailableError(error)) {
            throw error;
          }
          logger.warn('[local] watch: daemon control /restart is unavailable; keeping the current daemon running.');
          return { skipped: true, reason: 'daemon-control-restart-unavailable' };
        }
        if (runtimeStatePath) {
          await syncStackRuntimeDaemonPidFromDaemonStateImpl({
            runtimeStatePath,
            cliHomeDir,
            internalServerUrl,
            env,
          });
        }
        return { restarted: true, mode: 'overlap' };
      }

      const canColdStart = await shouldColdStartAfterDaemonControlMiss(
        { ping, runtimeStatePath },
        { readStackRuntimeStateFileImpl, isPidAliveImpl },
      );
      if (!canColdStart) {
        logger.warn(
          `[local] watch: daemon control is unavailable (${ping?.reason ?? 'unknown'}); keeping the current daemon running.`
        );
        return { skipped: true, reason: `daemon-control-unavailable:${ping?.reason ?? 'unknown'}` };
      }
      return await coldStart();
    },
  };
}

export function watchHappyCliAndRestartDaemon({
  enabled,
  startDaemon,
  buildCli,
  cliDir,
  cliBin,
  cliHomeDir,
  internalServerUrl,
  publicServerUrl,
  runtimeStatePath = null,
  isShuttingDown,
  env = process.env,
  stackName = null,
  cliIdentity = 'default',
}, {
  watchDebouncedImpl = watchDebounced,
  ensureCliBuiltImpl = ensureCliBuilt,
  startLocalDaemonWithAuthImpl = startLocalDaemonWithAuth,
  pingDaemonImpl = pingDaemon,
  restartDaemonViaControlServerImpl = restartDaemonViaControlServer,
  syncStackRuntimeDaemonPidFromDaemonStateImpl = syncStackRuntimeDaemonPidFromDaemonState,
  readStackRuntimeStateFileImpl = readStackRuntimeStateFile,
  isPidAliveImpl = isPidAlive,
  readWatchChangeSignatureImpl = readHappyCliWatchChangeSignature,
  existsSyncImpl = existsSync,
  logger = console,
} = {}) {
  if (!enabled || !startDaemon) return null;

  // IMPORTANT:
  // Watch only source/config paths, not build outputs. Watching the whole repo can
  // trigger rebuild loops because `yarn build` writes to `dist/` (and may touch other
  // generated files), which then retriggers the watcher.
  const watchPaths = resolveHappyCliWatchPaths({ cliDir, existsSyncImpl, logger });
  let missingPathEventSignature = 0;

  return startDevReloadCoordinator({
    enabled: true,
    descriptors: [{
      id: 'daemon:cli',
      target: 'daemon',
      paths: watchPaths.length ? watchPaths : [cliDir],
      readSignature: () => readWatchChangeSignatureImpl(watchPaths) ?? `missing:${missingPathEventSignature++}`,
    }],
    executors: [
      createHappyCliReloadExecutor(
        {
          startDaemon,
          buildCli,
          cliDir,
          cliBin,
          cliHomeDir,
          internalServerUrl,
          publicServerUrl,
          runtimeStatePath,
          isShuttingDown,
          env,
          stackName,
          cliIdentity,
        },
        {
          ensureCliBuiltImpl,
          startLocalDaemonWithAuthImpl,
          pingDaemonImpl,
          restartDaemonViaControlServerImpl,
          syncStackRuntimeDaemonPidFromDaemonStateImpl,
          readStackRuntimeStateFileImpl,
          isPidAliveImpl,
          existsSyncImpl,
          logger,
        }
      ),
    ],
    debounceMs: 500,
    pollIntervalMs: resolveDevReloadPollIntervalMs(env),
    isShuttingDown,
    logger,
  }, {
    watchDebouncedImpl,
  });
}
