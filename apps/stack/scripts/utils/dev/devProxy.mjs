import http from 'node:http';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { isTcpPortFree, pickNextFreeTcpPort } from '../net/ports.mjs';

const DISABLED_ENV_VALUES = new Set(['0', 'false', 'no', 'off']);
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

function normalizeProxyHost(raw) {
  const host = String(raw ?? '').trim();
  if (!host) return '';
  return host === '*' ? '0.0.0.0' : host;
}

export function shouldEnableStackDevProxy({ startServer = true, flags = new Set(), env = process.env } = {}) {
  if (!startServer) return false;
  if (flags?.has?.('--no-proxy')) return false;
  const raw = String(env?.HAPPIER_STACK_DEV_PROXY ?? '').trim().toLowerCase();
  if (raw && DISABLED_ENV_VALUES.has(raw)) return false;
  return true;
}

export function resolveDevProxyStableHost({ env = process.env } = {}) {
  const explicit = normalizeProxyHost(env?.HAPPIER_STACK_DEV_PROXY_HOST);
  if (explicit) return explicit;

  const bindMode = String(env?.HAPPIER_STACK_BIND_MODE ?? '').trim().toLowerCase();
  const host = normalizeProxyHost(env?.HOST).toLowerCase();
  if (bindMode === 'loopback' || LOOPBACK_HOSTS.has(host)) {
    return '127.0.0.1';
  }

  return '0.0.0.0';
}

export async function prepareDevProxyStartup({
  enabled,
  stablePort,
  host,
  stableHost = host ?? '127.0.0.1',
  targetHost = host ?? '127.0.0.1',
  label = 'server-proxy',
  logger = console,
  pickNextFreeTcpPortImpl = pickNextFreeTcpPort,
  startDevProxyImpl = startDevProxy,
  isTcpPortFreeImpl = isTcpPortFree,
  onUnexpectedExit,
} = {}) {
  const publicPort = Number(stablePort);
  if (!enabled) {
    return {
      mode: 'direct',
      stablePort: publicPort,
      backendPort: publicPort,
      proxyController: null,
      fallbackReason: null,
    };
  }

  const backendPort = await pickNextFreeTcpPortImpl(publicPort + 1, {
    host: targetHost,
    reservedPorts: new Set([publicPort]),
  });

  try {
    const proxyController = await startDevProxyImpl({
      stableHost,
      stablePort: publicPort,
      targetHost,
      targetPort: backendPort,
      label,
      onUnexpectedExit,
    });
    return {
      mode: 'proxy',
      stablePort: publicPort,
      backendPort,
      proxyController,
      fallbackReason: null,
    };
  } catch (error) {
    const fallbackReason = error instanceof Error ? error.message : String(error);
    const directSafe = await isTcpPortFreeImpl(publicPort, { host: stableHost }).catch(() => false);
    if (!directSafe) {
      throw error;
    }
    logger.warn?.(
      `[local] server proxy unavailable on port ${publicPort}; falling back to direct server bind (${fallbackReason}).`
    );
    return {
      mode: 'directFallback',
      stablePort: publicPort,
      backendPort: publicPort,
      proxyController: null,
      fallbackReason,
    };
  }
}

function normalizeRetryAfterSeconds(retryAfterMs) {
  const ms = Math.max(0, Number(retryAfterMs) || 0);
  return String(Math.max(1, Math.ceil(ms / 1000)));
}

/**
 * Start the tiny HTTP upstream used by the dev proxy during exclusive DB windows.
 *
 * The raw TCP forwarder stays protocol-agnostic; this helper owns the HTTP 503
 * semantics that clients see while no real server backend should receive traffic.
 */
