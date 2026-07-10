import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  readDevReloadWatchChangeSignature,
  resolveDevReloadPollIntervalMs,
  startDevReloadCoordinator,
} from './devReloadCoordinator.mjs';

function createDescriptor({ id, target, initial = '0', paths = [`/tmp/${id}`] }) {
  let signature = initial;
  return {
    id,
    target,
    paths,
    setSignature(value) {
      signature = value;
    },
    readSignature() {
      return signature;
    },
  };
}

function createExecutor(target, calls, overrides = {}) {
  return {
    target,
    async build(context) {
      calls.push(`${target}:build:${context.cycle}`);
      return await overrides.build?.(context);
    },
    async restart(context) {
      calls.push(`${target}:restart:${context.cycle}`);
      return await overrides.restart?.(context);
    },
  };
}

function startCoordinator({ descriptors, executors, calls = [], isShuttingDown = () => false, logger } = {}) {
  let capturedOnChange = null;
  const watcher = startDevReloadCoordinator(
    {
      enabled: true,
      descriptors,
      executors,
      isShuttingDown,
      logger: logger ?? { log() {}, warn() {}, error() {} },
    },
    {
      watchDebouncedImpl: ({ paths, onChange }) => {
        calls.push(`watch:${paths.sort().join('|')}`);
        capturedOnChange = onChange;
        return { close() { calls.push('closed'); } };
      },
    }
  );

  assert.ok(watcher);
  assert.equal(typeof capturedOnChange, 'function');
  return { watcher, onChange: capturedOnChange };
}

test('daemon-only and server-only changes build and restart only their target', async () => {
  const calls = [];
  const daemon = createDescriptor({ id: 'daemon:cli', target: 'daemon' });
  const server = createDescriptor({ id: 'server:app', target: 'server' });
  const { onChange } = startCoordinator({
    descriptors: [daemon, server],
    executors: [
      createExecutor('daemon', calls),
      createExecutor('server', calls),
    ],
    calls,
  });

  daemon.setSignature('1');
  await onChange({ eventType: 'change', filename: 'index.ts' });
  assert.deepEqual(calls.slice(1), ['daemon:build:1', 'daemon:restart:1']);

  calls.length = 1;
  server.setSignature('1');
  await onChange({ eventType: 'change', filename: null });
  assert.deepEqual(calls.slice(1), ['server:build:2', 'server:restart:2']);
});

test('shared edits build both targets first and restart server before daemon sequentially', async () => {
  const calls = [];
  let serverRestartResolved = false;
  const shared = createDescriptor({ id: 'shared:protocol', target: 'shared' });
  const { onChange } = startCoordinator({
    descriptors: [shared],
    executors: [
      createExecutor('daemon', calls, {
        restart() {
          assert.equal(serverRestartResolved, true, 'daemon restart must wait for server restart');
        },
      }),
      createExecutor('server', calls, {
        async restart() {
          await Promise.resolve();
          serverRestartResolved = true;
        },
      }),
    ],
    calls,
  });

  shared.setSignature('1');
  await onChange({ eventType: 'change', filename: 'mutations.ts' });

  assert.deepEqual(calls.slice(1), [
    'server:build:1',
    'daemon:build:1',
    'server:restart:1',
    'daemon:restart:1',
  ]);
});

test('build failure skips all restarts and keeps coordinator alive', async () => {
  const calls = [];
  const errors = [];
  const shared = createDescriptor({ id: 'shared:cli-common', target: 'shared' });
  const { onChange } = startCoordinator({
    descriptors: [shared],
    executors: [
      createExecutor('server', calls, {
        build() {
          throw new Error('server preflight failed');
        },
      }),
      createExecutor('daemon', calls),
    ],
    calls,
    logger: { log() {}, warn() {}, error(message) { errors.push(String(message)); } },
  });

  shared.setSignature('1');
  await onChange({ eventType: 'change', filename: 'types.ts' });

  assert.deepEqual(calls.slice(1), ['server:build:1']);
  assert.ok(errors.some((message) => message.includes('server preflight failed')));

  shared.setSignature('2');
  await onChange({ eventType: 'change', filename: 'types.ts' });
  assert.deepEqual(calls.slice(1), ['server:build:1', 'server:build:2']);
});

