import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { buildExpoDevEnv, buildExpoStartArgs, resolveExpoDevHost, stopExpoProcessTree } from './expo_dev.mjs';

test('stopExpoProcessTree forwards its declared grace to the canonical tree owner', async () => {
  const proc = new EventEmitter();
  proc.pid = 100;
  proc.exitCode = null;
  proc.signalCode = null;
  proc.__happierClosed = false;
  let receivedOptions = null;
  await stopExpoProcessTree(proc, {
    graceMs: 17,
    killProcessTreeImpl: async (_proc, _signal, options) => {
      receivedOptions = options;
      proc.exitCode = 0;
      proc.__happierClosed = true;
    },
    isPidAliveImpl: () => false,
  });
  assert.deepEqual(receivedOptions, { graceMs: 17 });
});

test('stopExpoProcessTree kills a certified Windows listener after its wrapper has exited', async () => {
  const proc = new EventEmitter();
  proc.pid = 100;
  proc.exitCode = 1;
  proc.signalCode = null;
  proc.__happierClosed = true;
  const alive = new Set([200]);
  const killed = [];
  await stopExpoProcessTree(proc, {
    platform: 'win32',
    ownedListenerPids: [200],
    killProcessTreeImpl: () => {},
    killPidImpl: (pid, signal) => {
      killed.push([pid, signal]);
      alive.delete(pid);
    },
    isPidAliveImpl: (pid) => alive.has(pid),
  });
  assert.deepEqual(killed, [[200, 'SIGTERM']]);
});

test('stopExpoProcessTree surfaces a certified Windows listener that survives TERM and KILL', async () => {
  const proc = new EventEmitter();
  proc.pid = 100;
  proc.exitCode = 1;
  proc.signalCode = null;
  proc.__happierClosed = true;
  await assert.rejects(
    () => stopExpoProcessTree(proc, {
      platform: 'win32',
      graceMs: 1,
      ownedListenerPids: [200],
      killProcessTreeImpl: () => {},
      killPidImpl: () => {},
      isPidAliveImpl: () => true,
    }),
    (error) => error?.code === 'EEXPOCLEANUP',
  );
});

test('resolveExpoDevHost defaults to lan and normalizes values', () => {
  assert.equal(resolveExpoDevHost({ env: {} }), 'lan');
  assert.equal(resolveExpoDevHost({ env: { HAPPIER_STACK_EXPO_HOST: 'LAN' } }), 'lan');
  assert.equal(resolveExpoDevHost({ env: { HAPPIER_STACK_EXPO_HOST: '  TuNnEl  ' } }), 'tunnel');
  assert.equal(resolveExpoDevHost({ env: { HAPPIER_STACK_EXPO_HOST: 'localhost' } }), 'localhost');
  assert.equal(resolveExpoDevHost({ env: { HAPPIER_STACK_EXPO_HOST: 'tunnel' } }), 'tunnel');
  assert.equal(resolveExpoDevHost({ env: { HAPPIER_STACK_EXPO_HOST: 'nope' } }), 'lan');
});

test('buildExpoDevEnv enables Expo Router web modal support', () => {
  const env = buildExpoDevEnv({
    baseEnv: { EXPO_UNSTABLE_WEB_MODAL: '0' },
    apiServerUrl: 'http://127.0.0.1:4000',
    wantDevClient: false,
    wantWeb: true,
  });

  assert.equal(env.EXPO_UNSTABLE_WEB_MODAL, '1');
});

test('buildExpoStartArgs builds dev-client args (preferred when mobile enabled)', () => {
  const args = buildExpoStartArgs({
    port: 8081,
    host: 'lan',
    wantWeb: true,
    wantDevClient: true,
    scheme: 'happy',
    clearCache: true,
  });
  assert.deepEqual(args, ['start', '--dev-client', '--host', 'lan', '--port', '8081', '--scheme', 'happy', '--clear']);
});

test('buildExpoStartArgs builds web args when dev-client is not requested', () => {
  const args = buildExpoStartArgs({
    port: 8081,
    host: 'lan',
    wantWeb: true,
    wantDevClient: false,
    scheme: '',
    clearCache: false,
  });
  assert.deepEqual(args, ['start', '--web', '--host', 'lan', '--port', '8081']);
});

test('buildExpoStartArgs omits --scheme when empty', () => {
  const args = buildExpoStartArgs({
    port: 8081,
    host: 'lan',
    wantWeb: false,
    wantDevClient: true,
    scheme: '',
    clearCache: false,
  });
  assert.deepEqual(args, ['start', '--dev-client', '--host', 'lan', '--port', '8081']);
});

test('buildExpoStartArgs accepts numeric port strings and does not add --clear when disabled', () => {
  const args = buildExpoStartArgs({
    port: '8082',
    host: 'localhost',
    wantWeb: true,
    wantDevClient: false,
    scheme: '',
    clearCache: false,
  });
  assert.deepEqual(args, ['start', '--web', '--host', 'localhost', '--port', '8082']);
  assert.equal(args.includes('--clear'), false);
});

test('buildExpoStartArgs throws on invalid requests', () => {
  assert.throws(
    () =>
      buildExpoStartArgs({
        port: 0,
        host: 'lan',
        wantWeb: true,
        wantDevClient: false,
        scheme: '',
        clearCache: false,
      }),
    /invalid Metro port/i
  );
  assert.throws(
    () =>
      buildExpoStartArgs({
        port: 8081,
        host: 'lan',
        wantWeb: false,
        wantDevClient: false,
        scheme: '',
        clearCache: false,
      }),
    /neither web nor dev-client requested/i
  );
});
