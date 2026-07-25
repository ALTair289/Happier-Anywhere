import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { setupStackNewMonorepoFixture } from './testkit/stack_new_monorepo_testkit.mjs';
import { waitForTcpPortFree } from './utils/net/ports.mjs';

async function closeServer(server) {
  if (!server.listening) return;
  await new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

async function listenOnPort(t, port = 0) {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  t.after(() => closeServer(server));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return { port: address.port, server };
}

function parseJsonResult(result) {
  assert.equal(result.code, 0, result.stderr);
  return JSON.parse(result.stdout);
}

async function installDeterministicListenerDiscoveryBoundary(fixture) {
  const binDir = join(fixture.tmp, 'listener-discovery-bin');
  await mkdir(binDir, { recursive: true });
  const lsofPath = join(binDir, 'lsof');
  await writeFile(lsofPath, '#!/bin/sh\nexit 0\n', 'utf8');
  await chmod(lsofPath, 0o755);
  fixture.baseEnv.PATH = `${binDir}:${fixture.baseEnv.PATH ?? process.env.PATH ?? ''}`;
}

test('stack new --force-port overrides only another stack reservation', async (t) => {
  const fixture = await setupStackNewMonorepoFixture({
    importMetaUrl: import.meta.url,
    t,
    tmpPrefix: 'hstack-stack-new-force-reserved-port-',
  });
  await installDeterministicListenerDiscoveryBoundary(fixture);
  await fixture.createMonorepoCheckout('main');

  const reservation = await listenOnPort(t);
  const port = reservation.port;
  await closeServer(reservation.server);
  assert.equal((await waitForTcpPortFree(port, { timeoutMs: 5_000 })).status, 'free');

  const owner = await fixture.runStackNew([
    'reserved-owner',
    '--no-copy-auth',
    `--port=${port}`,
    '--json',
  ]);
  const ownerResult = parseJsonResult(owner);
  assert.equal(ownerResult.port, port);
  assert.equal(ownerResult.portsMode, 'pinned');
  assert.match(await fixture.readStackEnv('reserved-owner'), new RegExp(`^HAPPIER_STACK_SERVER_PORT=${port}$`, 'm'));

  const rejected = await fixture.runStackNew([
    'reserved-rejected',
    '--no-copy-auth',
    `--port=${port}`,
    '--json',
  ]);
  assert.equal(rejected.code, 1);
  assert.match(rejected.stderr, /reserved/i);
  await assert.rejects(fixture.readStackEnv('reserved-rejected'), { code: 'ENOENT' });

  const occupiedReservation = await listenOnPort(t, port);
  const occupied = await fixture.runStackNew([
    'reserved-occupied',
    '--no-copy-auth',
    `--port=${port}`,
    '--force-port',
    '--json',
  ]);
  assert.equal(occupied.code, 1);
  assert.match(occupied.stderr, /not free/i);
  assert.equal(occupiedReservation.server.listening, true);
  await assert.rejects(fixture.readStackEnv('reserved-occupied'), { code: 'ENOENT' });
  await closeServer(occupiedReservation.server);
  assert.equal((await waitForTcpPortFree(port, { timeoutMs: 5_000 })).status, 'free');

  const forced = await fixture.runStackNew([
    'reserved-forced',
    '--no-copy-auth',
    `--port=${port}`,
    '--force-port',
    '--json',
  ]);
  const forcedResult = parseJsonResult(forced);
  assert.equal(forcedResult.port, port);
  assert.equal(forcedResult.portsMode, 'pinned');
  assert.match(await fixture.readStackEnv('reserved-forced'), new RegExp(`^HAPPIER_STACK_SERVER_PORT=${port}$`, 'm'));
});

test('stack new --force-port never overrides a live listener', async (t) => {
  const fixture = await setupStackNewMonorepoFixture({
    importMetaUrl: import.meta.url,
    t,
    tmpPrefix: 'hstack-stack-new-force-live-port-',
  });
  await installDeterministicListenerDiscoveryBoundary(fixture);
  await fixture.createMonorepoCheckout('main');
  const { port, server } = await listenOnPort(t);

  const result = await fixture.runStackNew([
    'occupied-forced',
    '--no-copy-auth',
    `--port=${port}`,
    '--force-port',
    '--json',
  ]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /not free/i);
  assert.equal(server.listening, true);
  assert.equal(server.address()?.port, port);
  await assert.rejects(fixture.readStackEnv('occupied-forced'), { code: 'ENOENT' });
});
