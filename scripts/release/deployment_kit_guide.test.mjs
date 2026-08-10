import test from 'node:test';
import assert from 'node:assert/strict';

import { createDeploymentKitGuide } from '../pipeline/deployment-kit/lib/deployment-kit-guide.mjs';

test('deployment kit guide explains the role-first cross-platform install without false capability claims', () => {
  const guide = createDeploymentKitGuide({
    schemaVersion: 'happier-deployment-kit/v1',
    kitVersion: '0.2.10-local.1',
    channel: 'local',
    source: { reproducibility: 'not-verified' },
    securityPolicy: {
      relayBindHost: '127.0.0.1',
      relayPort: 3005,
      requireHttpsGateway: true,
      allowTailscaleServe: true,
      allowTailscaleFunnel: false,
      allowPlaintextLan: false,
      credentialContentStatus: 'not-verified',
    },
    installation: {
      controller: { offline: true, owner: 'happier-relay-host' },
      agent: {
        offline: true,
        owner: 'happier-machine-setup',
        offlineBlocker: null,
      },
    },
    rollback: {
      binaryAndService: 'canonical-owner',
      data: 'operator-backup-required',
      maintenanceWindowRequired: true,
    },
    mobile: {
      android: { channels: [{ id: 'google-play' }, { id: 'signed-apk' }] },
      ios: {
        channels: [{ id: 'app-store' }, { id: 'testflight' }, { id: 'mdm' }],
        genericSideloadableIpa: false,
      },
      pairing: { runtimeIntegrationStatus: 'implemented', liveDeviceValidationStatus: 'not-verified' },
      push: { mode: 'private' },
    },
    artifacts: [
      { role: 'agent', target: { os: 'windows', arch: 'x64' }, path: 'packs/agent/windows.tar.gz' },
      { role: 'controller', target: { os: 'windows', arch: 'x64' }, path: 'packs/controller/windows.tar.gz' },
    ],
  });

  assert.match(guide, /exactly one Controller/i);
  assert.match(guide, /bootstrap[\\/]controller\.ps1/);
  assert.match(guide, /bootstrap[\\/]agent\.sh/);
  assert.match(guide, /127\.0\.0\.1:3005/);
  assert.match(guide, /Tailscale Serve.*HTTPS/i);
  assert.match(guide, /Funnel.*forbidden/i);
  assert.match(guide, /bootstrap[\\/]ssh-agent\.ps1.*-CliPayload/i);
  assert.match(guide, /bootstrap[\\/]ssh-agent\.sh.*--yes/i);
  assert.match(guide, /--cli-payload.*canonical.*machine setup/is);
  assert.match(guide, /Agent offline bootstrap.*available/i);
  assert.match(guide, /claim-v1.*implemented.*not-verified/i);
  assert.match(guide, /App Store|TestFlight/);
  assert.match(guide, /not an installable PWA/i);
  assert.match(guide, /full data snapshot/i);
  assert.match(guide, /relay host snapshot --preflight/i);
  assert.match(guide, /returns BLOCKED.*ACL-preserving/i);
  assert.match(guide, /credential.*not-verified/i);
  assert.match(guide, /does not inspect.*archive contents/i);
  assert.doesNotMatch(guide, /intentionally contains no credentials/i);
  assert.doesNotMatch(guide, /generic sideloadable IPA is supported/i);
});

test('deployment kit guide does not advertise ssh-agent bootstrap when the manifest blocks offline Agent installation', () => {
  const guide = createDeploymentKitGuide({
    schemaVersion: 'happier-deployment-kit/v1',
    kitVersion: '0.2.10-local.1',
    channel: 'local',
    source: { reproducibility: 'not-verified' },
    securityPolicy: {},
    installation: {
      agent: {
        offline: false,
        offlineBlocker: 'local-agent-payload-seam-required',
      },
    },
    mobile: {},
    artifacts: [
      { role: 'agent', target: { os: 'windows', arch: 'x64' }, path: 'packs/agent/windows.tar.gz' },
      { role: 'controller', target: { os: 'windows', arch: 'x64' }, path: 'packs/controller/windows.tar.gz' },
    ],
  });

  assert.match(guide, /Agent offline bootstrap.*not yet available.*local-agent-payload-seam-required/i);
  assert.doesNotMatch(guide, /bootstrap[\\/]ssh-agent\.(?:ps1|sh)/i);
});

test('deployment kit guide treats external mobile Apps as unavailable until the required claim-v1 versions are verified', () => {
  const guide = createDeploymentKitGuide({
    schemaVersion: 'happier-deployment-kit/v1',
    kitVersion: '0.2.10-local.1',
    channel: 'local',
    source: { reproducibility: 'not-verified' },
    securityPolicy: {},
    installation: {
      agent: { offline: false, offlineBlocker: 'not-relevant' },
    },
    mobile: {
      distribution: {
        mode: 'external-app',
        artifactInclusion: 'not-included',
        artifactVerificationStatus: 'not-performed',
        signingVerificationStatus: 'not-performed',
        publicationVerificationStatus: 'not-performed',
        deviceValidationStatus: 'not-verified',
        channelAvailabilityStatus: 'not-verified',
      },
      android: {
        requiredClaimV1AppVersion: '0.2.10',
        requiredRuntimeVersion: '0.2.10',
        channels: [{ id: 'google-play' }],
      },
      ios: {
        requiredClaimV1AppVersion: '0.2.10',
        requiredRuntimeVersion: '0.2.10',
        channels: [{ id: 'app-store' }, { id: 'testflight' }],
        genericSideloadableIpa: false,
      },
      pairing: { runtimeIntegrationStatus: 'implemented', liveDeviceValidationStatus: 'not-verified' },
      push: { mode: 'private' },
    },
    artifacts: [
      { role: 'agent', target: { os: 'windows', arch: 'x64' }, path: 'packs/agent/windows.tar.gz' },
      { role: 'controller', target: { os: 'windows', arch: 'x64' }, path: 'packs/controller/windows.tar.gz' },
    ],
  });

  assert.match(guide, /external-app/i);
  assert.match(guide, /mobile artifacts.*not included/i);
  assert.match(guide, /signing.*not[- ]performed/i);
  assert.match(guide, /publication.*not[- ]performed/i);
  assert.match(guide, /channel availability.*not-verified/i);
  assert.match(guide, /Android.*0\.2\.10.*claim-v1/is);
  assert.match(guide, /iOS.*0\.2\.10.*claim-v1/is);
  assert.match(guide, /no force-legacy QR/i);
  assert.match(guide, /mobile acceptance.*BLOCKED/i);
  assert.doesNotMatch(guide, /mobile artifacts are included|mobile (?:artifact|build) (?:is|was|are|were) verified/i);
  assert.doesNotMatch(guide, /generic sideloadable IPA is supported/i);
});
