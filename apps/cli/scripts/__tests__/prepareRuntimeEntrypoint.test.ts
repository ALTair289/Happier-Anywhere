import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

import { createTempDirSync } from '../../src/testkit/fs/tempDir';
import { prepareRuntimeEntrypoint } from '../../bin/_prepareRuntimeEntrypoint.mjs';
import { withWorkspaceBundleLock } from '../optionalWorkspaceBundleLock.mjs';

function writeBuildManifest(
  outputDir: string,
  fingerprint = '0123456789abcdef',
  builtAt = '2026-07-09T00:00:00.000Z',
) {
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(
    join(outputDir, '.build-manifest.json'),
    `${JSON.stringify({
      fingerprint,
      builtAt,
      fileCount: 1,
      toolVersion: '1',
    })}\n`,
    'utf8',
  );
}

function writeEntrypoint(outputDir: string, source = 'export const ready = true;\n') {
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(join(outputDir, 'index.mjs'), source, 'utf8');
}

function writeLocalRepoFixture(repoRoot: string) {
  const projectRoot = resolve(repoRoot, 'apps', 'cli');
  const syncModuleDir = resolve(repoRoot, 'scripts', 'workspaces');
  const syncCalledPath = resolve(repoRoot, '.project', 'tmp', 'sync-called');

  mkdirSync(resolve(projectRoot, 'scripts'), { recursive: true });
  mkdirSync(syncModuleDir, { recursive: true });
  writeFileSync(resolve(repoRoot, 'package.json'), '{ "private": true }\n', 'utf8');
  writeFileSync(resolve(repoRoot, 'yarn.lock'), '# yarn\n', 'utf8');
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

  return { projectRoot, syncCalledPath };
}

