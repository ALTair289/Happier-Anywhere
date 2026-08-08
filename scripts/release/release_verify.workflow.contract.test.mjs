import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import YAML from 'yaml';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

test('release-verify workflow exposes and forwards continuity/update release-validation inputs', async () => {
  const raw = await readFile(join(repoRoot, '.github', 'workflows', 'release-verify.yml'), 'utf8');

  for (const inputName of [
    'run_cli_update_continuity',
    'run_daemon_continuity',
    'run_session_continuity',
  ]) {
    assert.match(
      raw,
      new RegExp(`${inputName}:\\n\\s+description: "Verify — .*"\\n\\s+required: true\\n\\s+default: true\\n\\s+type: boolean`),
      `release-verify workflow_dispatch should expose ${inputName} with a release-verification default`,
    );
    assert.match(
      raw,
      new RegExp(`${inputName}:\\n\\s+required: false\\n\\s+default: true\\n\\s+type: boolean`),
      `release-verify workflow_call should expose ${inputName}`,
    );
    assert.match(
      raw,
      new RegExp(`${inputName}:\\s*\\$\\{\\{ inputs\\.${inputName} \\}\\}`),
      `release-verify should forward ${inputName} into tests.yml`,
    );
  }
});

test('release-verify workflow supports dev channel and maps installer channel per release lane', async () => {
  const raw = await readFile(join(repoRoot, '.github', 'workflows', 'release-verify.yml'), 'utf8');

  assert.match(
    raw,
    /options:\n(?:\s+- .*\n)*\s+- dev\n(?:\s+- .*\n)*\s+- preview\n(?:\s+- .*\n)*\s+- production/m,
    'release-verify workflow_dispatch should allow dev/preview/production channels',
  );
  assert.match(
    raw,
    /installers_channel:\s*\$\{\{\s*inputs\.channel == 'production' && 'stable' \|\| inputs\.channel == 'dev' && 'dev' \|\| 'preview'\s*\}\}/,
    'release-verify should map production->stable, dev->dev, preview->preview when forwarding installer channel',
  );
});

test('release candidate verification runs trusted workflow control bytes under token', async () => {
  const raw = await readFile(join(repoRoot, '.github', 'workflows', 'release-verify.yml'), 'utf8');
  const workflow = YAML.parse(raw, { prettyErrors: true });
  const job = workflow.jobs.verify_candidate;
  assert.ok(job && Array.isArray(job.steps), 'verify_candidate must remain a step-based job');

  const checkoutSteps = job.steps.filter((step) => String(step?.uses ?? '').startsWith('actions/checkout@'));
  assert.equal(checkoutSteps.length, 1, 'candidate verification must have one control checkout');
  assert.equal(checkoutSteps[0].with?.repository, '${{ job.workflow_repository }}');
  assert.equal(checkoutSteps[0].with?.ref, '${{ job.workflow_sha }}');
  assert.equal(checkoutSteps[0].with?.path, '.release-control');
  assert.equal(checkoutSteps[0].with?.['persist-credentials'], false);

  assert.equal(
    job.steps.some((step) => String(step?.uses ?? '').startsWith('./.github/actions/')),
    false,
    'candidate-root local actions must not run in the verification gate',
  );
  assert.equal(
    job.steps.some((step) => /candidate source/i.test(String(step?.name ?? '')) && String(step?.uses ?? '').startsWith('actions/checkout@')),
    false,
    'candidate source must remain metadata rather than executable checkout bytes',
  );

  const privilegedSteps = job.steps.filter((step) => step?.env?.GITHUB_TOKEN || step?.env?.GH_TOKEN);
  assert.equal(privilegedSteps.length, 1, 'exactly one step should receive the repository token');
  const privileged = privilegedSteps[0];
  assert.match(
    String(privileged.run ?? ''),
    /\.release-control\/scripts\/pipeline\/release\/verify-release-candidate-identity\.mjs/,
  );
  assert.doesNotMatch(String(privileged.run ?? ''), /node\s+scripts\/pipeline\//);
  assert.doesNotMatch(String(privileged.run ?? ''), /\$\{\{\s*inputs\./);

  for (const [name, expression] of Object.entries({
    RELEASE_CHANNEL: '${{ inputs.channel }}',
    CANDIDATE_SOURCE_SHA: '${{ inputs.candidate_source_sha }}',
    CANDIDATE_CLI_VERSION: '${{ inputs.candidate_cli_version }}',
    CANDIDATE_STACK_VERSION: '${{ inputs.candidate_stack_version }}',
    CANDIDATE_SERVER_VERSION: '${{ inputs.candidate_server_version }}',
    CANDIDATE_UI_WEB_VERSION: '${{ inputs.candidate_ui_web_version }}',
  })) {
    assert.equal(privileged.env?.[name], expression, `${name} must enter the shell through env`);
  }

  const artifactVerification = job.steps.find((step) => /Verify downloaded signed artifacts/.test(String(step?.name ?? '')));
  assert.ok(artifactVerification, 'downloaded artifacts must be verified in a separate step');
  assert.equal(artifactVerification.env?.GITHUB_TOKEN, undefined);
  assert.equal(artifactVerification.env?.GH_TOKEN, undefined);
  assert.match(
    String(artifactVerification.run ?? ''),
    /\.release-control\/scripts\/pipeline\/release\/verify-artifacts\.mjs/,
  );
  assert.doesNotMatch(String(artifactVerification.run ?? ''), /\$\{\{\s*inputs\./);
});
