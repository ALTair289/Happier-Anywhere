import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const TOOLS_DIR = join(SCRIPT_DIR, '..', 'tools');
const MANIFEST_PATH = join(TOOLS_DIR, 'third-party-assets.json');
const SUPPORTED_PLATFORMS = [
  'arm64-darwin',
  'arm64-linux',
  'x64-darwin',
  'x64-linux',
  'x64-win32',
];

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function readManifest() {
  return JSON.parse(await readFile(MANIFEST_PATH, 'utf8'));
}

test('third-party manifest pins exactly fifteen target assets and keeps Windows arm64 unsupported', async () => {
  const manifest = await readManifest();
  assert.equal(manifest.schemaVersion, 'happier-third-party-assets/v1');
  assert.deepEqual(manifest.platforms.supported, SUPPORTED_PLATFORMS);
  assert.deepEqual(manifest.platforms.unsupported, [{ platformDir: 'arm64-win32', reason: 'upstream binaries unavailable' }]);
  assert.equal(manifest.assets.length, 15);

  const identities = new Set();
  for (const asset of manifest.assets) {
    assert.ok(['difftastic', 'ripgrep', 'zellij'].includes(asset.tool));
    assert.ok(SUPPORTED_PLATFORMS.includes(asset.platformDir));
    assert.equal(typeof asset.version, 'string');
    assert.ok(asset.version.length > 0 && asset.version !== '0');
    assert.match(asset.source.url, /^https:\/\//);
    assert.doesNotMatch(asset.source.url, /\/latest(?:\/|$)/i);
    assert.match(asset.source.sha256, /^[a-f0-9]{64}$/);
    assert.ok(Number.isSafeInteger(asset.source.size) && asset.source.size > 0);
    assert.match(asset.source.commit, /^[a-f0-9]{40}$/);
    assert.ok(['tar.gz', 'zip'].includes(asset.source.archiveType));
    assert.ok(['exact', 'pinned-container'].includes(asset.memberPolicy));
    assert.ok(Array.isArray(asset.members) && asset.members.length > 0);
    assert.match(asset.licenseId, /^[a-z0-9-]+$/);
    for (const member of asset.members) {
      assert.ok(member.sourcePath && member.destinationPath);
      assert.match(member.sha256, /^[a-f0-9]{64}$/);
      assert.ok(Number.isSafeInteger(member.size) && member.size >= 0);
    }
    const identity = `${asset.tool}:${asset.platformDir}`;
    assert.equal(identities.has(identity), false, `duplicate asset identity: ${identity}`);
    identities.add(identity);
  }
  for (const tool of ['difftastic', 'ripgrep', 'zellij']) {
    assert.deepEqual(
      manifest.assets.filter((asset) => asset.tool === tool).map((asset) => asset.platformDir).sort(),
      [...SUPPORTED_PLATFORMS].sort(),
    );
  }
});

test('third-party licenses and NOTICE are pinned to normalized source bytes', async () => {
  const manifest = await readManifest();
  assert.equal(manifest.licenses.length, 3);
  const licenseIds = new Set(manifest.licenses.map((license) => license.id));
  for (const asset of manifest.assets) assert.ok(licenseIds.has(asset.licenseId));

  for (const license of manifest.licenses) {
    assert.match(license.spdx, /^[A-Za-z0-9-.+]+(?: (?:AND|OR) [A-Za-z0-9-.+]+)*$/);
    assert.match(license.normalizedSha256, /^[a-f0-9]{64}$/);
    const bytes = await readFile(join(TOOLS_DIR, 'licenses', license.file), 'utf8');
    assert.equal(sha256(bytes.replace(/\r\n/g, '\n')), license.normalizedSha256);
    assert.ok(license.source.url || license.source.archiveMember);
  }

  const notice = await readFile(join(TOOLS_DIR, 'THIRD_PARTY_NOTICES.md'), 'utf8');
  assert.match(notice, /Difftastic/i);
  assert.match(notice, /Anthropic.*ripgrep|ripgrep.*Anthropic/is);
  assert.match(notice, /Zellij/i);
  assert.match(notice, /fixed|pinned/i);
});

test('HEAD no longer ships active third-party binary archives', async () => {
  const archivesDir = join(TOOLS_DIR, 'archives');
  const entries = await readdir(archivesDir).catch((error) => {
    if (error?.code === 'ENOENT') return [];
    throw error;
  });
  assert.deepEqual(entries, []);
});
