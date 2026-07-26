import { randomUUID } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { chmodSync, mkdirSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { readdir, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

const ATOMIC_RENAME_MAX_ATTEMPTS = 3;
const ATOMIC_RENAME_RETRY_DELAY_MS = 2;
const atomicRenameRetryWaitArray = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

function isRetryableAtomicRenameConflict(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException)?.code;
  return code === 'EPERM' || code === 'EEXIST';
}

function renameWithBoundedConflictRetrySync(sourcePath: string, destinationPath: string): void {
  for (let attempt = 1; attempt <= ATOMIC_RENAME_MAX_ATTEMPTS; attempt += 1) {
    try {
      renameSync(sourcePath, destinationPath);
      return;
    } catch (error) {
      if (!isRetryableAtomicRenameConflict(error) || attempt === ATOMIC_RENAME_MAX_ATTEMPTS) {
        throw error;
      }
      Atomics.wait(atomicRenameRetryWaitArray, 0, 0, ATOMIC_RENAME_RETRY_DELAY_MS);
    }
  }
}

function bestEffortChmod0600Sync(path: string): void {
  if (process.platform === 'win32') return;
  try {
    chmodSync(path, 0o600);
  } catch {
    // best-effort
  }
}

function isAtomicWriteTempFileName(fileName: string, path: string): boolean {
  const tempPrefix = `${basename(path)}.tmp`;
  return fileName === tempPrefix || fileName.startsWith(`${tempPrefix}-`);
}

function resolveAtomicWriteTempPath(path: string): string {
  return join(dirname(path), `${basename(path)}.tmp-${process.pid}-${randomUUID()}`);
}

export function writeJsonAtomicSync(path: string, value: unknown): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tmpPath = resolveAtomicWriteTempPath(path);
  try {
    writeFileSync(tmpPath, JSON.stringify(value, null, 2), { encoding: 'utf-8', mode: 0o600 });
    bestEffortChmod0600Sync(tmpPath);
    renameWithBoundedConflictRetrySync(tmpPath, path);
    bestEffortChmod0600Sync(path);
  } catch (error) {
    try {
      unlinkSync(tmpPath);
    } catch {
      // ignore cleanup failure
    }
    throw error;
  }
}

export function cleanupAtomicWriteTempFilesSync(path: string): void {
  const dir = dirname(path);
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !isAtomicWriteTempFileName(entry.name, path)) {
      continue;
    }
    try {
      unlinkSync(join(dir, entry.name));
    } catch {
      // best-effort
    }
  }
}

export async function cleanupAtomicWriteTempFiles(path: string): Promise<void> {
  const dir = dirname(path);
  let entries: Dirent<string>[];
  try {
    entries = await readdir(dir, { encoding: 'utf8', withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !isAtomicWriteTempFileName(entry.name, path)) {
      continue;
    }
    await unlink(join(dir, entry.name)).catch(() => {});
  }
}
