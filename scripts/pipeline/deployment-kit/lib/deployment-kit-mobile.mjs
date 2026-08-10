// @ts-check

export const HAPPIER_DEPLOYMENT_KIT_MOBILE_SCHEMA_VERSION = 'happier-deployment-kit-mobile/v1';

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const OPAQUE_ID_PATTERN = /^[0-9A-Za-z][0-9A-Za-z._+-]{0,127}$/;
const CLAIM_ID_PATTERN = /^claim_[0-9A-Za-z_-]{43}$/;
const APP_ID_PATTERN = /^[0-9A-Za-z_-]+(?:\.[0-9A-Za-z_-]+)+$/;
const DEEP_LINK_SCHEME_PATTERN = /^[A-Za-z][A-Za-z0-9+.-]*$/;
const MAX_PAIRING_CLAIM_TTL_SECONDS = 600;
const EXTERNAL_ANDROID_CHANNELS = new Set(['google-play', 'signed-apk']);
const EXTERNAL_IOS_CHANNELS = new Set(['app-store', 'testflight', 'mdm']);
const EXTERNAL_DISTRIBUTION_FIELDS = new Set([
  'mode',
  'artifactInclusion',
  'artifactVerificationStatus',
  'signingVerificationStatus',
  'publicationVerificationStatus',
  'deviceValidationStatus',
  'channelAvailabilityStatus',
]);

const RECEIPT_FIELDS = new Set([
  'platform',
  'channel',
  'artifactFormat',
  'applicationId',
  'bundleId',
  'appVersion',
  'runtimeVersion',
  'protocolVersion',
  'buildId',
  'signingCertificateSha256',
  'artifactSha256',
  'artifactSize',
  'evidenceSource',
  'receiptId',
  'appleSigned',
  'teamId',
  'genericSideloadableIpa',
]);

function fail(message) {
  throw new Error(`[deployment-kit-mobile] ${message}`);
}

function requireObject(value, label) {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  return value;
}

function assertAllowedFields(value, allowed, label) {
  const record = requireObject(value, label);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) fail(`unsupported ${label} field: ${key}`);
  }
  return record;
}

function requireNonBlank(value, label) {
  const normalized = String(value ?? '').trim();
  if (!normalized) fail(`${label} is required`);
  return normalized;
}

function requireOpaqueId(value, label) {
  const normalized = requireNonBlank(value, label);
  if (!OPAQUE_ID_PATTERN.test(normalized)) fail(`invalid ${label}`);
  return normalized;
}

function requireAppId(value, label) {
  const normalized = requireNonBlank(value, label);
  if (!APP_ID_PATTERN.test(normalized)) fail(`invalid ${label}`);
  return normalized;
}

function requireSha256(value, label) {
  const normalized = requireNonBlank(value, label).toLowerCase();
  if (!SHA256_PATTERN.test(normalized)) fail(`${label} must be a 64 character hexadecimal SHA256`);
  return normalized;
}

function requirePositiveSafeInteger(value, label) {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized <= 0) fail(`${label} must be a positive safe integer`);
  return normalized;
}

function normalizeProtocol(input) {
  if (!Array.isArray(input?.supportedProtocolVersions) || input.supportedProtocolVersions.length === 0) {
    fail('at least one supported protocol version is required');
  }
  const supportedVersions = [...new Set(input.supportedProtocolVersions.map(
    (entry) => requireOpaqueId(entry, 'protocol version'),
  ))];
  const preferredVersion = requireOpaqueId(input?.preferredProtocolVersion, 'preferred protocol version');
  if (!supportedVersions.includes(preferredVersion)) {
    fail('preferred protocol version must be included in supported protocol versions');
  }
  return { supportedVersions, preferredVersion };
}

function normalizeBuild(value, label) {
  const build = assertAllowedFields(
    value,
    new Set(['buildId', 'signingCertificateSha256']),
    label,
  );
  return {
    buildId: requireOpaqueId(build.buildId, `${label} build id`),
    signingCertificateSha256: requireSha256(
      build.signingCertificateSha256,
      `${label} signing certificate fingerprint`,
    ),
  };
}

