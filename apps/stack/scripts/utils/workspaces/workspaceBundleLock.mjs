import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

async function loadWorkspaceBundleLockModule() {
  try {
    return await import('@happier-dev/cli-common/workspaceBundleLock');
  } catch (packageImportError) {
    const sourceModulePath = resolve(
      dirname(fileURLToPath(import.meta.url)),
      '../../../../../packages/cli-common/workspaceBundleLock.mjs',
    );
    if (!existsSync(sourceModulePath)) return null;
    return await import(pathToFileURL(sourceModulePath).href);
  }
}

const workspaceBundleLock = await loadWorkspaceBundleLockModule();

function requireWorkspaceBundleLockModule() {
  if (workspaceBundleLock) return workspaceBundleLock;
  throw new Error('The canonical @happier-dev/cli-common workspace bundle lock is unavailable');
}

export function resolveWorkspaceBundleLockPath(options) {
  return requireWorkspaceBundleLockModule().resolveWorkspaceBundleLockPath(options);
}

export function isWorkspaceBundleLockActive(options) {
  return requireWorkspaceBundleLockModule().isWorkspaceBundleLockActive(options);
}

export function withWorkspaceBundleLock(fn, options) {
  return requireWorkspaceBundleLockModule().withWorkspaceBundleLock(fn, options);
}

export function withWorkspaceBundleLockSync(fn, options) {
  return requireWorkspaceBundleLockModule().withWorkspaceBundleLockSync(fn, options);
}
