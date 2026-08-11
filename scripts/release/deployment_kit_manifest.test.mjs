import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createDeploymentKitManifest,
  HAPPIER_DEPLOYMENT_KIT_SCHEMA_VERSION,
} from '../pipeline/deployment-kit/lib/deployment-kit-manifest.mjs';
import { assertDeploymentKitManifestSchema } from '../pipeline/deployment-kit/lib/deployment-kit-schema.mjs';

const TARGETS = [
  { os: 'windows', arch: 'x64' },
  { os: 'linux', arch: 'x64', libc: 'glibc' },
  { os: 'linux', arch: 'arm64', libc: 'glibc' },
  { os: 'darwin', arch: 'x64' },
  { os: 'darwin', arch: 'arm64' },
];

function artifact({ role, target, index }) {
  const targetKey = [target.os, target.arch, target.libc].filter(Boolean).join('-');
  return {
    id: `${role}-${targetKey}`,
    role,
    target,
    format: 'tar.gz',
    path: `packs/${role}/${role}-${targetKey}.tar.gz`,
    sha256: String(index).padStart(64, 'a').slice(0, 64),
    size: 1024 + index,
  };
}

function createInput(overrides = {}) {
  return {
    kitVersion: '0.2.10-local.1',
    channel: 'local',
    source: {
      commitSha: 'c65ea282ba582e527e7fa1d94f9cad1cb535b9e7',
      workspaceDirty: true,
      workspaceSnapshotSha256: 'b'.repeat(64),
    },
    versions: {
      cli: '0.2.10',
      relay: '0.2.10',
      webUi: '0.2.10',
      protocol: '1',
      androidApp: '0.2.10',
      iosApp: '0.2.10',
    },
    artifacts: TARGETS.flatMap((target, index) => [
      artifact({ role: 'agent', target, index: index + 1 }),
      artifact({ role: 'controller', target, index: index + 11 }),
    ]),
    mobile: {
      supportedProtocolVersions: ['1'],
      preferredProtocolVersion: '1',
      android: {
        applicationId: 'dev.happier.app',
        appVersion: '0.2.10',
        runtimeVersion: '0.2.10',
        googlePlay: { buildId: 'android-play-210', signingCertificateSha256: 'c'.repeat(64) },
        signedApk: { buildId: 'android-apk-210', signingCertificateSha256: 'd'.repeat(64) },
      },
      ios: {
        bundleId: 'dev.happier.app',
        appVersion: '0.2.10',
        runtimeVersion: '0.2.10',
        teamId: 'L86V3EF623',
        appStore: { buildId: 'ios-store-210', signingCertificateSha256: 'e'.repeat(64) },
        testflight: { buildId: 'ios-testflight-210', signingCertificateSha256: 'e'.repeat(64) },
        mdm: { buildId: 'ios-mdm-210', signingCertificateSha256: 'f'.repeat(64) },
        genericSideloadableIpa: false,
      },
      pairing: { deepLinkScheme: 'happier', maxTtlSeconds: 300 },
      push: { mode: 'private' },
    },
    ...overrides,
  };
}

function externalMobileInput() {
  return {
    supportedProtocolVersions: ['1'],
    preferredProtocolVersion: '1',
    distribution: {
      mode: 'external-app',
      artifactInclusion: 'not-included',
    },
    android: {
      applicationId: 'dev.happier.app',
      appVersion: '0.2.10',
      runtimeVersion: '0.2.10',
      channels: ['google-play'],
    },
    ios: {
      bundleId: 'dev.happier.app',
      appVersion: '0.2.10',
      runtimeVersion: '0.2.10',
      channels: ['app-store', 'testflight'],
      genericSideloadableIpa: false,
    },
    pairing: { deepLinkScheme: 'happier', maxTtlSeconds: 300 },
    push: { mode: 'private' },
  };
}

test('createDeploymentKitManifest describes the role-first five-platform kit and native apps', () => {
  const manifest = createDeploymentKitManifest(createInput());

  assert.equal(manifest.schemaVersion, HAPPIER_DEPLOYMENT_KIT_SCHEMA_VERSION);
  assert.deepEqual(manifest.source, {
    commitSha: 'c65ea282ba582e527e7fa1d94f9cad1cb535b9e7',
    workspaceState: 'dirty',
    workspaceSnapshotSha256: 'b'.repeat(64),
    reproducibility: 'not-verified',
  });
  assert.deepEqual(manifest.topology, {
    controller: { recommendedCount: 1, componentRole: 'controller' },
    agents: { minimumCount: 1, componentRole: 'agent', defaultServiceRole: 'daemon-only' },
    clients: ['web', 'android', 'ios'],
  });
  assert.deepEqual(manifest.securityPolicy, {
    relayBindHost: '127.0.0.1',
    relayPort: 3005,
    requireHttpsGateway: true,
    allowTailscaleServe: true,
    allowTailscaleFunnel: false,
    allowPlaintextLan: false,
    credentialContentStatus: 'not-verified',
  });
  assert.equal(manifest.installation.controller.offline, true);
  assert.equal(manifest.installation.agent.offline, true);
  assert.equal(manifest.installation.agent.offlineBlocker, null);
  assert.equal(manifest.mobile.android.applicationId, 'dev.happier.app');
  assert.equal(Object.hasOwn(manifest.mobile, 'distribution'), false);
  assert.equal(manifest.mobile.ios.genericSideloadableIpa, false);
  assert.equal(manifest.artifacts.length, TARGETS.length * 2);
  assert.equal(manifest.compatibility.protocol, '1');
});

