import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

import { projectPathFromModuleUrl } from './projectPath';

describe('projectPathFromModuleUrl', () => {
  it('treats a pinned runner snapshot as the runtime project root', () => {
    const snapshotRoot = join(process.cwd(), '.runner-snapshots', 'abc123def4567890');

    expect(projectPathFromModuleUrl(pathToFileURL(join(snapshotRoot, 'api-test.mjs')).href)).toBe(snapshotRoot);
  });

  it('keeps source and normal dist modules anchored at the CLI package root', () => {
    expect(projectPathFromModuleUrl(pathToFileURL(join(process.cwd(), 'src', 'projectPath.ts')).href)).toBe(
      process.cwd(),
    );
    expect(projectPathFromModuleUrl(pathToFileURL(join(process.cwd(), 'dist', 'api-test.mjs')).href)).toBe(
      process.cwd(),
    );
  });
});