function normalizeExternalDistribution(value) {
  if (value == null) return null;
  const distribution = assertAllowedFields(
    value,
    new Set(['mode', 'artifactInclusion']),
    'mobile distribution',
  );
  if (requireNonBlank(distribution.mode, 'mobile distribution mode').toLowerCase() !== 'external-app') {
    fail('unsupported mobile distribution mode');
  }
  if (requireNonBlank(distribution.artifactInclusion, 'mobile artifact inclusion').toLowerCase()
    !== 'not-included') {
    fail('external-app mode must declare mobile artifacts as not-included');
  }
  return {
    mode: 'external-app',
    artifactInclusion: 'not-included',
    artifactVerificationStatus: 'not-performed',
    signingVerificationStatus: 'not-performed',
    publicationVerificationStatus: 'not-performed',
    deviceValidationStatus: 'not-verified',
    channelAvailabilityStatus: 'not-verified',
  };
}

function normalizeExternalChannels(value, allowed, label) {
  if (!Array.isArray(value) || value.length === 0) {
    fail(`${label} must declare at least one external App channel`);
  }
  const ids = value.map((entry) => requireNonBlank(entry, `${label} channel`).toLowerCase());
  if (new Set(ids).size !== ids.length) fail(`${label} channels must be unique`);
  for (const id of ids) {
    if (!allowed.has(id)) fail(`unsupported ${label} channel: ${id}`);
  }
  return ids.map((id) => ({ id }));
}

function normalizeExternalAndroid(value) {
  const android = assertAllowedFields(
    value,
    new Set(['applicationId', 'appVersion', 'runtimeVersion', 'channels']),
    'external Android configuration',
  );
  return {
    applicationId: requireAppId(android.applicationId, 'Android application id'),
    requiredClaimV1AppVersion: requireOpaqueId(android.appVersion, 'Android app version'),
    requiredRuntimeVersion: requireOpaqueId(android.runtimeVersion, 'Android runtime version'),
    channels: normalizeExternalChannels(android.channels, EXTERNAL_ANDROID_CHANNELS, 'Android'),
  };
}

function normalizeExternalIos(value) {
  const ios = assertAllowedFields(
    value,
    new Set(['bundleId', 'appVersion', 'runtimeVersion', 'channels', 'genericSideloadableIpa']),
    'external iOS configuration',
  );
  if (ios.genericSideloadableIpa === true) {
    fail('iOS cannot be declared as a generic sideloadable IPA');
  }
  return {
    bundleId: requireAppId(ios.bundleId, 'iOS bundle id'),
    requiredClaimV1AppVersion: requireOpaqueId(ios.appVersion, 'iOS app version'),
    requiredRuntimeVersion: requireOpaqueId(ios.runtimeVersion, 'iOS runtime version'),
    genericSideloadableIpa: false,
    channels: normalizeExternalChannels(ios.channels, EXTERNAL_IOS_CHANNELS, 'iOS'),
  };
}

function createChannel(id, artifactFormat, evidenceSource, build, pipelineAutomated) {
  return {
    id,
    artifactFormat,
    evidenceSource,
    buildId: build.buildId,
    signingCertificateSha256: build.signingCertificateSha256,
    pipelineAutomated,
  };
}

function normalizeAndroid(value) {
  const android = assertAllowedFields(
    value,
    new Set(['applicationId', 'appVersion', 'runtimeVersion', 'googlePlay', 'signedApk']),
    'Android configuration',
  );
  const googlePlay = normalizeBuild(android.googlePlay, 'Google Play');
  const signedApk = android.signedApk == null ? null : normalizeBuild(android.signedApk, 'signed APK');
  return {
    applicationId: requireAppId(android.applicationId, 'Android application id'),
    appVersion: requireOpaqueId(android.appVersion, 'Android app version'),
    runtimeVersion: requireOpaqueId(android.runtimeVersion, 'Android runtime version'),
    channels: [
      createChannel('google-play', 'aab', 'google-play', googlePlay, true),
      ...(signedApk == null
        ? []
        : [createChannel('signed-apk', 'apk', 'signed-artifact', signedApk, true)]),
    ],
  };
}

