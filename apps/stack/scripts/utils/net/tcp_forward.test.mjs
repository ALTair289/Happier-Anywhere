import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';

import { startTcpForwarder, stopTcpForwarder } from './tcp_forward.mjs';

async function startEchoServer(label) {
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('data', (chunk) => {
      socket.write(`${label}:${chunk.toString()}`);
    });
    socket.on('close', () => sockets.delete(socket));
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 0 }, resolve);
  });

  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : null;
  if (!port) throw new Error(`failed to start ${label} echo server`);

  return {
    port,
    sockets,
    async stop() {
      for (const socket of sockets) socket.destroy();
      await closeServer(server);
    },
  };
}

async function getUnusedLoopbackPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 0 }, resolve);
  });
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : null;
  await closeServer(server);
  if (!port) throw new Error('failed to allocate an unused port');
  return port;
}

async function closeServer(server) {
  await new Promise((resolve) => {
    server.close(() => resolve());
  });
}

async function connectClient(port) {
  const socket = net.createConnection({ host: '127.0.0.1', port });
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  return socket;
}

async function writeAndRead(socket, message) {
  const dataPromise = new Promise((resolve, reject) => {
    const onData = (chunk) => {
      cleanup();
      resolve(chunk.toString());
    };
    const onError = (err) => {
      cleanup();
      reject(err);
    };
    const cleanup = () => {
      socket.off('data', onData);
      socket.off('error', onError);
    };
    socket.once('data', onData);
    socket.once('error', onError);
  });
  socket.write(message);
  return dataPromise;
}

async function waitForSocketClosed(socket) {
  if (socket.destroyed) return;
  await new Promise((resolve) => {
    socket.once('close', resolve);
  });
}

test('upstream flip affects new connections while existing connections stay on their original upstream until drain', { timeout: 5000 }, async () => {
  const oldUpstream = await startEchoServer('old');
  const newUpstream = await startEchoServer('new');
  let forwarder;
  const sockets = [];
  try {
    forwarder = await startTcpForwarder({
      listenHost: '127.0.0.1',
      listenPort: 0,
      targetHost: '127.0.0.1',
      targetPort: oldUpstream.port,
      label: 'tcp-forward-test',
    });

    assert.equal(typeof forwarder.server.setUpstream, 'function');
    assert.equal(typeof forwarder.server.closeIdleOrAllConnectionsAfterGrace, 'function');

    const existing = await connectClient(forwarder.port);
    sockets.push(existing);
    assert.equal(await writeAndRead(existing, 'one'), 'old:one');

    forwarder.server.setUpstream({ targetHost: '127.0.0.1', targetPort: newUpstream.port });

    const fresh = await connectClient(forwarder.port);
    sockets.push(fresh);
    assert.equal(await writeAndRead(fresh, 'two'), 'new:two');
    assert.equal(await writeAndRead(existing, 'three'), 'old:three');

    const drain = forwarder.server.closeIdleOrAllConnectionsAfterGrace({ graceMs: 10 });
    await Promise.all([drain, waitForSocketClosed(existing), waitForSocketClosed(fresh)]);

    const afterDrain = await connectClient(forwarder.port);
    sockets.push(afterDrain);
    assert.equal(await writeAndRead(afterDrain, 'four'), 'new:four');
  } finally {
    for (const socket of sockets) socket.destroy();
    await stopTcpForwarder(forwarder?.server, 'tcp-forward-test');
    await oldUpstream.stop();
    await newUpstream.stop();
  }
});

test('targeted drain closes only connections bound to the selected upstream', { timeout: 5000 }, async () => {
  const oldUpstream = await startEchoServer('old');
  const newUpstream = await startEchoServer('new');
  let forwarder;
  const sockets = [];
  try {
    forwarder = await startTcpForwarder({
      listenHost: '127.0.0.1',
      listenPort: 0,
      targetHost: '127.0.0.1',
      targetPort: oldUpstream.port,
      label: 'tcp-forward-target-drain-test',
    });

    const oldConnection = await connectClient(forwarder.port);
    sockets.push(oldConnection);
    assert.equal(await writeAndRead(oldConnection, 'one'), 'old:one');

    forwarder.server.setUpstream({ targetHost: '127.0.0.1', targetPort: newUpstream.port });

    const newConnection = await connectClient(forwarder.port);
    sockets.push(newConnection);
    assert.equal(await writeAndRead(newConnection, 'two'), 'new:two');

    await forwarder.server.closeConnectionsAfterGrace({
      graceMs: 0,
      target: { targetHost: '127.0.0.1', targetPort: oldUpstream.port },
    });

    await waitForSocketClosed(oldConnection);
    assert.equal(await writeAndRead(newConnection, 'three'), 'new:three');
  } finally {
    for (const socket of sockets) socket.destroy();
    await stopTcpForwarder(forwarder?.server, 'tcp-forward-target-drain-test');
    await oldUpstream.stop();
    await newUpstream.stop();
  }
});

test('forwarder shutdown closes listener and active sockets', { timeout: 5000 }, async () => {
  const upstream = await startEchoServer('upstream');
  let forwarder;
  let client;
  try {
    forwarder = await startTcpForwarder({
      listenHost: '127.0.0.1',
      listenPort: 0,
      targetHost: '127.0.0.1',
      targetPort: upstream.port,
      label: 'tcp-forward-shutdown-test',
    });

    client = await connectClient(forwarder.port);
    assert.equal(await writeAndRead(client, 'before'), 'upstream:before');

    await stopTcpForwarder(forwarder.server, 'tcp-forward-shutdown-test');
    await waitForSocketClosed(client);

    await assert.rejects(
      () => connectClient(forwarder.port),
      (err) => err && err.code === 'ECONNREFUSED',
    );
  } finally {
    client?.destroy();
    await stopTcpForwarder(forwarder?.server, 'tcp-forward-shutdown-test');
    await upstream.stop();
  }
});

test('connection drain waits for socket close before resolving', { timeout: 5000 }, async () => {
  const upstream = await startEchoServer('upstream');
  let forwarder;
  let client;
  try {
    forwarder = await startTcpForwarder({
      listenHost: '127.0.0.1',
      listenPort: 0,
      targetHost: '127.0.0.1',
      targetPort: upstream.port,
      label: 'tcp-forward-drain-close-test',
    });

    client = await connectClient(forwarder.port);
    assert.equal(await writeAndRead(client, 'before'), 'upstream:before');

    await forwarder.server.closeIdleOrAllConnectionsAfterGrace({ graceMs: 0 });

    assert.equal(forwarder.server.getActiveConnectionCount(), 0);
  } finally {
    client?.destroy();
    await stopTcpForwarder(forwarder?.server, 'tcp-forward-drain-close-test');
    await upstream.stop();
  }
});

test('refused upstream closes the client without unhandled rejections', { timeout: 5000 }, async () => {
  const targetPort = await getUnusedLoopbackPort();
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);

  let forwarder;
  let client;
  try {
    forwarder = await startTcpForwarder({
      listenHost: '127.0.0.1',
      listenPort: 0,
      targetHost: '127.0.0.1',
      targetPort,
      label: 'tcp-forward-refused-test',
    });

    client = await connectClient(forwarder.port);
    await waitForSocketClosed(client);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', onUnhandled);
    client?.destroy();
    await stopTcpForwarder(forwarder?.server, 'tcp-forward-refused-test');
  }
});
