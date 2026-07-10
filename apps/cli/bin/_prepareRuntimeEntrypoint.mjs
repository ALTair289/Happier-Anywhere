import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  resolveRuntimeEntrypoint,
  resolveValidRuntimeEntrypoint,
} from './_resolveRuntimeEntrypoint.mjs';
import { withOptionalCliSharedDepsBuildLock } from '../scripts/optionalWorkspaceBundleLock.mjs';

function resolveLocalRepoRoot(projectRoot) {
  const root = String(projectRoot ?? '').trim();
  if (!root) return null;

  const repoRoot = resolve(root, '..', '..');
  const syncModulePath = resolve(repoRoot, 'scripts', 'workspaces', 'syncBundledWorkspacePackages.mjs');
  return existsSync(syncModulePath) ? repoRoot : null;
}

async function buildLocalRuntimeSnapshot(projectRoot, repoRoot, opts) {
  const buildSharedDepsModulePath = resolve(projectRoot, 'scripts', 'buildSharedDeps.mjs');
  const buildModulePath = resolve(projectRoot, 'scripts', 'build.mjs');
  if (!existsSync(buildSharedDepsModulePath) || !existsSync(buildModulePath)) {
    throw new Error(`Cannot build missing CLI runtime snapshot under ${projectRoot}`);
  }

  const buildEnv = {
    ...(opts.env ?? process.env),
  };
  const lockPath = String(opts.lockPath ?? '').trim();
  if (lockPath) {
    buildEnv.HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD = resolve(lockPath);
  }

  const [{ main: buildSharedDeps }, { buildCliDist }] = await Promise.all([
    import(pathToFileURL(buildSharedDepsModulePath).href),
    import(pathToFileURL(buildModulePath).href),
  ]);
  await buildSharedDeps({ skipLock: true });
  await buildCliDist({
    packageRoot: projectRoot,
    repoRoot,
    lockPath: opts.lockPath,
    lockTimeoutMs: opts.lockTimeoutMs,
    lockPollIntervalMs: opts.lockPollIntervalMs,
    lockStaleAfterMs: opts.lockStaleAfterMs,
    skipLock: true,
    env: buildEnv,
  });
}

export async function prepareRuntimeEntrypoint(projectRoot, relativePath, opts = {}) {
  const repoRoot = resolveLocalRepoRoot(projectRoot);
  if (!repoRoot) {
    return resolveRuntimeEntrypoint(projectRoot, relativePath);
  }

  const readyEntrypoint = resolveValidRuntimeEntrypoint(projectRoot, relativePath);
  if (readyEntrypoint) {
    return readyEntrypoint;
  }

  return await withOptionalCliSharedDepsBuildLock(async () => {
    // A writer may have completed while this cold reader waited for the build lock.
    const concurrentlyBuiltEntrypoint = resolveValidRuntimeEntrypoint(projectRoot, relativePath);
    if (concurrentlyBuiltEntrypoint) {
      return concurrentlyBuiltEntrypoint;
    }

    await buildLocalRuntimeSnapshot(projectRoot, repoRoot, opts);
    const builtEntrypoint = resolveValidRuntimeEntrypoint(projectRoot, relativePath);
    if (!builtEntrypoint) {
      throw new Error(`CLI build completed without a valid runtime snapshot under ${projectRoot}`);
    }
    return builtEntrypoint;
  }, {
    startDir: projectRoot,
    repoRoot,
    lockPath: opts.lockPath,
    lockTimeoutMs: opts.lockTimeoutMs,
    lockPollIntervalMs: opts.lockPollIntervalMs,
    lockStaleAfterMs: opts.lockStaleAfterMs,
    env: opts.env,
  });
}
