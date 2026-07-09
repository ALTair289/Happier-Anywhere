import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { createTempDirSync } from '../../src/testkit/fs/tempDir';
import { maybeRefreshLocalBundledWorkspacePackages } from '../../bin/_prepareRuntimeEntrypoint.mjs';
import { withWorkspaceBundleLock } from '../optionalWorkspaceBundleLock.mjs';

describe('maybeRefreshLocalBundledWorkspacePackages', () => {
  it('waits for the shared CLI build lock before source-mode bundled workspace prep', async () => {
    const repoRoot = createTempDirSync('happier-cli-prepare-entrypoint-lock-');
    try {
      const projectRoot = resolve(repoRoot, 'apps', 'cli');
      const syncModuleDir = resolve(repoRoot, 'scripts', 'workspaces');
      const syncCalledPath = resolve(repoRoot, '.project', 'tmp', 'sync-called');
      const lockPath = resolve(repoRoot, '.project', 'tmp', 'cli-dist-build.lock');

      mkdirSync(projectRoot, { recursive: true });
      mkdirSync(syncModuleDir, { recursive: true });
      writeFileSync(
        resolve(syncModuleDir, 'syncBundledWorkspacePackages.mjs'),
        [
          "import { mkdirSync, writeFileSync } from 'node:fs';",
          "import { dirname } from 'node:path';",
          `const syncCalledPath = ${JSON.stringify(syncCalledPath)};`,
          'export function syncBundledWorkspacePackages() {',
          '  mkdirSync(dirname(syncCalledPath), { recursive: true });',
          "  writeFileSync(syncCalledPath, 'called', 'utf8');",
          '}',
          '',
        ].join('\n'),
        'utf8',
      );

      await withWorkspaceBundleLock(
        async () => {
          await expect(
            maybeRefreshLocalBundledWorkspacePackages(projectRoot, {
              lockPath,
              lockTimeoutMs: 50,
              lockPollIntervalMs: 10,
              lockStaleAfterMs: 1_000,
            }),
          ).rejects.toThrow(/Timed out waiting for workspace bundle lock/);
          expect(existsSync(syncCalledPath)).toBe(false);
        },
        {
          lockPath,
          timeoutMs: 2_000,
          pollIntervalMs: 10,
          staleAfterMs: 1_000,
        },
      );
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});
