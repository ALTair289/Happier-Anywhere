import { isTcpPortFree, listListenPids, pickNextFreeTcpPort } from '../net/ports.mjs';
import { resolveStablePortStart } from '../expo/metro_ports.mjs';
import { isPidAlive, readStackRuntimeStateFile } from '../stack/runtime_state.mjs';
import { isPidOwnedByStack } from '../proc/ownership.mjs';
import { resolveActiveStackEnvFilePath } from '../paths/paths.mjs';
import { resolveStackOwnedListenPid } from './listener_ownership.mjs';
import { isHappierServerRunning } from './server.mjs';
import { resolveServerPortFromEnv } from './port.mjs';

function coercePort(v) {
  const n = Number(String(v ?? '').trim());
  return Number.isFinite(n) && n > 0 ? n : null;
}

function coercePositiveInt(v) {
  const n = Number(String(v ?? '').trim());
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

function isWithinRange(port, base, range) {
  const p = coercePositiveInt(port);
  const b = coercePositiveInt(base);
  const r = coercePositiveInt(range);
  if (!p || !b || !r) return false;
  return p >= b && p < b + r;
}

export async function isRuntimePortOwnedByStackDevProxy({
  env,
  port,
  stackName,
  runtimeStatePath,
}) {
  const runtime = runtimeStatePath ? await readStackRuntimeStateFile(runtimeStatePath) : null;
  if (!runtime) return false;

  const runtimeStackName = String(runtime.stackName ?? '').trim();
  if (runtimeStackName && runtimeStackName !== stackName) return false;
  if (runtime?.serverProxy?.enabled !== true) return false;
  if (coercePort(runtime?.ports?.server) !== port) return false;

  const proxyPid = coercePositiveInt(runtime?.processes?.proxyPid);
  if (!proxyPid || !isPidAlive(proxyPid)) return false;

  const envPath = resolveActiveStackEnvFilePath(stackName, env);
  if (!await isPidOwnedByStack(proxyPid, { stackName, envPath }).catch(() => false)) {
    return false;
  }

  const listenPids = await listListenPids(port, { timeoutMs: 1000 }).catch(() => []);
  return listenPids.includes(proxyPid);
}

async function isHealthyServerPortOwnedByStack({ env, port, stackName }) {
  const url = `http://127.0.0.1:${port}`;
  if (!await isHappierServerRunning(url)) return false;

  const envPath = resolveActiveStackEnvFilePath(stackName, env);
  const listenPid = await resolveStackOwnedListenPid({ port, stackName, envPath });
  return Number.isFinite(Number(listenPid)) && Number(listenPid) > 1;
}

export async function resolveLocalServerPortForStack({
  env = process.env,
  stackMode,
  stackName,
  runtimeStatePath,
  defaultPort = 3005,
} = {}) {
  const name = String(stackName ?? '').trim() || 'main';
  const inStackMode = Boolean(stackMode);

  const explicitPort = coercePort(env.HAPPIER_STACK_SERVER_PORT);
  if (explicitPort) {
    // For non-main stacks, treat an explicit server port as a pin, but fail closed if it's
    // occupied by a non-happier process. (Otherwise we can accidentally connect/auth against
    // an unrelated process and get confusing behavior.)
    if (inStackMode && name !== 'main') {
      const url = `http://127.0.0.1:${explicitPort}`;
      if (await isHealthyServerPortOwnedByStack({ env, port: explicitPort, stackName: name })) {
        return explicitPort;
      }
      if (
        await isRuntimePortOwnedByStackDevProxy({
          env,
          port: explicitPort,
          stackName: name,
          runtimeStatePath,
        })
      ) {
        return explicitPort;
      }
      const healthyButUnowned = await isHappierServerRunning(url);
      if (healthyButUnowned) {
        throw new Error(
          `[stack] ${name}: pinned server port ${explicitPort} is not available (in use by another process).\n` +
            `[stack] Fix: stop the process using it, or reallocate by unsetting the pin:\n` +
            `  yarn env unset HAPPIER_STACK_SERVER_PORT\n` +
            `  # (or) hstack env unset HAPPIER_STACK_SERVER_PORT`
        );
      }
      const free = await isTcpPortFree(explicitPort, { host: '127.0.0.1' }).catch(() => false);
      if (!free) {
        throw new Error(
          `[stack] ${name}: pinned server port ${explicitPort} is not available (in use by another process).\n` +
            `[stack] Fix: stop the process using it, or reallocate by unsetting the pin:\n` +
            `  yarn env unset HAPPIER_STACK_SERVER_PORT\n` +
            `  # (or) hstack env unset HAPPIER_STACK_SERVER_PORT`
        );
      }
    }
    return explicitPort;
  }

  // For main stack (and stackless=false mode), keep legacy behavior: allow HAPPIER_SERVER_URL to determine the port.
  if (!inStackMode || name === 'main') {
    return resolveServerPortFromEnv({ env, defaultPort });
  }

  // Non-main stacks: avoid leaking global HAPPIER_SERVER_URL into local stack port selection.
  // Prefer runtime state, else pick a stable per-stack port range.
  const runtime = runtimeStatePath ? await readStackRuntimeStateFile(runtimeStatePath) : null;
  const runtimePort = coercePort(runtime?.ports?.server);

  // If the caller configured a stable range explicitly (base/range), ignore runtime ports
  // that don't fall within that range. This prevents stale low ports (e.g. 3009) from
  // overriding stackless high port ranges.
  const baseRaw = (env.HAPPIER_STACK_SERVER_PORT_BASE ?? '').toString().trim();
  const rangeRaw = (env.HAPPIER_STACK_SERVER_PORT_RANGE ?? '').toString().trim();
  const hasExplicitStableRange = Boolean(baseRaw || rangeRaw);
  const stableBase = coercePositiveInt(baseRaw) ?? 4101;
  const stableRange = coercePositiveInt(rangeRaw) ?? 1000;

  if (runtimePort && (!hasExplicitStableRange || isWithinRange(runtimePort, stableBase, stableRange))) {
    if (await isHealthyServerPortOwnedByStack({ env, port: runtimePort, stackName: name })) {
      return runtimePort;
    }
    if (
      await isRuntimePortOwnedByStackDevProxy({
        env,
        port: runtimePort,
        stackName: name,
        runtimeStatePath,
      })
    ) {
      return runtimePort;
    }
    if (await isTcpPortFree(runtimePort, { host: '127.0.0.1' })) {
      return runtimePort;
    }
  }

  const startPort = resolveStablePortStart({
    env: {
      ...env,
      HAPPIER_STACK_SERVER_PORT_BASE: (env.HAPPIER_STACK_SERVER_PORT_BASE ?? '4101').toString(),
      HAPPIER_STACK_SERVER_PORT_RANGE: (env.HAPPIER_STACK_SERVER_PORT_RANGE ?? '1000').toString(),
    },
    stackName: name,
    baseKey: 'HAPPIER_STACK_SERVER_PORT_BASE',
    rangeKey: 'HAPPIER_STACK_SERVER_PORT_RANGE',
    defaultBase: 4101,
    defaultRange: 1000,
  });

  return await pickNextFreeTcpPort(startPort, { host: '127.0.0.1' });
}
