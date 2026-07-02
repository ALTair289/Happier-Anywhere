import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import {
  prepareDevProxyStartup,
  resolveDevProxyStableHost,
  shouldEnableStackDevProxy,
  startDevProxy,
  startDevProxyMaintenanceUpstream,
} from './devProxy.mjs';

function request(port, path = '/') {
  return new Promise((resolve, reject) => {
    const req = http.get({
      host: '127.0.0.1',
      port,
      path,
      agent: false,
      headers: { Connection: 'close' },
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
  });
}

test('stack dev proxy is default-on and supports flag/env opt-out', () => {
  assert.equal(shouldEnableStackDevProxy({ startServer: true, flags: new Set(), env: {} }), true);
  assert.equal(shouldEnableStackDevProxy({ startServer: true, flags: new Set(['--no-proxy']), env: {} }), false);
  assert.equal(shouldEnableStackDevProxy({ startServer: true, flags: new Set(), env: { HAPPIER_STACK_DEV_PROXY: '0' } }), false);
  assert.equal(shouldEnableStackDevProxy({ startServer: false, flags: new Set(), env: {} }), false);
});

test('stack dev proxy stable host preserves direct server reachability unless loopback is requested', () => {
  assert.equal(resolveDevProxyStableHost({ env: {} }), '0.0.0.0');
  assert.equal(resolveDevProxyStableHost({ env: { HAPPIER_STACK_BIND_MODE: 'lan' } }), '0.0.0.0');
  assert.equal(resolveDevProxyStableHost({ env: { HAPPIER_STACK_BIND_MODE: 'loopback' } }), '127.0.0.1');
  assert.equal(resolveDevProxyStableHost({ env: { HOST: '127.0.0.1' } }), '127.0.0.1');
  assert.equal(resolveDevProxyStableHost({ env: { HAPPIER_STACK_DEV_PROXY_HOST: '100.64.0.10' } }), '100.64.0.10');
});

test('startDevProxy owns the stable port and can flip new connections to a new backend', async () => {
  const firstBackend = http.createServer((_req, res) => res.end('first'));
  const secondBackend = http.createServer((_req, res) => res.end('second'));
  await new Promise((resolve, reject) => firstBackend.once('error', reject).listen(0, '127.0.0.1', resolve));
  await new Promise((resolve, reject) => secondBackend.once('error', reject).listen(0, '127.0.0.1', resolve));

  const firstPort = firstBackend.address().port;
  const secondPort = secondBackend.address().port;
  const proxy = await startDevProxy({
    stableHost: '127.0.0.1',
    stablePort: 0,
    targetHost: '127.0.0.1',
    targetPort: firstPort,
    label: 'dev-proxy-test',
  });

  try {
    assert.equal(proxy.pid, process.pid);
    assert.equal((await request(proxy.port)).body, 'first');

    proxy.flipUpstream({ targetPort: secondPort });
    assert.equal((await request(proxy.port)).body, 'second');
  } finally {
    await proxy.stop();
    await new Promise((resolve) => firstBackend.close(() => resolve()));
    await new Promise((resolve) => secondBackend.close(() => resolve()));
  }
});

test('startDevProxy serves maintenance 503 on the stable port during exclusive restart windows', async () => {
  const firstBackend = http.createServer((_req, res) => res.end('first'));
  const secondBackend = http.createServer((_req, res) => res.end('second'));
  await new Promise((resolve, reject) => firstBackend.once('error', reject).listen(0, '127.0.0.1', resolve));
  await new Promise((resolve, reject) => secondBackend.once('error', reject).listen(0, '127.0.0.1', resolve));

  const firstPort = firstBackend.address().port;
  const secondPort = secondBackend.address().port;
  const proxy = await startDevProxy({
    stableHost: '127.0.0.1',
    stablePort: 0,
    targetHost: '127.0.0.1',
    targetPort: firstPort,
    label: 'dev-proxy-maintenance-test',
  });

  try {
    assert.equal((await request(proxy.port)).body, 'first');

    await proxy.enterMaintenance({ retryAfterMs: 1500, message: 'maintenance' });
    const maintenance = await request(proxy.port);
    assert.equal(maintenance.statusCode, 503);
    assert.equal(maintenance.headers['retry-after'], '2');
    assert.equal(maintenance.body, 'maintenance\n');

    proxy.flipUpstream({ targetPort: secondPort });
    assert.equal((await request(proxy.port)).body, 'second');
  } finally {
    await proxy.stop();
    await new Promise((resolve) => firstBackend.close(() => resolve()));
    await new Promise((resolve) => secondBackend.close(() => resolve()));
  }
});

test('prepareDevProxyStartup defaults to proxy mode and inverts stable and backend ports', async () => {
  const calls = [];
  const plan = await prepareDevProxyStartup({
    enabled: true,
    stablePort: 4101,
    pickNextFreeTcpPortImpl: async (startPort, options) => {
      calls.push(['pick', startPort, options.reservedPorts.has(4101)]);
      return 5101;
    },
    startDevProxyImpl: async (options) => {
      calls.push(['proxy', options.stablePort, options.targetPort]);
      return { pid: 123, port: options.stablePort };
    },
  });

  assert.equal(plan.mode, 'proxy');
  assert.equal(plan.stablePort, 4101);
  assert.equal(plan.backendPort, 5101);
  assert.equal(plan.proxyController.pid, 123);
  assert.deepEqual(calls, [
    ['pick', 4102, true],
    ['proxy', 4101, 5101],
  ]);
});

test('prepareDevProxyStartup separates externally reachable stable bind from backend target', async () => {
  const calls = [];
  const plan = await prepareDevProxyStartup({
    enabled: true,
    stablePort: 4101,
    stableHost: '0.0.0.0',
    targetHost: '127.0.0.1',
    pickNextFreeTcpPortImpl: async (startPort, options) => {
      calls.push(['pick', startPort, options.host]);
      return 5101;
    },
    startDevProxyImpl: async (options) => {
      calls.push(['proxy', options.stableHost, options.stablePort, options.targetHost, options.targetPort]);
      return { pid: 123, port: options.stablePort };
    },
  });

  assert.equal(plan.mode, 'proxy');
  assert.equal(plan.backendPort, 5101);
  assert.deepEqual(calls, [
    ['pick', 4102, '127.0.0.1'],
    ['proxy', '0.0.0.0', 4101, '127.0.0.1', 5101],
  ]);
});

test('prepareDevProxyStartup records directFallback only when the stable port is safe for direct bind', async () => {
  const plan = await prepareDevProxyStartup({
    enabled: true,
    stablePort: 4101,
    pickNextFreeTcpPortImpl: async () => 5101,
    startDevProxyImpl: async () => {
      const error = new Error('bind failed');
      error.code = 'EADDRNOTAVAIL';
      throw error;
    },
    isTcpPortFreeImpl: async () => true,
  });

  assert.equal(plan.mode, 'directFallback');
  assert.equal(plan.stablePort, 4101);
  assert.equal(plan.backendPort, 4101);
  assert.match(plan.fallbackReason, /bind failed/);

  await assert.rejects(
    () => prepareDevProxyStartup({
      enabled: true,
      stablePort: 4101,
      pickNextFreeTcpPortImpl: async () => 5101,
      startDevProxyImpl: async () => {
        const error = new Error('address in use');
        error.code = 'EADDRINUSE';
        throw error;
      },
      isTcpPortFreeImpl: async () => false,
    }),
    /address in use/
  );
});

test('maintenance upstream returns 503 with Retry-After and a stable plain response', async () => {
  const upstream = await startDevProxyMaintenanceUpstream({
    host: '127.0.0.1',
    retryAfterMs: 2500,
    message: 'Server reload in progress',
  });

  try {
    const response = await request(upstream.port, '/v1/test');
    assert.equal(response.statusCode, 503);
    assert.equal(response.headers['retry-after'], '3');
    assert.equal(response.headers['x-happier-retry-reason'], 'server_restarting');
    assert.equal(response.headers['content-type'], 'text/plain; charset=utf-8');
    assert.equal(response.body, 'Server reload in progress\n');
  } finally {
    await upstream.stop();
  }
});

test('maintenance upstream can update retry window and message without restarting', async () => {
  const upstream = await startDevProxyMaintenanceUpstream({
    host: '127.0.0.1',
    retryAfterMs: 1000,
    message: 'old',
  });

  try {
    upstream.update({ retryAfterMs: 100, message: 'new' });

    const response = await request(upstream.port);
    assert.equal(response.statusCode, 503);
    assert.equal(response.headers['retry-after'], '1');
    assert.equal(response.body, 'new\n');
  } finally {
    await upstream.stop();
  }
});
