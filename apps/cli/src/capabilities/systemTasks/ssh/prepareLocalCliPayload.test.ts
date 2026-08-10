import { execFile } from 'node:child_process';
import { link, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import { prepareLocalCliPayload } from './prepareLocalCliPayload';

const cleanupRoots: string[] = [];
const execFileAsync = promisify(execFile);

async function createPayloadFixture(params: Readonly<{
  version?: string;
  os?: 'linux' | 'darwin';
  arch?: 'x64' | 'arm64';
  parentDirectoryName?: string;
}> = {}): Promise<string> {
  const scratchRoot = await mkdtemp(join(await realpath(tmpdir()), 'happier-local-cli-payload-'));
  cleanupRoots.push(scratchRoot);
  const payloadRoot = join(
    scratchRoot,
    ...(params.parentDirectoryName ? [params.parentDirectoryName] : []),
    `happier-v${params.version ?? '0.2.10'}-${params.os ?? 'linux'}-${params.arch ?? 'x64'}`,
  );
  await mkdir(join(payloadRoot, 'package-dist'), { recursive: true });
  await writeFile(join(payloadRoot, 'happier'), 'binary', 'utf8');
  await writeFile(join(payloadRoot, 'package-dist', 'index.mjs'), 'export {}\n', 'utf8');
  return payloadRoot;
}

afterEach(async () => {
  await Promise.all(cleanupRoots.splice(0).map(async (root) => {
    await rm(root, { recursive: true, force: true });
  }));
});
describe('prepareLocalCliPayload', () => {
  it('rejects relative payload roots instead of resolving them against ambient cwd', async () => {
    await expect(prepareLocalCliPayload({
      localPayloadRoot: 'happier-v0.2.10-linux-x64',
      componentId: 'happier-cli',
      channel: 'stable',
      os: 'linux',
      arch: 'x64',
    })).rejects.toThrow(/absolute path/i);
  });

  it('returns a private snapshot so later source mutations cannot change the canonical installer input', async () => {
    const payloadRoot = await createPayloadFixture();

    const prepared = await prepareLocalCliPayload({
      localPayloadRoot: payloadRoot,
      componentId: 'happier-cli',
      channel: 'stable',
      os: 'linux',
      arch: 'x64',
    });

    expect(prepared).toMatchObject({
      componentId: 'happier-cli',
      channel: 'stable',
      versionId: '0.2.10',
      source: null,
    });
    expect(prepared.payloadRoot).not.toBe(payloadRoot);
    expect(basename(prepared.payloadRoot)).toBe(basename(payloadRoot));
    expect(await readFile(join(prepared.payloadRoot, 'happier'), 'utf8')).toBe('binary');

    await writeFile(join(payloadRoot, 'happier'), 'tampered-after-validation', 'utf8');
    expect(await readFile(join(prepared.payloadRoot, 'happier'), 'utf8')).toBe('binary');

    const snapshotParent = dirname(prepared.payloadRoot);
    await expect(prepared.cleanup()).resolves.toBeUndefined();
    await expect(lstat(snapshotParent)).rejects.toThrow();
  });

  it('rejects payload metadata that does not match the detected remote target', async () => {
    const payloadRoot = await createPayloadFixture({ os: 'darwin', arch: 'arm64' });

    await expect(prepareLocalCliPayload({
      localPayloadRoot: payloadRoot,
      componentId: 'happier-cli',
      channel: 'stable',
      os: 'linux',
      arch: 'x64',
    })).rejects.toThrow(/does not match the remote target/i);
  });

  it('rejects a symlinked payload root before reading its contents', async () => {
    const targetRoot = await createPayloadFixture();
    const linkRoot = join(join(targetRoot, '..'), 'happier-v0.2.10-linux-x64-link');
    await symlink(targetRoot, linkRoot, 'junction');

    await expect(prepareLocalCliPayload({
      localPayloadRoot: linkRoot,
      componentId: 'happier-cli',
      channel: 'stable',
      os: 'linux',
      arch: 'x64',
    })).rejects.toThrow(/must not traverse symbolic links/i);
  });

  it('rejects a payload reached through a symlinked parent directory', async () => {
    const targetRoot = await createPayloadFixture({ parentDirectoryName: 'payload-parent-real' });
    const scratchRoot = join(targetRoot, '..', '..');
    const linkedParent = join(scratchRoot, 'payload-parent-link');
    await symlink(join(scratchRoot, 'payload-parent-real'), linkedParent, 'junction');

    await expect(prepareLocalCliPayload({
      localPayloadRoot: join(linkedParent, 'happier-v0.2.10-linux-x64'),
      componentId: 'happier-cli',
      channel: 'stable',
      os: 'linux',
      arch: 'x64',
    })).rejects.toThrow(/path must not traverse symbolic links/i);
  });

  it('rejects a symlinked CLI executable', async () => {
    const payloadRoot = await createPayloadFixture();
    const binaryPath = join(payloadRoot, 'happier');
    const realBinaryPath = join(payloadRoot, 'happier-real');
    await rm(binaryPath);
    await mkdir(realBinaryPath);
    await symlink(realBinaryPath, binaryPath, 'junction');

    await expect(prepareLocalCliPayload({
      localPayloadRoot: payloadRoot,
      componentId: 'happier-cli',
      channel: 'stable',
      os: 'linux',
      arch: 'x64',
    })).rejects.toThrow(/CLI executable must not be a symbolic link/i);
  });

  it('rejects incomplete payloads without the packaged runtime entrypoint', async () => {
    const payloadRoot = await createPayloadFixture();
    await rm(join(payloadRoot, 'package-dist', 'index.mjs'));

    await expect(prepareLocalCliPayload({
      localPayloadRoot: payloadRoot,
      componentId: 'happier-cli',
      channel: 'stable',
      os: 'linux',
      arch: 'x64',
    })).rejects.toThrow(/runtime entrypoint is missing/i);
  });

  it('rejects nested symlinks so SCP staging cannot materialize files outside the payload', async () => {
    const payloadRoot = await createPayloadFixture();
    const targetDir = join(payloadRoot, 'runtime-real');
    const nestedLink = join(payloadRoot, 'runtime-link');
    await mkdir(targetDir);
    await writeFile(join(targetDir, 'marker.txt'), 'safe', 'utf8');
    await symlink(targetDir, nestedLink, 'junction');

    await expect(prepareLocalCliPayload({
      localPayloadRoot: payloadRoot,
      componentId: 'happier-cli',
      channel: 'stable',
      os: 'linux',
      arch: 'x64',
    })).rejects.toThrow(/payload tree must not contain symbolic links/i);
  });

  it('rejects hard-linked regular files instead of snapshotting aliased content', async () => {
    const payloadRoot = await createPayloadFixture();
    await link(join(payloadRoot, 'happier'), join(payloadRoot, 'happier-hardlink'));

    await expect(prepareLocalCliPayload({
      localPayloadRoot: payloadRoot,
      componentId: 'happier-cli',
      channel: 'stable',
      os: 'linux',
      arch: 'x64',
    })).rejects.toThrow(/hard link/i);
  });

  it.skipIf(process.platform === 'win32')('rejects special filesystem entries', async () => {
    const payloadRoot = await createPayloadFixture();
    await execFileAsync('mkfifo', [join(payloadRoot, 'runtime.fifo')]);

    await expect(prepareLocalCliPayload({
      localPayloadRoot: payloadRoot,
      componentId: 'happier-cli',
      channel: 'stable',
      os: 'linux',
      arch: 'x64',
    })).rejects.toThrow(/only regular files and directories/i);
  });
});
