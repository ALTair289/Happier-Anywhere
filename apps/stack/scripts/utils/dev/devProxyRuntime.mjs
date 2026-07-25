import { startTcpForwarder, stopTcpForwarder } from '../net/tcp_forward.mjs';
import { startDevProxyMaintenanceUpstream } from './devProxy.mjs';

let forwarder = null;
let maintenance = null;
let runtimeLabel = 'server-proxy';
let stopping = false;

function respond(id, ok, result, error) {
  if (typeof process.send !== 'function') return;
  process.send({ type: 'response', id, ok, ...(result !== undefined ? { result } : {}), ...(error ? { error } : {}) });
}

async function stopRuntime() {
  if (stopping) return;
  stopping = true;
  await stopTcpForwarder(forwarder?.server, runtimeLabel);
  forwarder = null;
  await maintenance?.stop();
  maintenance = null;
}

async function handleCommand(name, payload) {
  if (name === 'start') {
    if (forwarder) throw new Error('proxy runtime is already started');
    runtimeLabel = String(payload.label || runtimeLabel);
    forwarder = await startTcpForwarder({
      listenHost: payload.stableHost,
      listenPort: Number(payload.stablePort),
      targetHost: payload.targetHost,
      targetPort: Number(payload.targetPort),
      label: runtimeLabel,
    });
    return { address: forwarder.address, port: forwarder.port };
  }
  if (!forwarder) throw new Error('proxy runtime is not started');

  if (name === 'flip') {
    return forwarder.server.setUpstream({
      targetHost: payload.targetHost,
      targetPort: Number(payload.targetPort),
    });
  }
  if (name === 'getUpstream') return forwarder.server.getUpstream();
  if (name === 'maintenance') {
    if (!maintenance) {
      maintenance = await startDevProxyMaintenanceUpstream({
        host: '127.0.0.1',
        port: 0,
        retryAfterMs: payload.retryAfterMs,
        retryable: payload.retryable,
        message: payload.message,
      });
    } else {
      maintenance.update({ retryAfterMs: payload.retryAfterMs, retryable: payload.retryable, message: payload.message });
    }
    forwarder.server.setUpstream({ targetHost: maintenance.address, targetPort: maintenance.port });
    return { targetHost: maintenance.address, targetPort: maintenance.port, port: maintenance.port };
  }
  if (name === 'drain') {
    const target = Number.isInteger(Number(payload.targetPort)) && Number(payload.targetPort) > 0
      ? { targetHost: payload.targetHost || '127.0.0.1', targetPort: Number(payload.targetPort) }
      : null;
    await forwarder.server.closeConnectionsAfterGrace({ graceMs: payload.graceMs, target });
    return null;
  }
  if (name === 'stop') {
    await stopRuntime();
    return null;
  }
  throw new Error(`unknown proxy runtime command: ${name}`);
}

let commandQueue = Promise.resolve();
process.on('message', (message) => {
  if (!message || typeof message !== 'object' || message.type !== 'command') return;
  commandQueue = commandQueue.then(async () => {
    try {
      const result = await handleCommand(message.name, message.payload || {});
      respond(message.id, true, result);
      if (message.name === 'stop') setImmediate(() => process.exit(0));
    } catch (error) {
      respond(message.id, false, undefined, error instanceof Error ? error.message : String(error));
    }
  });
});

process.on('disconnect', () => {
  void stopRuntime().finally(() => process.exit(0));
});
process.on('SIGTERM', () => {
  void stopRuntime().finally(() => process.exit(0));
});
process.on('SIGINT', () => {
  void stopRuntime().finally(() => process.exit(0));
});
