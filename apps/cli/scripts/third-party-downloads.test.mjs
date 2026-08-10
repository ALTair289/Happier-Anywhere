import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  ensurePinnedSourceArchive,
  loadThirdPartyManifest,
} = require('./third-party-assets.cjs');

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function sourceFor(bytes, overrides = {}) {
  return {
    url: 'https://downloads.example.test/tool-1.2.3.tar.gz',
    archiveName: 'tool-1.2.3.tar.gz',
    archiveType: 'tar.gz',
    ref: 'v1.2.3',
    commit: '1'.repeat(40),
    sha256: sha256(bytes),
    size: bytes.length,
    ...overrides,
  };
}

test('loadThirdPartyManifest returns the pinned fifteen-asset contract', () => {
  const manifest = loadThirdPartyManifest();
  assert.equal(manifest.schemaVersion, 'happier-third-party-assets/v1');
  assert.equal(manifest.assets.length, 15);
});

test('manifest loader rejects a unique but non-canonical fifteen-row matrix', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-third-party-matrix-'));
  try {
    const manifestPath = join(root, 'manifest.json');
    const manifest = JSON.parse(await readFile(new URL('../tools/third-party-assets.json', import.meta.url), 'utf8'));
    manifest.assets[0].tool = 'unexpected-tool';
    await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
    assert.throws(() => loadThirdPartyManifest(manifestPath), /exactly three tools.*canonical platform/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('fixed download verifies first use and re-verifies cache reuse without a second download', async () => {
  const bytes = Buffer.from('pinned archive');
  const cacheDir = await mkdtemp(join(tmpdir(), 'happier-third-party-cache-'));
  let downloads = 0;
  const download = async ({ destinationPath }) => {
    downloads += 1;
    await writeFile(destinationPath, bytes);
  };

  const first = await ensurePinnedSourceArchive({ source: sourceFor(bytes), cacheDir, download });
  assert.equal(downloads, 1);
  assert.deepEqual(await readFile(first), bytes);
  const second = await ensurePinnedSourceArchive({ source: sourceFor(bytes), cacheDir, download });
  assert.equal(second, first);
  assert.equal(downloads, 1);

  await writeFile(first, Buffer.from('tampered bytes'));
  await assert.rejects(
    () => ensurePinnedSourceArchive({ source: sourceFor(bytes), cacheDir, download }),
    /size|sha-?256|cache/i,
  );
  assert.equal(downloads, 1);
});

test('fixed download rejects insecure URLs and mismatched bytes without publishing a cache entry', async () => {
  const expected = Buffer.from('expected');
  const cacheDir = await mkdtemp(join(tmpdir(), 'happier-third-party-cache-'));
  const download = async ({ destinationPath }) => writeFile(destinationPath, 'wrong');
  await assert.rejects(
    () => ensurePinnedSourceArchive({
      source: sourceFor(expected, { url: 'http://downloads.example.test/tool.tar.gz' }),
      cacheDir,
      download,
    }),
    /https/i,
  );
  await assert.rejects(
    () => ensurePinnedSourceArchive({ source: sourceFor(expected), cacheDir, download }),
    /size|sha-?256/i,
  );
  const entries = await readdir(cacheDir);
  assert.deepEqual(entries, []);
});
