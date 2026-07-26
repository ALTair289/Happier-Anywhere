import { createServer, request as httpRequest } from 'node:http';
import { connect, type Socket } from 'node:net';
import { once } from 'node:events';

import { describe, expect, it } from 'vitest';

import { withTimeoutMs } from './timing/withTimeout';
import { startHttpRequestRecordingProxy } from './httpRequestRecordingProxy';

function listen(server: ReturnType<typeof createServer>, host = '127.0.0.1'): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, () => resolve());
  });
}

function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

async function waitForNoSockets(sockets: ReadonlySet<Socket>): Promise<void> {
  await withTimeoutMs({
    promise: new Promise<void>((resolve) => {
      const check = () => {
        if (sockets.size === 0) {
          resolve();
          return;
        }
        setTimeout(check, 25);
      };
      check();
    }),
    timeoutMs: 1_000,
    label: 'upgraded upstream sockets to close',
  });
}

async function requestThroughProxy(params: Readonly<{
  baseUrl: string;
  path: string;
  headers?: Record<string, string>;
}>): Promise<Readonly<{ statusCode: number; body: string }>> {
  const target = new URL(params.path, params.baseUrl);
  return await new Promise((resolve, reject) => {
    const req = httpRequest({
      hostname: target.hostname,
      port: target.port,
      method: 'POST',
      path: `${target.pathname}${target.search}`,
      headers: {
        'content-type': 'application/json',
        'content-length': '2',
        ...params.headers,
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer | string) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      res.on('end', () => resolve({
        statusCode: res.statusCode ?? 0,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.once('error', reject);
    req.end('{}');
  });
}

describe('startHttpRequestRecordingProxy', () => {
  it('drops exactly one exact-path response only after the upstream 2xx completes', async () => {
    const exactPath = '/v2/sessions/session-1/pending/local-1/delivery/accepted';
    const querySecret = 'test-secret-query-token';
    const exactUrl = `${exactPath}?access_token=${querySecret}`;
    const neighborPath = '/v2/sessions/session-1/pending/local-1/delivery/accepted-neighbor';
    const neighborUrl = `${neighborPath}?access_token=${querySecret}`;
    const sensitiveHeaders = {
      authorization: 'Bearer test-secret-token',
      cookie: 'session=test-secret-cookie',
      'x-api-token': 'test-secret-api-token',
      'x-auth-key': 'test-secret-auth-key',
      referer: `http://127.0.0.1/callback?access_token=${querySecret}`,
      'x-happier-request-purpose': 'accepted-settlement-test',
    };
    const upstreamRequests: Array<Readonly<{
      path: string;
      authorization?: string;
      cookie?: string;
      'x-api-token'?: string;
      'x-auth-key'?: string;
      referer?: string;
      'x-happier-request-purpose'?: string;
    }>> = [];
    let completedUpstreamResponses = 0;
    let releaseDroppedUpstreamResponse!: () => void;
    const droppedUpstreamResponseRelease = new Promise<void>((resolve) => {
      releaseDroppedUpstreamResponse = resolve;
    });
    let observeDroppedUpstreamResponse!: () => void;
    const droppedUpstreamResponseObserved = new Promise<void>((resolve) => {
      observeDroppedUpstreamResponse = resolve;
    });
    const target = createServer((req, res) => {
      upstreamRequests.push({
        path: req.url ?? '/',
        ...(typeof req.headers.authorization === 'string' ? { authorization: req.headers.authorization } : {}),
        ...(typeof req.headers.cookie === 'string' ? { cookie: req.headers.cookie } : {}),
        ...(typeof req.headers['x-api-token'] === 'string' ? { 'x-api-token': req.headers['x-api-token'] } : {}),
        ...(typeof req.headers['x-auth-key'] === 'string' ? { 'x-auth-key': req.headers['x-auth-key'] } : {}),
        ...(typeof req.headers.referer === 'string' ? { referer: req.headers.referer } : {}),
        ...(typeof req.headers['x-happier-request-purpose'] === 'string'
          ? { 'x-happier-request-purpose': req.headers['x-happier-request-purpose'] }
          : {}),
      });
      res.once('finish', () => {
        completedUpstreamResponses += 1;
      });
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.setHeader('set-cookie', 'upstream=test-secret-cookie');
      if (req.url === exactUrl && upstreamRequests.length === 2) {
        res.write('{"ok":');
        observeDroppedUpstreamResponse();
        void droppedUpstreamResponseRelease.then(() => {
          res.end('true,"privatePayload":"must-not-be-recorded"}');
        });
        return;
      }
      res.end(JSON.stringify({ ok: true, privatePayload: 'must-not-be-recorded' }));
    });
    await listen(target);
    const targetAddress = target.address();
    if (!targetAddress || typeof targetAddress !== 'object') throw new Error('target server did not bind');

    const proxy = await startHttpRequestRecordingProxy({
      targetBaseUrl: `http://127.0.0.1:${targetAddress.port}`,
    });

    try {
      proxy.armOneShotResponseDrop({
        armId: 'settlement-local-1',
        method: 'POST',
        path: exactPath,
      });
      expect(() => proxy.armOneShotResponseDrop({
        armId: 'overlapping-arm',
        method: 'POST',
        path: exactPath,
      })).toThrow(/already armed/i);

      await expect(requestThroughProxy({
        baseUrl: proxy.baseUrl,
        path: neighborUrl,
        headers: sensitiveHeaders,
      })).resolves.toMatchObject({ statusCode: 200 });

      const droppedRequest = requestThroughProxy({
        baseUrl: proxy.baseUrl,
        path: exactUrl,
        headers: sensitiveHeaders,
      });
      let droppedRequestSettled = false;
      void droppedRequest.then(
        () => { droppedRequestSettled = true; },
        () => { droppedRequestSettled = true; },
      );
      await droppedUpstreamResponseObserved;
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(droppedRequestSettled).toBe(false);
      expect(completedUpstreamResponses).toBe(1);
      releaseDroppedUpstreamResponse();
      await expect(droppedRequest).rejects.toThrow();
      expect(completedUpstreamResponses).toBe(2);

      await expect(requestThroughProxy({
        baseUrl: proxy.baseUrl,
        path: exactUrl,
        headers: sensitiveHeaders,
      })).resolves.toMatchObject({ statusCode: 200 });

      expect(upstreamRequests).toHaveLength(3);
      expect(upstreamRequests[1]).toMatchObject({ path: exactUrl, ...sensitiveHeaders });
      const entries = proxy.entries();
      expect(entries.map((entry) => entry.path)).toEqual([neighborPath, exactPath, exactPath]);
      expect(entries.map((entry) => entry.responseDisposition)).toEqual([
        'forwarded',
        'dropped_after_upstream',
        'forwarded',
      ]);
      expect(entries[1]).toMatchObject({
        statusCode: 200,
        responseBodyBytes: expect.any(Number),
      });
      expect(entries[1]?.headers).toMatchObject({
        authorization: '[redacted]',
        cookie: '[redacted]',
        'x-api-token': '[redacted]',
        'x-auth-key': '[redacted]',
        referer: '[redacted]',
        'x-happier-request-purpose': 'accepted-settlement-test',
      });
      expect(JSON.stringify(entries)).not.toContain('test-secret');
      expect(JSON.stringify(entries)).not.toContain('privatePayload');
      expect(() => proxy.armOneShotResponseDrop({
        armId: 'settlement-local-1',
        method: 'POST',
        path: exactPath,
      })).toThrow(/already used/i);
    } finally {
      releaseDroppedUpstreamResponse();
      await proxy.stop().catch(() => {});
      await closeServer(target);
    }
  });

  it('fails a matched downstream request when the upstream response aborts before completion', async () => {
    const exactPath = '/v2/sessions/session-1/pending/local-aborted/delivery/accepted';
    const target = createServer((_req, res) => {
      res.statusCode = 200;
      res.write('partial-response');
      setImmediate(() => res.socket?.destroy());
    });
    await listen(target);
    const targetAddress = target.address();
    if (!targetAddress || typeof targetAddress !== 'object') throw new Error('target server did not bind');

    const proxy = await startHttpRequestRecordingProxy({
      targetBaseUrl: `http://127.0.0.1:${targetAddress.port}`,
    });

    try {
      proxy.armOneShotResponseDrop({
        armId: 'settlement-local-aborted',
        method: 'POST',
        path: exactPath,
      });
      await expect(withTimeoutMs({
        promise: requestThroughProxy({ baseUrl: proxy.baseUrl, path: exactPath }),
        timeoutMs: 250,
        label: 'matched downstream request to fail after incomplete upstream response',
      })).rejects.not.toThrow(/Timed out/i);
      expect(proxy.entries()).toEqual([
        expect.objectContaining({
          path: exactPath,
          statusCode: 200,
          error: 'response_drop_upstream_incomplete',
        }),
      ]);
    } finally {
      await proxy.stop().catch(() => {});
      await closeServer(target);
    }
  });

  it('forwards a matched non-2xx response without applying the success-response buffer cap', async () => {
    const exactPath = '/v2/sessions/session-1/pending/local-overloaded/delivery/accepted';
    const responseBody = JSON.stringify({ error: 'temporarily-unavailable', padding: 'x'.repeat(128) });
    const target = createServer((_req, res) => {
      res.statusCode = 503;
      res.setHeader('content-type', 'application/json');
      res.end(responseBody);
    });
    await listen(target);
    const targetAddress = target.address();
    if (!targetAddress || typeof targetAddress !== 'object') throw new Error('target server did not bind');

    const proxy = await startHttpRequestRecordingProxy({
      targetBaseUrl: `http://127.0.0.1:${targetAddress.port}`,
    });
    try {
      proxy.armOneShotResponseDrop({
        armId: 'settlement-local-overloaded',
        method: 'POST',
        path: exactPath,
        maxResponseBytes: 4,
      });
      await expect(requestThroughProxy({
        baseUrl: proxy.baseUrl,
        path: exactPath,
      })).resolves.toEqual({ statusCode: 503, body: responseBody });
      expect(proxy.entries()).toEqual([
        expect.objectContaining({
          path: exactPath,
          statusCode: 503,
          error: 'response_drop_upstream_not_successful',
          responseDisposition: 'forwarded',
          responseBodyBytes: Buffer.byteLength(responseBody),
        }),
      ]);
    } finally {
      await proxy.stop().catch(() => {});
      await closeServer(target);
    }
  });

  it('bounds a matched 2xx drain and consumes the arm without storing the response body', async () => {
    const exactPath = '/v2/sessions/session-1/pending/local-oversized/delivery/accepted';
    const responseBody = 'x'.repeat(128);
    const target = createServer((_req, res) => {
      res.statusCode = 200;
      res.end(responseBody);
    });
    await listen(target);
    const targetAddress = target.address();
    if (!targetAddress || typeof targetAddress !== 'object') throw new Error('target server did not bind');

    const proxy = await startHttpRequestRecordingProxy({
      targetBaseUrl: `http://127.0.0.1:${targetAddress.port}`,
    });
    try {
      proxy.armOneShotResponseDrop({
        armId: 'settlement-local-oversized',
        method: 'POST',
        path: exactPath,
        maxResponseBytes: 4,
      });
      await expect(requestThroughProxy({
        baseUrl: proxy.baseUrl,
        path: exactPath,
      })).rejects.toThrow();
      await expect(requestThroughProxy({
        baseUrl: proxy.baseUrl,
        path: exactPath,
      })).resolves.toEqual({ statusCode: 200, body: responseBody });

      expect(proxy.entries()).toEqual([
        expect.objectContaining({
          path: exactPath,
          statusCode: 200,
          error: 'response_drop_buffer_limit_exceeded',
          responseDisposition: null,
          responseBodyBytes: responseBody.length,
        }),
        expect.objectContaining({
          path: exactPath,
          statusCode: 200,
          error: null,
          responseDisposition: 'forwarded',
          responseBodyBytes: responseBody.length,
        }),
      ]);
      expect(JSON.stringify(proxy.entries())).not.toContain(responseBody);
    } finally {
      await proxy.stop().catch(() => {});
      await closeServer(target);
    }
  });

  it('forwards to an explicitly allowed IPv6 loopback target', async ({ skip }) => {
    const target = createServer((_req, res) => {
      res.statusCode = 200;
      res.end('ipv6-loopback-ok');
    });
    try {
      await listen(target, '::1');
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error
        ? (error as { code?: unknown }).code
        : null;
      if (code === 'EAFNOSUPPORT' || code === 'EADDRNOTAVAIL') {
        skip();
        return;
      }
      throw error;
    }
    const targetAddress = target.address();
    if (!targetAddress || typeof targetAddress !== 'object') throw new Error('IPv6 target server did not bind');

    const proxy = await startHttpRequestRecordingProxy({
      targetBaseUrl: `http://[::1]:${targetAddress.port}`,
    });
    try {
      await expect(requestThroughProxy({
        baseUrl: proxy.baseUrl,
        path: '/ipv6-loopback',
      })).resolves.toEqual({ statusCode: 200, body: 'ipv6-loopback-ok' });
    } finally {
      await proxy.stop().catch(() => {});
      await closeServer(target);
    }
  });

  it('closes upgraded upstream sockets when stopped', async () => {
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
      socket.resume();
      const ping = setInterval(() => {
        if (!socket.destroyed) socket.write('ping');
      }, 25);
      socket.once('close', () => clearInterval(ping));
      socket.once('error', () => clearInterval(ping));
    });
    await listen(target);
    const targetAddress = target.address();
    if (!targetAddress || typeof targetAddress !== 'object') throw new Error('target server did not bind');

    const proxy = await startHttpRequestRecordingProxy({
      targetBaseUrl: `http://127.0.0.1:${targetAddress.port}`,
    });
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
      expect(targetSockets.size).toBeGreaterThan(0);

      stopPromise = proxy.stop();
      await expect(withTimeoutMs({
        promise: stopPromise,
        timeoutMs: 1_000,
        label: 'http request recording proxy stop',
      })).resolves.toBeUndefined();
      await waitForNoSockets(targetSockets);
    } finally {
      socket.destroy();
      for (const targetSocket of targetSockets) targetSocket.destroy();
      await stopPromise?.catch(() => {});
      await closeServer(target);
    }
  });
});
