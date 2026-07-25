import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

async function loadWorkflow(name) {
  const raw = await readFile(join(repoRoot, '.github', 'workflows', name), 'utf8');
  return { raw, parsed: parse(raw) };
}

function listNeeds(needs) {
  if (Array.isArray(needs)) return needs;
  if (typeof needs === 'string') return [needs];
  return [];
}

function jobNeedsTransitively(jobs, jobName, requiredJobName, seen = new Set()) {
  if (jobName === requiredJobName) return true;
  if (seen.has(jobName)) return false;
  seen.add(jobName);

  const needs = listNeeds(jobs?.[jobName]?.needs);
  return needs.some((neededJobName) =>
    neededJobName === requiredJobName ||
    jobNeedsTransitively(jobs, neededJobName, requiredJobName, seen)
  );
}

function assertInheritedSecretsRequireTrustedRefGuard(file, parsed) {
  const jobs = parsed?.jobs ?? {};

  for (const [jobName, job] of Object.entries(jobs)) {
    if (job?.secrets !== 'inherit') continue;
    assert.ok(
      jobNeedsTransitively(jobs, jobName, 'trusted_ref_guard'),
      `${file} job '${jobName}' uses secrets: inherit and should require 'trusted_ref_guard' directly or transitively`
    );
  }
}

test('release workflows scope shared signing/publishing secrets to release-shared environment', async () => {
  const checks = [
    ['release-npm.yml', 'release', 'release-shared'],
    ['promote-ui.yml', 'promote', 'release-shared'],
    ['promote-server.yml', 'promote', 'release-shared'],
    ['promote-website.yml', 'promote', 'release-shared'],
    ['promote-docs.yml', 'promote', 'release-shared'],
    ['promote-branch.yml', 'promote', 'release-shared'],
    ['build-tauri.yml', 'build', 'release-shared'],
    ['publish-github-release.yml', 'publish', 'release-shared'],
    ['release.yml', 'deploy_plan', 'release-shared'],
  ];

  for (const [file, job, expected] of checks) {
    const { parsed } = await loadWorkflow(file);
    const actual = parsed?.jobs?.[job]?.environment;
    assert.equal(actual, expected, `${file} job '${job}' should use environment '${expected}'`);
  }
});

test('provider-secret jobs are isolated to providers-ci environment', async () => {
  const testsWorkflow = await loadWorkflow('tests.yml');
  const providersJobEnv = testsWorkflow.parsed?.jobs?.providers?.environment;
  assert.equal(providersJobEnv, 'providers-ci', 'tests.yml providers job should use providers-ci environment');

  const providersContracts = await loadWorkflow('providers-contracts.yml');
  const providersJob = providersContracts.parsed?.jobs?.providers;
  assert.equal(providersJob?.secrets, 'inherit', 'providers-contracts should pass secrets only to providers lane');
});

test('manual tests dispatch forwards provider secrets only to the reusable tests workflow', async () => {
  const { parsed } = await loadWorkflow('tests-dispatch.yml');
  const testsJob = parsed?.jobs?.tests;

  assert.ok(testsJob, 'tests-dispatch.yml should define the reusable tests job');
  assert.equal(testsJob?.uses, './.github/workflows/tests.yml');
  assert.equal(testsJob?.secrets, 'inherit', 'manual dispatch must pass provider secrets into tests.yml');
  assertInheritedSecretsRequireTrustedRefGuard('tests-dispatch.yml', parsed);
  assert.equal(testsJob?.with?.run_providers, "${{ needs.resolve.outputs.run_providers == 'true' }}");
});

test('provider workflow does not install Cursor through an unpinned remote shell pipeline', async () => {
  const { raw } = await loadWorkflow('tests.yml');

  assert.doesNotMatch(
    raw,
    /cursor\.com\/install[\s\S]*\|\s*bash/,
    'tests.yml must not run the mutable Cursor curl-to-bash installer before provider tests',
  );
  assert.match(
    raw,
    /Cursor provider CI requires a preinstalled cursor-agent/,
    'tests.yml should fail closed unless Cursor is preinstalled by the runner image or a pinned setup step',
  );
});

test('stress workflows do not inherit secrets into reusable tests workflow', async () => {
  const { parsed } = await loadWorkflow('stress-tests.yml');
  assert.equal(parsed?.jobs?.['stress-scheduled']?.secrets, undefined, 'stress-scheduled should not inherit secrets');
  assert.equal(parsed?.jobs?.['stress-manual']?.secrets, undefined, 'stress-manual should not inherit secrets');
});

