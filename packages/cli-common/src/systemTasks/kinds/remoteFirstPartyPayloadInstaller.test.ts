import { execFile, spawnSync } from 'node:child_process';
import { chmod, cp, link, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

import { installRemoteFirstPartyComponent } from './remoteFirstPartyPayloadInstaller.js';
import {
  createFirstPartyPayloadContentManifest,
  FIRST_PARTY_PAYLOAD_MANIFEST_FILE_NAME,
} from '../../componentArtifacts/firstPartyPayloadManifest.js';

const execFileAsync = promisify(execFile);

function expectPosixShellSyntax(command: string): void {
  const result = spawnSync('sh', ['-n', '-c', command], { encoding: 'utf8', windowsHide: true });
  if (result.error && (result.error as NodeJS.ErrnoException).code === 'ENOENT') return;
  expect(result.status, result.stderr || 'remote installer command must parse as POSIX sh').toBe(0);
}

async function createPayloadRootFixture(): Promise<Readonly<{
  payloadRoot: string;
  cleanup: () => Promise<void>;
}>> {
  const rootDir = await mkdtemp(join(tmpdir(), 'happier-remote-first-party-fixture-'));
  const payloadRoot = join(rootDir, 'payload-root');
  await mkdir(join(payloadRoot, 'package-dist'), { recursive: true });
  await writeFile(join(payloadRoot, 'happier'), '#!/usr/bin/env bash\nexit 0\n', 'utf8');
  await writeFile(join(payloadRoot, 'package-dist', 'index.mjs'), 'export {};\n', 'utf8');
  return {
    payloadRoot,
    cleanup: async () => {
      await rm(rootDir, { recursive: true, force: true });
    },
  };
}

async function extractTarFixture(params: Readonly<{ archivePath: string }>): Promise<Readonly<{
  extractRoot: string;
  cleanup: () => Promise<void>;
}>> {
  const extractRoot = await mkdtemp(join(tmpdir(), 'happier-remote-first-party-extract-'));
  try {
    await execFileAsync('tar', ['-xf', params.archivePath, '-C', extractRoot]);
    return {
      extractRoot,
      cleanup: async () => {
        await rm(extractRoot, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await rm(extractRoot, { recursive: true, force: true });
    throw error;
  }
}

describe('installRemoteFirstPartyComponent', () => {
  it('uses an scp-safe remote path for staging while keeping $HOME-based paths in remote shell commands', async () => {
    const remoteTextCommands: string[] = [];
    const copiedRemotePaths: string[] = [];
    const fixture = await createPayloadRootFixture();

    try {
      await installRemoteFirstPartyComponent(
        {
          componentId: 'happier-cli',
          channel: 'preview',
          ssh: {
            target: 'dev@example.test',
            auth: 'agent',
          },
        },
        {
          resolveRemoteReleaseTarget: async () => ({ os: 'linux', arch: 'x64' }),
          runRemoteText: async ({ remoteCommand }) => {
            remoteTextCommands.push(remoteCommand);
            return { status: 0, stdout: '', stderr: '' };
          },
          copyLocalDirectoryToRemote: async ({ remotePath }) => {
            copiedRemotePaths.push(remotePath);
          },
          preparePayload: async () => ({
            componentId: 'happier-cli',
            channel: 'preview',
            versionId: 'preview-1',
            payloadRoot: fixture.payloadRoot,
            source: 'https://example.test/payload.tar.gz',
            cleanup: async () => undefined,
          }),
          now: () => 123,
        },
      );

      expect(copiedRemotePaths).toEqual([
        '.happier/bootstrap-staging/happier-cli-preview-1-123',
      ]);
      expect(remoteTextCommands.some((command) => command.includes('mkdir -p "$HOME/.happier'))).toBe(true);
      expect(remoteTextCommands.some((command) => command.includes('mkdir -p $HOME/.happier'))).toBe(false);
      expect(remoteTextCommands.some((command) => command.includes('/versions/'))).toBe(true);
      expect(remoteTextCommands.some((command) => command.includes('tar -xf'))).toBe(true);
      expect(remoteTextCommands.some((command) => command.includes('mv -fT "$next_current"'))).toBe(true);
      expect(remoteTextCommands.some((command) => command.includes('chmod +x'))).toBe(true);
      expect(remoteTextCommands.some((command) => command.includes('bash $HOME/.happier'))).toBe(false);
      expect(remoteTextCommands.some((command) => command.includes('pipefail'))).toBe(false);

      const installCommand = remoteTextCommands.find((command) => command.includes('tar -xf'))!;
      expect(installCommand).toContain('.candidate.XXXXXX');
      expect(installCommand).toContain('.happier-payload-manifest-v1');
      expect(installCommand).toContain('verify_payload_tree');
      expect(installCommand).toContain('-links +1');
      expect(installCommand).toContain('cmp -s');
      expect(installCommand).not.toContain('rm -rf $HOME/.happier/cli-preview/versions/preview-1');
      expect(installCommand.indexOf('cp -R')).toBeLessThan(installCommand.indexOf('mv -fT "$next_current"'));
      expect(installCommand).toContain('test ! -L "$candidate_dir/happier"');
      expect(installCommand).toContain('test -f "$candidate_dir/happier"');
      expect(installCommand).toContain('mv -fT "$next_previous" "$HOME/.happier/cli-preview/previous"');
      expect(installCommand).toContain('trap cleanup EXIT');
      expect(installCommand).toContain('else mv "$candidate_dir" "$HOME/.happier/cli-preview/versions/preview-1"; candidate_dir=; fi');
      expectPosixShellSyntax(installCommand);
    } finally {
      await fixture.cleanup();
    }
  });

  it('installs an explicit local binary instead of downloading the channel artifact', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'happier-remote-first-party-local-binary-'));
    const localBinaryPath = join(rootDir, 'happier-server');
    let preparePayloadCalled = false;

    try {
      await writeFile(localBinaryPath, 'local-server-binary', 'utf8');
      await mkdir(join(rootDir, 'node_modules', '@prisma', 'client'), { recursive: true });
      await writeFile(
        join(rootDir, 'node_modules', '@prisma', 'client', 'index.js'),
        'export const PrismaClient = class {};\n',
        'utf8',
      );

      const installed = await installRemoteFirstPartyComponent(
        {
          componentId: 'happier-server',
          channel: 'preview',
          ssh: {
            target: 'dev@example.test',
            auth: 'agent',
          },
          localBinaryPath,
        },
        {
          resolveRemoteReleaseTarget: async () => ({ os: 'linux', arch: 'arm64' }),
          runRemoteText: async () => ({ status: 0, stdout: '', stderr: '' }),
          copyLocalDirectoryToRemote: async ({ localPath }) => {
            const extracted = await extractTarFixture({ archivePath: join(localPath, 'payload-root.tar') });
            try {
              expect(
                await readFile(join(extracted.extractRoot, 'payload-root', 'happier-server'), 'utf8'),
              ).toBe('local-server-binary');
              expect(
                await readFile(
                  join(extracted.extractRoot, 'payload-root', 'node_modules', '@prisma', 'client', 'index.js'),
                  'utf8',
                ),
              ).toContain('PrismaClient');
            } finally {
              await extracted.cleanup();
            }
          },
          preparePayload: async () => {
            preparePayloadCalled = true;
            throw new Error('channel payload should not be prepared');
          },
          now: () => 123,
        },
      );

      expect(preparePayloadCalled).toBe(false);
      expect(installed.versionId).toBe('local-123');
      expect(installed.source).toBeNull();
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it('best-effort removes remote staging when SCP fails before the install trap exists', async () => {
    const remoteTextCommands: string[] = [];
    const fixture = await createPayloadRootFixture();
    let preparedCleanupCount = 0;
    try {
      await expect(installRemoteFirstPartyComponent(
        {
          componentId: 'happier-cli',
          channel: 'preview',
          ssh: { target: 'dev@example.test', auth: 'agent' },
        },
        {
          resolveRemoteReleaseTarget: async () => ({ os: 'linux', arch: 'x64' }),
          runRemoteText: async ({ remoteCommand }) => {
            remoteTextCommands.push(remoteCommand);
            return { status: 0, stdout: '', stderr: '' };
          },
          copyLocalDirectoryToRemote: async () => {
            throw new Error('injected SCP failure');
          },
          preparePayload: async () => ({
            componentId: 'happier-cli',
            channel: 'preview',
            versionId: 'scp-failure',
            payloadRoot: fixture.payloadRoot,
            source: null,
            cleanup: async () => {
              preparedCleanupCount += 1;
            },
          }),
          now: () => 123,
        },
      )).rejects.toThrow(/injected SCP failure/i);

      expect(remoteTextCommands).toEqual([
        'mkdir -p "$HOME/.happier/bootstrap-staging/happier-cli-scp-failure-123"',
        'rm -rf "$HOME/.happier/bootstrap-staging/happier-cli-scp-failure-123"',
      ]);
      expect(preparedCleanupCount).toBe(1);
    } finally {
      await fixture.cleanup();
    }
  });

  it('best-effort removes the precise staging parent when the install transport throws after SCP without masking the original error', async () => {
    const remoteTextCommands: string[] = [];
    const fixture = await createPayloadRootFixture();
    const transportError = new Error('injected install transport spawn failure');
    try {
      await expect(installRemoteFirstPartyComponent(
        {
          componentId: 'happier-cli',
          channel: 'preview',
          ssh: { target: 'dev@example.test', auth: 'agent' },
        },
        {
          resolveRemoteReleaseTarget: async () => ({ os: 'linux', arch: 'x64' }),
          runRemoteText: async ({ remoteCommand }) => {
            remoteTextCommands.push(remoteCommand);
            if (remoteCommand.includes('tar -xf')) {
              throw transportError;
            }
            if (remoteCommand.startsWith('rm -rf ')) {
              throw new Error('injected cleanup transport failure');
            }
            return { status: 0, stdout: '', stderr: '' };
          },
          copyLocalDirectoryToRemote: async () => undefined,
          preparePayload: async () => ({
            componentId: 'happier-cli',
            channel: 'preview',
            versionId: 'transport-failure',
            payloadRoot: fixture.payloadRoot,
            source: null,
            cleanup: async () => undefined,
          }),
          now: () => 123,
        },
      )).rejects.toBe(transportError);

      expect(remoteTextCommands.at(-1)).toBe(
        'rm -rf "$HOME/.happier/bootstrap-staging/happier-cli-transport-failure-123"',
      );
      expect(remoteTextCommands.filter((command) => command.startsWith('rm -rf '))).toHaveLength(1);
    } finally {
      await fixture.cleanup();
    }
  });

  it('preserves a primary install error when both archive and prepared payload cleanup fail', async () => {
    const fixture = await createPayloadRootFixture();
    const primaryError = new Error('injected primary install failure');
    let archiveCleanupCount = 0;
    let preparedCleanupCount = 0;
    try {
      await expect(installRemoteFirstPartyComponent(
        {
          componentId: 'happier-cli',
          channel: 'preview',
          ssh: { target: 'dev@example.test', auth: 'agent' },
        },
        {
          resolveRemoteReleaseTarget: async () => ({ os: 'linux', arch: 'x64' }),
          runRemoteText: async ({ remoteCommand }) => {
            if (remoteCommand.includes('tar -xf')) {
              throw primaryError;
            }
            return { status: 0, stdout: '', stderr: '' };
          },
          copyLocalDirectoryToRemote: async () => undefined,
          preparePayload: async () => ({
            componentId: 'happier-cli',
            channel: 'preview',
            versionId: 'cleanup-failure',
            payloadRoot: fixture.payloadRoot,
            source: null,
            cleanup: async () => {
              preparedCleanupCount += 1;
              throw new Error('injected prepared cleanup failure');
            },
          }),
          createScpReadyPayloadArchive: async () => ({
            archiveStageRoot: '/tmp/injected-scp-ready',
            archiveFileName: 'payload-root.tar',
            extractedPayloadDirName: 'payload-root',
            manifestFileName: FIRST_PARTY_PAYLOAD_MANIFEST_FILE_NAME,
            manifestSha256: 'a'.repeat(64),
            cleanup: async () => {
              archiveCleanupCount += 1;
              throw new Error('injected archive cleanup failure');
            },
          }),
          now: () => 123,
        },
      )).rejects.toBe(primaryError);

      expect(archiveCleanupCount).toBe(1);
      expect(preparedCleanupCount).toBe(1);
    } finally {
      await fixture.cleanup();
    }
  });

  it('rejects a prepared payload whose immutable content does not match its approved SHA-256 before staging', async () => {
    const fixture = await createPayloadRootFixture();
    let remoteCallCount = 0;
    try {
      await expect(installRemoteFirstPartyComponent(
        {
          componentId: 'happier-cli',
          channel: 'preview',
          ssh: { target: 'dev@example.test', auth: 'agent' },
        },
        {
          resolveRemoteReleaseTarget: async () => ({ os: 'linux', arch: 'x64' }),
          runRemoteText: async () => {
            remoteCallCount += 1;
            return { status: 0, stdout: '', stderr: '' };
          },
          copyLocalDirectoryToRemote: async () => undefined,
          preparePayload: async () => ({
            componentId: 'happier-cli',
            channel: 'preview',
            versionId: 'approved-digest-mismatch',
            payloadRoot: fixture.payloadRoot,
            source: 'local-cli-payload:sha256:invalid',
            contentSha256: '0'.repeat(64),
            cleanup: async () => undefined,
          }),
          now: () => 123,
        },
      )).rejects.toThrow(/approved SHA-256/i);

      expect(remoteCallCount).toBe(0);
    } finally {
      await fixture.cleanup();
    }
  });

  describe.skipIf(process.platform === 'win32')('existing same-version integrity', () => {
    it.each([
      'legacy-without-manifest',
      'damaged-content',
      'hard-linked-content',
    ] as const)('strictly rejects an existing same-version directory with %s', async (failureMode) => {
      const fixture = await createPayloadRootFixture();
      const remoteHome = await mkdtemp(join(tmpdir(), 'happier-remote-first-party-existing-'));
      const installRoot = join(remoteHome, '.happier', 'cli-preview');
      const versionDir = join(installRoot, 'versions', 'same-version');
      const currentPath = join(installRoot, 'current');
      await cp(fixture.payloadRoot, versionDir, { recursive: true });
      await chmod(join(versionDir, 'happier'), 0o755);
      const manifest = await createFirstPartyPayloadContentManifest(fixture.payloadRoot);
      if (failureMode !== 'legacy-without-manifest') {
        await writeFile(join(versionDir, FIRST_PARTY_PAYLOAD_MANIFEST_FILE_NAME), manifest.text, 'utf8');
      }
      if (failureMode === 'damaged-content') {
        await writeFile(join(versionDir, 'happier'), 'tampered-existing-binary', 'utf8');
      }
      if (failureMode === 'hard-linked-content') {
        await link(join(versionDir, 'happier'), join(versionDir, 'happier-hardlink'));
      }
      await symlink(versionDir, currentPath);

      try {
        await expect(installRemoteFirstPartyComponent(
          {
            componentId: 'happier-cli',
            channel: 'preview',
            ssh: { target: 'dev@example.test', auth: 'agent' },
          },
          {
            resolveRemoteReleaseTarget: async () => ({ os: 'linux', arch: 'x64' }),
            runRemoteText: async ({ remoteCommand }) => {
              try {
                await execFileAsync('/bin/sh', ['-c', remoteCommand], {
                  env: { ...process.env, HOME: remoteHome },
                });
                return { status: 0, stdout: '', stderr: '' };
              } catch (error) {
                const status = Number((error as NodeJS.ErrnoException).code);
                return {
                  status: Number.isSafeInteger(status) ? status : 1,
                  stdout: '',
                  stderr: '',
                };
              }
            },
            copyLocalDirectoryToRemote: async ({ localPath, remotePath }) => {
              const remoteParent = join(remoteHome, remotePath);
              await mkdir(remoteParent, { recursive: true });
              await cp(localPath, join(remoteParent, basename(localPath)), { recursive: true });
            },
            preparePayload: async () => ({
              componentId: 'happier-cli',
              channel: 'preview',
              versionId: 'same-version',
              payloadRoot: fixture.payloadRoot,
              source: null,
              cleanup: async () => undefined,
            }),
            now: () => 123,
          },
        )).rejects.toThrow(/remote install command failed/i);

        expect(await readlink(currentPath)).toBe(versionDir);
      } finally {
        await fixture.cleanup();
        await rm(remoteHome, { recursive: true, force: true });
      }
    });
  });

  it.skipIf(process.platform === 'win32')(
    'keeps a same-version current target intact when an injected archive failure happens before atomic activation',
    async () => {
      const fixture = await createPayloadRootFixture();
      const remoteHome = await mkdtemp(join(tmpdir(), 'happier-remote-first-party-home-'));
      const installRoot = join(remoteHome, '.happier', 'cli-preview');
      const versionDir = join(installRoot, 'versions', 'same-version');
      const currentPath = join(installRoot, 'current');
      await mkdir(versionDir, { recursive: true });
      await writeFile(join(versionDir, 'happier'), 'existing-safe-binary', 'utf8');
      await symlink(versionDir, currentPath);

      try {
        await expect(installRemoteFirstPartyComponent(
          {
            componentId: 'happier-cli',
            channel: 'preview',
            ssh: { target: 'dev@example.test', auth: 'agent' },
          },
          {
            resolveRemoteReleaseTarget: async () => ({ os: 'linux', arch: 'x64' }),
            runRemoteText: async ({ remoteCommand }) => {
              try {
                await execFileAsync('/bin/sh', ['-c', remoteCommand], {
                  env: { ...process.env, HOME: remoteHome },
                });
                return { status: 0, stdout: '', stderr: '' };
              } catch (error) {
                throw new Error('injected remote archive failure', { cause: error });
              }
            },
            copyLocalDirectoryToRemote: async ({ localPath, remotePath }) => {
              const remoteParent = join(remoteHome, remotePath);
              const copiedRoot = join(remoteParent, basename(localPath));
              await mkdir(remoteParent, { recursive: true });
              await cp(localPath, copiedRoot, { recursive: true });
              const archiveName = (await readdir(copiedRoot)).find((name) => name.endsWith('.tar'))!;
              await writeFile(join(copiedRoot, archiveName), 'not-a-tar', 'utf8');
            },
            preparePayload: async () => ({
              componentId: 'happier-cli',
              channel: 'preview',
              versionId: 'same-version',
              payloadRoot: fixture.payloadRoot,
              source: null,
              cleanup: async () => undefined,
            }),
            now: () => 123,
          },
        )).rejects.toThrow(/injected remote archive failure/i);

        expect(await readlink(currentPath)).toBe(versionDir);
        expect(await readFile(join(versionDir, 'happier'), 'utf8')).toBe('existing-safe-binary');
      } finally {
        await fixture.cleanup();
        await rm(remoteHome, { recursive: true, force: true });
      }
    },
  );

  it('uses the BSD no-dereference move form for atomic current replacement on Darwin', async () => {
    const fixture = await createPayloadRootFixture();
    const remoteTextCommands: string[] = [];
    try {
      await installRemoteFirstPartyComponent(
        {
          componentId: 'happier-server',
          channel: 'stable',
          ssh: { target: 'dev@example.test', auth: 'agent' },
        },
        {
          resolveRemoteReleaseTarget: async () => ({ os: 'darwin', arch: 'arm64' }),
          runRemoteText: async ({ remoteCommand }) => {
            remoteTextCommands.push(remoteCommand);
            return { status: 0, stdout: '', stderr: '' };
          },
          copyLocalDirectoryToRemote: async () => undefined,
          preparePayload: async () => ({
            componentId: 'happier-server',
            channel: 'stable',
            versionId: 'darwin-atomic',
            payloadRoot: fixture.payloadRoot,
            source: null,
            cleanup: async () => undefined,
          }),
          now: () => 123,
        },
      );

      const installCommand = remoteTextCommands.find((command) => command.includes('tar -xf'))!;
      expect(installCommand).toContain('mv -fh "$next_current"');
      expect(installCommand).toContain('mv -fh "$next_previous" "$HOME/.happier/server/previous"');
      expect(installCommand).not.toContain('mv -fT "$next_current"');
      expectPosixShellSyntax(installCommand);
    } finally {
      await fixture.cleanup();
    }
  });

  it('fails closed on an injected non-zero remote install status and best-effort cleans remote and local payload state', async () => {
    const fixture = await createPayloadRootFixture();
    let remoteCallCount = 0;
    let preparedCleanupCount = 0;
    try {
      await expect(installRemoteFirstPartyComponent(
        {
          componentId: 'happier-cli',
          channel: 'preview',
          ssh: { target: 'dev@example.test', auth: 'agent' },
        },
        {
          resolveRemoteReleaseTarget: async () => ({ os: 'linux', arch: 'x64' }),
          runRemoteText: async () => {
            remoteCallCount += 1;
            return remoteCallCount === 1
              ? { status: 0, stdout: '', stderr: '' }
              : { status: 23, stdout: 'must-not-be-surfaced', stderr: 'must-not-be-surfaced' };
          },
          copyLocalDirectoryToRemote: async () => undefined,
          preparePayload: async () => ({
            componentId: 'happier-cli',
            channel: 'preview',
            versionId: 'injected-failure',
            payloadRoot: fixture.payloadRoot,
            source: null,
            cleanup: async () => {
              preparedCleanupCount += 1;
            },
          }),
          now: () => 123,
        },
      )).rejects.toThrow(/remote install command failed.*23/i);

      expect(remoteCallCount).toBe(3);
      expect(preparedCleanupCount).toBe(1);
    } finally {
      await fixture.cleanup();
    }
  });

  it('rejects remoteHomeDir values that are unsafe to embed in shell commands', async () => {
    await expect(
      installRemoteFirstPartyComponent(
        {
          componentId: 'happier-cli',
          channel: 'preview',
          ssh: {
            target: 'dev@example.test',
            auth: 'agent',
          },
          remoteHomeDir: '$HOME/.happier; rm -rf /',
        },
        {
          resolveRemoteReleaseTarget: async () => ({ os: 'linux', arch: 'x64' }),
          runRemoteText: async () => ({ status: 0, stdout: '', stderr: '' }),
          copyLocalDirectoryToRemote: async () => undefined,
          preparePayload: async () => ({
            componentId: 'happier-cli',
            channel: 'preview',
            versionId: 'preview-1',
            payloadRoot: '/tmp/payload-root',
            source: 'https://example.test/payload.tar.gz',
            cleanup: async () => undefined,
          }),
          now: () => 123,
        },
      ),
    ).rejects.toThrow(/remote home dir/i);
  });

  it('shell-escapes versionId values when embedding them in the remote install command', async () => {
    const remoteTextCommands: string[] = [];
    const fixture = await createPayloadRootFixture();

    try {
      await installRemoteFirstPartyComponent(
        {
          componentId: 'happier-cli',
          channel: 'preview',
          ssh: {
            target: 'dev@example.test',
            auth: 'agent',
          },
        },
        {
          resolveRemoteReleaseTarget: async () => ({ os: 'linux', arch: 'x64' }),
          runRemoteText: async ({ remoteCommand }) => {
            remoteTextCommands.push(remoteCommand);
            return { status: 0, stdout: '', stderr: '' };
          },
          copyLocalDirectoryToRemote: async () => undefined,
          preparePayload: async () => ({
            componentId: 'happier-cli',
            channel: 'preview',
            versionId: "preview-1'break-quote",
            payloadRoot: fixture.payloadRoot,
            source: 'https://example.test/payload.tar.gz',
            cleanup: async () => undefined,
          }),
          now: () => 123,
        },
      );

      const combined = remoteTextCommands.join('\n');
      expect(combined).toContain('preview-1-break-quote');
      expect(combined).not.toContain("preview-1'break-quote");
    } finally {
      await fixture.cleanup();
    }
  });

  it.each(['.', '..'])('rejects the reserved remote version path segment %s before staging', async (versionId) => {
    const fixture = await createPayloadRootFixture();
    let remoteCallCount = 0;
    try {
      await expect(installRemoteFirstPartyComponent(
        {
          componentId: 'happier-cli',
          channel: 'preview',
          ssh: { target: 'dev@example.test', auth: 'agent' },
        },
        {
          resolveRemoteReleaseTarget: async () => ({ os: 'linux', arch: 'x64' }),
          runRemoteText: async () => {
            remoteCallCount += 1;
            return { status: 0, stdout: '', stderr: '' };
          },
          copyLocalDirectoryToRemote: async () => undefined,
          preparePayload: async () => ({
            componentId: 'happier-cli',
            channel: 'preview',
            versionId,
            payloadRoot: fixture.payloadRoot,
            source: null,
            cleanup: async () => undefined,
          }),
          now: () => 123,
        },
      )).rejects.toThrow(/unsafe remote path segment/i);

      expect(remoteCallCount).toBe(0);
    } finally {
      await fixture.cleanup();
    }
  });

  it.skipIf(process.platform === 'win32')('materializes symlinked payload entries before copying them over scp', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'happier-remote-first-party-payload-'));
    const capturedLocalPaths: string[] = [];

    try {
      const externalTargetPath = join(rootDir, 'external-tool.js');
      const missingTargetPath = join(rootDir, 'missing-tool.js');
      const payloadRoot = join(rootDir, 'payload-root');
      const symlinkPath = join(payloadRoot, 'node_modules', '.bin', 'tool');
      const brokenSymlinkPath = join(payloadRoot, 'node_modules', '.bin', 'tool-broken');

      await writeFile(externalTargetPath, 'console.log("tool")\n', 'utf8');
      await mkdir(join(payloadRoot, 'node_modules', '.bin'), { recursive: true });
      await writeFile(join(payloadRoot, 'happier'), '#!/usr/bin/env bash\nexit 0\n', 'utf8');
      await symlink(externalTargetPath, symlinkPath);
      await symlink(missingTargetPath, brokenSymlinkPath);

      await installRemoteFirstPartyComponent(
        {
          componentId: 'happier-cli',
          channel: 'preview',
          ssh: {
            target: 'dev@example.test',
            auth: 'agent',
          },
        },
        {
          resolveRemoteReleaseTarget: async () => ({ os: 'linux', arch: 'x64' }),
          runRemoteText: async () => ({ status: 0, stdout: '', stderr: '' }),
          copyLocalDirectoryToRemote: async ({ localPath }) => {
            capturedLocalPaths.push(localPath);
            const stageInfo = await lstat(localPath);
            expect(stageInfo.isDirectory()).toBe(true);
            const extracted = await extractTarFixture({ archivePath: join(localPath, 'payload-root.tar') });
            try {
              const copiedSymlinkPath = join(extracted.extractRoot, 'payload-root', 'node_modules', '.bin', 'tool');
              const copiedBrokenSymlinkPath = join(extracted.extractRoot, 'payload-root', 'node_modules', '.bin', 'tool-broken');
              expect((await lstat(copiedSymlinkPath)).isSymbolicLink()).toBe(false);
              expect(await readFile(copiedSymlinkPath, 'utf8')).toBe('console.log("tool")\n');
              await expect(lstat(copiedBrokenSymlinkPath)).rejects.toThrow();
            } finally {
              await extracted.cleanup();
            }
          },
          preparePayload: async () => ({
            componentId: 'happier-cli',
            channel: 'preview',
            versionId: 'preview-1',
            payloadRoot,
            source: 'https://example.test/payload.tar.gz',
            cleanup: async () => undefined,
          }),
          now: () => 123,
        },
      );

      expect(capturedLocalPaths).toHaveLength(1);
      expect(capturedLocalPaths[0]).not.toBe(payloadRoot);
      await expect(lstat(capturedLocalPaths[0]!)).rejects.toThrow();
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')('drops dangling payload symlinks before copying them over scp', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'happier-remote-first-party-dangling-'));
    const capturedLocalPaths: string[] = [];

    try {
      const payloadRoot = join(rootDir, 'payload-root');
      const symlinkPath = join(payloadRoot, 'node_modules', '.bin', 'tool');

      await mkdir(join(payloadRoot, 'node_modules', '.bin'), { recursive: true });
      await writeFile(join(payloadRoot, 'happier'), '#!/usr/bin/env bash\nexit 0\n', 'utf8');
      await symlink('../missing-tool.js', symlinkPath);

      await installRemoteFirstPartyComponent(
        {
          componentId: 'happier-cli',
          channel: 'preview',
          ssh: {
            target: 'dev@example.test',
            auth: 'agent',
          },
        },
        {
          resolveRemoteReleaseTarget: async () => ({ os: 'linux', arch: 'x64' }),
          runRemoteText: async () => ({ status: 0, stdout: '', stderr: '' }),
          copyLocalDirectoryToRemote: async ({ localPath }) => {
            capturedLocalPaths.push(localPath);
            const extracted = await extractTarFixture({ archivePath: join(localPath, 'payload-root.tar') });
            try {
              await expect(lstat(join(extracted.extractRoot, 'payload-root', 'node_modules', '.bin', 'tool'))).rejects.toThrow();
            } finally {
              await extracted.cleanup();
            }
          },
          preparePayload: async () => ({
            componentId: 'happier-cli',
            channel: 'preview',
            versionId: 'preview-1',
            payloadRoot,
            source: 'https://example.test/payload.tar.gz',
            cleanup: async () => undefined,
          }),
          now: () => 123,
        },
      );

      expect(capturedLocalPaths).toHaveLength(1);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });
});
