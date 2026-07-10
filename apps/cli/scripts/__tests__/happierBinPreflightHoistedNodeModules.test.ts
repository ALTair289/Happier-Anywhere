import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { withWorkspaceBundleLockSync } from '../optionalWorkspaceBundleLock.mjs';
import {
  copyCliBinRuntimeFiles,
  createCliBinPreflightSandbox,
  runHappierBin,
  writeCliProjectFixture,
  writeNodeModuleStub,
  writeProtocolBundleStub,
} from './testkit/cliBinPreflightSandbox';

describe('apps/cli bin/happier.mjs preflight', () => {
  it('runs from packaged package-dist entrypoints when dist is absent', () => {
    const { rootDir: tmp, cleanup } = createCliBinPreflightSandbox('happier-bin-preflight-');
    try {
      const projectRoot = join(tmp, 'apps', 'cli');
      const { binDir } = writeCliProjectFixture({
        projectRoot,
        entrypointDir: 'package-dist',
        entrypointContent: 'process.exit(0);\n',
      });

      copyCliBinRuntimeFiles({ binDir });
      writeProtocolBundleStub({
        packageDir: join(tmp, 'node_modules', '@happier-dev', 'protocol'),
      });
      writeNodeModuleStub({
        packageDir: join(tmp, 'node_modules', 'tweetnacl'),
        files: { 'index.js': 'module.exports = {};\n' },
      });
      writeNodeModuleStub({
        packageDir: join(tmp, 'node_modules', 'base64-js'),
        files: { 'index.js': 'module.exports = {};\n' },
      });
      writeNodeModuleStub({
        packageDir: join(tmp, 'node_modules', '@noble', 'hashes'),
        manifest: { name: '@noble/hashes' },
        files: {
          'hmac.js': 'module.exports = {};\n',
          'sha512.js': 'module.exports = {};\n',
        },
      });

      const res = runHappierBin({ binDir, cwd: projectRoot, args: ['--help'] });

      expect(res.status).toBe(0);
      expect(res.stderr).toBe('');
    } finally {
      cleanup();
    }
  });

  it('allows @happier-dev/protocol to be hoisted to the repo root node_modules', () => {
    const { rootDir: tmp, cleanup } = createCliBinPreflightSandbox('happier-bin-preflight-');
    try {
      const projectRoot = join(tmp, 'apps', 'cli');
      const { binDir } = writeCliProjectFixture({
        projectRoot,
        entrypointDir: 'dist',
        entrypointContent: 'process.exit(0);\n',
      });

      copyCliBinRuntimeFiles({ binDir });

      // Simulate the `hstack` clone setup behavior: only root node_modules exist.
      writeProtocolBundleStub({
        packageDir: join(tmp, 'node_modules', '@happier-dev', 'protocol'),
      });
      writeNodeModuleStub({
        packageDir: join(tmp, 'node_modules', 'tweetnacl'),
        files: { 'index.js': 'module.exports = {};\n' },
      });
      writeNodeModuleStub({
        packageDir: join(tmp, 'node_modules', 'base64-js'),
        files: { 'index.js': 'module.exports = {};\n' },
      });
      writeNodeModuleStub({
        packageDir: join(tmp, 'node_modules', '@noble', 'hashes'),
        manifest: { name: '@noble/hashes' },
        files: {
          'hmac.js': 'module.exports = {};\n',
          'sha512.js': 'module.exports = {};\n',
        },
      });

      const res = runHappierBin({ binDir, cwd: projectRoot, args: ['--help'] });

      expect(res.status).toBe(0);
      expect(res.stderr).toBe('');
    } finally {
      cleanup();
    }
  });

  it('prints a helpful error if @happier-dev/protocol cannot be resolved', () => {
    const { rootDir: tmp, cleanup } = createCliBinPreflightSandbox('happier-bin-preflight-');
    try {
      const projectRoot = join(tmp, 'apps', 'cli');
      const { binDir } = writeCliProjectFixture({
        projectRoot,
        entrypointDir: 'dist',
        entrypointContent: 'process.exit(0);\n',
      });

      copyCliBinRuntimeFiles({ binDir });

      const res = runHappierBin({ binDir, cwd: projectRoot, args: ['--help'] });

      expect(res.status).toBe(1);
      expect(res.stderr).toContain('Missing bundled package: @happier-dev/protocol');
      expect(res.stderr).toContain('Reinstall @happier-dev/cli to repair your installation.');
    } finally {
      cleanup();
    }
  });

  it('launches a valid local snapshot without waiting for the writer lock or running workspace sync', () => {
    const { rootDir: tmp, cleanup } = createCliBinPreflightSandbox('happier-bin-preflight-');
    try {
      const projectRoot = join(tmp, 'apps', 'cli');
      const binDir = join(projectRoot, 'bin');
      const bundledProtocolDir = join(projectRoot, 'node_modules', '@happier-dev', 'protocol');
      const scriptsDir = join(tmp, 'scripts', 'workspaces');
      const syncCalledPath = join(tmp, '.project', 'tmp', 'sync-called');
      const lockPath = join(tmp, '.project', 'tmp', 'cli-dist-build.lock');

      mkdirSync(scriptsDir, { recursive: true });

      writeCliProjectFixture({
        projectRoot,
        entrypointDir: 'dist',
        entrypointContent: "console.log('launched');\n",
      });
      writeFileSync(
        join(projectRoot, 'dist', '.build-manifest.json'),
        `${JSON.stringify({ fingerprint: '0123456789abcdef', builtAt: '2026-07-09T00:00:00.000Z', fileCount: 1, toolVersion: '1' })}\n`,
        'utf8',
      );
      writeFileSync(
        join(projectRoot, 'package.json'),
        `${JSON.stringify({ name: '@happier-dev/cli', bundledDependencies: ['@happier-dev/protocol'] }, null, 2)}\n`,
        'utf8',
      );
      copyCliBinRuntimeFiles({ binDir });
      writeFileSync(
        join(scriptsDir, 'syncBundledWorkspacePackages.mjs'),
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

      writeFileSync(join(tmp, 'package.json'), JSON.stringify({ name: 'repo', private: true }), 'utf8');
      writeFileSync(join(tmp, 'yarn.lock'), '# lock\n', 'utf8');
      writeProtocolBundleStub({
        packageDir: bundledProtocolDir,
      });

      writeNodeModuleStub({
        packageDir: join(tmp, 'node_modules', 'tweetnacl'),
        files: { 'index.js': 'module.exports = {};\n' },
      });
      writeNodeModuleStub({
        packageDir: join(tmp, 'node_modules', 'base64-js'),
        files: { 'index.js': 'module.exports = {};\n' },
      });
      writeNodeModuleStub({
        packageDir: join(tmp, 'node_modules', '@noble', 'hashes'),
        manifest: { name: '@noble/hashes' },
        files: {
          'hmac.js': 'module.exports = {};\n',
          'sha512.js': 'module.exports = {};\n',
        },
      });

      const res = withWorkspaceBundleLockSync(
        () => runHappierBin({
          binDir,
          cwd: projectRoot,
          args: ['--help'],
          timeoutMs: 2_000,
          env: {
            ...process.env,
            NODE_OPTIONS: '',
          },
        }),
        {
          lockPath,
          timeoutMs: 2_000,
          pollIntervalMs: 10,
          staleAfterMs: 5_000,
        },
      );

      expect(res.status).toBe(0);
      expect(res.stdout).toContain('launched');
      expect(existsSync(syncCalledPath)).toBe(false);
    } finally {
      cleanup();
    }
  });
});