test('createDeploymentKitManifest accepts an honest external-app mobile contract without artifact evidence', () => {
  const manifest = createDeploymentKitManifest(createInput({ mobile: externalMobileInput() }));

  assert.doesNotThrow(() => assertDeploymentKitManifestSchema(manifest));
  assert.equal(manifest.mobile.distribution.mode, 'external-app');
  assert.equal(manifest.mobile.distribution.artifactInclusion, 'not-included');
  assert.equal(manifest.mobile.distribution.signingVerificationStatus, 'not-performed');
  assert.equal(manifest.mobile.distribution.publicationVerificationStatus, 'not-performed');
  assert.equal(manifest.mobile.distribution.deviceValidationStatus, 'not-verified');
  assert.equal(manifest.mobile.distribution.channelAvailabilityStatus, 'not-verified');
  assert.deepEqual(manifest.mobile.android.channels, [{ id: 'google-play' }]);
  assert.equal(manifest.mobile.android.requiredClaimV1AppVersion, manifest.compatibility.androidApp);
  assert.equal(manifest.mobile.ios.requiredClaimV1AppVersion, manifest.compatibility.iosApp);
  assert.equal(Object.hasOwn(manifest.mobile.ios, 'teamId'), false);
  assert.doesNotMatch(JSON.stringify(manifest.mobile), /buildId|signingCertificateSha256|artifactFormat/);

  const invalidManifest = structuredClone(manifest);
  invalidManifest.mobile.android.channels[0].buildId = 'invented-build';
  assert.throws(
    () => assertDeploymentKitManifestSchema(invalidManifest),
    /manifest does not satisfy.*JSON Schema/i,
  );
});

test('createDeploymentKitManifest rejects dirty non-local release inputs', () => {
  assert.throws(
    () => createDeploymentKitManifest(createInput({ channel: 'preview' })),
    /non-local deployment kit.*clean workspace/i,
  );
});

test('createDeploymentKitManifest rejects path traversal and duplicate role-target artifacts', () => {
  const input = createInput();
  assert.throws(
    () => createDeploymentKitManifest({
      ...input,
      artifacts: [{ ...input.artifacts[0], path: '../secret.env' }, ...input.artifacts.slice(1)],
    }),
    /unsafe artifact path/i,
  );
  assert.throws(
    () => createDeploymentKitManifest({
      ...input,
      artifacts: [...input.artifacts, { ...input.artifacts[0], id: 'duplicate-agent' }],
    }),
    /duplicate artifact role\/target/i,
  );
});

test('createDeploymentKitManifest rejects credential-like payload entries', () => {
  const input = createInput();
  assert.throws(
    () => createDeploymentKitManifest({
      ...input,
      artifacts: [{ ...input.artifacts[0], path: 'packs/agent/.env' }, ...input.artifacts.slice(1)],
    }),
    /credential-like artifact path/i,
  );
});

test('createDeploymentKitManifest requires complete agent and controller coverage for declared targets', () => {
  const input = createInput();
  assert.throws(
    () => createDeploymentKitManifest({
      ...input,
      artifacts: input.artifacts.filter((entry) => entry.id !== 'controller-linux-arm64-glibc'),
    }),
    /missing controller artifact.*linux-arm64-glibc/i,
  );
});

test('createDeploymentKitManifest requires every canonical target even when both roles are absent', () => {
  const input = createInput();
  assert.throws(
    () => createDeploymentKitManifest({
      ...input,
      artifacts: input.artifacts.filter((entry) => (
        [entry.target.os, entry.target.arch, entry.target.libc].filter(Boolean).join('-') !== 'darwin-arm64'
      )),
    }),
    /missing artifacts for canonical target.*darwin-arm64/i,
  );
});

test('createDeploymentKitManifest accepts only the canonical five native target combinations', () => {
  const input = createInput();
  assert.throws(
    () => createDeploymentKitManifest({
      ...input,
      artifacts: input.artifacts.map((entry, index) => (
        index < 2 ? { ...entry, target: { os: 'windows', arch: 'arm64' } } : entry
      )),
    }),
    /unsupported native target.*windows-arm64/i,
  );
  assert.throws(
    () => createDeploymentKitManifest({
      ...input,
      artifacts: input.artifacts.map((entry, index) => (
        index < 2 ? { ...entry, target: { os: 'linux', arch: 'x64', libc: 'musl' } } : entry
      )),
    }),
    /unsupported native target.*linux-x64-musl/i,
  );
});

test('createDeploymentKitManifest rejects non-canonical variants and targets without a variant bypass', () => {
  const input = createInput();
  assert.throws(
    () => createDeploymentKitManifest({
      ...input,
      artifacts: input.artifacts.map((entry, index) => (
        index < 2 ? { ...entry, variant: 'portable' } : entry
      )),
    }),
    /unsupported artifact variant.*portable/i,
  );
  assert.throws(
    () => createDeploymentKitManifest({
      ...input,
      artifacts: input.artifacts.map((entry, index) => (
        index < 2 ? { ...entry, variant: 'portable', target: { os: 'plan9', arch: 'mips' } } : entry
      )),
    }),
    /unsupported artifact variant|unsupported artifact target/i,
  );
});

test('the formal JSON Schema accepts generated manifests and rejects a non-canonical artifact target', () => {
  const manifest = createDeploymentKitManifest(createInput());
  assert.doesNotThrow(() => assertDeploymentKitManifestSchema(manifest));

  const invalidManifest = structuredClone(manifest);
  invalidManifest.artifacts[0].target = { os: 'plan9', arch: 'mips' };
  assert.throws(
    () => assertDeploymentKitManifestSchema(invalidManifest),
    /manifest does not satisfy.*JSON Schema/i,
  );
});
