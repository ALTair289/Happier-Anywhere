import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { withWorkspaceBundleLock } from '../../../scripts/workspaces/workspaceBundleLock.mjs';
import { ensureWorkspacePackagesBuiltByName } from '../../../scripts/workspaces/ensureWorkspacePackagesBuilt.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

function findRepoRoot(startDir) {
  let dir = startDir;
  for (let i = 0; i < 10; i++) {
    if (existsSync(resolve(dir, 'package.json')) && existsSync(resolve(dir, 'yarn.lock'))) {
      return dir;
    }
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  return resolve(startDir, '..', '..', '..');
}

async function loadCliCommonWorkspacesModule(repoRoot, env = process.env) {
  const modulePath = resolve(repoRoot, 'packages', 'cli-common', 'dist', 'workspaces', 'index.js');
  if (!existsSync(modulePath)) {
    await ensureWorkspacePackagesBuiltByName(repoRoot, ['@happier-dev/cli-common'], {
      quiet: false,
      env,
    });
  }

  if (!existsSync(modulePath)) {
    throw new Error(`Missing cli-common workspaces build helpers: ${modulePath}`);
  }

  return await import(pathToFileURL(modulePath).href);
}

export async function bundleWorkspaceDeps(opts = {}) {
  const repoRoot = opts.repoRoot ?? findRepoRoot(__dirname);
  const relayDir = opts.relayDir ?? resolve(repoRoot, 'packages', 'relay-server');
  const lockPath = opts.lockPath ?? resolve(repoRoot, '.project', 'tmp', 'cli-shared-deps-build.lock');
  const baseEnv = opts.env ?? process.env;
  const ensureWorkspacePackagesBuiltByNameImpl = opts.ensureWorkspacePackagesBuiltByName
    ?? ensureWorkspacePackagesBuiltByName;

  return withWorkspaceBundleLock(async ({ heldLockValue }) => {
    const heldLockEnv = {
      ...baseEnv,
      HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD: heldLockValue,
    };
    delete heldLockEnv.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR;
    const {
      bundleWorkspacePackages,
      resolveWorkspaceBundlesFromPackageJson,
      vendorBundledPackageRuntimeDependencies,
    } = await loadCliCommonWorkspacesModule(repoRoot, heldLockEnv);

    const bundles = resolveWorkspaceBundlesFromPackageJson({
      repoRoot,
      hostPackageDir: relayDir,
    });
    await ensureWorkspacePackagesBuiltByNameImpl(
      repoRoot,
      [...new Set(bundles.map((bundle) => String(bundle?.packageName ?? bundle?.name ?? '').trim()).filter(Boolean))],
      { quiet: false, env: heldLockEnv },
    );

    bundleWorkspacePackages({ bundles });

    for (const b of bundles) {
      vendorBundledPackageRuntimeDependencies({
        srcPackageJsonPath: resolve(b.srcDir, 'package.json'),
        destPackageDir: b.destDir,
      });
    }
  }, {
    lockPath,
    heldLockValue: String(
      opts.heldLockValue
        ?? opts.heldLockPath
        ?? baseEnv?.HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD
        ?? '',
    ).trim(),
    timeoutMs: 240_000,
    pollIntervalMs: 250,
    staleAfterMs: 240_000,
  });
}

const invokedAsMain = (() => {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  return resolve(argv1) === fileURLToPath(import.meta.url);
})();

if (invokedAsMain) {
  try {
    await bundleWorkspaceDeps();
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
