import test from 'node:test';
import assert from 'node:assert/strict';

import {
  deploymentKitJsonSchema,
  HAPPIER_DEPLOYMENT_KIT_TARGETS,
} from '../pipeline/deployment-kit/lib/deployment-kit-schema.mjs';

test('deployment kit JSON Schema exposes the role, platform, security, and native app contract', () => {
  assert.equal(deploymentKitJsonSchema.$schema, 'https://json-schema.org/draft/2020-12/schema');
  assert.equal(deploymentKitJsonSchema.$id, 'https://happier.dev/schemas/deployment-kit/v1.json');
  assert.equal(deploymentKitJsonSchema.additionalProperties, false);
  assert.deepEqual(
    deploymentKitJsonSchema.required,
    [
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
  );
  assert.deepEqual(deploymentKitJsonSchema.$defs.artifact.properties.role.enum, ['agent', 'controller']);
  assert.deepEqual(deploymentKitJsonSchema.$defs.artifact.properties.variant.enum, ['native']);
  assert.deepEqual(
    deploymentKitJsonSchema.$defs.target.oneOf.map((targetSchema) => Object.fromEntries(
      Object.entries(targetSchema.properties).map(([key, value]) => [key, value.const]),
    )),
    HAPPIER_DEPLOYMENT_KIT_TARGETS,
  );
  assert.equal(deploymentKitJsonSchema.properties.securityPolicy.properties.relayBindHost.const, '127.0.0.1');
  assert.equal(deploymentKitJsonSchema.properties.securityPolicy.properties.relayPort.const, 3005);
  assert.equal(deploymentKitJsonSchema.properties.securityPolicy.properties.allowTailscaleFunnel.const, false);
  assert.equal(
    deploymentKitJsonSchema.properties.securityPolicy.properties.credentialContentStatus.const,
    'not-verified',
  );
  assert.equal(
    Object.hasOwn(deploymentKitJsonSchema.properties.securityPolicy.properties, 'containsCredentials'),
    false,
  );
  assert.deepEqual(
    deploymentKitJsonSchema.$defs.mobile.oneOf.map((entry) => entry.$ref),
    ['#/$defs/signedMobile', '#/$defs/externalAppMobile'],
  );
  assert.equal(deploymentKitJsonSchema.$defs.signedMobile.required.includes('android'), true);
  assert.equal(deploymentKitJsonSchema.$defs.signedMobile.required.includes('ios'), true);
  assert.equal(
    deploymentKitJsonSchema.$defs.externalAppMobile.properties.distribution.properties.mode.const,
    'external-app',
  );
  assert.equal(
    deploymentKitJsonSchema.$defs.externalAppMobile.properties.distribution.properties.artifactInclusion.const,
    'not-included',
  );
  assert.equal(
    deploymentKitJsonSchema.$defs.externalAppMobile.properties.distribution.properties.signingVerificationStatus.const,
    'not-performed',
  );
  assert.equal(
    deploymentKitJsonSchema.$defs.externalAppMobile.properties.distribution.properties.channelAvailabilityStatus.const,
    'not-verified',
  );
  assert.equal(
    deploymentKitJsonSchema.$defs.mobilePairing.properties.runtimeIntegrationStatus.enum.includes('contract-only'),
    true,
  );
  assert.equal(
    deploymentKitJsonSchema.$defs.mobilePairing.properties.liveDeviceValidationStatus.enum.includes('not-verified'),
    true,
  );
});
