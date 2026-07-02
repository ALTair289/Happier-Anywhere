import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { getComponentDir, resolveExplicitStackEnvFilePath } from '../paths/paths.mjs';
import { isPidAlive, killPid, readPidState } from '../expo/expo.mjs';
import { stopLocalDaemon } from '../../daemon.mjs';
import { stopHappyServerManagedInfra } from '../server/infra/happy_server_infra.mjs';
import { deleteStackRuntimeStateFile, readStackRuntimeStateFile, recordStackRuntimeStopRequest } from './runtime_state.mjs';
import {
  getProcessGroupId,
  getPsEnvLine,
  killPidOwnedByStack,
  killProcessGroupOwnedByStack,
  listPidsWithEnvNeedles,
  listPidsWithEnvNeedlesAndEnvBindingNames,
  readStackProcessKindFromEnvLine,
  textContainsEnvBindingName,
  textContainsNeedle,
} from '../proc/ownership.mjs';
import { terminateProcessGroup } from '../proc/terminate.mjs';
import { coercePort } from '../server/port.mjs';
import { daemonControlPost, readDaemonControlState } from './daemonControlClient.mjs';

function resolveServerComponentFromStackEnv(env) {
  const v =
    (env.HAPPIER_STACK_SERVER_COMPONENT ?? '').toString().trim() || 'happier-server-light';
  return v === 'happier-server' ? 'happier-server' : 'happier-server-light';
}

function normalizeRuntimePid(pid) {
  const n = Number(pid);
  return Number.isFinite(n) && n > 1 ? n : null;
}

function getRuntimeProcessEntries(processes) {
  const entries = [];
  const seen = new Set();
  const source = processes && typeof processes === 'object' ? processes : {};
  for (const [key, rawValue] of Object.entries(source)) {
    const values = Array.isArray(rawValue) ? rawValue : [rawValue];
    for (const rawPid of values) {
      const pid = normalizeRuntimePid(rawPid);
      if (!pid) continue;
      const id = `${key}:${pid}`;
      if (seen.has(id)) continue;
      seen.add(id);
      entries.push({ key, pid });
    }
  }
  return entries;
}

function getRuntimeProcessPids(processes) {
  return Array.from(new Set(getRuntimeProcessEntries(processes).map((entry) => entry.pid)));
}

function getRuntimeDaemonPids(processes) {
  return Array.from(new Set(getRuntimeProcessEntries({
    daemonPid: processes?.daemonPid,
    daemonPids: processes?.daemonPids,
  }).map((entry) => entry.pid)));
}

function isDaemonRuntimeProcessKey(key) {
  return key === 'daemonPid' || key === 'daemonPids';
}

function isEphemeralRuntimeFallbackKillAllowed(line, stackName) {
  if (!line || !textContainsNeedle(line, `HAPPIER_STACK_STACK=${stackName}`)) {
    return false;
  }
  const kind = readStackProcessKindFromEnvLine(line);
  if (kind === 'session') return false;
  if (kind === 'infra' || kind === 'server') return true;
  if (kind) return false;

  return (
    textContainsNeedle(line, 'npm_package_name=@happier-dev/server') &&
    textContainsEnvBindingName(line, 'npm_lifecycle_event')
  );
}

