import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createControllerOperationPlan,
  createExposurePolicy,
} from '../pipeline/deployment-kit/lib/deployment-kit-operations.mjs';

const artifact = {
  id: 'controller-linux-x64',
  path: 'packs/controller/controller-linux-x64.tar.gz',
  sha256: 'a'.repeat(64),
};

test('fresh native controller install delegates to the canonical relay owner and keeps exposure separate', () => {
  const plan = createControllerOperationPlan({
    operation: 'install',
    backend: 'native',
    artifact,
    observed: {
      nativeInstalled: false,
      dockerRunning: false,
      activeRelayWriters: 0,
    },
  });

  assert.equal(plan.owner, 'happier-relay-host');
  assert.equal(plan.rollbackScope, 'binary-and-service-only');
  assert.deepEqual(plan.steps.map((step) => step.kind), [
    'verify-kit-artifact',
    'extract-to-restricted-staging',
    'canonical-relay-install',
    'verify-loopback-health',
  ]);
  assert.equal(plan.steps[2].host, '127.0.0.1');
  assert.equal(plan.steps.some((step) => step.kind.includes('tailscale')), false);
});

test('controller install refuses to mix native and Docker relay backends', () => {
  assert.throws(
    () => createControllerOperationPlan({
      operation: 'install',
      backend: 'native',
      artifact,
      observed: {
        nativeInstalled: false,
        dockerRunning: true,
        activeRelayWriters: 1,
      },
    }),
    /Docker.*active|backend conflict/i,
  );
});

test('controller upgrade requires an offline full-data snapshot and no active writer', () => {
  const common = {
    operation: 'upgrade',
    backend: 'native',
    artifact,
    observed: {
      nativeInstalled: true,
      dockerRunning: false,
      activeRelayWriters: 0,
    },
  };
  assert.throws(() => createControllerOperationPlan(common), /snapshot/i);
  assert.throws(
    () => createControllerOperationPlan({
      ...common,
      backup: {
        relayStopped: true,
        snapshotSha256: 'b'.repeat(64),
        includes: ['sqlite', 'files'],
      },
    }),
    /master-secret|complete snapshot/i,
  );

  const plan = createControllerOperationPlan({
    ...common,
    backup: {
      relayStopped: true,
      snapshotSha256: 'b'.repeat(64),
      includes: ['sqlite', 'sqlite-wal-shm', 'files', 'master-secret', 'config'],
    },
  });
  assert.equal(plan.preconditions.dataSnapshotVerified, true);
  assert.equal(plan.steps.at(-1).kind, 'verify-loopback-health');
});

test('rollback never schedules automatic data restoration', () => {
  const plan = createControllerOperationPlan({
    operation: 'rollback',
    backend: 'native',
    artifact,
    explicitRollbackApproval: true,
    observed: {
      nativeInstalled: true,
      dockerRunning: false,
      activeRelayWriters: 0,
    },
    backup: {
      relayStopped: true,
      snapshotSha256: 'c'.repeat(64),
      includes: ['sqlite', 'sqlite-wal-shm', 'files', 'master-secret', 'config'],
    },
  });
  assert.equal(plan.dataRestore, 'separate-explicit-operator-action');
  assert.equal(plan.steps.some((step) => step.kind === 'restore-data'), false);
});

test('exposure policy permits HTTPS gateways but never Funnel or plaintext LAN', () => {
  assert.deepEqual(createExposurePolicy({ kind: 'tailscale-serve' }), {
    kind: 'tailscale-serve',
    scheme: 'https',
    upstream: 'http://127.0.0.1:3005',
    allowFunnel: false,
    mutateDuringInstall: false,
  });
  assert.throws(
    () => createExposurePolicy({ kind: 'tailscale-serve', allowFunnel: true }),
    /Funnel/i,
  );
  assert.throws(
    () => createExposurePolicy({ kind: 'lan-http' }),
    /plaintext|unsupported/i,
  );
});
