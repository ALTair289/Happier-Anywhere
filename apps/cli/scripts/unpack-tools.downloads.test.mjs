import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { createRequire } from 'node:module';

import * as tar from 'tar';

const require = createRequire(import.meta.url);
const { unpackTools } = require('./unpack-tools.cjs');

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function sha256File(path) {
  return sha256(await readFile(path));
}

async function createTarGz(root, name, files) {
  const sourceDir = join(root, `${name}-source`);
  await mkdir(sourceDir, { recursive: true });
  for (const [relativePath, bytes] of Object.entries(files)) {
    const destination = join(sourceDir, ...relativePath.split('/'));
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, bytes);
  }
  const archivePath = join(root, `${name}.tar.gz`);
  await tar.create({ cwd: sourceDir, file: archivePath, gzip: true }, Object.keys(files));
  return archivePath;
}

function normalizedSha256(text) {
  return sha256(Buffer.from(text.replace(/\r\n/g, '\n')));
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'happier-unpack-fixed-'));
  const toolsDir = join(root, 'tools');
  const licensesDir = join(toolsDir, 'licenses');
  await mkdir(licensesDir, { recursive: true });
  const licenseTexts = {
    difftastic: 'difftastic license\n',
    ripgrep: 'ripgrep license\n',
    zellij: 'zellij license\n',
  };
  for (const [name, text] of Object.entries(licenseTexts)) {
    await writeFile(join(licensesDir, `${name}-LICENSE`), text);
  }

  const archives = {
    difftastic: await createTarGz(root, 'difftastic', { difft: 'difft' }),
    ripgrep: await createTarGz(root, 'ripgrep', {
      'package/vendor/ripgrep/rg': 'rg',
      'package/vendor/ripgrep/ripgrep.node': 'node',
      'package/README.md': 'pinned container metadata',
    }),
    zellij: await createTarGz(root, 'zellij', { zellij: 'zellij' }),
  };
  const source = async (tool) => ({
    url: `https://downloads.example.test/${basename(archives[tool])}`,
    archiveName: basename(archives[tool]),
    archiveType: 'tar.gz',
    ref: 'v1.0.0',
    commit: ({ difftastic: '1', ripgrep: '2', zellij: '3' })[tool].repeat(40),
    sha256: await sha256File(archives[tool]),
    size: (await readFile(archives[tool])).length,
  });
  const manifest = {
    schemaVersion: 'happier-third-party-assets/v1',
    platforms: { supported: ['test-platform'], unsupported: [] },
    licenses: Object.entries(licenseTexts).map(([id, text]) => ({
      id,
      file: `${id}-LICENSE`,
      normalizedSha256: normalizedSha256(text),
    })),
    assets: [
      {
        tool: 'difftastic', platformDir: 'test-platform', version: '1.0.0', licenseId: 'difftastic', memberPolicy: 'exact',
        source: await source('difftastic'),
        members: [{ sourcePath: 'difft', destinationPath: 'difft', sha256: sha256(Buffer.from('difft')), size: 5, executable: true }],
      },
      {
        tool: 'ripgrep', platformDir: 'test-platform', version: 'vendor-1.0.0', licenseId: 'ripgrep', memberPolicy: 'pinned-container',
        source: await source('ripgrep'),
        members: [
          { sourcePath: 'package/vendor/ripgrep/rg', destinationPath: 'rg', sha256: sha256(Buffer.from('rg')), size: 2, executable: true },
          { sourcePath: 'package/vendor/ripgrep/ripgrep.node', destinationPath: 'ripgrep.node', sha256: sha256(Buffer.from('node')), size: 4, executable: false },
        ],
      },
      {
        tool: 'zellij', platformDir: 'test-platform', version: '1.0.0', licenseId: 'zellij', memberPolicy: 'exact',
        source: await source('zellij'),
        members: [{ sourcePath: 'zellij', destinationPath: 'zellij', sha256: sha256(Buffer.from('zellij')), size: 6, executable: true }],
      },
    ],
  };
  return { archives, manifest, root, toolsDir };
}

test('postinstall consumer downloads fixed sources, preflights all archives, and atomically writes verified tools', async () => {
  const { archives, manifest, toolsDir } = await fixture();
  let downloads = 0;
  const download = async ({ url, destinationPath }) => {
    downloads += 1;
    const tool = basename(url).replace(/\.tar\.gz$/, '');
    await copyFile(archives[tool], destinationPath);
  };
  await assert.doesNotReject(() => unpackTools({
    platformDir: 'test-platform',
    toolsDir,
    cacheDir: join(toolsDir, 'downloads'),
    manifest,
    download,
  }));
  assert.equal(downloads, 3);
  assert.equal(await readFile(join(toolsDir, 'unpacked', 'difft'), 'utf8'), 'difft');
  assert.equal(await readFile(join(toolsDir, 'unpacked', 'rg'), 'utf8'), 'rg');
  assert.equal(await readFile(join(toolsDir, 'unpacked', 'ripgrep.node'), 'utf8'), 'node');
  assert.equal(await readFile(join(toolsDir, 'unpacked', 'zellij'), 'utf8'), 'zellij');
  assert.match(await readFile(join(toolsDir, 'unpacked', '.happier-tools-manifest.json'), 'utf8'), /sourceSha256/);

  await assert.doesNotReject(() => unpackTools({
    platformDir: 'test-platform',
    toolsDir,
    cacheDir: join(toolsDir, 'downloads'),
    manifest,
    download,
  }));
  assert.equal(downloads, 3, 'verified output should not trigger another download');
});

test('postinstall consumer fails closed without partial output when a fixed download fails', async () => {
  const { manifest, toolsDir } = await fixture();
  await assert.rejects(
    () => unpackTools({
      platformDir: 'test-platform',
      toolsDir,
      cacheDir: join(toolsDir, 'downloads'),
      manifest,
      download: async () => { throw new Error('offline'); },
    }),
    /offline/,
  );
  const entries = await readdir(toolsDir);
  assert.equal(entries.includes('unpacked'), false);
  assert.equal(entries.some((entry) => entry.startsWith('.unpacked-staging-') || entry.startsWith('.archive-staging-')), false);
});

test('Windows arm64 remains explicitly unsupported', async () => {
  const { manifest, toolsDir } = await fixture();
  manifest.platforms.unsupported.push({ platformDir: 'arm64-win32', reason: 'upstream binaries unavailable' });
  await assert.rejects(
    () => unpackTools({ platformDir: 'arm64-win32', toolsDir, manifest }),
    /unsupported.*arm64-win32.*upstream binaries unavailable/i,
  );
});
