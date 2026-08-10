import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildPairingClaimDeepLink,
  createMobileDeploymentFragment,
  validateAndConsumePairingClaim,
  validateMobileDistributionReceipt,
} from '../pipeline/deployment-kit/lib/deployment-kit-mobile.mjs';

const ANDROID_PLAY_CERT = 'a'.repeat(64);
const ANDROID_APK_CERT = 'b'.repeat(64);
const IOS_STORE_CERT = 'c'.repeat(64);
const IOS_MDM_CERT = 'd'.repeat(64);
const ARTIFACT_SHA256 = 'e'.repeat(64);
const CLAIM_ID = `claim_${'0'.repeat(43)}`;

function createInput(overrides = {}) {
  return {
    supportedProtocolVersions: ['1', '2'],
    preferredProtocolVersion: '2',
    android: {
      applicationId: 'dev.happier.app',
      appVersion: '0.2.10',
      runtimeVersion: '0.2.10',
      googlePlay: {
        buildId: 'android-play-210',
        signingCertificateSha256: ANDROID_PLAY_CERT,
      },
      signedApk: {
        buildId: 'android-apk-210',
        signingCertificateSha256: ANDROID_APK_CERT,
      },
    },
    ios: {
      bundleId: 'dev.happier.app',
      appVersion: '0.2.10',
      runtimeVersion: '0.2.10',
      teamId: 'L86V3EF623',
      appStore: {
        buildId: 'ios-store-210',
        signingCertificateSha256: IOS_STORE_CERT,
      },
      testflight: {
        buildId: 'ios-testflight-210',
        signingCertificateSha256: IOS_STORE_CERT,
      },
      mdm: {
        buildId: 'ios-mdm-210',
        signingCertificateSha256: IOS_MDM_CERT,
      },
    },
    pairing: {
      deepLinkScheme: 'happier',
      maxTtlSeconds: 300,
    },
    push: { mode: 'private' },
    ...overrides,
  };
}

function createExternalAppInput(overrides = {}) {
  return {
    supportedProtocolVersions: ['1', '2'],
    preferredProtocolVersion: '2',
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
    pairing: {
      deepLinkScheme: 'happier',
      maxTtlSeconds: 300,
    },
    push: { mode: 'private' },
    ...overrides,
  };
}

function createReceipt(overrides = {}) {
  return {
    platform: 'android',
    channel: 'google-play',
    artifactFormat: 'aab',
    applicationId: 'dev.happier.app',
    appVersion: '0.2.10',
    runtimeVersion: '0.2.10',
    protocolVersion: '2',
    buildId: 'android-play-210',
    signingCertificateSha256: ANDROID_PLAY_CERT,
    artifactSha256: ARTIFACT_SHA256,
    artifactSize: 42_000_000,
    evidenceSource: 'google-play',
    receiptId: 'google-play-release-210',
    ...overrides,
  };
}

test('mobile fragment models native store/direct channels and the private push boundary', () => {
  const fragment = createMobileDeploymentFragment(createInput());

  assert.equal(fragment.schemaVersion, 'happier-deployment-kit-mobile/v1');
  assert.equal(Object.hasOwn(fragment, 'distribution'), false);
  assert.deepEqual(fragment.protocol, {
    supportedVersions: ['1', '2'],
    preferredVersion: '2',
  });
  assert.deepEqual(fragment.android.channels.map(({ id, artifactFormat }) => ({ id, artifactFormat })), [
    { id: 'google-play', artifactFormat: 'aab' },
    { id: 'signed-apk', artifactFormat: 'apk' },
  ]);
  assert.deepEqual(fragment.ios.channels.map(({ id, pipelineAutomated }) => ({ id, pipelineAutomated })), [
    { id: 'app-store', pipelineAutomated: true },
    { id: 'testflight', pipelineAutomated: true },
    { id: 'mdm', pipelineAutomated: false },
  ]);
  assert.equal(fragment.ios.genericSideloadableIpa, false);
  assert.deepEqual(fragment.push, {
    mode: 'private',
    providers: [],
    containsProviderCredentials: false,
    capabilities: {
      foregroundRealtime: true,
      backgroundRemoteNotifications: false,
      backgroundWakeup: false,
    },
    limitation: 'background delivery is unavailable without external APNs/FCM infrastructure',
  });
  assert.deepEqual(fragment.pairing.deepLinkParameters, ['v', 'claimId', 'origin']);
  assert.equal(fragment.pairing.requiresAtomicConsume, true);
  assert.equal(fragment.pairing.runtimeIntegrationStatus, 'implemented');
  assert.equal(fragment.pairing.liveDeviceValidationStatus, 'not-verified');
});

test('signed Android APK is optional while Google Play AAB remains mandatory', () => {
  const input = createInput();
  const fragment = createMobileDeploymentFragment({
    ...input,
    android: { ...input.android, signedApk: null },
  });

  assert.deepEqual(fragment.android.channels.map((channel) => channel.id), ['google-play']);
  assert.throws(
    () => validateMobileDistributionReceipt(fragment, createReceipt({ channel: 'signed-apk', artifactFormat: 'apk' })),
    /channel is not declared/i,
  );
});

