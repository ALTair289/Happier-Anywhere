// @ts-check

import Ajv2020 from 'ajv/dist/2020.js';

export const HAPPIER_DEPLOYMENT_KIT_ARTIFACT_VARIANTS = Object.freeze(['native']);
export const HAPPIER_DEPLOYMENT_KIT_TARGETS = Object.freeze([
  Object.freeze({ os: 'windows', arch: 'x64' }),
  Object.freeze({ os: 'linux', arch: 'x64', libc: 'glibc' }),
  Object.freeze({ os: 'linux', arch: 'arm64', libc: 'glibc' }),
  Object.freeze({ os: 'darwin', arch: 'x64' }),
  Object.freeze({ os: 'darwin', arch: 'arm64' }),
]);

const safeSegment = {
  type: 'string',
  minLength: 1,
  pattern: '^[0-9A-Za-z][0-9A-Za-z._+-]*$',
};

const closedObject = (properties, required = Object.keys(properties)) => ({
  type: 'object',
  additionalProperties: false,
  required,
  properties,
});

const canonicalTargetSchema = (target) => closedObject(Object.fromEntries(
  Object.entries(target).map(([key, value]) => [key, { const: value }]),
));

export const deploymentKitJsonSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://happier.dev/schemas/deployment-kit/v1.json',
  title: 'Happier Deployment Kit Manifest v1',
  description: 'Portable component inventory and deployment policy for a Happier controller, agents, and Web/native clients.',
  type: 'object',
  additionalProperties: false,
  required: [
    'schemaVersion',
    'product',
    'kitVersion',
    'channel',
    'source',
    'compatibility',
    'topology',
    'securityPolicy',
    'installation',
    'rollback',
    'mobile',
    'artifacts',
  ],
  properties: {
    schemaVersion: { const: 'happier-deployment-kit/v1' },
    product: { const: 'happier-deployment-kit' },
    kitVersion: { $ref: '#/$defs/safeSegment' },
    channel: { enum: ['local', 'dev', 'preview', 'stable'] },
    source: closedObject({
      commitSha: { type: 'string', pattern: '^[a-f0-9]{40,64}$' },
      workspaceState: { enum: ['clean', 'dirty'] },
      workspaceSnapshotSha256: {
        anyOf: [{ $ref: '#/$defs/sha256' }, { type: 'null' }],
      },
      reproducibility: { const: 'not-verified' },
    }),
    compatibility: closedObject({
      protocol: { $ref: '#/$defs/safeSegment' },
      cli: { $ref: '#/$defs/safeSegment' },
      relay: { $ref: '#/$defs/safeSegment' },
      webUi: { $ref: '#/$defs/safeSegment' },
      androidApp: { $ref: '#/$defs/safeSegment' },
      iosApp: { $ref: '#/$defs/safeSegment' },
    }),
    topology: closedObject({
      controller: closedObject({
        recommendedCount: { const: 1 },
        componentRole: { const: 'controller' },
      }),
      agents: closedObject({
        minimumCount: { type: 'integer', minimum: 1 },
        componentRole: { const: 'agent' },
        defaultServiceRole: { const: 'daemon-only' },
      }),
      clients: {
        type: 'array',
        prefixItems: [{ const: 'web' }, { const: 'android' }, { const: 'ios' }],
        items: false,
        minItems: 3,
        maxItems: 3,
      },
    }),
    securityPolicy: closedObject({
      relayBindHost: { const: '127.0.0.1' },
      relayPort: { const: 3005 },
      requireHttpsGateway: { const: true },
      allowTailscaleServe: { const: true },
      allowTailscaleFunnel: { const: false },
      allowPlaintextLan: { const: false },
      credentialContentStatus: { const: 'not-verified' },
    }),
    installation: closedObject({
      controller: closedObject({
        online: { type: 'boolean' },
        offline: { type: 'boolean' },
        owner: { const: 'happier-relay-host' },
      }),
      agent: closedObject({
        online: { type: 'boolean' },
        offline: { type: 'boolean' },
        owner: { const: 'happier-machine-setup' },
        offlineBlocker: { type: ['string', 'null'] },
      }),
    }),
    rollback: closedObject({
      binaryAndService: { const: 'canonical-owner' },
      data: { const: 'operator-backup-required' },
      maintenanceWindowRequired: { const: true },
    }),
    mobile: { $ref: '#/$defs/mobile' },
    artifacts: {
      type: 'array',
      minItems: 1,
      items: { $ref: '#/$defs/artifact' },
    },
  },
  $defs: {
    safeSegment,
    sha256: {
      type: 'string',
      pattern: '^[a-f0-9]{64}$',
    },
    mobileChannel: closedObject({
      id: { $ref: '#/$defs/safeSegment' },
      artifactFormat: { enum: ['aab', 'apk', 'ipa'] },
      evidenceSource: { $ref: '#/$defs/safeSegment' },
      buildId: { $ref: '#/$defs/safeSegment' },
      signingCertificateSha256: { $ref: '#/$defs/sha256' },
      pipelineAutomated: { type: 'boolean' },
    }),
    externalAndroidChannel: closedObject({
      id: { enum: ['google-play', 'signed-apk'] },
    }),
    externalIosChannel: closedObject({
      id: { enum: ['app-store', 'testflight', 'mdm'] },
    }),
    mobileProtocol: closedObject({
      supportedVersions: {
        type: 'array',
        minItems: 1,
        uniqueItems: true,
        items: { $ref: '#/$defs/safeSegment' },
      },
      preferredVersion: { $ref: '#/$defs/safeSegment' },
    }),
    mobilePairing: closedObject({
      contractVersion: { const: 'claim-v1' },
      deepLinkScheme: { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9+.-]*$' },
      deepLinkPath: { const: '/pair' },
      deepLinkParameters: {
        type: 'array',
        prefixItems: [{ const: 'v' }, { const: 'claimId' }, { const: 'origin' }],
        items: false,
        minItems: 3,
        maxItems: 3,
      },
      relayOriginProtocol: { const: 'https:' },
      maxTtlSeconds: { type: 'integer', minimum: 1, maximum: 600 },
      oneTime: { const: true },
      requiresAtomicConsume: { const: true },
      containsLongLivedCredentials: { const: false },
      runtimeIntegrationStatus: { enum: ['contract-only', 'implemented'] },
      liveDeviceValidationStatus: { enum: ['not-verified', 'verified'] },
    }),
    mobilePush: closedObject({
      mode: { enum: ['private', 'cloud'] },
      providers: {
        type: 'array',
        uniqueItems: true,
        items: { enum: ['apns', 'fcm'] },
      },
      containsProviderCredentials: { const: false },
      capabilities: closedObject({
        foregroundRealtime: { type: 'boolean' },
        backgroundRemoteNotifications: { type: 'boolean' },
        backgroundWakeup: { type: 'boolean' },
      }),
      limitation: { type: ['string', 'null'] },
    }),
    mobile: {
      oneOf: [
        { $ref: '#/$defs/signedMobile' },
        { $ref: '#/$defs/externalAppMobile' },
      ],
    },
    signedMobile: closedObject({
      schemaVersion: { const: 'happier-deployment-kit-mobile/v1' },
      protocol: { $ref: '#/$defs/mobileProtocol' },
      android: closedObject({
        applicationId: { type: 'string', minLength: 3 },
        appVersion: { $ref: '#/$defs/safeSegment' },
        runtimeVersion: { $ref: '#/$defs/safeSegment' },
        channels: {
          type: 'array',
          minItems: 1,
          items: { $ref: '#/$defs/mobileChannel' },
        },
      }),
      ios: closedObject({
        bundleId: { type: 'string', minLength: 3 },
        appVersion: { $ref: '#/$defs/safeSegment' },
        runtimeVersion: { $ref: '#/$defs/safeSegment' },
        teamId: { $ref: '#/$defs/safeSegment' },
        genericSideloadableIpa: { const: false },
        channels: {
          type: 'array',
          minItems: 3,
          maxItems: 3,
          items: { $ref: '#/$defs/mobileChannel' },
        },
      }),
      pairing: { $ref: '#/$defs/mobilePairing' },
      push: { $ref: '#/$defs/mobilePush' },
    }),
    externalAppMobile: closedObject({
      schemaVersion: { const: 'happier-deployment-kit-mobile/v1' },
      protocol: { $ref: '#/$defs/mobileProtocol' },
      distribution: closedObject({
        mode: { const: 'external-app' },
        artifactInclusion: { const: 'not-included' },
        artifactVerificationStatus: { const: 'not-performed' },
        signingVerificationStatus: { const: 'not-performed' },
        publicationVerificationStatus: { const: 'not-performed' },
        deviceValidationStatus: { const: 'not-verified' },
        channelAvailabilityStatus: { const: 'not-verified' },
      }),
      android: closedObject({
        applicationId: { type: 'string', minLength: 3 },
        requiredClaimV1AppVersion: { $ref: '#/$defs/safeSegment' },
        requiredRuntimeVersion: { $ref: '#/$defs/safeSegment' },
        channels: {
          type: 'array',
          minItems: 1,
          maxItems: 2,
          uniqueItems: true,
          items: { $ref: '#/$defs/externalAndroidChannel' },
        },
      }),
      ios: closedObject({
        bundleId: { type: 'string', minLength: 3 },
        requiredClaimV1AppVersion: { $ref: '#/$defs/safeSegment' },
        requiredRuntimeVersion: { $ref: '#/$defs/safeSegment' },
        genericSideloadableIpa: { const: false },
        channels: {
          type: 'array',
          minItems: 1,
          maxItems: 3,
          uniqueItems: true,
          items: { $ref: '#/$defs/externalIosChannel' },
        },
      }),
      pairing: { $ref: '#/$defs/mobilePairing' },
      push: { $ref: '#/$defs/mobilePush' },
    }),
    target: {
      oneOf: HAPPIER_DEPLOYMENT_KIT_TARGETS.map(canonicalTargetSchema),
    },
    artifact: closedObject({
      id: { $ref: '#/$defs/safeSegment' },
      role: { enum: ['agent', 'controller'] },
      target: { $ref: '#/$defs/target' },
      variant: { enum: HAPPIER_DEPLOYMENT_KIT_ARTIFACT_VARIANTS },
      format: { $ref: '#/$defs/safeSegment' },
      path: {
        type: 'string',
        minLength: 1,
        pattern: '^(?!/)(?![A-Za-z]:)(?!.*(?:^|/)\\.\\.(?:/|$))(?!.*\\\\).+$',
      },
      sha256: { $ref: '#/$defs/sha256' },
      size: { type: 'integer', minimum: 1 },
    }),
  },
};

const manifestValidator = new Ajv2020({ allErrors: true, strict: true }).compile(deploymentKitJsonSchema);

export function assertDeploymentKitManifestSchema(manifest) {
  if (manifestValidator(manifest)) return manifest;
  const failures = (manifestValidator.errors ?? [])
    .map((error) => `${error.instancePath || '/'}:${error.keyword}`)
    .join(', ');
  throw new Error(`[deployment-kit] manifest does not satisfy the v1 JSON Schema${failures ? ` (${failures})` : ''}`);
}
