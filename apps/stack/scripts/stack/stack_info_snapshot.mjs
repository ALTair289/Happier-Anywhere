import { parseEnvToObject } from '../utils/env/dotenv.mjs';
import { getComponentDir, resolveStackEnvPath } from '../utils/paths/paths.mjs';
import { getEnvValueAny } from '../utils/env/values.mjs';
import { resolveLocalhostHost, preferStackLocalhostUrl } from '../utils/paths/localhost_host.mjs';
import { worktreeSpecFromDir } from '../utils/git/worktrees.mjs';
import { getStackRuntimeStatePath, isPidAlive, readStackRuntimeStateFile } from '../utils/stack/runtime_state.mjs';
import { isTcpPortListening, listListenPidsWithStatus } from '../utils/net/ports.mjs';
import { getProcessGroupId, isPidOwnedByStack } from '../utils/proc/ownership.mjs';
import { readTextOrEmpty } from '../utils/fs/ops.mjs';
import { resolveDefaultRepoEnv } from './stack_environment.mjs';
import { resolveStackRuntimeMode } from '../runtime/shared/runtime_mode.mjs';
import { inspectActiveRuntimeSnapshot } from '../runtime/launch/inspectActiveRuntimeSnapshot.mjs';
import { getObservedStackDaemonAsync, readStackRuntimeStateWithDaemonSync } from '../utils/stack/runtime_daemon_state.mjs';
import { applyStackActiveServerScopeEnv } from '../utils/auth/stable_scope_id.mjs';
import { join } from 'node:path';
import { checkDaemonStatePingAware } from '../daemon.mjs';

const readExistingEnv = readTextOrEmpty;

function normalizePid(value) {
  const pid = Number(value);
  return Number.isFinite(pid) && pid > 1 ? pid : null;
}

function normalizePort(value) {
  const port = Number(value);
  return Number.isFinite(port) && port > 0 ? port : null;
}

