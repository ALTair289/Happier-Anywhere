import { cpSync, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withOptionalCliSharedDepsBuildLockSync } from './optionalWorkspaceBundleLock.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WRITE_FS_OPTION_NAMES = ['cpSync', 'mkdirSync', 'renameSync', 'rmSync'];

export function resolveCliPackageRoot(scriptDir = __dirname) {
  return resolve(scriptDir, '..');
}

export function syncPackageDist(options = {}) {
  const packageRoot = resolve(String(options.packageRoot ?? resolveCliPackageRoot()));
  const env = options.env ?? process.env;
  if (String(env?.HAPPIER_CLI_SKIP_PACKAGE_DIST_SYNC ?? '').trim() === '1') {
    return { packageRoot, skipped: true };
  }
  return withOptionalCliSharedDepsBuildLockSync(() => syncPackageDistUnlocked({ ...options, packageRoot }), {
    startDir: packageRoot,
    repoRoot: options.repoRoot,
    lockPath: options.lockPath,
    lockModulePath: options.lockModulePath,
    lockTimeoutMs: options.lockTimeoutMs,
    lockPollIntervalMs: options.lockPollIntervalMs,
    lockStaleAfterMs: options.lockStaleAfterMs,
  });
}

function syncPackageDistUnlocked(options = {}) {
  const packageRoot = resolve(String(options.packageRoot ?? resolveCliPackageRoot()));
  const env = options.env ?? process.env;
  const distDir = resolve(String(options.distDir ?? resolve(packageRoot, env?.HAPPIER_CLI_BUILD_OUTPUT_DIR ?? 'dist')));
  const packageDistDir = resolve(String(options.packageDistDir ?? resolve(packageRoot, 'package-dist')));
  const exists = options.existsSync ?? existsSync;
  const { copy, makeDir, rename, remove } = resolveWriteFs(options);

  if (!exists(distDir)) {
    throw new Error(`[sync-package-dist] missing dist directory: ${distDir}`);
  }

  const suffix = `${process.pid}.${Date.now()}`;
  const stagingDir = `${packageDistDir}.__sync_tmp__.${suffix}`;
  const backupDir = `${packageDistDir}.__sync_backup__.${suffix}`;

  remove(stagingDir, { recursive: true, force: true });
  remove(backupDir, { recursive: true, force: true });
  makeDir(dirname(packageDistDir), { recursive: true });
  copy(distDir, stagingDir, { recursive: true });

  let movedExistingDir = false;
  try {
    if (exists(packageDistDir)) {
      rename(packageDistDir, backupDir);
      movedExistingDir = true;
    }
    rename(stagingDir, packageDistDir);
    if (movedExistingDir) {
      remove(backupDir, { recursive: true, force: true });
    }
  } catch (error) {
    remove(stagingDir, { recursive: true, force: true });
    if (movedExistingDir && exists(backupDir) && !exists(packageDistDir)) {
      rename(backupDir, packageDistDir);
    }
    throw error;
  }

  return {
    packageRoot,
    distDir,
    packageDistDir,
  };
}

function hasOwnOption(options, name) {
  return Object.prototype.hasOwnProperty.call(options, name);
}

function resolveWriteFs(options) {
  const injectedWriteNames = WRITE_FS_OPTION_NAMES.filter((name) => hasOwnOption(options, name));
  if (injectedWriteNames.length > 0 && injectedWriteNames.length < WRITE_FS_OPTION_NAMES.length) {
    const missingNames = WRITE_FS_OPTION_NAMES.filter((name) => !hasOwnOption(options, name)).join(', ');
    throw new Error(`[sync-package-dist] incomplete filesystem adapter; missing ${missingNames}`);
  }

  return {
    copy: options.cpSync ?? cpSync,
    makeDir: options.mkdirSync ?? mkdirSync,
    rename: options.renameSync ?? renameSync,
    remove: options.rmSync ?? rmSync,
  };
}

const invokedAsMain = (() => {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  return resolve(argv1) === resolve(fileURLToPath(import.meta.url));
})();

if (invokedAsMain) {
  try {
    syncPackageDist();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
