// @ts-check

/**
 * @typedef {{
 *   id: string;
 *   supportsDirectSource: boolean;
 *   supportsUpdateSources: boolean;
 *   supportedDirectSourceKinds?: readonly string[];
 *   supportedUpdateSourceKinds?: readonly string[];
 *   supportedUpdateSourcePairs?: readonly { from: string; to: string }[];
 *   executorId?: string | null;
 * }} ReleaseValidationSuiteDefinition
 */

/**
 * @typedef {{
 *   id: 'integrated' | 'stable' | 'deep';
 *   normalRelease: boolean;
 *   checksProfile: 'fast' | 'full' | null;
 *   automaticSuiteIds: readonly string[];
 *   compatibilityDirections: readonly { id: string; required: boolean; reason: string }[];
 *   manualChecks: readonly string[];
 * }} ReleaseValidationProfileDefinition
 */

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
  'supported-old-relay-compatibility',
]);

const INTEGRATED_MANUAL_CHECKS = Object.freeze([
  'supported-old-relay-compatibility',
]);

const STABLE_MANUAL_CHECKS = Object.freeze([
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

/** @type {readonly ReleaseValidationProfileDefinition[]} */
export const RELEASE_VALIDATION_PROFILES = Object.freeze([
  Object.freeze({
    id: 'integrated',
    normalRelease: true,
    checksProfile: 'fast',
    automaticSuiteIds: INTEGRATED_AUTOMATIC_SUITE_IDS,
    compatibilityDirections: COMPATIBILITY_DIRECTIONS,
    manualChecks: INTEGRATED_MANUAL_CHECKS,
  }),
  Object.freeze({
    id: 'stable',
    normalRelease: true,
    checksProfile: 'full',
    automaticSuiteIds: STABLE_AUTOMATIC_SUITE_IDS,
    compatibilityDirections: COMPATIBILITY_DIRECTIONS,
    manualChecks: STABLE_MANUAL_CHECKS,
  }),
  Object.freeze({
    id: 'deep',
    normalRelease: false,
    checksProfile: null,
    automaticSuiteIds: Object.freeze([]),
    compatibilityDirections: COMPATIBILITY_DIRECTIONS,
    manualChecks: DEEP_MANUAL_CHECKS,
  }),
]);

/** @type {readonly ReleaseValidationSuiteDefinition[]} */
export const RELEASE_VALIDATION_SUITES = [
  {
    id: 'installers-smoke',
    supportsDirectSource: true,
    supportsUpdateSources: false,
    supportedDirectSourceKinds: ['published-channel', 'published-tag', 'local-build'],
    executorId: 'installers-smoke',
  },
  {
    id: 'binary-smoke',
    supportsDirectSource: true,
    supportsUpdateSources: false,
    supportedDirectSourceKinds: ['local-build'],
    executorId: 'binary-smoke',
  },
  {
    id: 'artifact-verify',
    supportsDirectSource: true,
    supportsUpdateSources: false,
    supportedDirectSourceKinds: ['local-build'],
    executorId: 'artifact-verify',
  },
  {
    id: 'docker-release-assets',
    supportsDirectSource: true,
    supportsUpdateSources: true,
    supportedDirectSourceKinds: ['local-build', 'published-channel'],
    supportedUpdateSourceKinds: ['published-channel', 'local-build'],
    executorId: 'docker-release-assets',
  },
  {
    id: 'cli-update',
    supportsDirectSource: false,
    supportsUpdateSources: true,
    supportedUpdateSourceKinds: ['published-channel', 'published-tag', 'local-build', 'local-pack'],
    supportedUpdateSourcePairs: [
      { from: 'published-channel', to: 'published-channel' },
      { from: 'published-channel', to: 'published-tag' },
      { from: 'published-channel', to: 'local-build' },
      { from: 'published-channel', to: 'local-pack' },
      { from: 'published-tag', to: 'published-channel' },
      { from: 'published-tag', to: 'published-tag' },
      { from: 'published-tag', to: 'local-build' },
      { from: 'published-tag', to: 'local-pack' },
    ],
    executorId: 'cli-update',
  },
  { id: 'server-upgrade', supportsDirectSource: false, supportsUpdateSources: true },
  {
    id: 'daemon-continuity',
    supportsDirectSource: true,
    supportsUpdateSources: false,
    supportedDirectSourceKinds: ['local-build'],
    executorId: 'daemon-continuity',
  },
  {
    id: 'session-continuity',
    supportsDirectSource: true,
    supportsUpdateSources: false,
    supportedDirectSourceKinds: ['local-build'],
    executorId: 'session-continuity',
  },
];

export const RELEASE_VALIDATION_SUITE_IDS = RELEASE_VALIDATION_SUITES.map((suite) => suite.id);

/**
 * @param {string} raw
 * @returns {ReleaseValidationSuiteDefinition | null}
 */
export function resolveReleaseValidationSuite(raw) {
  const id = String(raw ?? '').trim();
  return RELEASE_VALIDATION_SUITES.find((suite) => suite.id === id) ?? null;
}

export const RELEASE_VALIDATION_SOURCE_KINDS = [
  'published-channel',
  'published-tag',
  'local-build',
  'local-pack',
  'git-ref-build',
];

/**
 * @param {string} raw
 * @returns {string | null}
 */
export function resolveReleaseValidationSourceKind(raw) {
  const value = String(raw ?? '').trim();
  return RELEASE_VALIDATION_SOURCE_KINDS.includes(value) ? value : null;
}
