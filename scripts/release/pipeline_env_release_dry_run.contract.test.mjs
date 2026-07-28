import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadPipelineEnv } from '../pipeline/env/load-pipeline-env.mjs';

test('release dry-run environment resolution does not read secret-bearing dotenv files', () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'release-dry-run-env-'));
  try {
    writeFileSync(join(repoRoot, '.env.pipeline.local'), 'SECRET_FROM_FILE=must-not-load\n', 'utf8');
    writeFileSync(join(repoRoot, '.env.pipeline.preview.local'), 'PREVIEW_SECRET=must-not-load\n', 'utf8');

    const resolved = loadPipelineEnv({
      repoRoot,
      deployEnvironment: 'preview',
      includeFiles: false,
      processEnv: { SAFE_PLANNING_VALUE: 'available' },
    });

    assert.deepEqual(resolved.sources, []);
    assert.equal(resolved.env.SAFE_PLANNING_VALUE, 'available');
    assert.equal(resolved.env.SECRET_FROM_FILE, undefined);
    assert.equal(resolved.env.PREVIEW_SECRET, undefined);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});
