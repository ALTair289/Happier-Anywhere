import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createReleaseCliDryRunEnv, RELEASE_CLI_DRY_RUN_TIMEOUT_MS } from './releaseCliDryRunTestkit.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const pipelineCli = resolve(repoRoot, 'scripts', 'pipeline', 'run.mjs');

test('release dry-run JSON resolves the actual promotion source independently of workflow-control HEAD', () => {
  const stub = createReleaseCliDryRunEnv();
  try {
    const raw = execFileSync(
      process.execPath,
      [
        pipelineCli,
        'release',
        '--confirm',
        'release preview to main',
        '--repository',
        'happier-dev/happier',
        '--deploy-environment',
        'production',
        '--dry-run',
        '--json',
      ],
      {
        cwd: repoRoot,
        env: { ...stub.env, GH_TOKEN: '', GH_REPO: '', GITHUB_REPOSITORY: '' },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: RELEASE_CLI_DRY_RUN_TIMEOUT_MS,
      },
    );

    assert.deepEqual(JSON.parse(raw), {
      kind: 'happier.release-dispatch-plan.v1',
      schemaVersion: 1,
      sourceBranch: 'preview',
      authorizedPromotionSourceSha: '3333333333333333333333333333333333333333',
    });
  } finally {
    stub.cleanup();
  }
});

test('release workflow admits an exact promotion source and forwards it through each branch mutation', async () => {
  const raw = await readFile(resolve(repoRoot, '.github', 'workflows', 'release.yml'), 'utf8');

  assert.match(raw, /authorized_promotion_source_sha:\s*\n\s*description: "Safety — exact source branch SHA approved for promotion"/);
  assert.match(raw, /authorized_promotion_source_sha is required when dry_run is false/);
  assert.match(raw, /Checkout authorized release planning source/);
  assert.match(raw, /Verify authorized promotion source/);
  assert.match(raw, /Materialize and commit changelog and version updates, then rerun with --bump none\./);
  assert.doesNotMatch(raw, /^  bump_versions_dev:/m, 'the final workflow must not create a post-admission bump commit');
  assert.match(raw, /promote_main:[\s\S]*?source_sha: \$\{\{[^\n]+\}\}/);
  assert.match(raw, /promote_preview:[\s\S]*?source_sha: \$\{\{[^\n]+\}\}/);
  assert.match(raw, /sync_dev:[\s\S]*?source_sha: \$\{\{ needs\.bind_server_source\.outputs\.authorized_sha \}\}/);
});