function normalizeIos(value) {
  const ios = assertAllowedFields(
    value,
    new Set([
      'bundleId',
      'appVersion',
      'runtimeVersion',
      'teamId',
      'appStore',
      'testflight',
      'mdm',
      'genericSideloadableIpa',
    ]),
    'iOS configuration',
  );
  if (ios.genericSideloadableIpa === true) {
    fail('iOS cannot be declared as a generic sideloadable IPA');
  }
  const appStore = normalizeBuild(ios.appStore, 'App Store');
  const testflight = normalizeBuild(ios.testflight, 'TestFlight');
  const mdm = normalizeBuild(ios.mdm, 'MDM');
  return {
    bundleId: requireAppId(ios.bundleId, 'iOS bundle id'),
    appVersion: requireOpaqueId(ios.appVersion, 'iOS app version'),
    runtimeVersion: requireOpaqueId(ios.runtimeVersion, 'iOS runtime version'),
    teamId: requireOpaqueId(ios.teamId, 'Apple team id'),
    genericSideloadableIpa: false,
    channels: [
      createChannel('app-store', 'ipa', 'app-store-connect', appStore, true),
      createChannel('testflight', 'ipa', 'app-store-connect', testflight, true),
      createChannel('mdm', 'ipa', 'mdm', mdm, false),
    ],
  };
}

function normalizePairing(value) {
  const pairing = assertAllowedFields(
    value,
    new Set(['deepLinkScheme', 'maxTtlSeconds']),
    'pairing configuration',
  );
  const deepLinkScheme = requireNonBlank(pairing.deepLinkScheme, 'pairing deep link scheme').replace(/:$/, '');
  if (!DEEP_LINK_SCHEME_PATTERN.test(deepLinkScheme)) fail('invalid pairing deep link scheme');
  const maxTtlSeconds = requirePositiveSafeInteger(pairing.maxTtlSeconds, 'pairing maximum TTL');
  if (maxTtlSeconds > MAX_PAIRING_CLAIM_TTL_SECONDS) {
    fail(`pairing maximum TTL must not exceed ${MAX_PAIRING_CLAIM_TTL_SECONDS} seconds`);
  }
  return {
    contractVersion: 'claim-v1',
    deepLinkScheme,
    deepLinkPath: '/pair',
    deepLinkParameters: ['v', 'claimId', 'origin'],
    relayOriginProtocol: 'https:',
    maxTtlSeconds,
    oneTime: true,
    requiresAtomicConsume: true,
    containsLongLivedCredentials: false,
    runtimeIntegrationStatus: 'implemented',
    liveDeviceValidationStatus: 'not-verified',
  };
}

function normalizePush(value) {
  const push = assertAllowedFields(value, new Set(['mode', 'providers']), 'push configuration');
  const mode = requireNonBlank(push.mode, 'push mode').toLowerCase();
  if (mode === 'private') {
    if (push.providers != null && (!Array.isArray(push.providers) || push.providers.length > 0)) {
      fail('private push mode cannot declare external providers');
    }
    return {
      mode,
      providers: [],
      containsProviderCredentials: false,
      capabilities: {
        foregroundRealtime: true,
        backgroundRemoteNotifications: false,
        backgroundWakeup: false,
      },
      limitation: 'background delivery is unavailable without external APNs/FCM infrastructure',
    };
  }
  if (mode !== 'cloud') fail(`unsupported push mode: ${mode}`);
  if (!Array.isArray(push.providers)) fail('cloud push mode requires both APNs and FCM');
  const providers = [...new Set(push.providers.map((entry) => requireNonBlank(entry, 'push provider').toLowerCase()))];
  if (providers.length !== 2 || !providers.includes('apns') || !providers.includes('fcm')) {
    fail('cloud push mode requires both APNs and FCM');
  }
  return {
    mode,
    providers: ['apns', 'fcm'],
    containsProviderCredentials: false,
    capabilities: {
      foregroundRealtime: true,
      backgroundRemoteNotifications: true,
      backgroundWakeup: true,
    },
    limitation: null,
  };
}