describe('prepareRuntimeEntrypoint', () => {
  it('uses a valid local snapshot without running bundled-workspace sync', async () => {
    const repoRoot = createTempDirSync('happier-cli-prepare-entrypoint-ready-');
    try {
      const { projectRoot, syncCalledPath } = writeLocalRepoFixture(repoRoot);
      const distDir = resolve(projectRoot, 'dist');
      writeEntrypoint(distDir);
      writeBuildManifest(distDir);

      await expect(prepareRuntimeEntrypoint(projectRoot, 'index.mjs')).resolves.toBe(
        resolve(distDir, 'index.mjs'),
      );
      expect(existsSync(syncCalledPath)).toBe(false);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('uses a valid local snapshot while another process holds the build-writer lock', async () => {
    const repoRoot = createTempDirSync('happier-cli-prepare-entrypoint-lockfree-');
    try {
      const { projectRoot, syncCalledPath } = writeLocalRepoFixture(repoRoot);
      const distDir = resolve(projectRoot, 'dist');
      const lockPath = resolve(repoRoot, '.project', 'tmp', 'cli-dist-build.lock');
      writeEntrypoint(distDir);
      writeBuildManifest(distDir);

      await withWorkspaceBundleLock(
        async () => {
          await expect(
            prepareRuntimeEntrypoint(projectRoot, 'index.mjs', {
              lockPath,
              lockTimeoutMs: 50,
              lockPollIntervalMs: 10,
              lockStaleAfterMs: 1_000,
            }),
          ).resolves.toBe(resolve(distDir, 'index.mjs'));
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

  it.each(['missing', 'invalid'] as const)(
    'builds under the writer lock when the local snapshot is %s',
    async (snapshotState) => {
      const repoRoot = createTempDirSync(`happier-cli-prepare-entrypoint-${snapshotState}-`);
      try {
        const { projectRoot, syncCalledPath } = writeLocalRepoFixture(repoRoot);
        const distDir = resolve(projectRoot, 'dist');
        const lockPath = resolve(repoRoot, '.project', 'tmp', 'cli-dist-build.lock');
        const eventsPath = resolve(repoRoot, '.project', 'tmp', 'build-events');
        const buildSharedDepsPath = resolve(projectRoot, 'scripts', 'buildSharedDeps.mjs');
        const buildPath = resolve(projectRoot, 'scripts', 'build.mjs');

        if (snapshotState === 'invalid') {
          writeEntrypoint(distDir, 'export const stale = true;\n');
          mkdirSync(distDir, { recursive: true });
          writeFileSync(join(distDir, '.build-manifest.json'), '{not-json\n', 'utf8');
        }

        writeFileSync(
          buildSharedDepsPath,
          [
            "import { appendFileSync, existsSync, mkdirSync } from 'node:fs';",
            "import { dirname } from 'node:path';",
            `const lockPath = ${JSON.stringify(lockPath)};`,
            `const eventsPath = ${JSON.stringify(eventsPath)};`,
            'export async function main() {',
            '  mkdirSync(dirname(eventsPath), { recursive: true });',
            "  appendFileSync(eventsPath, `shared:${existsSync(lockPath)}\\n`, 'utf8');",
            '}',
            '',
          ].join('\n'),
          'utf8',
        );
        writeFileSync(
          buildPath,
          [
            "import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';",
            "import { dirname, join } from 'node:path';",
            `const lockPath = ${JSON.stringify(lockPath)};`,
            `const eventsPath = ${JSON.stringify(eventsPath)};`,
            `const distDir = ${JSON.stringify(distDir)};`,
            'export async function buildCliDist(options) {',
            '  mkdirSync(dirname(eventsPath), { recursive: true });',
            "  appendFileSync(eventsPath, `build:${existsSync(lockPath)}\\n`, 'utf8');",
            '  const heldLockValue = options.env?.HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD;',
            '  const heldLock = JSON.parse(heldLockValue);',
            "  appendFileSync(eventsPath, `lease:${heldLock.path === lockPath}:${typeof heldLock.token === 'string' && heldLock.token.length > 0}\\n`, 'utf8');",
            "  appendFileSync(eventsPath, `explicit:${options.heldLockValue === heldLockValue}\\n`, 'utf8');",
            '  mkdirSync(distDir, { recursive: true });',
            "  writeFileSync(join(distDir, 'index.mjs'), 'export const built = true;\\n', 'utf8');",
            "  writeFileSync(join(distDir, '.build-manifest.json'), JSON.stringify({ fingerprint: 'fedcba9876543210', builtAt: '2026-07-09T00:00:00.000Z', fileCount: 1, toolVersion: '1' }) + '\\n', 'utf8');",
            '}',
            '',
          ].join('\n'),
          'utf8',
        );

        await expect(
          prepareRuntimeEntrypoint(projectRoot, 'index.mjs', {
            lockPath,
            lockTimeoutMs: 500,
            lockPollIntervalMs: 10,
            lockStaleAfterMs: 1_000,
          }),
        ).resolves.toBe(resolve(distDir, 'index.mjs'));
        expect(readFileSync(eventsPath, 'utf8')).toBe(
          'shared:true\nbuild:true\nlease:true:true\nexplicit:true\n',
        );
        expect(existsSync(syncCalledPath)).toBe(false);
      } finally {
        rmSync(repoRoot, { recursive: true, force: true });
      }
    },
  );

  it('reads a complete published fallback while a writer is between atomic directory renames', async () => {
    const repoRoot = createTempDirSync('happier-cli-prepare-entrypoint-swap-');
    try {
      const { projectRoot, syncCalledPath } = writeLocalRepoFixture(repoRoot);
      const distDir = resolve(projectRoot, 'dist');
      const packageDistDir = resolve(projectRoot, 'package-dist');
      const stagingDir = resolve(projectRoot, 'dist.staging.writer');
      const backupDir = resolve(projectRoot, 'dist.__finalize_backup__.writer');
      const lockPath = resolve(repoRoot, '.project', 'tmp', 'cli-dist-build.lock');
      writeEntrypoint(distDir, 'export const generation = "old-dist";\n');
      writeBuildManifest(distDir, '1111111111111111');
      writeEntrypoint(packageDistDir, 'export const generation = "old-package";\n');
      writeBuildManifest(packageDistDir, '1111111111111111');
      writeEntrypoint(stagingDir, 'export const generation = "new-dist";\n');
      writeBuildManifest(stagingDir, '2222222222222222');

      await withWorkspaceBundleLock(
        async () => {
          renameSync(distDir, backupDir);

          const entrypoint = await prepareRuntimeEntrypoint(projectRoot, 'index.mjs', {
            lockPath,
            lockTimeoutMs: 50,
            lockPollIntervalMs: 10,
            lockStaleAfterMs: 1_000,
          });
          expect(entrypoint).toBe(resolve(packageDistDir, 'index.mjs'));
          expect(readFileSync(entrypoint, 'utf8')).toContain('old-package');
          expect(existsSync(syncCalledPath)).toBe(false);

          renameSync(stagingDir, distDir);
        },
        {
          lockPath,
          timeoutMs: 2_000,
          pollIntervalMs: 10,
          staleAfterMs: 1_000,
        },
      );

      await expect(prepareRuntimeEntrypoint(projectRoot, 'index.mjs')).resolves.toBe(
        resolve(distDir, 'index.mjs'),
      );
      expect(readFileSync(resolve(distDir, 'index.mjs'), 'utf8')).toContain('new-dist');
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('re-resolves a manifest-backed entrypoint removed between selection and module import', async () => {
    const repoRoot = createTempDirSync('happier-cli-import-entrypoint-swap-');
    try {
      const { projectRoot } = writeLocalRepoFixture(repoRoot);
      const distDir = resolve(projectRoot, 'dist');
      const stagingDir = resolve(projectRoot, 'dist.staging.writer');
      const backupDir = resolve(projectRoot, 'dist.__finalize_backup__.writer');
      writeEntrypoint(distDir, 'export const generation = "old-dist";\n');
      writeBuildManifest(distDir, '1111111111111111');
      writeEntrypoint(stagingDir, 'export const generation = "new-dist";\n');
      writeBuildManifest(stagingDir, '2222222222222222');

      const launcher = await import('../../bin/_importRuntimeEntrypoint.mjs').catch(() => null);
      expect(launcher).not.toBeNull();
      if (!launcher) return;

      let importAttempts = 0;
      const runtimeModule = await launcher.importPreparedRuntimeEntrypoint(projectRoot, 'index.mjs', {
        importModule: async (specifier: string) => {
          importAttempts += 1;
          if (importAttempts === 1) {
            renameSync(distDir, backupDir);
            try {
              return await import(specifier);
            } finally {
              renameSync(stagingDir, distDir);
            }
          }
          return await import(specifier);
        },
        retryDelayMs: 1,
        retryPollAttempts: 10,
      });

      expect(runtimeModule.generation).toBe('new-dist');
      expect(importAttempts).toBe(2);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('does not retry a dependency-resolution failure when the published snapshot is unchanged', async () => {
    const repoRoot = createTempDirSync('happier-cli-import-entrypoint-dependency-error-');
    try {
      const { projectRoot } = writeLocalRepoFixture(repoRoot);
      const distDir = resolve(projectRoot, 'dist');
      writeEntrypoint(distDir);
      writeBuildManifest(distDir, '1111111111111111');
      const launcher = await import('../../bin/_importRuntimeEntrypoint.mjs');
      const dependencyError = Object.assign(new Error('missing external dependency'), {
        code: 'ERR_MODULE_NOT_FOUND',
      });
      let importAttempts = 0;

      await expect(
        launcher.importPreparedRuntimeEntrypoint(projectRoot, 'index.mjs', {
          importModule: async () => {
            importAttempts += 1;
            throw dependencyError;
          },
          retryDelayMs: 1,
          retryPollAttempts: 2,
        }),
      ).rejects.toBe(dependencyError);
      expect(importAttempts).toBe(1);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('retries a dependency-resolution failure after an identical-fingerprint generation swap', async () => {
    const repoRoot = createTempDirSync('happier-cli-import-entrypoint-generation-swap-');
    try {
      const { projectRoot } = writeLocalRepoFixture(repoRoot);
      const distDir = resolve(projectRoot, 'dist');
      const stagingDir = resolve(projectRoot, 'dist.staging.writer');
      const backupDir = resolve(projectRoot, 'dist.__finalize_backup__.writer');
      writeEntrypoint(distDir, 'export const generation = "old-dist";\n');
      writeBuildManifest(distDir, '1111111111111111', '2026-07-09T00:00:00.000Z');
      writeEntrypoint(stagingDir, 'export const generation = "new-dist";\n');
      writeBuildManifest(stagingDir, '1111111111111111', '2026-07-09T00:00:01.000Z');
      const launcher = await import('../../bin/_importRuntimeEntrypoint.mjs');
      const missingChunkError = Object.assign(new Error('missing chunk during swap'), {
        code: 'ERR_MODULE_NOT_FOUND',
        url: pathToFileURL(join(distDir, 'chunk.mjs')).href,
      });
      let importAttempts = 0;

      const runtimeModule = await launcher.importPreparedRuntimeEntrypoint(projectRoot, 'index.mjs', {
        importModule: async () => {
          importAttempts += 1;
          if (importAttempts === 1) {
            renameSync(distDir, backupDir);
            renameSync(stagingDir, distDir);
            throw missingChunkError;
          }
          return { generation: 'new-dist' };
        },
        retryDelayMs: 1,
        retryPollAttempts: 2,
      });

      expect(runtimeModule.generation).toBe('new-dist');
      expect(importAttempts).toBe(2);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});