test('failed shared transaction stays dirty until all affected targets restart', async () => {
  const calls = [];
  let daemonBuildAttempts = 0;
  const shared = createDescriptor({ id: 'shared:protocol', target: 'shared' });
  const daemon = createDescriptor({ id: 'daemon:cli', target: 'daemon' });
  const { onChange } = startCoordinator({
    descriptors: [shared, daemon],
    executors: [
      createExecutor('server', calls),
      createExecutor('daemon', calls, {
        build() {
          daemonBuildAttempts += 1;
          if (daemonBuildAttempts === 1) {
            throw new Error('daemon build failed');
          }
        },
      }),
    ],
    calls,
  });

  shared.setSignature('1');
  await onChange({ eventType: 'change', filename: 'protocol.ts' });
  assert.deepEqual(calls.slice(1), ['server:build:1', 'daemon:build:1']);

  daemon.setSignature('1');
  await onChange({ eventType: 'change', filename: 'cli.ts' });
  assert.deepEqual(calls.slice(1), [
    'server:build:1',
    'daemon:build:1',
    'server:build:2',
    'daemon:build:2',
    'server:restart:2',
    'daemon:restart:2',
  ]);
});

test('change during a cycle runs exactly one trailing cycle with the latest signature', async () => {
  const calls = [];
  const daemon = createDescriptor({ id: 'daemon:cli', target: 'daemon' });
  let onChange = null;
  const coordinator = startCoordinator({
    descriptors: [daemon],
    executors: [
      createExecutor('daemon', calls, {
        async restart(context) {
          if (context.cycle === 1) {
            daemon.setSignature('2');
            await onChange({ eventType: 'change', filename: 'second.ts' });
            daemon.setSignature('3');
            await onChange({ eventType: 'change', filename: 'third.ts' });
          }
        },
      }),
    ],
    calls,
  });
  onChange = coordinator.onChange;

  daemon.setSignature('1');
  await onChange({ eventType: 'change', filename: 'first.ts' });

  assert.deepEqual(calls.slice(1), [
    'daemon:build:1',
    'daemon:restart:1',
    'daemon:build:2',
    'daemon:restart:2',
  ]);
});

test('duplicate shared events for the same signature coalesce to one transaction', async () => {
  const calls = [];
  const sharedA = createDescriptor({ id: 'shared:agents:a', target: 'shared', paths: ['/tmp/shared-agents'] });
  const sharedB = createDescriptor({ id: 'shared:agents:b', target: 'shared', paths: ['/tmp/shared-agents'] });
  const { onChange } = startCoordinator({
    descriptors: [sharedA, sharedB],
    executors: [
      createExecutor('server', calls),
      createExecutor('daemon', calls),
    ],
    calls,
  });

  sharedA.setSignature('1');
  sharedB.setSignature('1');
  await onChange({ eventType: 'change', filename: 'index.ts' });
  await onChange({ eventType: 'change', filename: 'index.ts' });

  assert.deepEqual(calls.slice(1), [
    'server:build:1',
    'daemon:build:1',
    'server:restart:1',
    'daemon:restart:1',
  ]);
});

test('duplicate shared descriptor ids from daemon and server wiring merge into one transaction', async () => {
  const calls = [];
  const sharedFromDaemon = createDescriptor({ id: 'shared:protocol', target: 'shared', paths: ['/tmp/protocol/src'] });
  const sharedFromServer = createDescriptor({ id: 'shared:protocol', target: 'shared', paths: ['/tmp/protocol/package.json'] });
  const { onChange } = startCoordinator({
    descriptors: [sharedFromDaemon, sharedFromServer],
    executors: [
      createExecutor('daemon', calls),
      createExecutor('server', calls),
    ],
    calls,
  });

  sharedFromDaemon.setSignature('1');
  sharedFromServer.setSignature('1');
  await onChange({ eventType: 'change', filename: 'index.ts' });

  assert.deepEqual(calls.slice(1), [
    'server:build:1',
    'daemon:build:1',
    'server:restart:1',
    'daemon:restart:1',
  ]);
});

