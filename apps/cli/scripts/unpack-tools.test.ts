import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);

type ToolAsset = {
  tool: string;
  platformDir: string;
  version: string;
  licenseId: string;
  source: {
    url: string;
    archiveName: string;
    archiveType: 'tar.gz' | 'zip';
    commit: string;
    sha256: string;
  };
  members: readonly { destinationPath: string }[];
};

type UnpackToolsModule = {
  getToolArchiveManifest: () => readonly ToolAsset[];
  areToolsUnpacked: (toolsDir: string, platformDir: string) => boolean;
  unpackTools: (options?: { platformDir?: string; toolsDir?: string }) => Promise<unknown>;
};

describe('unpack-tools fixed-download contract', () => {
  it('pins three tools across the canonical five targets and keeps the Windows ZIP mapping', () => {
    const unpackTools = require('./unpack-tools.cjs') as UnpackToolsModule;
    const manifest = unpackTools.getToolArchiveManifest();
    expect(manifest).toHaveLength(15);
    expect(new Set(manifest.map((entry) => entry.platformDir))).toEqual(new Set([
      'arm64-darwin',
      'arm64-linux',
      'x64-darwin',
      'x64-linux',
      'x64-win32',
    ]));
    expect(manifest).toEqual(expect.arrayContaining([
      expect.objectContaining({
        tool: 'zellij',
        platformDir: 'x64-win32',
        version: '0.44.3',
        source: expect.objectContaining({
          archiveName: 'zellij-no-web-x86_64-pc-windows-msvc.zip',
          archiveType: 'zip',
          commit: '55a2121b73dce4be624cda425a960e893000777c',
        }),
      }),
    ]));
    expect(manifest.every((entry) => entry.source.url.startsWith('https://'))).toBe(true);
    expect(manifest.every((entry) => /^[a-f0-9]{64}$/.test(entry.source.sha256))).toBe(true);
  });

  it('accepts only a complete regular-file output whose marker binds every source SHA', async () => {
    const unpackTools = require('./unpack-tools.cjs') as UnpackToolsModule;
    const root = await mkdtemp(join(tmpdir(), 'happier-unpack-tools-'));
    const unpacked = join(root, 'unpacked');
    await mkdir(unpacked, { recursive: true });
    const entries = unpackTools.getToolArchiveManifest().filter((entry) => entry.platformDir === 'x64-win32');
    for (const entry of entries) {
      for (const member of entry.members) await writeFile(join(unpacked, member.destinationPath), member.destinationPath);
    }
    for (const license of ['difftastic-LICENSE', 'ripgrep-LICENSE', 'zellij-LICENSE']) {
      await writeFile(join(unpacked, license), license);
    }
    await writeFile(join(unpacked, '.happier-tools-manifest.json'), `${JSON.stringify({
      schemaVersion: 'happier-unpacked-tools/v1',
      platformDir: 'x64-win32',
      tools: Object.fromEntries(entries.map((entry) => [entry.tool, {
        version: entry.version,
        sourceSha256: entry.source.sha256,
      }])),
    })}\n`);

    expect(unpackTools.areToolsUnpacked(root, 'x64-win32')).toBe(true);
    await writeFile(join(unpacked, '.happier-tools-manifest.json'), '{}\n');
    expect(unpackTools.areToolsUnpacked(root, 'x64-win32')).toBe(false);
  });

  it('keeps Windows arm64 explicitly unsupported', async () => {
    const unpackTools = require('./unpack-tools.cjs') as UnpackToolsModule;
    const root = await mkdtemp(join(tmpdir(), 'happier-unpack-tools-'));
    await expect(unpackTools.unpackTools({ platformDir: 'arm64-win32', toolsDir: root })).rejects.toThrow(
      /unsupported.*arm64-win32.*upstream binaries unavailable/i,
    );
  });
});