export function createMobileDeploymentFragment(input) {
  const root = assertAllowedFields(
    input,
    new Set([
      'supportedProtocolVersions',
      'preferredProtocolVersion',
      'distribution',
      'android',
      'ios',
      'pairing',
      'push',
    ]),
    'mobile deployment input',
  );
  const distribution = normalizeExternalDistribution(root.distribution);
  return {
    schemaVersion: HAPPIER_DEPLOYMENT_KIT_MOBILE_SCHEMA_VERSION,
    protocol: normalizeProtocol(root),
    ...(distribution == null ? {} : { distribution }),
    android: distribution == null ? normalizeAndroid(root.android) : normalizeExternalAndroid(root.android),
    ios: distribution == null ? normalizeIos(root.ios) : normalizeExternalIos(root.ios),
    pairing: normalizePairing(root.pairing),
    push: normalizePush(root.push),
  };
}

function assertFragment(fragment) {
  const value = requireObject(fragment, 'mobile deployment fragment');
  if (value.schemaVersion !== HAPPIER_DEPLOYMENT_KIT_MOBILE_SCHEMA_VERSION) {
    fail('unsupported mobile deployment fragment schema');
  }
  if (!Array.isArray(value.protocol?.supportedVersions) || value.protocol.supportedVersions.length === 0) {
    fail('mobile deployment fragment has no supported protocol versions');
  }
  if (value.ios?.genericSideloadableIpa !== false) {
    fail('mobile deployment fragment must forbid a generic sideloadable IPA');
  }
  if (value.distribution != null) {
    const distribution = assertAllowedFields(
      value.distribution,
      EXTERNAL_DISTRIBUTION_FIELDS,
      'mobile distribution fragment',
    );
    if (
      distribution.mode !== 'external-app'
      || distribution.artifactInclusion !== 'not-included'
      || distribution.artifactVerificationStatus !== 'not-performed'
      || distribution.signingVerificationStatus !== 'not-performed'
      || distribution.publicationVerificationStatus !== 'not-performed'
      || distribution.deviceValidationStatus !== 'not-verified'
      || distribution.channelAvailabilityStatus !== 'not-verified'
    ) {
      fail('invalid external-app mobile distribution fragment');
    }
  }
  return value;
}

function findChannel(fragment, platform, channelId) {
  const platformConfig = fragment[platform];
  if (!Array.isArray(platformConfig?.channels)) fail(`invalid ${platform} channel configuration`);
  const channel = platformConfig.channels.find((entry) => entry?.id === channelId);
  if (!channel) fail(`${platform} channel is not declared: ${channelId}`);
  return { platformConfig, channel };
}