test('release workflow keeps provider checks outside the compact manual release surface', async () => {
  const { parsed } = await loadWorkflow('release.yml');
  const inputs = parsed?.on?.workflow_dispatch?.inputs ?? {};

  assert.equal(inputs?.run_providers, undefined, 'compact manual release workflow should not expose provider toggles');
  assert.equal(inputs?.providers_preset, undefined, 'compact manual release workflow should not expose provider presets');
  assert.equal(inputs?.providers_tier, undefined, 'compact manual release workflow should not expose provider tiers');

  const ciJob = parsed?.jobs?.ci;
  assert.ok(ciJob, 'ci job should exist');
  assert.equal(ciJob.secrets, undefined, 'ci should not inherit secrets');
  assert.equal(ciJob.with?.run_providers, false, 'ci should never run providers directly');
  assert.equal(parsed?.jobs?.providers, undefined, 'release.yml should not embed a separate providers job; provider contracts run from their dedicated workflow');
});

test('manual secret-bearing workflows enforce trusted refs', async () => {
  const files = [
    'release.yml',
    'release-npm.yml',
    'promote-ui.yml',
    'promote-server.yml',
    'promote-website.yml',
    'promote-docs.yml',
    'promote-branch.yml',
    'build-tauri.yml',
    'providers-contracts.yml',
    'tests-dispatch.yml',
    'deploy.yml',
  ];

  for (const file of files) {
    const { raw } = await loadWorkflow(file);
    assert.match(
      raw,
      /Untrusted workflow_dispatch ref|trusted refs for manual dispatch|Refusing workflow_dispatch from untrusted ref/,
      `${file} should contain an explicit trusted-ref guard for workflow_dispatch`
    );
  }
});

test('secret-bearing workflows require release-admin actor guard before privileged jobs', async () => {
  const { raw: deployRaw } = await loadWorkflow('deploy.yml');
  assert.doesNotMatch(
    deployRaw,
    /\n\s*push:\s*\n/,
    'deploy workflow must not deploy on push (promote workflows trigger webhooks directly)'
  );

  const guardJob = 'release_actor_guard';
  const expectedWiring = [
    ['release.yml', 'ci'],
    ['release-npm.yml', 'release'],
    ['promote-ui.yml', 'promote'],
    ['promote-server.yml', 'promote'],
    ['promote-website.yml', 'promote'],
    ['promote-docs.yml', 'promote'],
    ['promote-branch.yml', 'promote'],
    ['build-tauri.yml', 'resolve_source'],
    ['publish-github-release.yml', 'publish'],
    ['providers-contracts.yml', 'trusted_ref_guard'],
    ['tests-dispatch.yml', 'trusted_ref_guard'],
    ['deploy.yml', 'deploy'],
    ['tests.yml', 'providers'],
  ];

  for (const [file, jobName] of expectedWiring) {
    const { parsed } = await loadWorkflow(file);
    const guard = parsed?.jobs?.[guardJob];
    assert.ok(guard, `${file} should define '${guardJob}'`);
    assert.equal(
      guard?.environment,
      undefined,
      `${file} '${guardJob}' should not request release-shared environment secrets`
    );
    assert.ok(
      Array.isArray(guard?.steps),
      `${file} '${guardJob}' should be implemented as a normal job with steps`
    );
    const guardStep = guard.steps.find(
      (step) => step?.uses === './.github/actions/release-actor-guard'
    );
    assert.ok(
      guardStep,
      `${file} '${guardJob}' should use the composite release-actor-guard action`
    );
    assert.match(
      String(guardStep?.with?.app_id ?? ''),
      /secrets\.RELEASE_BOT_APP_ID/,
      `${file} '${guardJob}' should pass RELEASE_BOT_APP_ID to the guard action`
    );
    assert.match(
      String(guardStep?.with?.private_key ?? ''),
      /secrets\.RELEASE_BOT_PRIVATE_KEY/,
      `${file} '${guardJob}' should pass RELEASE_BOT_PRIVATE_KEY to the guard action`
    );

    const job = parsed?.jobs?.[jobName];
    assert.ok(job, `${file} should define job '${jobName}'`);
    assert.ok(
      listNeeds(job?.needs).includes(guardJob),
      `${file} job '${jobName}' should require '${guardJob}'`
    );
    assert.equal(
      guard?.secrets,
      undefined,
      `${file} should not pass app secrets directly to release_actor_guard`
    );
  }
});
