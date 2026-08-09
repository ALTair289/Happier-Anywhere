import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { versionedComponents } from '../pipeline/release/component-registry.mjs';
import { resolveHostedChecksProfileForReleaseProfile } from '../pipeline/release/public-release-contract.mjs';
import * as releaseValidationRegistry from '../pipeline/release-validation/registry.mjs';

const { RELEASE_VALIDATION_SUITES } = releaseValidationRegistry;

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const pipelineCli = resolve(repoRoot, 'scripts', 'pipeline', 'run.mjs');

const expectedCompatibilityDirections = [
  {
    id: 'candidate-clients-cli-daemon-to-supported-older-stable-relay',
    required: true,
    reason: 'Self-hosted deployments may independently upgrade candidate clients, CLI, and daemons against a supported older stable relay.',
  },
  {
    id: 'bounded-older-client-daemon-to-candidate-relay-core-flows',
    required: true,
    reason: 'Self-hosted deployments must preserve bounded core flows for supported older clients and daemons against a candidate relay.',
  },
  {
    id: 'persisted-old-writer-state-to-candidate-readers',
    required: true,
    reason: 'Candidate readers must accept persisted state written by supported older versions.',
  },
  {
    id: 'candidate-writer-to-older-reader-on-rollback-or-coexistence',
    required: false,
    reason: 'This direction becomes required only when supported rollback or coexistence makes a candidate write visible to an older reader.',
  },
];

function readPublicReleaseContract() {
  return JSON.parse(
    execFileSync(process.execPath, [pipelineCli, 'release-contract'], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    }),
  );
}

test('release-contract exposes canonical release targets and suite capabilities as JSON', () => {
  const contract = readPublicReleaseContract();

  assert.equal(contract.schemaVersion, 1);
  assert.equal(contract.kind, 'happier.public-release-contract.v1');
  assert.deepEqual(
    contract.targets,
    Object.values(versionedComponents).map(({ id, baselineTagPrefix, changedWhen }) => ({ id, baselineTagPrefix, changedWhen })),
  );
  assert.deepEqual(contract.releaseTargets, [
    'ui',
    'server',
    'website',
    'docs',
    'cli',
    'stack',
    'server_runner',
  ]);
  assert.deepEqual(
    contract.validationSuites,
    RELEASE_VALIDATION_SUITES.map((suite) => ({
      id: suite.id,
      supportsDirectSource: suite.supportsDirectSource,
      supportsUpdateSources: suite.supportsUpdateSources,
      ...(suite.supportedDirectSourceKinds ? { supportedDirectSourceKinds: suite.supportedDirectSourceKinds } : {}),
      ...(suite.supportedUpdateSourceKinds ? { supportedUpdateSourceKinds: suite.supportedUpdateSourceKinds } : {}),
      ...(suite.supportedUpdateSourcePairs ? { supportedUpdateSourcePairs: suite.supportedUpdateSourcePairs } : {}),
      executable: Boolean(suite.executorId),
    })),
  );
});

test('release-contract profiles distinguish bounded normal release validation from manual deep certification', () => {
  const contract = readPublicReleaseContract();
  const integratedAutomaticSuiteIds = ['artifact-verify', 'binary-smoke', 'session-continuity'];
  const stableAutomaticSuiteIds = [...integratedAutomaticSuiteIds, 'cli-update', 'daemon-continuity'];
  const supportedOlderRelayCompatibilityCheck = 'supported-old-relay-compatibility';

  assert.deepEqual(contract.validationProfiles, [
    {
      id: 'integrated',
      normalRelease: true,
      checksProfile: 'fast',
      automaticSuiteIds: integratedAutomaticSuiteIds,
      compatibilityDirections: expectedCompatibilityDirections,
      manualChecks: [supportedOlderRelayCompatibilityCheck],
    },
    {
      id: 'stable',
      normalRelease: true,
      checksProfile: 'full',
      automaticSuiteIds: stableAutomaticSuiteIds,
      compatibilityDirections: expectedCompatibilityDirections,
      manualChecks: [supportedOlderRelayCompatibilityCheck, 'agent-diff-sanity'],
    },
    {
      id: 'deep',
      normalRelease: false,
      checksProfile: null,
      automaticSuiteIds: [],
      compatibilityDirections: expectedCompatibilityDirections,
      manualChecks: [
        'review-integrated-and-stable-evidence',
        'installers-smoke-when-installer-surfaces-change',
        'docker-release-assets-when-docker-surface-changes',
        'cross-os-certification',
        'provider-certification',
        'mobile-certification',
        'manual-comprehensive-certification',
      ],
    },
  ]);
  assert.deepEqual(releaseValidationRegistry.RELEASE_VALIDATION_PROFILES, contract.validationProfiles);
  assert.equal(resolveHostedChecksProfileForReleaseProfile('integrated'), 'fast');
  assert.equal(resolveHostedChecksProfileForReleaseProfile('stable'), 'full');
  assert.equal(resolveHostedChecksProfileForReleaseProfile('deep'), null);
});

test('release-contract is discoverable from pipeline help', () => {
  const help = execFileSync(process.execPath, [pipelineCli, 'help', 'release-contract'], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30_000,
  });

  assert.match(help, /release-contract/);
  assert.match(help, /JSON/);
});
