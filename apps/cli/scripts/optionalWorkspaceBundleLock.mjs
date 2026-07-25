import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

async function loadWorkspaceBundleLockModule() {
  try {
    return await import('@happier-dev/cli-common/workspaceBundleLock');
  } catch (packageImportError) {
    const scriptDir = dirname(fileURLToPath(import.meta.url));
    const repoRoot = resolve(scriptDir, '..', '..', '..');
    const sourceModulePath = resolve(repoRoot, 'packages', 'cli-common', 'workspaceBundleLock.mjs');
    const isSourceCheckout = existsSync(resolve(repoRoot, 'package.json'))
      && existsSync(resolve(repoRoot, 'yarn.lock'))
      && existsSync(sourceModulePath);
    if (!isSourceCheckout) throw packageImportError;
    return await import(pathToFileURL(sourceModulePath).href);
  }
}

const workspaceBundleLock = await loadWorkspaceBundleLockModule();

const resolveWorkspaceBundleLockPath = workspaceBundleLock.resolveWorkspaceBundleLockPath;
export const withWorkspaceBundleLock = workspaceBundleLock.withWorkspaceBundleLock;
export const withWorkspaceBundleLockSync = workspaceBundleLock.withWorkspaceBundleLockSync;

export function findRepoRoot(startDir) {
  let dir = resolve(String(startDir ?? process.cwd()));
  for (let i = 0; i < 10; i++) {
    if (existsSync(resolve(dir, 'package.json')) && existsSync(resolve(dir, 'yarn.lock'))) {
      return dir;
    }
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  return resolve(String(startDir ?? process.cwd()), '..', '..');
}
export function resolveCliSharedDepsBuildLockPath(repoRoot) {
  return resolveWorkspaceBundleLockPath(repoRoot);
}

function resolveInheritedWorkspaceBundleLockValue(options) {
  const env = options.env ?? process.env;
  return String(
    options.heldLockValue
      ?? options.heldLockPath
      ?? env?.HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD
      ?? '',
  ).trim();
}

function resolveRepositoryWorkspaceBundleLockMarker(repoRoot) {
  const candidate = resolve(repoRoot, 'scripts', 'workspaces', 'workspaceBundleLock.mjs');
  return existsSync(candidate) ? candidate : null;
}

export async function withOptionalCliSharedDepsBuildLock(fn, options = {}) {
  if (options.skipLock === true) {
    return await fn();
  }
  const repoRoot = resolve(String(options.repoRoot ?? findRepoRoot(options.startDir)));
  const explicitLockPath = String(options.lockPath ?? '').trim();
  const lockModulePath = String(
    options.lockModulePath ?? resolveRepositoryWorkspaceBundleLockMarker(repoRoot) ?? '',
  ).trim();
  if (!explicitLockPath && (!lockModulePath || !existsSync(lockModulePath))) {
    return await fn();
  }

  const lockTimeoutMs = options.lockTimeoutMs ?? options.timeoutMs ?? 240_000;
  return await withWorkspaceBundleLock(fn, {
    lockPath: String(options.lockPath ?? resolveCliSharedDepsBuildLockPath(repoRoot)),
    heldLockValue: resolveInheritedWorkspaceBundleLockValue(options),
    timeoutMs: lockTimeoutMs,
    pollIntervalMs: options.lockPollIntervalMs ?? options.pollIntervalMs ?? 250,
    staleAfterMs: options.lockStaleAfterMs ?? options.staleAfterMs ?? lockTimeoutMs,
  });
}

export function withOptionalCliSharedDepsBuildLockSync(fn, options = {}) {
  if (options.skipLock === true) {
    return fn();
  }
  const repoRoot = resolve(String(options.repoRoot ?? findRepoRoot(options.startDir)));
  const explicitLockPath = String(options.lockPath ?? '').trim();
  const lockModulePath = String(
    options.lockModulePath ?? resolveRepositoryWorkspaceBundleLockMarker(repoRoot) ?? '',
  ).trim();
  if (!explicitLockPath && (!lockModulePath || !existsSync(lockModulePath))) {
    return fn();
  }

  const lockPath = explicitLockPath || resolveCliSharedDepsBuildLockPath(repoRoot);
  const timeoutMs = options.lockTimeoutMs ?? options.timeoutMs ?? 240_000;
  return withWorkspaceBundleLockSync(fn, {
    lockPath,
    heldLockValue: resolveInheritedWorkspaceBundleLockValue(options),
    timeoutMs,
    pollIntervalMs: options.lockPollIntervalMs ?? options.pollIntervalMs ?? 250,
    staleAfterMs: options.lockStaleAfterMs ?? options.staleAfterMs ?? timeoutMs,
  });
}
