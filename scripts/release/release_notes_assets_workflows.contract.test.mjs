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

const releaseNotesAssetCallers = [
  ['promote-ui.yml', 'promote'],
  ['build-ui-mobile-local.yml', 'release_notes_assets'],
  ['publish-ui-web.yml', 'publish'],
  ['publish-ui-mobile-dev.yml', 'publish'],
];

for (const [workflow, jobName] of releaseNotesAssetCallers) {
  test(`${workflow} builds and publishes release notes assets to the dedicated assets repo`, async () => {
    const { raw, parsed } = await loadWorkflow(workflow);
    const job = parsed?.jobs?.[jobName];
    assert.ok(job, `${workflow} should define job '${jobName}'`);
    assert.equal(job.environment, 'release-shared', `${workflow} job '${jobName}' should use release-shared secrets`);

    assert.match(raw, /Build release notes assets/);
    assert.match(raw, /Publish release notes assets/);
    assert.match(raw, /sources\/scripts\/parseReleaseNotes\.ts/);
    assert.match(raw, /scripts\/pipeline\/release\/release-notes\/build-release-notes-assets\.mjs/);
    assert.match(raw, /scripts\/pipeline\/release\/release-notes\/publish-release-notes-assets\.mjs/);
    assert.match(raw, /GH_REPO:\s*happier-dev\/happier-assets/);
    assert.match(raw, /--repo\s+"?happier-dev\/happier-assets"?/);
    assert.match(raw, /--tag\s+"?release-notes"?/);

    const steps = Array.isArray(job.steps) ? job.steps : [];
    const tokenStep = steps.find((step) => step?.id === 'release_notes_assets_token');
    assert.ok(tokenStep, `${workflow} should mint a dedicated release-notes assets token`);
    assert.equal(tokenStep.uses, 'actions/create-github-app-token@d72941d797fd3113feb6b93fd0dec494b13a2547');
    assert.equal(tokenStep.with?.['app-id'], '${{ secrets.RELEASE_BOT_APP_ID }}');
    assert.equal(tokenStep.with?.['private-key'], '${{ secrets.RELEASE_BOT_PRIVATE_KEY }}');
    assert.equal(tokenStep.with?.owner, '${{ github.repository_owner }}');
    assert.equal(tokenStep.with?.repositories, 'happier-assets');
    assert.equal(tokenStep.with?.['permission-contents'], 'write');

    const publishStep = steps.find((step) => step?.name === 'Publish release notes assets');
    assert.ok(publishStep, `${workflow} should publish release notes assets`);
    assert.equal(
      publishStep.env?.GH_TOKEN,
      '${{ steps.release_notes_assets_token.outputs.token }}',
      `${workflow} should publish release notes assets with the token scoped to happier-assets`,
    );
  });
}