export async function startDevProxyMaintenanceUpstream({
  host = '127.0.0.1',
  port = 0,
  retryAfterMs = 1000,
  retryable = true,
  message = 'Server reload in progress',
} = {}) {
  let currentRetryAfterMs = retryAfterMs;
  let currentRetryable = retryable !== false;
  let currentMessage = message;

  const server = http.createServer((_req, res) => {
    const body = `${currentMessage}\n`;
    const headers = {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      'X-Happier-Retry-Reason': currentRetryable ? 'server_restarting' : 'server_unavailable',
      'Cache-Control': 'no-store',
      Connection: 'close',
    };
    if (currentRetryable) headers['Retry-After'] = normalizeRetryAfterSeconds(currentRetryAfterMs);
    res.writeHead(503, headers);
    res.end(body);
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host, port }, resolve);
  });

  const addr = server.address();
  const address = typeof addr === 'object' && addr ? addr.address : host;
  const resolvedPort = typeof addr === 'object' && addr ? addr.port : port;

  let stopped = false;
  return {
    server,
    address,
    port: resolvedPort,
    update({
      retryAfterMs: nextRetryAfterMs = currentRetryAfterMs,
      retryable: nextRetryable = currentRetryable,
      message: nextMessage = currentMessage,
    } = {}) {
      currentRetryAfterMs = nextRetryAfterMs;
      currentRetryable = nextRetryable !== false;
      currentMessage = nextMessage;
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      await new Promise((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}

export async function startDevProxy({
  stableHost = '127.0.0.1',
  stablePort,
  targetHost = '127.0.0.1',
  targetPort,
  label = 'server-proxy',
  onUnexpectedExit,
  forkImpl = fork,
  commandTimeoutMs = 5000,
} = {}) {
  const runtimePath = fileURLToPath(new URL('./devProxyRuntime.mjs', import.meta.url));
  const child = forkImpl(runtimePath, [], {
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    detached: process.platform !== 'win32',
  });
  child.stdout?.on('data', (chunk) => process.stdout.write(chunk));
  child.stderr?.on('data', (chunk) => process.stderr.write(chunk));

  let requestId = 0;
  const pending = new Map();
  let stopped = false;
  let available = false;
  let expectedExit = false;
  let currentTargetPort = Number(targetPort);
  let resolveClosed;
  const closed = new Promise((resolve) => { resolveClosed = resolve; });

  const rejectPending = (error) => {
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer);
      reject(error);
    }
    pending.clear();
  };
  child.on('exit', (code, signal) => {
    available = false;
    currentTargetPort = null;
    const error = new Error(`[${label}] proxy runtime exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})`);
    rejectPending(error);
    const event = { expected: expectedExit, code: code ?? null, signal: signal ?? null, error };
    resolveClosed(event);
    if (!expectedExit && typeof onUnexpectedExit === 'function') {
      Promise.resolve(onUnexpectedExit(event)).catch((callbackError) => {
        process.stderr.write(`[${label}] unexpected-exit handler failed: ${callbackError instanceof Error ? callbackError.message : String(callbackError)}\n`);
      });
    }
  });
  child.on('error', rejectPending);
  child.on('message', (message) => {
    if (!message || typeof message !== 'object' || message.type !== 'response') return;
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    clearTimeout(waiter.timer);
    if (message.ok) waiter.resolve(message.result);
    else waiter.reject(new Error(String(message.error || 'proxy runtime command failed')));
  });

  const command = (name, payload = {}, { timeoutMs = commandTimeoutMs } = {}) => new Promise((resolve, reject) => {
    if (!child.connected || (name !== 'start' && !available)) {
      reject(new Error(`[${label}] proxy runtime is unavailable (control channel closed)`));
      return;
    }
    const id = ++requestId;
    const timer = setTimeout(() => {
      if (!pending.delete(id)) return;
      const error = new Error(`[${label}] proxy runtime command '${name}' timed out after ${timeoutMs}ms`);
      error.code = 'EPROXYCOMMANDTIMEOUT';
      error.command = name;
      reject(error);
    }, Math.max(1, Number(timeoutMs) || commandTimeoutMs));
    pending.set(id, { resolve, reject, timer });
    child.send({ type: 'command', id, name, payload }, (error) => {
      if (!error) return;
      const waiter = pending.get(id);
      if (!waiter) return;
      pending.delete(id);
      clearTimeout(waiter.timer);
      reject(error);
    });
  });

  let started;
  try {
    started = await command('start', {
      stableHost,
      stablePort: Number(stablePort),
      targetHost,
      targetPort: Number(targetPort),
      label,
    });
  } catch (error) {
    expectedExit = true;
    child.kill('SIGKILL');
    throw error;
  }
  available = true;

  const controller = {
    pid: child.pid,
    closed,
    get available() {
      return available;
    },
    host: started.address,
    port: started.port,
    get targetPort() {
      return currentTargetPort;
    },
    async getUpstream() {
      return await command('getUpstream');
    },
    async flipUpstream({ targetHost: nextTargetHost = targetHost, targetPort: nextTargetPort } = {}) {
      const result = await command('flip', {
        targetHost: nextTargetHost,
        targetPort: Number(nextTargetPort),
      });
      currentTargetPort = Number(nextTargetPort);
      return result;
    },
    async enterMaintenance({ retryAfterMs = 2000, retryable = true, message = 'Server reload in progress' } = {}) {
      return await command('maintenance', { retryAfterMs, retryable, message });
    },
    async drainConnections({ graceMs = 0, targetHost, targetPort } = {}) {
      await command('drain', { graceMs, targetHost, targetPort });
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      expectedExit = true;
      try {
        if (available) await command('stop');
      } finally {
        if (child.connected) child.disconnect();
      }
    },
  };

  return controller;
}
