import { createServer } from 'node:http';
import { connect, type Socket } from 'node:net';
import { once } from 'node:events';

import { describe, expect, it } from 'vitest';

import { withTimeoutMs } from '../timing/withTimeout';
import { startForwardedHeaderProxy } from './forwardedHeaderProxy';

function listen(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
}

function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

describe('startForwardedHeaderProxy', () => {
  it('stops even when an upgraded socket is still open', async () => {
    const targetSockets = new Set<Socket>();
    const target = createServer((_req, res) => {
      res.end('ok');
    });
    target.on('connection', (socket) => {
      targetSockets.add(socket);
      socket.once('close', () => targetSockets.delete(socket));
    });
    target.on('upgrade', (_req, socket) => {
      socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
    });
    await listen(target);
    const targetAddress = target.address();
    if (!targetAddress || typeof targetAddress !== 'object') throw new Error('target server did not bind');

    const proxy = await startForwardedHeaderProxy({
      targetBaseUrl: `http://127.0.0.1:${targetAddress.port}`,
      identityHeaders: { 'x-happier-client-cert-email': 'alice@example.com' },
    });

    const preflight = await fetch(`${proxy.baseUrl}/v1/features`, {
      method: 'OPTIONS',
      headers: {
        origin: 'http://127.0.0.1:4011',
        'access-control-request-method': 'GET',
        'access-control-request-headers': 'authorization,content-type',
      },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-headers')).toBe('authorization,content-type');

    const proxyUrl = new URL(proxy.baseUrl);
    const socket = connect(Number(proxyUrl.port), proxyUrl.hostname);
    let stopPromise: Promise<void> | null = null;
    try {
      await once(socket, 'connect');
      socket.write(
        [
          'GET /socket HTTP/1.1',
          `Host: ${proxyUrl.host}`,
          'Connection: Upgrade',
          'Upgrade: websocket',
          '',
          '',
        ].join('\r\n'),
      );
      await once(socket, 'data');

      stopPromise = proxy.stop();
      await expect(
        withTimeoutMs({
          promise: stopPromise,
          timeoutMs: 1_000,
          label: 'forwarded header proxy stop',
        }),
      ).resolves.toBeUndefined();
    } finally {
      socket.destroy();
      for (const targetSocket of targetSockets) targetSocket.destroy();
      await stopPromise?.catch(() => {});
      await closeServer(target);
    }
  });
});
