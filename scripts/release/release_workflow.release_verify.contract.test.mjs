import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

test('release workflow verifies immutable candidates before promoting preview or production channels', async () => {
  const raw = await readFile(join(repoRoot, '.github', 'workflows', 'release.yml'), 'utf8');

  assert.match(
    raw,
    /publish_server_runtime:[\s\S]*?publish_rolling:\s*false/,
    'server artifacts must remain immutable candidates until verification succeeds',
  );
  assert.match(
    raw,
    /publish_ui_web:[\s\S]*?publish_rolling:\s*false/,
    'UI artifacts must remain immutable candidates until verification succeeds',
  );
  assert.match(
    raw,
    /publish_cli_binaries:[\s\S]*?publish_rolling:\s*false/,
    'CLI artifacts must remain immutable candidates until verification succeeds',
  );
  assert.match(
    raw,
    /verify_release_candidates:[\s\S]*?needs:\s*\[plan, bind_server_source, publish_cli_binaries, publish_server_runtime, publish_ui_web\][\s\S]*?candidate_source_sha:\s*\$\{\{\s*needs\.bind_server_source\.outputs\.authorized_sha\s*\}\}[\s\S]*?candidate_cli_version:\s*\$\{\{\s*needs\.publish_cli_binaries\.outputs\.version\s*\}\}[\s\S]*?candidate_server_version:\s*\$\{\{\s*needs\.publish_server_runtime\.outputs\.version\s*\}\}[\s\S]*?candidate_ui_web_version:\s*\$\{\{\s*needs\.publish_ui_web\.outputs\.version\s*\}\}/,
    'the verifier must consume the exact source and immutable versions emitted by the candidate jobs',
  );
  assert.match(
    raw,
    /promote_server_runtime:[\s\S]*?needs:\s*\[verify_release_candidates, publish_server_runtime\][\s\S]*?retry_version:\s*\$\{\{\s*needs\.publish_server_runtime\.outputs\.version\s*\}\}/,
  );
  assert.match(
    raw,
    /promote_ui_web:[\s\S]*?needs:\s*\[verify_release_candidates, publish_ui_web, promote_server_runtime\][\s\S]*?retry_version:\s*\$\{\{\s*needs\.publish_ui_web\.outputs\.version\s*\}\}/,
  );
  assert.match(
    raw,
    /promote_cli_binaries:[\s\S]*?needs:\s*\[verify_release_candidates, publish_cli_binaries, promote_ui_web\][\s\S]*?retry_version:\s*\$\{\{\s*needs\.publish_cli_binaries\.outputs\.version\s*\}\}/,
  );
  assert.match(
    raw,
    /release_verify:[\s\S]*?needs:\s*\[plan, promote_cli_binaries, promote_server_runtime, promote_ui_web, publish_docker, publish_npm\][\s\S]*?uses:\s*\.\/\.github\/workflows\/release-verify\.yml/,
    'full checks should verify the promoted projections after candidate verification and promotion',
  );
  assert.match(
    raw,
    /plan:[\s\S]*?needs:\s*\[release_actor_guard, ci\][\s\S]*?\(needs\.ci\.result == 'success' \|\| needs\.ci\.result == 'skipped'\)/,
    'release.yml planning should only wait for the pre-release CI gate before continuing',
  );
  assert.match(
    raw,
    /sync_dev:[\s\S]*?\(needs\.release_verify\.result == 'success' \|\| needs\.release_verify\.result == 'skipped'\)[\s\S]*?needs:\s*\[plan, bump_versions_dev, promote_main, release_verify\]/,
    'release.yml should gate the final production sync on release verification succeeding or being skipped',
  );
});
