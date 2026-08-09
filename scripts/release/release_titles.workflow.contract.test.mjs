import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getBinaryPublishProductSpec } from '../pipeline/release/publishing/product-specs.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

async function loadWorkflow(name) {
  return readFile(join(repoRoot, '.github', 'workflows', name), 'utf8');
}

async function loadFile(rel) {
  return readFile(join(repoRoot, rel), 'utf8');
}

test('GitHub release titles are prefixed with Happier', async () => {
  const publishUiWeb = await loadFile('scripts/pipeline/release/publish-ui-web.mjs');
  assert.match(publishUiWeb, /Happier UI Web Bundle/);

  assert.equal(getBinaryPublishProductSpec('server').releaseTitleBase, 'Happier Server');

  assert.equal(getBinaryPublishProductSpec('cli').releaseTitleBase, 'Happier CLI');
  assert.equal(getBinaryPublishProductSpec('hstack').releaseTitleBase, 'Happier Stack');

  const buildTauri = await loadWorkflow('build-tauri.yml');
  assert.match(buildTauri, /title: Happier UI Desktop Dev/);
  assert.match(buildTauri, /title: Happier UI Desktop Preview/);
  assert.match(buildTauri, /title: Happier UI Desktop v/);
  assert.match(buildTauri, /--title "Happier UI Desktop Stable"/);
});