export function validateMobileDistributionReceipt(fragmentInput, receiptInput) {
  const fragment = assertFragment(fragmentInput);
  if (fragment.distribution?.mode === 'external-app') {
    fail('external-app mode artifacts are not included and distribution receipts are not accepted');
  }
  const receipt = assertAllowedFields(receiptInput, RECEIPT_FIELDS, 'distribution receipt');
  const platform = requireNonBlank(receipt.platform, 'receipt platform').toLowerCase();
  if (platform !== 'android' && platform !== 'ios') fail(`unsupported receipt platform: ${platform}`);
  const channelId = requireNonBlank(receipt.channel, 'receipt channel').toLowerCase();
  const { platformConfig, channel } = findChannel(fragment, platform, channelId);

  const artifactFormat = requireNonBlank(receipt.artifactFormat, 'receipt artifact format').toLowerCase();
  if (artifactFormat !== channel.artifactFormat) fail(`artifact format mismatch for ${platform}/${channelId}`);
  const protocolVersion = requireOpaqueId(receipt.protocolVersion, 'receipt protocol version');
  if (!fragment.protocol.supportedVersions.includes(protocolVersion)) {
    fail(`unsupported protocol version: ${protocolVersion}`);
  }
  if (requireOpaqueId(receipt.appVersion, 'receipt app version') !== platformConfig.appVersion) {
    fail(`${platform} app version mismatch`);
  }
  if (requireOpaqueId(receipt.runtimeVersion, 'receipt runtime version') !== platformConfig.runtimeVersion) {
    fail(`${platform} runtime version mismatch`);
  }
  if (requireOpaqueId(receipt.buildId, 'receipt build id') !== channel.buildId) {
    fail(`${platform} build id mismatch`);
  }
  if (requireSha256(receipt.signingCertificateSha256, 'receipt signing certificate fingerprint')
    !== channel.signingCertificateSha256) {
    fail(`${platform} signing certificate fingerprint mismatch`);
  }
  if (requireNonBlank(receipt.evidenceSource, 'receipt evidence source') !== channel.evidenceSource) {
    fail(`${platform} evidence source mismatch`);
  }

  if (platform === 'android') {
    if (requireAppId(receipt.applicationId, 'receipt Android application id') !== platformConfig.applicationId) {
      fail('Android application id mismatch');
    }
    if (receipt.bundleId != null || receipt.appleSigned != null || receipt.teamId != null
      || receipt.genericSideloadableIpa != null) {
      fail('Android receipt contains iOS-only fields');
    }
  } else {
    if (requireAppId(receipt.bundleId, 'receipt iOS bundle id') !== platformConfig.bundleId) {
      fail('iOS bundle id mismatch');
    }
    if (receipt.applicationId != null) fail('iOS receipt contains an Android application id');
    if (receipt.appleSigned !== true) fail('iOS receipt must attest an Apple-signed artifact');
    if (requireOpaqueId(receipt.teamId, 'receipt Apple team id') !== platformConfig.teamId) {
      fail('iOS Apple team id mismatch');
    }
    if (receipt.genericSideloadableIpa !== false) {
      fail('iOS receipt must not claim a generic sideloadable IPA');
    }
  }

  const artifactSha256 = requireSha256(receipt.artifactSha256, 'receipt artifact SHA256');
  const artifactSize = requirePositiveSafeInteger(receipt.artifactSize, 'receipt artifact size');
  const receiptId = requireOpaqueId(receipt.receiptId, 'distribution receipt id');
  return {
    ok: true,
    schemaVersion: HAPPIER_DEPLOYMENT_KIT_MOBILE_SCHEMA_VERSION,
    platform,
    channel: channelId,
    protocolVersion,
    buildId: channel.buildId,
    artifactSha256,
    artifactSize,
    receiptId,
  };
}

function normalizeHttpsOrigin(value, label) {
  const raw = requireNonBlank(value, label);
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    fail(`${label} must be a valid HTTPS origin`);
  }
  if (
    parsed.protocol !== 'https:'
    || !parsed.hostname
    || parsed.username
    || parsed.password
    || parsed.pathname !== '/'
    || parsed.search
    || parsed.hash
    || raw !== parsed.origin
  ) {
    fail(`${label} must be a canonical HTTPS origin without credentials, path, query, or fragment`);
  }
  return parsed.origin;
}

function requireClaimId(value) {
  const claimId = requireNonBlank(value, 'pairing claim id');
  if (!CLAIM_ID_PATTERN.test(claimId)) fail('invalid pairing claim id');
  return claimId;
}

function getPairingContract(fragmentInput) {
  const fragment = assertFragment(fragmentInput);
  const pairing = fragment.pairing;
  if (
    pairing?.contractVersion !== 'claim-v1'
    || pairing?.requiresAtomicConsume !== true
    || pairing?.oneTime !== true
    || pairing?.relayOriginProtocol !== 'https:'
    || !DEEP_LINK_SCHEME_PATTERN.test(String(pairing?.deepLinkScheme ?? ''))
    || pairing?.deepLinkPath !== '/pair'
    || !Array.isArray(pairing?.deepLinkParameters)
    || pairing.deepLinkParameters.join(',') !== 'v,claimId,origin'
  ) {
    fail('invalid pairing contract in mobile deployment fragment');
  }
  return pairing;
}

