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

test('promote-server delegates finalized runtime publishing to the hardened reusable workflow', async () => {
  const raw = await loadWorkflow('promote-server.yml');
  const publisher = raw.match(/\n  publish_runtime_release:[\s\S]*?(?=\n  [a-z_]+:|$)/)?.[0] ?? '';
  const deploy = raw.match(/\n  promote_deploy_ref:[\s\S]*$/)?.[0] ?? '';

  assert.match(publisher, /if:\s*inputs\.publish_runtime_release\s*==\s*true/);
  assert.match(publisher, /needs:\s*\[[^\]]*finalize_source[^\]]*\]/);
  assert.match(publisher, /uses:\s*\.\/\.github\/workflows\/publish-server-runtime\.yml/);
  assert.match(publisher, /source_ref:\s*\$\{\{\s*needs\.finalize_source\.outputs\.authorized_sha\s*\}\}/);
  assert.match(publisher, /authorized_sha:\s*\$\{\{\s*needs\.finalize_source\.outputs\.authorized_sha\s*\}\}/);
  assert.match(publisher, /channel:\s*\$\{\{\s*inputs\.environment\s*==\s*'production'\s*&&\s*'stable'\s*\|\|\s*'preview'\s*\}\}/);
  assert.match(publisher, /allow_stable:\s*\$\{\{\s*inputs\.environment\s*==\s*'production'\s*\}\}/);
  assert.match(publisher, /secrets:\s*inherit/);
  assert.doesNotMatch(publisher, /RELEASE_BOT_|MINISIGN_|GH_TOKEN|runs-on:|steps:/);

  assert.match(deploy, /needs:\s*\[[^\]]*publish_runtime_release[^\]]*\]/);
  assert.match(
    deploy,
    /if:\s*always\(\)[^\n]*needs\.finalize_source\.result\s*==\s*'success'[^\n]*needs\.publish_runtime_release\.result\s*==\s*'success'[^\n]*needs\.publish_runtime_release\.result\s*==\s*'skipped'/,
  );

  assert.doesNotMatch(raw, /node scripts\/pipeline\/run\.mjs publish-server-runtime/);
  assert.doesNotMatch(raw, /node scripts\/pipeline\/run\.mjs github-publish-release/);
  assert.doesNotMatch(raw, /gh release upload/, 'promote-server should not embed gh release upload');
  assert.doesNotMatch(raw, /gh release create/, 'promote-server should not embed gh release create');
});