test('external-app mode declares trusted acquisition channels without mobile artifacts or evidence claims', () => {
  const fragment = createMobileDeploymentFragment(createExternalAppInput());

  assert.deepEqual(fragment.distribution, {
    mode: 'external-app',
    artifactInclusion: 'not-included',
    artifactVerificationStatus: 'not-performed',
    signingVerificationStatus: 'not-performed',
    publicationVerificationStatus: 'not-performed',
    deviceValidationStatus: 'not-verified',
    channelAvailabilityStatus: 'not-verified',
  });
  assert.deepEqual(fragment.android.channels, [{ id: 'google-play' }]);
  assert.deepEqual(fragment.ios.channels, [{ id: 'app-store' }, { id: 'testflight' }]);
  assert.equal(fragment.android.requiredClaimV1AppVersion, '0.2.10');
  assert.equal(fragment.ios.requiredClaimV1AppVersion, '0.2.10');
  assert.equal(fragment.android.requiredRuntimeVersion, '0.2.10');
  assert.equal(fragment.ios.requiredRuntimeVersion, '0.2.10');
  assert.equal(fragment.ios.genericSideloadableIpa, false);
  assert.equal(Object.hasOwn(fragment.ios, 'teamId'), false);
  assert.equal(JSON.stringify(fragment).includes('buildId'), false);
  assert.equal(JSON.stringify(fragment).includes('signingCertificateSha256'), false);
  assert.equal(JSON.stringify(fragment).includes('artifactFormat'), false);

  const link = buildPairingClaimDeepLink({
    fragment,
    claimId: CLAIM_ID,
    relayOrigin: 'https://relay.tailnet.example',
  });
  assert.match(link, /^happier:\/\/\/pair\?v=claim-v1&claimId=/);
});

test('external-app mode rejects receipts, signing metadata, unknown fields, and generic iOS sideload claims', () => {
  const fragment = createMobileDeploymentFragment(createExternalAppInput());
  assert.throws(
    () => validateMobileDistributionReceipt(fragment, createReceipt()),
    /external-app.*artifacts.*not included|distribution receipts.*not accepted/i,
  );
  assert.throws(
    () => createMobileDeploymentFragment(createExternalAppInput({
      distribution: {
        mode: 'external-app',
        artifactInclusion: 'not-included',
        signingCertificateSha256: ANDROID_PLAY_CERT,
      },
    })),
    /unsupported mobile distribution field/i,
  );
  assert.throws(
    () => createMobileDeploymentFragment(createExternalAppInput({
      android: {
        ...createExternalAppInput().android,
        googlePlay: { buildId: 'forbidden', signingCertificateSha256: ANDROID_PLAY_CERT },
      },
    })),
    /unsupported external Android configuration field/i,
  );
  assert.throws(
    () => createMobileDeploymentFragment(createExternalAppInput({
      ios: {
        ...createExternalAppInput().ios,
        genericSideloadableIpa: true,
      },
    })),
    /generic sideloadable IPA/i,
  );
});

test('cloud push declares APNs and FCM as external dependencies without embedding credentials', () => {
  const fragment = createMobileDeploymentFragment(createInput({
    push: { mode: 'cloud', providers: ['apns', 'fcm'] },
  }));

  assert.deepEqual(fragment.push.providers, ['apns', 'fcm']);
  assert.equal(fragment.push.capabilities.backgroundRemoteNotifications, true);
  assert.equal(fragment.push.capabilities.backgroundWakeup, true);
  assert.equal(fragment.push.containsProviderCredentials, false);
  assert.throws(
    () => createMobileDeploymentFragment(createInput({ push: { mode: 'cloud', providers: ['fcm'] } })),
    /requires both APNs and FCM/i,
  );
  assert.throws(
    () => createMobileDeploymentFragment(createInput({
      push: { mode: 'cloud', providers: ['apns', 'fcm'], fcmToken: 'forbidden' },
    })),
    /credential|unsupported push (?:configuration )?field/i,
  );
});