export function buildPairingClaimDeepLink(input) {
  const value = assertAllowedFields(
    input,
    new Set(['fragment', 'claimId', 'relayOrigin']),
    'pairing deep link input',
  );
  const pairing = getPairingContract(value.fragment);
  const claimId = requireClaimId(value.claimId);
  const relayOrigin = normalizeHttpsOrigin(value.relayOrigin, 'Relay origin');
  const params = new URLSearchParams([
    ['v', pairing.contractVersion],
    ['claimId', claimId],
    ['origin', relayOrigin],
  ]);
  return `${pairing.deepLinkScheme}:///${pairing.deepLinkPath.replace(/^\//, '')}?${params}`;
}

function parsePairingClaimDeepLink(pairing, deepLink) {
  let parsed;
  try {
    parsed = new URL(requireNonBlank(deepLink, 'pairing deep link'));
  } catch {
    fail('invalid pairing deep link');
  }
  if (
    parsed.protocol !== `${pairing.deepLinkScheme}:`
    || parsed.host
    || parsed.pathname !== pairing.deepLinkPath
    || parsed.username
    || parsed.password
    || parsed.hash
  ) {
    fail('pairing deep link target does not match the declared App scheme');
  }
  const keys = [...parsed.searchParams.keys()];
  const expectedKeys = pairing.deepLinkParameters;
  if (
    keys.length !== expectedKeys.length
    || expectedKeys.some((key, index) => keys[index] !== key)
    || expectedKeys.some((key) => parsed.searchParams.getAll(key).length !== 1)
  ) {
    fail('unexpected pairing parameter; only v, claimId, and origin are allowed');
  }
  if (parsed.searchParams.get('v') !== pairing.contractVersion) {
    fail('unsupported pairing contract version');
  }
  return {
    claimId: requireClaimId(parsed.searchParams.get('claimId')),
    relayOrigin: normalizeHttpsOrigin(parsed.searchParams.get('origin'), 'Relay origin'),
  };
}

export async function validateAndConsumePairingClaim(input) {
  const value = assertAllowedFields(
    input,
    new Set(['fragment', 'deepLink', 'claim', 'nowMs', 'consumeClaim']),
    'pairing validation input',
  );
  const pairing = getPairingContract(value.fragment);
  const link = parsePairingClaimDeepLink(pairing, value.deepLink);
  const claim = assertAllowedFields(
    value.claim,
    new Set(['id', 'relayOrigin', 'issuedAtMs', 'expiresAtMs', 'consumedAtMs']),
    'authoritative pairing claim',
  );
  const claimId = requireClaimId(claim.id);
  const relayOrigin = normalizeHttpsOrigin(claim.relayOrigin, 'authoritative Relay origin');
  if (link.claimId !== claimId || link.relayOrigin !== relayOrigin) {
    fail('pairing claim does not match the deep link');
  }
  const issuedAtMs = Number(claim.issuedAtMs);
  const expiresAtMs = Number(claim.expiresAtMs);
  const nowMs = Number(value.nowMs);
  if (
    !Number.isSafeInteger(issuedAtMs)
    || issuedAtMs < 0
    || !Number.isSafeInteger(expiresAtMs)
    || expiresAtMs <= issuedAtMs
    || !Number.isSafeInteger(nowMs)
    || nowMs < 0
  ) {
    fail('invalid pairing claim lifetime');
  }
  if (expiresAtMs - issuedAtMs > pairing.maxTtlSeconds * 1_000) {
    fail('pairing claim exceeds the declared short-lived TTL');
  }
  if (nowMs < issuedAtMs) fail('pairing claim is not active yet');
  if (nowMs >= expiresAtMs) fail('pairing claim expired');
  if (claim.consumedAtMs !== null) {
    if (Number.isSafeInteger(claim.consumedAtMs)) fail('pairing claim is already consumed');
    fail('pairing claim consumption state is unknown');
  }
  if (typeof value.consumeClaim !== 'function') fail('an atomic consume operation is required');

  let consumed;
  try {
    consumed = await value.consumeClaim({ claimId, expiresAtMs });
  } catch {
    fail('atomic claim consume failed');
  }
  if (consumed !== true) fail('pairing claim is already consumed or atomic consume failed');
  return { claimId, relayOrigin, consumedAtMs: nowMs };
}
