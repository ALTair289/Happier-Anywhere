import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createTempDirSync } from '../../src/testkit/fs/tempDir';
import {
  resolveRuntimeEntrypoint,
  resolveValidRuntimeEntrypoint,
} from '../../bin/_resolveRuntimeEntrypoint.mjs';

function writePackageRoot(root: string) {
  writeFileSync(join(root, 'package.json'), '{ "private": true }\n', 'utf8');
  writeFileSync(join(root, 'yarn.lock'), '# yarn\n', 'utf8');
}

function writeEntrypoint(dir: string, text = 'export {};\n') {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'index.mjs'), text, 'utf8');
}

function writeBuildManifest(dir: string, fingerprint: string) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, '.build-manifest.json'),
    `${JSON.stringify({
      fingerprint,
      builtAt: '2026-07-09T00:00:00.000Z',
      fileCount: 1,
      toolVersion: '1',
    })}\n`,
    'utf8',
  );
}

describe('resolveRuntimeEntrypoint', () => {
  it('prefers complete dist over a stale legacy backup', () => {
    const root = createTempDirSync('happier-cli-resolve-entrypoint-');
    writeEntrypoint(join(root, 'dist'), 'export const source = "dist";\n');
    writeBuildManifest(join(root, 'dist'), '1111111111111111');
    writeEntrypoint(join(root, '.dist.hstack-backup'), 'export const source = "backup";\n');
    writeBuildManifest(join(root, '.dist.hstack-backup'), '2222222222222222');

    expect(resolveRuntimeEntrypoint(root, 'index.mjs')).toEqual(join(root, 'dist', 'index.mjs'));
  });

  it('uses a valid dist snapshot while the CLI dist build lock is active', () => {
    const root = createTempDirSync('happier-cli-resolve-entrypoint-');
    writePackageRoot(root);
    writeEntrypoint(join(root, 'dist'), 'export const source = "dist";\n');
    writeBuildManifest(join(root, 'dist'), '1111111111111111');
    writeEntrypoint(join(root, '.dist.hstack-backup'), 'export const source = "backup";\n');
    writeBuildManifest(join(root, '.dist.hstack-backup'), '2222222222222222');
    mkdirSync(join(root, '.project', 'tmp'), { recursive: true });
    writeFileSync(
      join(root, '.project', 'tmp', 'cli-dist-build.lock'),
      `${JSON.stringify({ pid: process.pid, updatedAtMs: Date.now() })}\n`,
      'utf8',
    );

    expect(resolveRuntimeEntrypoint(root, 'index.mjs')).toEqual(join(root, 'dist', 'index.mjs'));
  });

  it('trusts the published manifest without recomputing the relative import closure', () => {
    const root = createTempDirSync('happier-cli-resolve-entrypoint-');
    writeEntrypoint(join(root, 'dist'), "import './missing.mjs';\n");
    writeBuildManifest(join(root, 'dist'), '1111111111111111');
    writeEntrypoint(join(root, '.dist.hstack-backup'), 'export const source = "backup";\n');
    writeBuildManifest(join(root, '.dist.hstack-backup'), '2222222222222222');

    expect(resolveRuntimeEntrypoint(root, 'index.mjs')).toEqual(join(root, 'dist', 'index.mjs'));
  });

  it('validates nested runtime entrypoints against the snapshot-root manifest', () => {
    const root = createTempDirSync('happier-cli-resolve-entrypoint-');
    const distDir = join(root, 'dist');
    mkdirSync(join(distDir, 'mcp', 'bridges'), { recursive: true });
    writeFileSync(join(distDir, 'mcp', 'bridges', 'remote.mjs'), 'export const ready = true;\n', 'utf8');
    writeBuildManifest(distDir, '1111111111111111');

    expect(resolveValidRuntimeEntrypoint(root, join('mcp', 'bridges', 'remote.mjs'))).toEqual(
      join(distDir, 'mcp', 'bridges', 'remote.mjs'),
    );
  });

  it('falls back to package-dist when dist and backup manifests are invalid', () => {
    const root = createTempDirSync('happier-cli-resolve-entrypoint-');
    writeEntrypoint(join(root, 'dist'), 'export const source = "dist";\n');
    writeFileSync(join(root, 'dist', '.build-manifest.json'), '{invalid\n', 'utf8');
    writeEntrypoint(join(root, '.dist.hstack-backup'), 'export const source = "backup";\n');
    writeBuildManifest(join(root, '.dist.hstack-backup'), 'not-a-fingerprint');
    writeEntrypoint(join(root, 'package-dist'), 'export const source = "package";\n');
    writeBuildManifest(join(root, 'package-dist'), '3333333333333333');

    expect(resolveRuntimeEntrypoint(root, 'index.mjs')).toEqual(join(root, 'package-dist', 'index.mjs'));
  });

  it('returns the dist path when no candidate exists', () => {
    const root = createTempDirSync('happier-cli-resolve-entrypoint-');

    expect(resolveRuntimeEntrypoint(root, 'index.mjs')).toEqual(resolve(root, 'dist', 'index.mjs'));
  });
});