test('distribution receipts must match platform identity, format, protocol, build, and signing fingerprint', () => {
  const fragment = createMobileDeploymentFragment(createInput());

  assert.equal(validateMobileDistributionReceipt(fragment, createReceipt()).ok, true);
  assert.equal(validateMobileDistributionReceipt(fragment, createReceipt({
    platform: 'ios',
    channel: 'testflight',
    artifactFormat: 'ipa',
    applicationId: undefined,
    bundleId: 'dev.happier.app',
    buildId: 'ios-testflight-210',
    signingCertificateSha256: IOS_STORE_CERT,
    evidenceSource: 'app-store-connect',
    receiptId: 'asc-testflight-210',
    appleSigned: true,
    teamId: 'L86V3EF623',
    genericSideloadableIpa: false,
  })).ok, true);

  for (const [overrides, pattern] of [
    [{ artifactFormat: 'apk' }, /artifact format/i],
    [{ applicationId: 'evil.example.app' }, /application id/i],
    [{ protocolVersion: '3' }, /protocol version/i],
    [{ buildId: 'different-build' }, /build id/i],
    [{ signingCertificateSha256: 'f'.repeat(64) }, /signing certificate/i],
    [{ accessToken: 'must-not-enter-a-receipt' }, /unsupported distribution receipt field/i],
  ]) {
    assert.throws(() => validateMobileDistributionReceipt(fragment, createReceipt(overrides)), pattern);
  }
});

test('iOS receipts are Apple-signed channel artifacts and can never claim a generic sideloadable IPA', () => {
  const fragment = createMobileDeploymentFragment(createInput());
  const iosReceipt = createReceipt({
    platform: 'ios',
    channel: 'mdm',
    artifactFormat: 'ipa',
    applicationId: undefined,
    bundleId: 'dev.happier.app',
    buildId: 'ios-mdm-210',
    signingCertificateSha256: IOS_MDM_CERT,
    evidenceSource: 'mdm',
    receiptId: 'mdm-build-210',
    appleSigned: true,
    teamId: 'L86V3EF623',
    genericSideloadableIpa: false,
  });

  assert.equal(validateMobileDistributionReceipt(fragment, iosReceipt).ok, true);
  assert.throws(
    () => validateMobileDistributionReceipt(fragment, { ...iosReceipt, genericSideloadableIpa: true }),
    /generic sideloadable IPA/i,
  );
  assert.throws(
    () => createMobileDeploymentFragment(createInput({
      ios: { ...createInput().ios, genericSideloadableIpa: true },
    })),
    /generic sideloadable IPA/i,
  );
});

test('pairing deep links contain only the claim-v1 discriminator, exact claim id, and HTTPS Relay origin', () => {
  const fragment = createMobileDeploymentFragment(createInput());
  const deepLink = buildPairingClaimDeepLink({
    fragment,
    claimId: CLAIM_ID,
    relayOrigin: 'https://relay.tailnet.example',
  });
  const parsed = new URL(deepLink);

  assert.equal(parsed.protocol, 'happier:');
  assert.equal(parsed.pathname, '/pair');
  assert.deepEqual([...parsed.searchParams.keys()], ['v', 'claimId', 'origin']);
  assert.equal(parsed.searchParams.get('v'), 'claim-v1');
  assert.equal(parsed.searchParams.get('claimId'), CLAIM_ID);
  assert.equal(parsed.searchParams.get('origin'), 'https://relay.tailnet.example');
  assert.doesNotMatch(deepLink, /token|secret|credential/i);

  assert.throws(
    () => buildPairingClaimDeepLink({
      fragment,
      claimId: CLAIM_ID,
      relayOrigin: 'http://relay.tailnet.example',
    }),
    /HTTPS/i,
  );
  assert.throws(
    () => buildPairingClaimDeepLink({
      fragment,
      claimId: 'claim_0123456789abcdef',
      relayOrigin: 'https://relay.tailnet.example',
    }),
    /claim id/i,
  );
});

test('pairing validation fails closed for expiry, injected credentials, and atomic reuse', async () => {
  const fragment = createMobileDeploymentFragment(createInput());
  const deepLink = buildPairingClaimDeepLink({
    fragment,
    claimId: CLAIM_ID,
    relayOrigin: 'https://relay.tailnet.example',
  });
  const claim = {
    id: CLAIM_ID,
    relayOrigin: 'https://relay.tailnet.example',
    issuedAtMs: 1_000,
    expiresAtMs: 301_000,
    consumedAtMs: null,
  };
  const consumed = new Set();
  const consumeClaim = async ({ claimId }) => {
    if (consumed.has(claimId)) return false;
    consumed.add(claimId);
    return true;
  };

  assert.deepEqual(
    await validateAndConsumePairingClaim({ fragment, deepLink, claim, nowMs: 2_000, consumeClaim }),
    {
      claimId: CLAIM_ID,
      relayOrigin: 'https://relay.tailnet.example',
      consumedAtMs: 2_000,
    },
  );
  await assert.rejects(
    validateAndConsumePairingClaim({ fragment, deepLink, claim, nowMs: 3_000, consumeClaim }),
    /already consumed|atomic consume/i,
  );
  await assert.rejects(
    validateAndConsumePairingClaim({ fragment, deepLink, claim, nowMs: 301_000, consumeClaim: async () => true }),
    /expired/i,
  );
  await assert.rejects(
    validateAndConsumePairingClaim({
      fragment,
      deepLink: `${deepLink}&token=long-lived-token`,
      claim,
      nowMs: 2_000,
      consumeClaim: async () => true,
    }),
    /unexpected pairing parameter/i,
  );
});