async function resolveStackComponentRuntime({
  port,
  recordedPid,
  stackName,
  envPath,
  cliHomeDir,
  listListenPidsWithStatusImpl = listListenPidsWithStatus,
  isTcpPortListeningImpl = isTcpPortListening,
}) {
  const expectedPort = normalizePort(port);
  const runtimePid = normalizePid(recordedPid);
  const runtimePidAlive = runtimePid ? isPidAlive(runtimePid) : false;

  if (!expectedPort) {
    return {
      pid: runtimePid,
      running: runtimePidAlive,
      pidAlive: runtimePidAlive,
      portListening: false,
      listenerPids: [],
      ownedListenerPids: [],
      listenerDiscoverySupported: false,
    };
  }

  const listenerStatus = await listListenPidsWithStatusImpl(expectedPort).catch((error) => ({
    supported: false,
    pids: [],
    reason: error instanceof Error ? error.message : String(error),
  }));
  const listenerPids = Array.from(
    new Set(
      (Array.isArray(listenerStatus?.pids) ? listenerStatus.pids : [])
        .map((pid) => normalizePid(pid))
        .filter(Boolean)
    )
  );
  const portListening =
    listenerPids.length > 0 ||
    (await isTcpPortListeningImpl(expectedPort, { host: '127.0.0.1' }).catch(() => false));

  const ownedListenerPids = [];
  for (const pid of listenerPids) {
    if (runtimePidAlive && pid === runtimePid) {
      ownedListenerPids.push(pid);
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    if (await isPidOwnedByStack(pid, { stackName, envPath, cliHomeDir })) {
      ownedListenerPids.push(pid);
      continue;
    }
    if (runtimePidAlive && runtimePid) {
      // eslint-disable-next-line no-await-in-loop
      const [runtimePgid, listenerPgid] = await Promise.all([getProcessGroupId(runtimePid), getProcessGroupId(pid)]);
      if (runtimePgid && runtimePgid === runtimePid && listenerPgid === runtimePgid) {
        ownedListenerPids.push(pid);
      }
    }
  }

  const effectivePid = ownedListenerPids[0] ?? runtimePid;
  const effectivePidAlive = effectivePid ? isPidAlive(effectivePid) : false;
  const running =
    ownedListenerPids.length > 0 ||
    (listenerStatus?.supported !== true && runtimePidAlive && portListening);

  return {
    pid: effectivePid,
    running,
    pidAlive: effectivePidAlive,
    portListening,
    listenerPids,
    ownedListenerPids,
    listenerDiscoverySupported: listenerStatus?.supported === true,
  };
}

export async function readStackInfoSnapshot({
  rootDir,
  stackName,
  listListenPidsWithStatusImpl = listListenPidsWithStatus,
  isTcpPortListeningImpl = isTcpPortListening,
}) {
  const baseDir = resolveStackEnvPath(stackName).baseDir;
  const envPath = resolveStackEnvPath(stackName).envPath;
  const envRaw = await readExistingEnv(envPath);
  const stackEnv = envRaw ? parseEnvToObject(envRaw) : {};
  const runtimeStatePath = getStackRuntimeStatePath(stackName);

  const serverComponent = getEnvValueAny(stackEnv, ['HAPPIER_STACK_SERVER_COMPONENT']) || 'happier-server-light';
  const stackRemote = getEnvValueAny(stackEnv, ['HAPPIER_STACK_STACK_REMOTE']) || 'upstream';

  const pinnedServerPortRaw = getEnvValueAny(stackEnv, ['HAPPIER_STACK_SERVER_PORT']);
  const pinnedServerPort = pinnedServerPortRaw ? Number(pinnedServerPortRaw) : null;
  const stackScopedEnv = applyStackActiveServerScopeEnv({
    env: {
      ...process.env,
      ...stackEnv,
      HAPPIER_STACK_STACK: stackName,
      HAPPIER_STACK_ENV_FILE: envPath,
      HAPPIER_STACK_CLI_HOME_DIR: join(baseDir, 'cli'),
    },
    stackName,
    cliIdentity: 'default',
  });
  const initialRuntimeState = await readStackRuntimeStateFile(runtimeStatePath);
  const initialRuntimePorts =
    initialRuntimeState?.ports && typeof initialRuntimeState.ports === 'object' ? initialRuntimeState.ports : {};
  const syncServerPort =
    Number.isFinite(pinnedServerPort) && pinnedServerPort > 0
      ? pinnedServerPort
      : Number(initialRuntimePorts?.server) > 0
        ? Number(initialRuntimePorts.server)
        : null;
  const runtimeState = await readStackRuntimeStateWithDaemonSync({
    runtimeStatePath,
    cliHomeDir: join(baseDir, 'cli'),
    internalServerUrl: Number.isFinite(syncServerPort) && syncServerPort > 0 ? `http://127.0.0.1:${syncServerPort}` : '',
    env: stackScopedEnv,
  }, {
    checkDaemonStateImpl: checkDaemonStatePingAware,
  });

  const runtimePorts = runtimeState?.ports && typeof runtimeState.ports === 'object' ? runtimeState.ports : {};
  const serverPort =
    Number.isFinite(pinnedServerPort) && pinnedServerPort > 0
      ? pinnedServerPort
      : Number(runtimePorts?.server) > 0
        ? Number(runtimePorts.server)
        : null;
  const backendPort = Number(runtimePorts?.backend) > 0 ? Number(runtimePorts.backend) : null;
  const serverBackendPort = Number(runtimePorts?.serverBackend) > 0 ? Number(runtimePorts.serverBackend) : null;
  const uiPort =
    runtimeState?.expo && typeof runtimeState.expo === 'object' && Number(runtimeState.expo.webPort) > 0
      ? Number(runtimeState.expo.webPort)
      : null;
  const mobilePort =
    runtimeState?.expo && typeof runtimeState.expo === 'object' && Number(runtimeState.expo.mobilePort) > 0
      ? Number(runtimeState.expo.mobilePort)
      : null;
  const ownerPid = normalizePid(runtimeState?.ownerPid);
  const serverProxy =
    runtimeState?.serverProxy && typeof runtimeState.serverProxy === 'object' ? runtimeState.serverProxy : null;
  const proxyMode = String(serverProxy?.mode ?? '').trim();
  const serverPid = normalizePid(runtimeState?.processes?.serverPid);
  const proxyPid = normalizePid(runtimeState?.processes?.proxyPid);
  const serverBackendPid = normalizePid(runtimeState?.processes?.serverBackendPid);
  const serverDrainingPid = normalizePid(runtimeState?.processes?.serverDrainingPid);
  const expoPid = normalizePid(runtimeState?.processes?.expoPid);
  const expoTailscaleForwarderPid = normalizePid(runtimeState?.processes?.expoTailscaleForwarderPid);
  const daemonExpected = String(getEnvValueAny(stackEnv, ['HAPPIER_STACK_DAEMON']) ?? '1').trim() !== '0';
  const cliHomeDir = join(baseDir, 'cli');
  const observedDaemon = await getObservedStackDaemonAsync({
    cliHomeDir,
    internalServerUrl: Number.isFinite(serverPort) && serverPort > 0 ? `http://127.0.0.1:${serverPort}` : '',
    runtimeDaemonPid: runtimeState?.processes?.daemonPid ?? null,
    runtimeDaemonPids: runtimeState?.processes?.daemonPids ?? [],
    env: stackScopedEnv,
  }, {
    checkDaemonStateImpl: checkDaemonStatePingAware,
  });
  const daemonPid = normalizePid(observedDaemon.pid);
  const daemonRunning = observedDaemon.running === true;
  const daemonPidAlive = daemonPid ? isPidAlive(daemonPid) : false;

  const ownerAlive = ownerPid ? isPidAlive(ownerPid) : false;
  const serverRuntimePid = proxyMode === 'proxy' ? proxyPid : serverPid;
  const serverComponentRuntime = await resolveStackComponentRuntime({
    port: serverPort,
    recordedPid: serverRuntimePid,
    stackName,
    envPath,
    cliHomeDir,
    listListenPidsWithStatusImpl,
    isTcpPortListeningImpl,
  });
  const serverBackendComponentRuntime = await resolveStackComponentRuntime({
    port: serverBackendPort,
    recordedPid: serverBackendPid,
    stackName,
    envPath,
    cliHomeDir,
    listListenPidsWithStatusImpl,
    isTcpPortListeningImpl,
  });
  const uiComponentRuntime = await resolveStackComponentRuntime({
    port: uiPort,
    recordedPid: expoPid,
    stackName,
    envPath,
    cliHomeDir,
    listListenPidsWithStatusImpl,
    isTcpPortListeningImpl,
  });
  const serverPidAlive = serverPid ? isPidAlive(serverPid) : false;
  const proxyPidAlive = proxyPid ? isPidAlive(proxyPid) : false;
  const serverBackendPidAlive = serverBackendPid ? isPidAlive(serverBackendPid) : false;
  const serverDrainingPidAlive = serverDrainingPid ? isPidAlive(serverDrainingPid) : false;
  const expoPidAlive = expoPid ? isPidAlive(expoPid) : false;
  const expoForwarderAlive = expoTailscaleForwarderPid ? isPidAlive(expoTailscaleForwarderPid) : false;

  const candidateRuntimePids = [
    ownerPid,
    serverComponentRuntime.pid,
    serverBackendComponentRuntime.pid,
    uiComponentRuntime.pid,
    serverPid,
    proxyPid,
    serverBackendPid,
    serverDrainingPid,
    expoPid,
    expoTailscaleForwarderPid,
    daemonPid,
  ].filter((pid) => Number.isFinite(pid) && pid > 1);
  const runningPid = candidateRuntimePids.find((pid) => isPidAlive(pid)) ?? null;
  const running =
    ownerAlive ||
    serverComponentRuntime.running ||
    serverBackendComponentRuntime.running ||
    uiComponentRuntime.running ||
    daemonRunning ||
    daemonPidAlive ||
    serverPidAlive ||
    proxyPidAlive ||
    serverBackendPidAlive ||
    serverDrainingPidAlive ||
    expoPidAlive ||
    expoForwarderAlive;

  const healthIssues = [];
  if (Number.isFinite(serverPort) && serverPort > 0 && !serverComponentRuntime.running) {
    healthIssues.push('server_down');
  }
  if (proxyMode === 'proxy' && Number.isFinite(serverBackendPort) && serverBackendPort > 0 && !serverBackendComponentRuntime.running) {
    healthIssues.push('server_backend_down');
  }
  if (Number.isFinite(uiPort) && uiPort > 0 && !uiComponentRuntime.running) {
    healthIssues.push('ui_down');
  }
  if (daemonExpected && running && !daemonRunning) {
    healthIssues.push('daemon_down');
  }
  const healthStatus = !running ? 'stopped' : healthIssues.length > 0 ? 'degraded' : 'healthy';

  const host = resolveLocalhostHost({ stackMode: true, stackName });
  const internalServerUrl = serverPort ? `http://127.0.0.1:${serverPort}` : null;
  const uiUrl = uiPort ? `http://${host}:${uiPort}` : null;
  const mobileUrl = mobilePort ? await preferStackLocalhostUrl(`http://localhost:${mobilePort}`, { stackName }) : null;

  const repoDir = getEnvValueAny(stackEnv, ['HAPPIER_STACK_REPO_DIR']) || resolveDefaultRepoEnv({ rootDir }).HAPPIER_STACK_REPO_DIR;
  const repoWorktreeSpec = repoDir ? worktreeSpecFromDir({ rootDir, component: 'happier-ui', dir: repoDir }) || null : null;
  const runtimeMode = resolveStackRuntimeMode({ argv: [], env: stackEnv }).mode;
  const runtimeInspection = await inspectActiveRuntimeSnapshot({ stackBaseDir: baseDir });
  const dirs = {
    repoDir,
    uiDir: getComponentDir(rootDir, 'happier-ui', { ...process.env, ...stackEnv }),
    cliDir: getComponentDir(rootDir, 'happier-cli', { ...process.env, ...stackEnv }),
    serverDir: getComponentDir(rootDir, serverComponent, { ...process.env, ...stackEnv }),
  };

  return {
    ok: true,
    stackName,
    baseDir,
    envPath,
    runtimeStatePath,
    serverComponent,
    stackRemote,
    pinned: {
      serverPort: Number.isFinite(pinnedServerPort) && pinnedServerPort > 0 ? pinnedServerPort : null,
    },
    runtime: {
      script: typeof runtimeState?.script === 'string' ? runtimeState.script : null,
      ownerPid: Number.isFinite(ownerPid) && ownerPid > 1 ? ownerPid : null,
      runningPid: Number.isFinite(runningPid) && runningPid > 1 ? runningPid : null,
      running,
      components: {
        owner: {
          pid: Number.isFinite(ownerPid) && ownerPid > 1 ? ownerPid : null,
          running: ownerAlive,
        },
        daemon: {
          pid: Number.isFinite(daemonPid) && daemonPid > 1 ? daemonPid : null,
          running: daemonRunning,
          pidAlive: daemonPidAlive,
          status: observedDaemon.status,
          source: observedDaemon.source,
        },
        server: {
          pid: serverComponentRuntime.pid,
          running: serverComponentRuntime.running,
          pidAlive: serverComponentRuntime.pidAlive,
          portListening: serverComponentRuntime.portListening,
          listenerPids: serverComponentRuntime.listenerPids,
          ownedListenerPids: serverComponentRuntime.ownedListenerPids,
          listenerDiscoverySupported: serverComponentRuntime.listenerDiscoverySupported,
        },
        serverBackend: {
          pid: serverBackendComponentRuntime.pid,
          running: serverBackendComponentRuntime.running,
          pidAlive: serverBackendComponentRuntime.pidAlive,
          portListening: serverBackendComponentRuntime.portListening,
          listenerPids: serverBackendComponentRuntime.listenerPids,
          ownedListenerPids: serverBackendComponentRuntime.ownedListenerPids,
          listenerDiscoverySupported: serverBackendComponentRuntime.listenerDiscoverySupported,
        },
        ui: {
          pid: uiComponentRuntime.pid,
          running: uiComponentRuntime.running,
          pidAlive: uiComponentRuntime.pidAlive,
          portListening: uiComponentRuntime.portListening,
          listenerPids: uiComponentRuntime.listenerPids,
          ownedListenerPids: uiComponentRuntime.ownedListenerPids,
          listenerDiscoverySupported: uiComponentRuntime.listenerDiscoverySupported,
        },
        expoTailscaleForwarder: {
          pid: expoTailscaleForwarderPid,
          running: expoForwarderAlive,
        },
      },
      health: {
        status: healthStatus,
        issues: healthIssues,
      },
      ports: runtimePorts,
      serverProxy,
      expo: runtimeState?.expo ?? null,
      processes: runtimeState?.processes ?? null,
      startedAt: runtimeState?.startedAt ?? null,
      updatedAt: runtimeState?.updatedAt ?? null,
      mode: runtimeMode,
      activeSnapshotId: runtimeInspection.activeSnapshotId,
      snapshotPath: runtimeInspection.snapshotPath,
      sourceFingerprint: runtimeInspection.sourceFingerprint,
      valid: runtimeInspection.valid,
      errors: runtimeInspection.errors,
      snapshotComponents: runtimeInspection.manifest?.components ?? null,
    },
    urls: {
      host,
      internalServerUrl,
      uiUrl,
      mobileUrl,
    },
    ports: {
      server: serverPort,
      backend: backendPort,
      serverBackend: serverBackendPort,
      ui: uiPort,
      mobile: mobilePort,
    },
    repo: {
      dir: repoDir,
      worktreeSpec: repoWorktreeSpec,
    },
    dirs,
  };
}
