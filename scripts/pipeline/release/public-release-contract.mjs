#!/usr/bin/env node

// @ts-check

import { pathToFileURL } from 'node:url';

import { releaseTargets, versionedComponents } from './component-registry.mjs';
import { RELEASE_VALIDATION_SUITES } from '../release-validation/registry.mjs';

export const PUBLIC_RELEASE_CONTRACT_SCHEMA_VERSION = 1;
export const PUBLIC_RELEASE_CONTRACT_KIND = 'happier.public-release-contract.v1';

const COMPATIBILITY_DIRECTIONS = Object.freeze([
  Object.freeze({
    id: 'candidate-clients-cli-daemon-to-supported-older-stable-relay',
    required: true,
    reason: 'Self-hosted deployments may independently upgrade candidate clients, CLI, and daemons against a supported older stable relay.',
  }),
  Object.freeze({
    id: 'bounded-older-client-daemon-to-candidate-relay-core-flows',
    required: true,
    reason: 'Self-hosted deployments must preserve bounded core flows for supported older clients and daemons against a candidate relay.',
  }),
  Object.freeze({
    id: 'persisted-old-writer-state-to-candidate-readers',
    required: true,
    reason: 'Candidate readers must accept persisted state written by supported older versions.',
  }),
  Object.freeze({
    id: 'candidate-writer-to-older-reader-on-rollback-or-coexistence',
    required: false,
    reason: 'This direction becomes required only when supported rollback or coexistence makes a candidate write visible to an older reader.',
  }),
]);

const INTEGRATED_AUTOMATIC_SUITE_IDS = Object.freeze([
  'artifact-verify',
  'binary-smoke',
  'session-continuity',
]);

const STABLE_AUTOMATIC_SUITE_IDS = Object.freeze([
  ...INTEGRATED_AUTOMATIC_SUITE_IDS,
  'cli-update',
  'daemon-continuity',
]);

const INTEGRATED_MANUAL_CHECKS = Object.freeze([
  'supported-old-relay-compatibility',
]);

const STABLE_MANUAL_CHECKS = Object.freeze([
  ...INTEGRATED_MANUAL_CHECKS,
  'agent-diff-sanity',
]);

const DEEP_MANUAL_CHECKS = Object.freeze([
  'review-integrated-and-stable-evidence',
  'installers-smoke-when-installer-surfaces-change',
  'docker-release-assets-when-docker-surface-changes',
  'cross-os-certification',
  'provider-certification',
  'mobile-certification',
  'manual-comprehensive-certification',
]);

function projectValidationSuite(suite) {
  return {
    id: suite.id,
    supportsDirectSource: suite.supportsDirectSource,
    supportsUpdateSources: suite.supportsUpdateSources,
    ...(suite.supportedDirectSourceKinds ? { supportedDirectSourceKinds: [...suite.supportedDirectSourceKinds] } : {}),
    ...(suite.supportedUpdateSourceKinds ? { supportedUpdateSourceKinds: [...suite.supportedUpdateSourceKinds] } : {}),
    ...(suite.supportedUpdateSourcePairs
      ? { supportedUpdateSourcePairs: suite.supportedUpdateSourcePairs.map((pair) => ({ ...pair })) }
      : {}),
    executable: Boolean(suite.executorId),
  };
}

function projectCompatibilityDirections() {
  return COMPATIBILITY_DIRECTIONS.map((direction) => ({ ...direction }));
}

export function resolvePublicReleaseContract() {
  return {
    schemaVersion: PUBLIC_RELEASE_CONTRACT_SCHEMA_VERSION,
    kind: PUBLIC_RELEASE_CONTRACT_KIND,
    targets: Object.values(versionedComponents).map(({ id, baselineTagPrefix, changedWhen }) => ({
      id,
      baselineTagPrefix,
      changedWhen: [...changedWhen],
    })),
    releaseTargets: [...releaseTargets],
    validationSuites: RELEASE_VALIDATION_SUITES.map(projectValidationSuite),
    validationProfiles: [
      {
        id: 'integrated',
        normalRelease: true,
        automaticSuiteIds: [...INTEGRATED_AUTOMATIC_SUITE_IDS],
        compatibilityDirections: projectCompatibilityDirections(),
        manualChecks: [...INTEGRATED_MANUAL_CHECKS],
      },
      {
        id: 'stable',
        normalRelease: true,
        automaticSuiteIds: [...STABLE_AUTOMATIC_SUITE_IDS],
        compatibilityDirections: projectCompatibilityDirections(),
        manualChecks: [...STABLE_MANUAL_CHECKS],
      },
      {
        id: 'deep',
        normalRelease: false,
        automaticSuiteIds: [],
        compatibilityDirections: projectCompatibilityDirections(),
        manualChecks: [...DEEP_MANUAL_CHECKS],
      },
    ],
  };
}

export function resolvePublicReleaseValidationProfile(raw) {
  const id = String(raw ?? '').trim();
  return resolvePublicReleaseContract().validationProfiles.find((profile) => profile.id === id) ?? null;
}

export function resolveHostedChecksProfileForReleaseProfile(raw) {
  const profile = resolvePublicReleaseValidationProfile(raw);
  if (!profile?.normalRelease) return null;
  return 'full';
}

function main() {
  process.stdout.write(`${JSON.stringify(resolvePublicReleaseContract())}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
