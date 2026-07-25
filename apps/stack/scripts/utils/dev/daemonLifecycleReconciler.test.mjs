import test from 'node:test';
import assert from 'node:assert/strict';

import { startDevDaemonLifecycleReconciler } from './daemonLifecycleReconciler.mjs';

test('daemon lifecycle reconciliation is single-flight and owned by the dev orchestrator', async () => {
  let tick = null;
  let release = null;
  let calls = 0;
  const reconciler = startDevDaemonLifecycleReconciler(
    {
      enabled: true,
      observe: async () => {
        calls += 1;
        if (calls > 1) return { status: 'running' };
        await new Promise((resolve) => {
          release = resolve;
        });
        return { status: 'running' };
      },
      recover: async () => assert.fail('a running daemon must not be recovered'),
    },
    {
      setIntervalImpl: (fn) => {
        tick = fn;
        return { unref() {} };
      },
      clearIntervalImpl: () => {},
    },
  );

  const first = reconciler.reconcileNow();
  tick();
  await Promise.resolve();
  assert.equal(calls, 1);
  release();
  await first;
  await reconciler.reconcileNow();
  assert.equal(calls, 2);
  reconciler.close();
});

test('daemon lifecycle reconciliation does not authorize recovery after one transient absence', async () => {
  const observations = [
    { status: 'stopped', pid: null },
    { status: 'running', pid: 16439 },
    { status: 'unreachable', pid: 16439 },
  ];
  let recoveries = 0;
  const reconciler = startDevDaemonLifecycleReconciler(
    {
      enabled: true,
      observe: async () => observations.shift(),
      recover: async () => {
        recoveries += 1;
      },
    },
    {
      setIntervalImpl: () => ({ unref() {} }),
      clearIntervalImpl: () => {},
    },
  );

  assert.deepEqual(await reconciler.reconcileNow(), {
    skipped: true,
    reason: 'daemon-absence-unconfirmed',
    consecutiveAbsences: 1,
  });
  assert.deepEqual(await reconciler.reconcileNow(), {
    skipped: true,
    reason: 'daemon-present',
    status: 'running',
  });
  assert.deepEqual(await reconciler.reconcileNow(), {
    skipped: true,
    reason: 'daemon-present',
    status: 'unreachable',
  });
  assert.equal(recoveries, 0);
  reconciler.close();
});

test('daemon lifecycle reconciliation fails closed for malformed state evidence', async () => {
  let recoveries = 0;
  const observations = [{ status: 'bad_state' }, { status: 'bad_lock' }];
  const reconciler = startDevDaemonLifecycleReconciler(
    {
      enabled: true,
      observe: async () => observations.shift(),
      recover: async () => {
        recoveries += 1;
      },
    },
    {
      setIntervalImpl: () => ({ unref() {} }),
      clearIntervalImpl: () => {},
    },
  );

  assert.deepEqual(await reconciler.reconcileNow(), {
    skipped: true,
    reason: 'daemon-state-inconclusive',
    status: 'bad_state',
  });
  assert.deepEqual(await reconciler.reconcileNow(), {
    skipped: true,
    reason: 'daemon-state-inconclusive',
    status: 'bad_lock',
  });
  assert.equal(recoveries, 0);
  reconciler.close();
});

test('daemon lifecycle reconciliation resets absence confirmation after an observation failure', async () => {
  const observations = [
    { status: 'stopped', pid: null },
    new Error('state read failed'),
    { status: 'stopped', pid: null },
    { status: 'stopped', pid: null },
  ];
  let recoveries = 0;
  const reconciler = startDevDaemonLifecycleReconciler(
    {
      enabled: true,
      observe: async () => {
        const observation = observations.shift();
        if (observation instanceof Error) throw observation;
        return observation;
      },
      recover: async () => {
        recoveries += 1;
        return { started: true };
      },
    },
    {
      setIntervalImpl: () => ({ unref() {} }),
      clearIntervalImpl: () => {},
      logger: { warn() {} },
    },
  );

  assert.equal((await reconciler.reconcileNow()).reason, 'daemon-absence-unconfirmed');
  assert.equal((await reconciler.reconcileNow()).reason, 'reconcile-failed');
  assert.equal((await reconciler.reconcileNow()).reason, 'daemon-absence-unconfirmed');
  assert.equal(recoveries, 0, 'an inconclusive observation must break consecutive absence proof');
  assert.deepEqual(await reconciler.reconcileNow(), { started: true });
  assert.equal(recoveries, 1);
  reconciler.close();
});

test('daemon lifecycle reconciliation recovers confirmed absence with bounded retry backoff', async () => {
  let now = 10_000;
  let recoveries = 0;
  const reconciler = startDevDaemonLifecycleReconciler(
    {
      enabled: true,
      observe: async () => ({ status: 'stopped', pid: null }),
      recover: async () => {
        recoveries += 1;
        return { started: true };
      },
      recoveryBackoffMs: 30_000,
    },
    {
      setIntervalImpl: () => ({ unref() {} }),
      clearIntervalImpl: () => {},
      nowImpl: () => now,
    },
  );

  await reconciler.reconcileNow();
  assert.deepEqual(await reconciler.reconcileNow(), { started: true });
  assert.equal(recoveries, 1);

  now += 1_000;
  assert.deepEqual(await reconciler.reconcileNow(), {
    skipped: true,
    reason: 'daemon-recovery-backoff',
    retryAfterMs: 29_000,
  });
  assert.equal(recoveries, 1);

  now += 29_000;
  assert.deepEqual(await reconciler.reconcileNow(), { started: true });
  assert.equal(recoveries, 2);
  reconciler.close();
});
