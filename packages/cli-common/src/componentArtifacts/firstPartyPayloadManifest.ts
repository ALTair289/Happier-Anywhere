import { createHash } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import { join } from 'node:path';

export const FIRST_PARTY_PAYLOAD_MANIFEST_FILE_NAME = '.happier-payload-manifest-v1';

export type FirstPartyPayloadContentManifest = Readonly<{
  formatVersion: 1;
  sha256: string;
  text: string;
  fileCount: number;
  directoryCount: number;
}>;

function compareNames(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertSafeManifestPathComponent(value: string): void {
  if (!value || /[\0\t\r\n]/u.test(value) || value === FIRST_PARTY_PAYLOAD_MANIFEST_FILE_NAME) {
    throw new Error('[first-party-payload-manifest] Payload paths contain a reserved or unsupported name.');
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

async function lstatStable(path: string): Promise<BigIntStats> {
  const info = await lstat(path, { bigint: true }).catch(() => null);
  if (!info) {
    throw new Error('[first-party-payload-manifest] Payload tree is missing, unreadable, or changed.');
  }
  return info;
}

function assertSupportedEntry(info: BigIntStats): void {
  if (info.isSymbolicLink()) {
    throw new Error('[first-party-payload-manifest] Payload tree must not contain symbolic links.');
  }
  if (!info.isDirectory() && !info.isFile()) {
    throw new Error('[first-party-payload-manifest] Payload tree may contain only directories and regular files.');
  }
  if (info.isFile() && info.nlink !== 1n) {
    throw new Error('[first-party-payload-manifest] Payload tree must not contain hard links.');
  }
}

async function hashStableRegularFile(path: string, before: BigIntStats): Promise<string> {
  const noFollowFlag = process.platform === 'win32' ? 0 : constants.O_NOFOLLOW;
  const handle = await open(path, constants.O_RDONLY | noFollowFlag).catch(() => null);
  if (!handle) {
    throw new Error('[first-party-payload-manifest] Payload file could not be opened without following links.');
  }
  try {
    const opened = await handle.stat({ bigint: true });
    assertSupportedEntry(opened);
    if (!opened.isFile() || !sameStableIdentity(before, opened)) {
      throw new Error('[first-party-payload-manifest] Payload file changed before hashing.');
    }

    const hash = createHash('sha256');
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      hash.update(chunk);
    }

    const afterHandle = await handle.stat({ bigint: true });
    const afterPath = await lstatStable(path);
    assertSupportedEntry(afterHandle);
    assertSupportedEntry(afterPath);
    if (!afterHandle.isFile()
      || !afterPath.isFile()
      || !sameStableIdentity(opened, afterHandle)
      || !sameStableIdentity(opened, afterPath)) {
      throw new Error('[first-party-payload-manifest] Payload file changed while hashing.');
    }
    return hash.digest('hex');
  } finally {
    await handle.close();
  }
}

export function normalizeFirstPartyPayloadSha256(value: unknown, label = 'payload SHA-256'): string {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(normalized)) {
    throw new Error(`[first-party-payload-manifest] Invalid ${label}; expected 64 hexadecimal characters.`);
  }
  return normalized;
}

export async function createFirstPartyPayloadContentManifest(
  payloadRoot: string,
): Promise<FirstPartyPayloadContentManifest> {
  const rootBefore = await lstatStable(payloadRoot);
  assertSupportedEntry(rootBefore);
  if (!rootBefore.isDirectory()) {
    throw new Error('[first-party-payload-manifest] Payload root must be a directory.');
  }

  const records: string[] = ['V\t1\t0\t.'];
  let fileCount = 0;
  let directoryCount = 0;

  const visitDirectory = async (directoryPath: string, relativeParent: string): Promise<void> => {
    const directoryBefore = await lstatStable(directoryPath);
    assertSupportedEntry(directoryBefore);
    if (!directoryBefore.isDirectory()) {
      throw new Error('[first-party-payload-manifest] Payload directory changed while hashing.');
    }
    const entryNames = await readdir(directoryPath).catch(() => null);
    if (!entryNames) {
      throw new Error('[first-party-payload-manifest] Payload directory is unreadable.');
    }
    entryNames.sort(compareNames);

    for (const entryName of entryNames) {
      assertSafeManifestPathComponent(entryName);
      const relativePath = relativeParent ? `${relativeParent}/${entryName}` : entryName;
      const entryPath = join(directoryPath, entryName);
      const before = await lstatStable(entryPath);
      assertSupportedEntry(before);
      if (before.isDirectory()) {
        directoryCount += 1;
        records.push(`D\t-\t0\t${relativePath}`);
        await visitDirectory(entryPath, relativePath);
      } else {
        const digest = await hashStableRegularFile(entryPath, before);
        fileCount += 1;
        records.push(`F\t${digest}\t${before.size.toString()}\t${relativePath}`);
      }
    }

    const directoryAfter = await lstatStable(directoryPath);
    if (!directoryAfter.isDirectory() || !sameStableIdentity(directoryBefore, directoryAfter)) {
      throw new Error('[first-party-payload-manifest] Payload directory changed while hashing.');
    }
  };

  await visitDirectory(payloadRoot, '');
  const rootAfter = await lstatStable(payloadRoot);
  if (!rootAfter.isDirectory() || !sameStableIdentity(rootBefore, rootAfter)) {
    throw new Error('[first-party-payload-manifest] Payload root changed while hashing.');
  }

  const text = `${records.join('\n')}\n`;
  return {
    formatVersion: 1,
    sha256: createHash('sha256').update(text, 'utf8').digest('hex'),
    text,
    fileCount,
    directoryCount,
  };
}
