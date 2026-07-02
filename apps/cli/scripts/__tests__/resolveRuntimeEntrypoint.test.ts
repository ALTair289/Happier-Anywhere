import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createTempDirSync } from '../../src/testkit/fs/tempDir';
import { resolveRuntimeEntrypoint } from '../../bin/_resolveRuntimeEntrypoint.mjs';

function writePackageRoot(root: string) {
  writeFileSync(join(root, 'package.json'), '{ "private": true }\n', 'utf8');
  writeFileSync(join(root, 'yarn.lock'), '# yarn\n', 'utf8');
}

function writeEntrypoint(dir: string, text = 'export {};\n') {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'index.mjs'), text, 'utf8');
}

describe('resolveRuntimeEntrypoint', () => {
  it('prefers complete dist over a stale legacy backup', () => {
    const root = createTempDirSync('happier-cli-resolve-entrypoint-');
    writeEntrypoint(join(root, 'dist'), 'export const source = "dist";\n');
    writeEntrypoint(join(root, '.dist.hstack-backup'), 'export const source = "backup";\n');

    expect(resolveRuntimeEntrypoint(root, 'index.mjs')).toEqual(join(root, 'dist', 'index.mjs'));
  });

  it('uses backup while the CLI dist build lock is active', () => {
    const root = createTempDirSync('happier-cli-resolve-entrypoint-');
    writePackageRoot(root);
    writeEntrypoint(join(root, 'dist'), 'export const source = "dist";\n');
    writeEntrypoint(join(root, '.dist.hstack-backup'), 'export const source = "backup";\n');
    mkdirSync(join(root, '.project', 'tmp'), { recursive: true });
    writeFileSync(
      join(root, '.project', 'tmp', 'cli-dist-build.lock'),
      `${JSON.stringify({ pid: process.pid, updatedAtMs: Date.now() })}\n`,
      'utf8',
    );

    expect(resolveRuntimeEntrypoint(root, 'index.mjs')).toEqual(join(root, '.dist.hstack-backup', 'index.mjs'));
  });

  it('uses backup when dist has a broken reachable local import graph', () => {
    const root = createTempDirSync('happier-cli-resolve-entrypoint-');
    writeEntrypoint(join(root, 'dist'), "import './missing.mjs';\n");
    writeEntrypoint(join(root, '.dist.hstack-backup'), 'export const source = "backup";\n');

    expect(resolveRuntimeEntrypoint(root, 'index.mjs')).toEqual(join(root, '.dist.hstack-backup', 'index.mjs'));
  });

  it('falls back to package-dist when dist and backup are incomplete', () => {
    const root = createTempDirSync('happier-cli-resolve-entrypoint-');
    writeEntrypoint(join(root, 'dist'), "import './missing.mjs';\n");
    writeEntrypoint(join(root, '.dist.hstack-backup'), "import './missing-too.mjs';\n");
    writeEntrypoint(join(root, 'package-dist'), 'export const source = "package";\n');

    expect(resolveRuntimeEntrypoint(root, 'index.mjs')).toEqual(join(root, 'package-dist', 'index.mjs'));
  });

  it('returns the dist path when no candidate exists', () => {
    const root = createTempDirSync('happier-cli-resolve-entrypoint-');

    expect(resolveRuntimeEntrypoint(root, 'index.mjs')).toEqual(resolve(root, 'dist', 'index.mjs'));
  });
});
