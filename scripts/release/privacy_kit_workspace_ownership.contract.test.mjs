import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { classifyChangedPaths, deriveVersionedComponentChanges } from '../pipeline/release/component-registry.mjs';

const repoRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));

async function readJson(relativePath) {
  return JSON.parse(await readFile(new URL(`../../${relativePath}`, import.meta.url), 'utf8'));
}

test('privacy-kit is an attributed private workspace consumed by server and compatibility tests', async () => {
  const [rootPackage, privacyKitPackage, serverPackage, testsPackage, upstreamNotice] = await Promise.all([
    readJson('package.json'),
    readJson('packages/privacy-kit/package.json'),
    readJson('apps/server/package.json'),
    readJson('packages/tests/package.json'),
    readFile(new URL('../../packages/privacy-kit/UPSTREAM.md', import.meta.url), 'utf8'),
  ]);

  assert.ok(rootPackage.workspaces.packages.includes('packages/privacy-kit'));
  assert.equal(privacyKitPackage.name, 'privacy-kit');
  assert.equal(privacyKitPackage.private, true);
  assert.equal(privacyKitPackage.license, 'MIT');
  assert.equal(serverPackage.dependencies['privacy-kit'], '^0.0.25');
  assert.equal(testsPackage.dependencies['privacy-kit'], '^0.0.25');
  assert.match(upstreamNotice, /476fd33b16bb930fec5b52b13303fb919f30f6f3/);
  assert.match(upstreamNotice, /https:\/\/github\.com\/ex3ndr\/privacy-kit/);
});

test('privacy-kit changes trigger only the server release component', () => {
  const classified = classifyChangedPaths(['packages/privacy-kit/src/modules/tokens/persistent.ts']);
  const versioned = deriveVersionedComponentChanges(classified);

  assert.equal(classified.server, true);
  assert.equal(classified.shared, false);
  assert.equal(versioned.server, true);
  assert.equal(versioned.app, false);
  assert.equal(versioned.cli, false);
  assert.equal(versioned.stack, false);
});

test('privacy-kit build honors the workspace staged output directory', () => {
  const outputRoot = mkdtempSync(join(tmpdir(), 'privacy-kit-staged-dist-'));
  try {
    const result = spawnSync('yarn', ['-s', 'build'], {
      cwd: join(repoRoot, 'packages/privacy-kit'),
      encoding: 'utf8',
      env: {
        ...process.env,
        HAPPIER_WORKSPACE_DIST_OUTPUT_DIR: outputRoot,
      },
      timeout: 120_000,
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    for (const outputFile of ['index.cjs', 'index.d.cts', 'index.d.mts', 'index.mjs']) {
      assert.equal(
        existsSync(join(outputRoot, outputFile)),
        true,
        `privacy-kit staged build must emit ${outputFile}`,
      );
    }
    assert.equal(
      existsSync(join(outputRoot, 'package.json')),
      false,
      'privacy-kit staged build must remove its temporary stage manifest',
    );
  } finally {
    rmSync(outputRoot, { force: true, recursive: true });
  }
});
