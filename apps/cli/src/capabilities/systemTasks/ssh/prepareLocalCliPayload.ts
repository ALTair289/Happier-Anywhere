import { constants, createWriteStream, type BigIntStats } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, open, readdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, parse, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';

import {
  getFirstPartyComponentCatalogEntry,
  type FirstPartyComponentId,
  type PreparedFirstPartyComponentPayload,
} from '@happier-dev/cli-common/firstPartyRuntime';
import {
  createFirstPartyPayloadContentManifest,
  normalizeFirstPartyPayloadSha256,
} from '@happier-dev/cli-common/componentArtifacts';
import type { PublicReleaseRingId } from '@happier-dev/release-runtime/releaseRings';

import { expandHomeDirPath } from '@/utils/path/expandHomeDirPath';

type RemotePayloadTarget = Readonly<{
  os: 'linux' | 'darwin';
  arch: 'x64' | 'arm64';
}>;

type PayloadRootMetadata = RemotePayloadTarget & Readonly<{
  versionId: string;
}>;

const PAYLOAD_ROOT_NAME_PATTERN = /^happier-v([A-Za-z0-9][A-Za-z0-9._-]{0,127})-(linux|darwin)-(x64|arm64)$/u;

function parsePayloadRootMetadata(payloadRoot: string): PayloadRootMetadata {
  const match = PAYLOAD_ROOT_NAME_PATTERN.exec(basename(payloadRoot));
  if (!match) {
    throw new Error(
      '[local-cli-payload] Payload root name must match happier-v<version>-<linux|darwin>-<x64|arm64>.',
    );
  }
  return {
    versionId: match[1]!,
    os: match[2] as RemotePayloadTarget['os'],
    arch: match[3] as RemotePayloadTarget['arch'],
  };
}
async function requirePayloadEntry(params: Readonly<{
  path: string;
  label: string;
  expectedType: 'directory' | 'file';
}>): Promise<void> {
  const info = await lstat(params.path).catch(() => null);
  if (!info) {
    throw new Error(`[local-cli-payload] ${params.label} is missing or unreadable.`);
  }
  if (info.isSymbolicLink()) {
    throw new Error(`[local-cli-payload] ${params.label} must not be a symbolic link.`);
  }
  if (params.expectedType === 'directory' && !info.isDirectory()) {
    throw new Error(`[local-cli-payload] ${params.label} must be a directory.`);
  }
  if (params.expectedType === 'file' && (!info.isFile() || info.size <= 0)) {
    throw new Error(`[local-cli-payload] ${params.label} must be a non-empty regular file.`);
  }
}

async function assertPayloadPathDoesNotTraverseLinks(payloadRoot: string): Promise<void> {
  if (process.platform === 'win32' && payloadRoot.startsWith('\\\\')) {
    throw new Error('[local-cli-payload] Payload root must be on a local filesystem path.');
  }

  const parsedPath = parse(payloadRoot);
  if (!parsedPath.root) {
    throw new Error('[local-cli-payload] Payload root must resolve to an absolute path.');
  }
  const components = payloadRoot
    .slice(parsedPath.root.length)
    .split(sep)
    .filter((component) => component.length > 0);
  const pathsToInspect = [
    parsedPath.root,
    ...components.map((_, index) => join(parsedPath.root, ...components.slice(0, index + 1))),
  ];

  for (const [index, componentPath] of pathsToInspect.entries()) {
    const info = await lstat(componentPath).catch(() => null);
    if (!info) {
      throw new Error('[local-cli-payload] Payload path is missing or unreadable.');
    }
    if (info.isSymbolicLink()) {
      throw new Error('[local-cli-payload] Payload path must not traverse symbolic links or junctions.');
    }
    if (index < pathsToInspect.length - 1 && !info.isDirectory()) {
      throw new Error('[local-cli-payload] Payload path parent components must be directories.');
    }
  }
}

function sameStableIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.nlink === right.nlink
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

async function lstatPayloadEntry(path: string): Promise<BigIntStats> {
  const info = await lstat(path, { bigint: true }).catch(() => null);
  if (!info) {
    throw new Error('[local-cli-payload] Payload tree changed or became unreadable while creating its snapshot.');
  }
  return info;
}

function assertSnapshotSourceType(info: BigIntStats): void {
  if (info.isSymbolicLink()) {
    throw new Error('[local-cli-payload] Payload tree must not contain symbolic links or junctions.');
  }
  if (!info.isFile() && !info.isDirectory()) {
    throw new Error('[local-cli-payload] Payload tree may contain only regular files and directories.');
  }
  if (info.isFile() && info.nlink !== 1n) {
    throw new Error('[local-cli-payload] Payload tree must not contain hard links.');
  }
}

