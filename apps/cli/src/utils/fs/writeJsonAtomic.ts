/**
 * Atomic JSON writer
 *
 * Used for updating runtime auth stores (OpenCode/Pi/Codex) so consumers never read a partially-written file.
 */

import { mkdir, rename, unlink, writeFile, chmod } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const ATOMIC_RENAME_MAX_ATTEMPTS = 3;
const ATOMIC_RENAME_RETRY_DELAY_MS = 5;

function isRetryableAtomicRenameConflict(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException)?.code;
  return code === 'EPERM' || code === 'EEXIST';
}

async function renameWithBoundedConflictRetry(sourcePath: string, destinationPath: string): Promise<void> {
  for (let attempt = 1; attempt <= ATOMIC_RENAME_MAX_ATTEMPTS; attempt += 1) {
    try {
      await rename(sourcePath, destinationPath);
      return;
    } catch (error) {
      if (!isRetryableAtomicRenameConflict(error) || attempt === ATOMIC_RENAME_MAX_ATTEMPTS) {
        throw error;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, ATOMIC_RENAME_RETRY_DELAY_MS));
    }
  }
}

async function bestEffortChmod0600(path: string): Promise<void> {
  if (process.platform === 'win32') return;
  await chmod(path, 0o600).catch(() => {});
}

export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });
  const tmpPath = join(dir, `.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  try {
    await writeFile(tmpPath, JSON.stringify(value, null, 2), { mode: 0o600 });
    await bestEffortChmod0600(tmpPath);
    await renameWithBoundedConflictRetry(tmpPath, path);
    await bestEffortChmod0600(path);
  } catch (error) {
    await unlink(tmpPath).catch(() => {});
    throw error;
  }
}