test('signature polling is delegated to watchDebounced with the aggregate descriptor signature', async () => {
  const calls = [];
  const daemon = createDescriptor({ id: 'daemon:cli', target: 'daemon' });
  let capturedOnChange = null;
  let capturedReadSignature = null;
  const watcher = startDevReloadCoordinator(
    {
      enabled: true,
      descriptors: [daemon],
      executors: [createExecutor('daemon', calls)],
      pollIntervalMs: 1234,
      logger: { log() {}, warn() {}, error() {} },
    },
    {
      watchDebouncedImpl: ({ paths, onChange, pollIntervalMs, readSignature }) => {
        calls.push(`watch:${paths.sort().join('|')}`);
        assert.equal(pollIntervalMs, 1234);
        assert.equal(typeof readSignature, 'function');
        capturedOnChange = onChange;
        capturedReadSignature = readSignature;
        return { close() { calls.push('watch:closed'); } };
      },
    },
  );

  assert.ok(watcher);
  assert.equal(typeof capturedOnChange, 'function');
  assert.equal(typeof capturedReadSignature, 'function');
  const before = capturedReadSignature();

  daemon.setSignature('1');
  assert.notEqual(capturedReadSignature(), before);
  await capturedOnChange({ eventType: 'poll', filename: null });

  assert.deepEqual(calls.slice(1), ['daemon:build:1', 'daemon:restart:1']);

  watcher.close();
  assert.ok(calls.includes('watch:closed'));
});

test('resolveDevReloadPollIntervalMs defaults on and supports explicit opt-out', () => {
  assert.equal(resolveDevReloadPollIntervalMs({}, { defaultMs: 2000 }), 2000);
  assert.equal(
    resolveDevReloadPollIntervalMs({ HAPPIER_STACK_DEV_RELOAD_POLL_MS: '750' }, { defaultMs: 2000 }),
    750,
  );
  assert.equal(
    resolveDevReloadPollIntervalMs({ HAPPIER_STACK_DEV_RELOAD_POLL_MS: '0' }, { defaultMs: 2000 }),
    0,
  );
  assert.equal(
    resolveDevReloadPollIntervalMs({ HAPPIER_STACK_DEV_RELOAD_POLL_MS: '-1' }, { defaultMs: 2000 }),
    2000,
  );
});

test('reload coordinator logs every initialization bail reason', () => {
  const messages = [];
  const logger = {
    log(message) { messages.push(String(message)); },
    warn(message) { messages.push(String(message)); },
    error(message) { messages.push(String(message)); },
  };
  const executor = createExecutor('daemon', []);
  const descriptor = createDescriptor({ id: 'daemon:cli', target: 'daemon' });

  assert.equal(startDevReloadCoordinator({ enabled: false, descriptors: [descriptor], executors: [executor], logger }), null);
  assert.equal(startDevReloadCoordinator({ enabled: true, descriptors: [], executors: [executor], logger }), null);
  assert.equal(startDevReloadCoordinator({ enabled: true, descriptors: [descriptor], executors: [], logger }), null);
  assert.equal(startDevReloadCoordinator({
    enabled: true,
    descriptors: [{ ...descriptor, paths: [] }],
    executors: [executor],
    logger,
  }), null);

  assert.ok(messages.some((message) => message.includes('disabled')));
  assert.ok(messages.some((message) => message.includes('no valid descriptors')));
  assert.ok(messages.some((message) => message.includes('no executors')));
  assert.ok(messages.some((message) => message.includes('no watch paths')));
});

test('reload coordinator logs a watcher event that has no signature delta', async () => {
  const messages = [];
  const daemon = createDescriptor({ id: 'daemon:cli', target: 'daemon' });
  const { onChange } = startCoordinator({
    descriptors: [daemon],
    executors: [createExecutor('daemon', [])],
    logger: {
      log(message) { messages.push(String(message)); },
      warn(message) { messages.push(String(message)); },
      error(message) { messages.push(String(message)); },
    },
  });

  await onChange({ eventType: 'change', filename: 'runtime.ts' });

  assert.ok(messages.some((message) => message.includes('no signature delta')));
});

test('watch signature distinguishes same-size edits within one millisecond', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hs-dev-reload-signature-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const sourcePath = join(root, 'runtime.ts');

  await writeFile(sourcePath, 'one\n', 'utf-8');
  await utimes(sourcePath, 1_000.0001, 1_000.0001);
  const first = readDevReloadWatchChangeSignature([sourcePath]);

  await writeFile(sourcePath, 'two\n', 'utf-8');
  await utimes(sourcePath, 1_000.0009, 1_000.0009);
  const second = readDevReloadWatchChangeSignature([sourcePath]);

  assert.notEqual(second, first);
});
