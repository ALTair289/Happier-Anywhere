import { mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { renameForPublication } from './atomic_rename.mjs';

function rand() {
  return Math.random().toString(16).slice(2);
}

export async function buildIntoTempThenReplace(
  targetDir,
  buildFn,
  {
    platform = process.platform,
    renameImpl,
    waitImpl,
  } = {},
) {
  const outDir = String(targetDir ?? '').trim();
  if (!outDir) throw new Error('[fs] buildIntoTempThenReplace: missing targetDir');
  if (typeof buildFn !== 'function') throw new Error('[fs] buildIntoTempThenReplace: buildFn must be a function');

  const parent = dirname(outDir);
  const tmpDir = join(parent, `.tmp.${Date.now()}.${process.pid}.${rand()}`);

  await rm(tmpDir, { recursive: true, force: true });
  await mkdir(tmpDir, { recursive: true });

  let backupDir = null;
  let preserveBackup = false;
  try {
    await buildFn(tmpDir);

    // Swap only after a successful build.
    backupDir = join(parent, `.backup.${Date.now()}.${process.pid}.${rand()}`);
    let hadExisting = false;
    try {
      await renameForPublication(outDir, backupDir, { platform, renameImpl, waitImpl });
      hadExisting = true;
    } catch (err) {
      if (err?.code !== 'ENOENT') throw err;
    }

    try {
      await renameForPublication(tmpDir, outDir, { platform, renameImpl, waitImpl });
    } catch (err) {
      if (hadExisting) {
        await renameForPublication(backupDir, outDir, { platform, renameImpl, waitImpl }).then(() => {
          backupDir = null;
        }).catch((restoreErr) => {
          preserveBackup = true;
          if (err && typeof err === 'object') err.restoreError = restoreErr;
        });
      }
      throw err;
    }

    if (hadExisting && backupDir) {
      await rm(backupDir, { recursive: true, force: true }).catch(() => {});
      backupDir = null;
    }
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    if (backupDir && !preserveBackup) {
      await rm(backupDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}