async function stopDaemonTrackedSessions({ cliHomeDir, serverUrl, env, stackName, json }) {
  // Read daemon state file written by happier-cli; needed to call control server (/list, /stop-session).
  const controlState = await readDaemonControlState({ cliHomeDir, serverUrl, env, stackName });
  if (!controlState.ok) {
    return {
      ok: controlState.reason === 'missing_state' || controlState.reason === 'daemon_not_running',
      skipped: true,
      reason: controlState.reason,
      stoppedSessionIds: [],
    };
  }
  const { httpPort, controlToken } = controlState;

  // Prefer a single /stop call with stopSessions, so the daemon can stop *all* tracked sessions
  // (including PID-fallback sessions) in a centralized, versioned way.
  const stopOk = await daemonControlPost({ httpPort, path: '/stop', body: { stopSessions: true }, controlToken })
    .then(() => true)
    .catch((e) => {
      if (!json) console.warn(`[stack] failed to stop daemon with sessions: ${e instanceof Error ? e.message : String(e)}`);
      return false;
    });

  if (stopOk) {
    return { ok: true, skipped: false, stoppedSessionIds: [] };
  }

  // Back-compat fallback: older daemons may not support /stop with stopSessions.
  const listed = await daemonControlPost({ httpPort, path: '/list', controlToken }).catch((e) => {
    if (!json) console.warn(`[stack] failed to list daemon sessions: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  });
  const children = Array.isArray(listed?.children) ? listed.children : [];

  const stoppedSessionIds = [];
  for (const child of children) {
    const sid = String(child?.happySessionId ?? '').trim();
    if (!sid) continue;
    // eslint-disable-next-line no-await-in-loop
    const res = await daemonControlPost({ httpPort, path: '/stop-session', body: { sessionId: sid }, controlToken }).catch(() => null);
    if (res?.success) {
      stoppedSessionIds.push(sid);
    }
  }

  return { ok: true, skipped: false, stoppedSessionIds };
}

async function stopExpoStateDir({ stackName, baseDir, kind, stateFileName, envPath, json }) {
  const root = join(baseDir, kind);
  let entries = [];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    entries = [];
  }

  const killed = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const statePath = join(root, e.name, stateFileName);
    // eslint-disable-next-line no-await-in-loop
    const state = await readPidState(statePath);
    if (!state) continue;
    const pid = Number(state.pid);

    if (!Number.isFinite(pid) || pid <= 1) continue;
    if (!isPidAlive(pid)) continue;

    if (!json) {
      // eslint-disable-next-line no-console
      console.log(`[stack] stopping ${kind} (pid=${pid}) for ${stackName}`);
    }
    // eslint-disable-next-line no-await-in-loop
    await killProcessGroupOwnedByStack(pid, { stackName, envPath, label: kind, json });
    killed.push({ pid, port: null, statePath });
  }
  return killed;
}

export async function stopStackWithEnv({
  rootDir,
  stackName,
  baseDir,
  env,
  json,
  noDocker = false,
  aggressive = false,
  sweepOwned = false,
  autoSweep = true,
  preserveDaemon = false,
}) {
  const actions = {
    stackName,
    baseDir,
    aggressive,
    sweepOwned,
    preserveDaemon,
    runner: null,
    daemonSessionsStopped: null,
    daemonStopped: false,
    killedPorts: [],
    expoDev: [],
    uiDev: [],
    mobile: [],
    infra: null,
    errors: [],
  };

  const serverComponent = resolveServerComponentFromStackEnv(env);
  const port = coercePort(env.HAPPIER_STACK_SERVER_PORT);
  const backendPort = coercePort(env.HAPPIER_STACK_SERVER_BACKEND_PORT);
  const internalServerUrl = port ? `http://127.0.0.1:${port}` : 'http://127.0.0.1:3005';
  const cliHomeDir = (env.HAPPIER_STACK_CLI_HOME_DIR ?? join(baseDir, 'cli')).toString();
  const cliDir = getComponentDir(rootDir, 'happier-cli', env);
  const cliBin = join(cliDir, 'bin', 'happier.mjs');
  const envPath = resolveExplicitStackEnvFilePath(env);
  const selfPgid = await getProcessGroupId(process.pid);

  // Preferred: stop stack-started processes (by PID) recorded in stack.runtime.json.
  // This is safer than killing whatever happens to listen on a port, and doesn't rely on the runner's shutdown handler.
  const runtimeStatePath = join(baseDir, 'stack.runtime.json');
  const runtimeState = await readStackRuntimeStateFile(runtimeStatePath);
  if (runtimeState) {
    await recordStackRuntimeStopRequest(runtimeStatePath, {
      signal: 'SIGTERM',
      requestedBy: 'stack stop',
      reason: persistentReason(aggressive, sweepOwned, autoSweep),
      preserveDaemon,
    }).catch(() => {});
  }
  const runnerPid = Number(runtimeState?.ownerPid);
  const processes = runtimeState?.processes && typeof runtimeState.processes === 'object' ? runtimeState.processes : {};

  // Kill known child processes first (process groups), then stop daemon, then stop runner.
  const killedProcessPids = [];
  const visitedProcessPids = new Set();
  for (const { key, pid } of getRuntimeProcessEntries(processes)) {
    if (preserveDaemon && isDaemonRuntimeProcessKey(key)) {
      continue;
    }
    if (pid === runnerPid) continue;
    if (visitedProcessPids.has(pid)) continue;
    visitedProcessPids.add(pid);
    if (!isPidAlive(pid)) continue;
    // eslint-disable-next-line no-await-in-loop
    const res = await killProcessGroupOwnedByStack(pid, { stackName, envPath, cliHomeDir, label: key, json });
    if (res.killed) {
      killedProcessPids.push({ key, pid, reason: res.reason, pgid: res.pgid ?? null });
      continue;
    }

    // Back-compat for earlier "stackless" runs:
    // Some repo-local runs started infra without HAPPIER_STACK_ENV_FILE/HAPPIER_HOME_DIR markers.
    // For ephemeral stacks, allow stopping runtime-recorded PIDs when the process environment still
    // proves the stack name, to avoid leaving orphaned servers/expo after quitting the TUI.
    if (runtimeState?.ephemeral && res.reason === 'not_owned') {
      // eslint-disable-next-line no-await-in-loop
      const line = await getPsEnvLine(pid);
      if (isEphemeralRuntimeFallbackKillAllowed(line, stackName)) {
        // eslint-disable-next-line no-await-in-loop
        const pgid = await getProcessGroupId(pid);
        if (pgid) {
          if (selfPgid && pgid === selfPgid) {
            // Avoid killing the stop command / TUI manager itself when PGIDs are shared.
            // eslint-disable-next-line no-await-in-loop
            await killPid(pid);
            killedProcessPids.push({ key, pid, reason: 'killed_ephemeral_runtime_pid_only_same_pgid', pgid });
            continue;
          }
          // eslint-disable-next-line no-await-in-loop
          const terminated = await terminateProcessGroup(pgid, { graceMs: 800, signal: 'SIGTERM' });
          if (terminated.ok) {
            killedProcessPids.push({ key, pid, reason: 'killed_ephemeral_runtime_pgid', pgid });
            continue;
          }
        }
        // Fallback: kill the pid directly.
        // eslint-disable-next-line no-await-in-loop
        await killPid(pid);
        killedProcessPids.push({ key, pid, reason: 'killed_ephemeral_runtime_pid_only', pgid: pgid ?? null });
      }
    }
  }
  actions.runner = { stopped: false, pid: Number.isFinite(runnerPid) ? runnerPid : null, reason: runtimeState ? 'not_running_or_not_owned' : 'missing_state' };
  actions.killedPorts = actions.killedPorts ?? [];
  actions.processes = { killed: killedProcessPids };

  if (aggressive && !preserveDaemon) {
    try {
      actions.daemonSessionsStopped = await stopDaemonTrackedSessions({ cliHomeDir, serverUrl: internalServerUrl, env, stackName, json });
    } catch (e) {
      actions.errors.push({ step: 'daemon-sessions', error: e instanceof Error ? e.message : String(e) });
    }
  } else if (preserveDaemon) {
    actions.daemonSessionsStopped = { ok: true, skipped: true, reason: 'preserve_daemon', stoppedSessionIds: [] };
  }

  if (!preserveDaemon) {
    try {
      // If happier-cli isn't built yet (common in repo checkouts), running `happier.mjs` can fail noisily.
      // Stopping stack infra should still work without the daemon stop step.
      const cliDistIndex = join(cliDir, 'dist', 'index.mjs');
      if (existsSync(cliDistIndex)) {
        await stopLocalDaemon({ cliBin, internalServerUrl, cliHomeDir });
        actions.daemonStopped = true;
      }
    } catch (e) {
      actions.errors.push({ step: 'daemon', error: e instanceof Error ? e.message : String(e) });
    }
  }

  // Now stop the runner PID last (if it exists). This should clean up any remaining state files it owns.
  if (Number.isFinite(runnerPid) && runnerPid > 1 && isPidAlive(runnerPid)) {
    if (!json) {
      // eslint-disable-next-line no-console
      console.log(`[stack] stopping runner (pid=${runnerPid}) for ${stackName}`);
    }
    const res = await killPidOwnedByStack(runnerPid, { stackName, envPath, cliHomeDir, label: 'runner', json });
    actions.runner = { stopped: res.killed, pid: runnerPid, reason: res.reason };
  }

  // Only delete runtime state if all runtime-tracked pids are confirmed stopped.
  // This avoids losing the only reliable link between a stack and its infra pids.
  const runtimeTrackedPids = [
    normalizeRuntimePid(runnerPid),
    ...getRuntimeProcessPids(processes),
  ].filter(Boolean);
  const anyRuntimePidAlive = runtimeTrackedPids.some((p) => isPidAlive(p));
  if (!anyRuntimePidAlive) {
    await deleteStackRuntimeStateFile(runtimeStatePath);
  }

  try {
    actions.expoDev = await stopExpoStateDir({ stackName, baseDir, kind: 'expo-dev', stateFileName: 'expo.state.json', envPath, json });
  } catch (e) {
    actions.errors.push({ step: 'expo-dev', error: e instanceof Error ? e.message : String(e) });
  }
  try {
    // Legacy cleanups (best-effort): older runs used separate state dirs.
    actions.uiDev = await stopExpoStateDir({ stackName, baseDir, kind: 'ui-dev', stateFileName: 'ui.state.json', envPath, json });
    const killedDev = await stopExpoStateDir({ stackName, baseDir, kind: 'mobile-dev', stateFileName: 'mobile.state.json', envPath, json });
    const killedLegacy = await stopExpoStateDir({ stackName, baseDir, kind: 'mobile', stateFileName: 'expo.state.json', envPath, json });
    actions.mobile = [...killedDev, ...killedLegacy];
  } catch (e) {
    actions.errors.push({ step: 'expo-mobile', error: e instanceof Error ? e.message : String(e) });
  }

  // IMPORTANT:
  // Never kill "whatever is listening on a port" in stack mode.
  void backendPort;
  void port;

  const managed = (env.HAPPIER_STACK_MANAGED_INFRA ?? '1').toString().trim() !== '0';
  if (!noDocker && serverComponent === 'happier-server' && managed) {
    try {
      actions.infra = await stopHappyServerManagedInfra({ stackName, baseDir, removeVolumes: false });
    } catch (e) {
      actions.errors.push({ step: 'infra', error: e instanceof Error ? e.message : String(e) });
    }
  } else {
    actions.infra = { ok: true, skipped: true, reason: noDocker ? 'no_docker' : 'not_managed_or_not_happier_server' };
  }

  // Last resort: sweep any remaining processes that still carry this stack env file in their environment.
  // IMPORTANT:
  // This must NOT kill daemon-spawned sessions/LLM/agent processes. Those should survive infra restarts.
  //
  // We only target infra processes by requiring HAPPIER_STACK_PROCESS_KIND=infra in addition to the stack env file.
  // We also exclude our own PID.
  const autoSweepFromEnvRaw = (env?.HAPPIER_STACK_STOP_AUTO_SWEEP ?? '').toString().trim();
  const autoSweepFromEnv = autoSweepFromEnvRaw ? autoSweepFromEnvRaw !== '0' : null;
  const autoSweepResolved = typeof autoSweepFromEnv === 'boolean' ? autoSweepFromEnv : Boolean(autoSweep);

  // If the runtime state exists but its owner PID is stale (e.g. runner was Ctrl+C'd),
  // treat it like "missing" and fall back to a safe infra-only sweep.
  const runtimeStateUsable = Boolean(runtimeState) && Number.isFinite(runnerPid) && runnerPid > 1 && isPidAlive(runnerPid);
  const shouldAutoSweep = autoSweepResolved && envPath && !runtimeStateUsable;
  if ((sweepOwned || shouldAutoSweep) && envPath) {
    const envNeedle = `HAPPIER_STACK_ENV_FILE=${envPath}`;
    const infraTagged = await listPidsWithEnvNeedles([envNeedle, 'HAPPIER_STACK_PROCESS_KIND=infra']);

    // Compatibility sweep for older stacks: some long-running infra (notably server dev loops)
    // may not have been started with HAPPIER_STACK_PROCESS_KIND=infra yet. We restrict this
    // fallback to npm/yarn managed server processes to avoid touching daemon-spawned sessions.
    const legacyServer = await listPidsWithEnvNeedlesAndEnvBindingNames([
      envNeedle,
      'npm_package_name=@happier-dev/server',
    ], ['npm_lifecycle_event']);

    const pids = [...new Set([...infraTagged, ...legacyServer])]
      .filter((pid) => pid !== process.pid)
      .filter((pid) => Number.isFinite(pid) && pid > 1);
    const daemonPids = getRuntimeDaemonPids(runtimeState?.processes);
    const preservedPids = preserveDaemon && daemonPids.length > 0 ? new Set(daemonPids) : null;

    const swept = [];
    const sweepPidDirect = async (pid, reason) => {
      const pgid = await getProcessGroupId(pid);
      if (pgid) {
        if (selfPgid && pgid === selfPgid) {
          await killPid(pid);
          swept.push({ pid, reason: `${reason}_pid_only_same_pgid`, pgid });
          return true;
        }
        const terminated = await terminateProcessGroup(pgid, { graceMs: 800, signal: 'SIGTERM' });
        if (terminated.ok) {
          swept.push({ pid, reason, pgid });
          return true;
        }
      }
      await killPid(pid);
      swept.push({ pid, reason, pgid: pgid ?? null });
      return true;
    };

    for (const pid of Array.from(new Set(pids))) {
      if (preservedPids?.has(pid)) continue;
      if (!isPidAlive(pid)) continue;
      // eslint-disable-next-line no-await-in-loop
      const res = await killProcessGroupOwnedByStack(pid, { stackName, envPath, cliHomeDir, label: 'sweep', json });
      if (res.killed) {
        swept.push({ pid, reason: res.reason, pgid: res.pgid ?? null });
      }
    }

    // Repo-local fallback: older stackless infra runs may have omitted HAPPIER_STACK_ENV_FILE.
    // Do not sweep by only (stackName + repoDir): daemon-spawned session runners inherit
    // those repo-local markers and must survive stack/TUI restarts.
    const repoDir = String(env.HAPPIER_STACK_REPO_DIR ?? '').trim();
    const isRepoLocalStack = stackName && stackName !== 'main' && String(stackName).startsWith('repo-');
    if (autoSweepResolved && shouldAutoSweep && swept.length === 0 && isRepoLocalStack && repoDir) {
      const repoLocalNeedles = [`HAPPIER_STACK_STACK=${stackName}`, `HAPPIER_STACK_REPO_DIR=${repoDir}`];
      const repoLocalInfraTagged = await listPidsWithEnvNeedles([
        ...repoLocalNeedles,
        'HAPPIER_STACK_PROCESS_KIND=infra',
      ]);
      const repoLocalLegacyServer = await listPidsWithEnvNeedlesAndEnvBindingNames([
        ...repoLocalNeedles,
        'npm_package_name=@happier-dev/server',
      ], ['npm_lifecycle_event']);
      const repoLocalPids = [...new Set([...repoLocalInfraTagged, ...repoLocalLegacyServer])]
        .filter((pid) => pid !== process.pid)
        .filter((pid) => Number.isFinite(pid) && pid > 1);
      for (const pid of Array.from(new Set(repoLocalPids))) {
        if (preservedPids?.has(pid)) continue;
        if (!isPidAlive(pid)) continue;
        // eslint-disable-next-line no-await-in-loop
        const line = await getPsEnvLine(pid);
        if (readStackProcessKindFromEnvLine(line) === 'session') continue;
        // eslint-disable-next-line no-await-in-loop
        await sweepPidDirect(pid, 'killed_repo_local_stackless_sweep');
      }
    }

    actions.sweep = { pids: swept, auto: shouldAutoSweep && !sweepOwned };
  }

  return actions;
}

function persistentReason(aggressive, sweepOwned, autoSweep) {
  if (aggressive) return 'explicit stack stop (aggressive)';
  if (sweepOwned) return 'explicit stack stop (sweep-owned)';
  if (autoSweep === false) return 'explicit stack stop (no-auto-sweep)';
  return 'explicit stack stop';
}
