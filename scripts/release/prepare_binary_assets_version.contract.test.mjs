import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { prepareBinaryReleaseAssets } from '../pipeline/release/publishing/prepare-binary-assets.mjs';

async function writeScript(path, source) {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, source, { encoding: 'utf8', mode: 0o755 });
}

test('CLI asset preparation builds preview artifacts with the requested version and restores package.json', async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), 'happier-prepare-cli-assets-version-'));
  const packageJsonPath = join(repoRoot, 'apps', 'cli', 'package.json');
  const observedVersionPath = join(repoRoot, 'observed-build-version.txt');
  const requestedVersion = '1.2.3-preview.45';

  try {
    await mkdir(join(repoRoot, 'apps', 'cli'), { recursive: true });
    await writeFile(packageJsonPath, '{\n  "name": "fixture-cli",\n  "version": "1.2.3"\n}\n', 'utf8');

    await writeScript(
      join(repoRoot, 'scripts', 'pipeline', 'release', 'build-cli-binaries.mjs'),
      [
        "import { mkdir, readFile, writeFile } from 'node:fs/promises';",
        "import { join } from 'node:path';",
        'const root = process.cwd();',
        "const version = process.argv[process.argv.indexOf('--version') + 1];",
        "const packageJson = JSON.parse(await readFile(join(root, 'apps', 'cli', 'package.json'), 'utf8'));",
        `await writeFile(${JSON.stringify(observedVersionPath)}, String(packageJson.version), 'utf8');`,
        "const artifactsDir = join(root, 'dist', 'release-assets', 'cli');",
        'await mkdir(artifactsDir, { recursive: true });',
        "await writeFile(join(artifactsDir, `happier-v${version}-linux-x64.tar.gz`), 'fixture', 'utf8');",
        "await writeFile(join(artifactsDir, `checksums-happier-v${version}.txt`), 'fixture', 'utf8');",
        "await writeFile(join(artifactsDir, `checksums-happier-v${version}.txt.minisig`), 'fixture', 'utf8');",
      ].join('\n'),
    );
    await writeScript(
      join(repoRoot, 'scripts', 'pipeline', 'release', 'publish-manifests.mjs'),
      [
        "import { mkdir, writeFile } from 'node:fs/promises';",
        "import { join } from 'node:path';",
        "const outDir = process.argv[process.argv.indexOf('--out-dir') + 1];",
        "const channel = process.argv[process.argv.indexOf('--channel') + 1];",
        "await mkdir(join(outDir, 'v1', 'happier', channel), { recursive: true });",
        "await writeFile(join(outDir, 'v1', 'happier', channel, 'latest.json'), '{}', 'utf8');",
      ].join('\n'),
    );
    await writeScript(
      join(repoRoot, 'scripts', 'pipeline', 'release', 'verify-artifacts.mjs'),
      "process.exit(0);\n",
    );

    await prepareBinaryReleaseAssets({
      repoRoot,
      productId: 'cli',
      channel: 'preview',
      version: requestedVersion,
      assetsBaseUrl: 'https://example.test/cli-preview',
      commitSha: '0123456789abcdef0123456789abcdef01234567',
      skipSmoke: true,
    });

    assert.equal(await readFile(observedVersionPath, 'utf8'), requestedVersion);
    assert.equal(JSON.parse(await readFile(packageJsonPath, 'utf8')).version, '1.2.3');
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});