async function copyPayloadEntryToSnapshot(sourcePath: string, snapshotPath: string): Promise<void> {
  const before = await lstatPayloadEntry(sourcePath);
  assertSnapshotSourceType(before);
  const mode = Number(before.mode & 0o777n);

  if (before.isDirectory()) {
    await mkdir(snapshotPath, { mode: 0o700 });
    const entryNames = await readdir(sourcePath).catch(() => null);
    if (!entryNames) {
      throw new Error('[local-cli-payload] Payload tree is unreadable.');
    }
    for (const entryName of entryNames) {
      await copyPayloadEntryToSnapshot(join(sourcePath, entryName), join(snapshotPath, entryName));
    }
    const after = await lstatPayloadEntry(sourcePath);
    if (!after.isDirectory() || !sameStableIdentity(before, after)) {
      throw new Error('[local-cli-payload] Payload tree changed while creating its snapshot.');
    }
    await chmod(snapshotPath, mode);
    return;
  }

  const noFollowFlag = process.platform === 'win32' ? 0 : constants.O_NOFOLLOW;
  const sourceHandle = await open(sourcePath, constants.O_RDONLY | noFollowFlag).catch(() => null);
  if (!sourceHandle) {
    throw new Error('[local-cli-payload] Payload file could not be opened without following links.');
  }
  try {
    const opened = await sourceHandle.stat({ bigint: true });
    assertSnapshotSourceType(opened);
    if (!opened.isFile() || !sameStableIdentity(before, opened)) {
      throw new Error('[local-cli-payload] Payload file changed before its snapshot was created.');
    }

    await pipeline(
      sourceHandle.createReadStream({ autoClose: false }),
      createWriteStream(snapshotPath, { flags: 'wx', mode }),
    );

    const afterHandle = await sourceHandle.stat({ bigint: true });
    const afterPath = await lstatPayloadEntry(sourcePath);
    assertSnapshotSourceType(afterHandle);
    assertSnapshotSourceType(afterPath);
    if (!afterHandle.isFile()
      || !afterPath.isFile()
      || !sameStableIdentity(opened, afterHandle)
      || !sameStableIdentity(opened, afterPath)) {
      throw new Error('[local-cli-payload] Payload file changed while its snapshot was created.');
    }
    await chmod(snapshotPath, mode);
  } finally {
    await sourceHandle.close();
  }
}

async function createPrivatePayloadSnapshot(payloadRoot: string): Promise<Readonly<{
  payloadRoot: string;
  cleanup: () => Promise<void>;
}>> {
  const canonicalTempRoot = await realpath(tmpdir());
  const snapshotParent = await mkdtemp(join(canonicalTempRoot, 'happier-local-cli-snapshot-'));
  try {
    await chmod(snapshotParent, 0o700);
    const snapshotRoot = join(snapshotParent, basename(payloadRoot));
    await copyPayloadEntryToSnapshot(payloadRoot, snapshotRoot);
    return {
      payloadRoot: snapshotRoot,
      cleanup: async () => {
        await rm(snapshotParent, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await rm(snapshotParent, { recursive: true, force: true });
    throw error;
  }
}

export async function prepareLocalCliPayload(params: Readonly<{
  localPayloadRoot: string;
  componentId: FirstPartyComponentId;
  channel: PublicReleaseRingId;
  os: RemotePayloadTarget['os'];
  arch: RemotePayloadTarget['arch'];
  approvedSha256: string;
}>): Promise<PreparedFirstPartyComponentPayload> {
  if (params.componentId !== 'happier-cli') {
    throw new Error('[local-cli-payload] Local payload override is only supported for happier-cli.');
  }

  const expandedRoot = expandHomeDirPath(String(params.localPayloadRoot ?? '').trim(), process.env);
  if (!expandedRoot) {
    throw new Error('[local-cli-payload] Payload root is required.');
  }
  if (!isAbsolute(expandedRoot)) {
    throw new Error('[local-cli-payload] Payload root must be an absolute path.');
  }
  const payloadRoot = resolve(expandedRoot);
  await assertPayloadPathDoesNotTraverseLinks(payloadRoot);
  await requirePayloadEntry({
    path: payloadRoot,
    label: 'Payload root',
    expectedType: 'directory',
  });

  const metadata = parsePayloadRootMetadata(payloadRoot);
  if (metadata.os !== params.os || metadata.arch !== params.arch) {
    throw new Error('[local-cli-payload] Payload metadata does not match the remote target.');
  }

  const component = getFirstPartyComponentCatalogEntry(params.componentId);
  const runtimeEntrypoint = component.nodeEntrypointRelativePath;
  if (!runtimeEntrypoint) {
    throw new Error('[local-cli-payload] CLI runtime entrypoint metadata is missing.');
  }

  await requirePayloadEntry({
    path: join(payloadRoot, 'package-dist'),
    label: 'Packaged runtime directory',
    expectedType: 'directory',
  });
  await requirePayloadEntry({
    path: join(payloadRoot, ...component.binaryRelativePath.split('/')),
    label: 'CLI executable',
    expectedType: 'file',
  });
  await requirePayloadEntry({
    path: join(payloadRoot, ...runtimeEntrypoint.split('/')),
    label: 'Packaged runtime entrypoint',
    expectedType: 'file',
  });
  const snapshot = await createPrivatePayloadSnapshot(payloadRoot);
  try {
    await requirePayloadEntry({
      path: join(snapshot.payloadRoot, 'package-dist'),
      label: 'Snapshotted runtime directory',
      expectedType: 'directory',
    });
    await requirePayloadEntry({
      path: join(snapshot.payloadRoot, ...component.binaryRelativePath.split('/')),
      label: 'Snapshotted CLI executable',
      expectedType: 'file',
    });
    await requirePayloadEntry({
      path: join(snapshot.payloadRoot, ...runtimeEntrypoint.split('/')),
      label: 'Snapshotted runtime entrypoint',
      expectedType: 'file',
    });
    const approvedSha256 = normalizeFirstPartyPayloadSha256(
      params.approvedSha256,
      'approved local CLI payload SHA-256',
    );
    const manifest = await createFirstPartyPayloadContentManifest(snapshot.payloadRoot);
    if (manifest.sha256 !== approvedSha256) {
      throw new Error('[local-cli-payload] Snapshotted payload does not match the explicitly approved SHA-256.');
    }

    return {
      componentId: params.componentId,
      channel: params.channel,
      versionId: metadata.versionId,
      payloadRoot: snapshot.payloadRoot,
      source: `local-cli-payload:sha256:${approvedSha256}`,
      contentSha256: approvedSha256,
      cleanup: snapshot.cleanup,
    };
  } catch (error) {
    await snapshot.cleanup();
    throw error;
  }
}
