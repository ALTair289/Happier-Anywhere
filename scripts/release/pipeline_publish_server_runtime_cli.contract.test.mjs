import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

for (const { channel, rollingTag } of [
  { channel: 'preview', rollingTag: 'server-preview' },
  { channel: 'dev', rollingTag: 'server-dev' },
]) {
  test(`pipeline CLI can publish server-runtime rolling release for ${channel} in dry-run`, async () => {
    const out = execFileSync(
      process.execPath,
      [
        resolve(repoRoot, 'scripts', 'pipeline', 'run.mjs'),
        'publish-server-runtime',
        '--channel',
        channel,
        '--allow-stable',
        'false',
        '--run-contracts',
        'false',
        '--check-installers',
        'false',
        '--dry-run',
        '--secrets-source',
        'env',
      ],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          HAPPIER_RELEASE_PUBLISHED_VERSIONS_JSON: JSON.stringify({ github: {}, npm: {} }),
        },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 30_000,
      },
    );

    assert.match(out, new RegExp(`\\[pipeline\\] server-runtime: channel=${channel} tag=${rollingTag}`));
    assert.match(out, /scripts\/pipeline\/release\/publish-server-runtime\.mjs/);
    // Manifests embed absolute GitHub release URLs; ensure we never emit a double-slash repo placeholder.
    assert.doesNotMatch(out, /https:\/\/github\.com\/\/releases\//);

    const wrapperSource = fs.readFileSync(resolve(repoRoot, 'scripts', 'pipeline', 'release', 'publish-server-runtime.mjs'), 'utf8');
    assert.match(wrapperSource, /publishing\/publish-binary-release\.mjs/);
  });
}

test('server runtime publisher exposes separate unsigned candidate build and authorized finalize modes', () => {
  const wrapperSource = fs.readFileSync(resolve(repoRoot, 'scripts', 'pipeline', 'release', 'publish-server-runtime.mjs'), 'utf8');
  const publisherSource = fs.readFileSync(resolve(repoRoot, 'scripts', 'pipeline', 'release', 'publishing', 'publish-binary-release.mjs'), 'utf8');
  assert.match(publisherSource, /build-candidate/);
  assert.match(publisherSource, /finalize-candidate/);
  assert.match(publisherSource, /authorized-sha/);
  assert.match(publisherSource, /server-runtime-candidate\.mjs/);
  assert.match(wrapperSource, /publishing\/publish-binary-release\.mjs/);
});

test('server runtime version allocation runs before workspace dependencies are installed', () => {
  const fixtureDir = mkdtempSync(join(tmpdir(), 'happier-server-release-preinstall-'));
  const loaderPath = join(fixtureDir, 'reject-workspace-imports.mjs');
  const githubOutputPath = join(fixtureDir, 'github-output.txt');
  writeFileSync(
    loaderPath,
    [
      "export async function resolve(specifier, context, nextResolve) {",
      "  if (specifier.startsWith('@happier-dev/')) {",
      "    throw new Error(`workspace dependency imported before install: ${specifier}`);",
      "  }",
      "  return nextResolve(specifier, context);",
      "}",
      '',
    ].join('\n'),
  );

  try {
    const result = spawnSync(
      process.execPath,
      [
        '--experimental-loader',
        loaderPath,
        resolve(repoRoot, 'scripts', 'pipeline', 'release', 'publish-server-runtime.mjs'),
        '--phase',
        'build-candidate',
        '--channel',
        'dev',
        '--base-version',
        '0.1.0',
        '--allow-stable',
        'false',
        '--run-contracts',
        'false',
        '--check-installers',
        'false',
        '--dry-run',
        '--github-output',
        githubOutputPath,
      ],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          GITHUB_RUN_NUMBER: '217',
          GITHUB_RUN_ATTEMPT: '1',
          HAPPIER_RELEASE_PUBLISHED_VERSIONS_JSON: JSON.stringify({ github: {}, npm: {} }),
        },
        encoding: 'utf8',
      },
    );

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(fs.readFileSync(githubOutputPath, 'utf8'), /^version=0\.1\.0-dev\.\d+$/m);
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});
