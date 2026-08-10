// @ts-check

const REQUIRED_DATA_SNAPSHOT_PARTS = [
  'sqlite',
  'sqlite-wal-shm',
  'files',
  'master-secret',
  'config',
];

function requireSha256(value, label) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized)) {
    throw new Error(`[deployment-kit] ${label} must be a SHA256 digest`);
  }
  return normalized;
}

function normalizeArtifact(artifact) {
  const id = String(artifact?.id ?? '').trim();
  const path = String(artifact?.path ?? '').trim();
  if (!id || !path) throw new Error('[deployment-kit] controller artifact id and path are required');
  return {
    id,
    path,
    sha256: requireSha256(artifact?.sha256, 'controller artifact digest'),
  };
}

function normalizeObserved(observed) {
  if (!observed || typeof observed !== 'object') {
    throw new Error('[deployment-kit] observed controller state is required');
  }
  const activeRelayWriters = Number(observed.activeRelayWriters);
  if (!Number.isSafeInteger(activeRelayWriters) || activeRelayWriters < 0) {
    throw new Error('[deployment-kit] active relay writer count must be known');
  }
  return {
    nativeInstalled: observed.nativeInstalled === true,
    dockerRunning: observed.dockerRunning === true,
    activeRelayWriters,
  };
}

function requireOfflineSnapshot(backup) {
  if (!backup || typeof backup !== 'object') {
    throw new Error('[deployment-kit] upgrade and rollback require a verified offline data snapshot');
  }
  if (backup.relayStopped !== true) {
    throw new Error('[deployment-kit] complete snapshot requires the Relay to be stopped');
  }
  const includes = new Set(Array.isArray(backup.includes) ? backup.includes : []);
  const missing = REQUIRED_DATA_SNAPSHOT_PARTS.filter((part) => !includes.has(part));
  if (missing.length > 0) {
    throw new Error(`[deployment-kit] complete snapshot is missing: ${missing.join(', ')}`);
  }
  return {
    relayStopped: true,
    snapshotSha256: requireSha256(backup.snapshotSha256, 'data snapshot digest'),
    includes: [...REQUIRED_DATA_SNAPSHOT_PARTS],
  };
}

export function createControllerOperationPlan(input) {
  const operation = String(input?.operation ?? '').trim().toLowerCase();
  if (!['install', 'upgrade', 'rollback'].includes(operation)) {
    throw new Error(`[deployment-kit] unsupported controller operation: ${operation || '<empty>'}`);
  }
  const backend = String(input?.backend ?? '').trim().toLowerCase();
  if (backend !== 'native') {
    throw new Error('[deployment-kit] this artifact kit supports the native Relay backend only');
  }
  const artifact = normalizeArtifact(input?.artifact);
  const observed = normalizeObserved(input?.observed);
  if (observed.dockerRunning) {
    throw new Error('[deployment-kit] Docker Relay backend is active; native/Docker backend conflict');
  }
  if (observed.activeRelayWriters !== 0) {
    throw new Error('[deployment-kit] controller operation requires zero active Relay writers');
  }
  if (operation === 'install' && observed.nativeInstalled) {
    throw new Error('[deployment-kit] native Relay is already installed; use upgrade');
  }
  if (operation !== 'install' && !observed.nativeInstalled) {
    throw new Error(`[deployment-kit] cannot ${operation} without an existing native Relay installation`);
  }
  if (operation === 'rollback' && input?.explicitRollbackApproval !== true) {
    throw new Error('[deployment-kit] rollback requires explicit operator approval');
  }

  const snapshot = operation === 'install' ? null : requireOfflineSnapshot(input?.backup);
  const executablePlaceholder = '<verified-extracted-happier-server-binary>';
  const steps = [
    {
      kind: 'verify-kit-artifact',
      artifactId: artifact.id,
      artifactPath: artifact.path,
      sha256: artifact.sha256,
    },
    {
      kind: 'extract-to-restricted-staging',
      rejectSymlinks: true,
      preserveArchive: true,
    },
    {
      kind: 'canonical-relay-install',
      owner: 'happier-relay-host',
      command: 'happier',
      argv: [
        'relay',
        'host',
        'install',
        '--server-binary',
        executablePlaceholder,
        '--host',
        '127.0.0.1',
        '--mode',
        'user',
        '--env',
        'PORT=3005',
        '--yes',
        '--json',
      ],
      host: '127.0.0.1',
      port: 3005,
    },
    {
      kind: 'verify-loopback-health',
      expectedListener: '127.0.0.1:3005',
      requireFeaturesEndpoint: true,
      requireSocketIo: true,
      forbidWildcardListener: true,
    },
  ];

  return {
    schemaVersion: 'happier-controller-operation/v1',
    operation,
    backend,
    owner: 'happier-relay-host',
    rollbackScope: 'binary-and-service-only',
    dataRestore: 'separate-explicit-operator-action',
    preconditions: {
      backendConflictFree: true,
      activeRelayWriters: 0,
      dataSnapshotVerified: snapshot !== null,
      ...(snapshot ? { snapshot } : {}),
    },
    steps,
  };
}

export function createExposurePolicy(input) {
  const kind = String(input?.kind ?? '').trim().toLowerCase();
  if (input?.allowFunnel === true) {
    throw new Error('[deployment-kit] Tailscale Funnel is forbidden by the deployment policy');
  }
  if (kind === 'tailscale-serve') {
    return {
      kind,
      scheme: 'https',
      upstream: 'http://127.0.0.1:3005',
      allowFunnel: false,
      mutateDuringInstall: false,
    };
  }
  if (kind === 'https-reverse-proxy') {
    return {
      kind,
      scheme: 'https',
      upstream: 'http://127.0.0.1:3005',
      allowFunnel: false,
      mutateDuringInstall: false,
    };
  }
  throw new Error(`[deployment-kit] unsupported or plaintext exposure policy: ${kind || '<empty>'}`);
}
