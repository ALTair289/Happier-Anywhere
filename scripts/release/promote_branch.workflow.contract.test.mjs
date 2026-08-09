import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

async function loadWorkflow(name) {
  return readFile(join(repoRoot, '.github', 'workflows', name), 'utf8');
}

test('promote-branch delegates branch updates to pipeline script', async () => {
  const raw = await loadWorkflow('promote-branch.yml');
  assert.match(raw, /actions\/create-github-app-token@d72941d797fd3113feb6b93fd0dec494b13a2547/);
  assert.match(raw, /node scripts\/pipeline\/run\.mjs promote-branch/);
});

test('promote-branch carries an authorized source SHA through the authenticated mutation boundary', async () => {
  const raw = await loadWorkflow('promote-branch.yml');

  assert.match(raw, /source_sha:\s*\n\s*description: Exact source commit SHA authorized for mutation/);
  assert.match(raw, /INPUT_SOURCE_SHA/);
  assert.match(raw, /source_sha is required unless dry_run is true/);
  assert.match(raw, /--source-sha "\$INPUT_SOURCE_SHA"/);
});
