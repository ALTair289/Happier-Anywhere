import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { resolveTypeScriptCliPath } from '../../../scripts/workspaces/typescriptCommand.mjs';
import { syncBundledWorkspacePackages } from '../../../scripts/workspaces/syncBundledWorkspacePackages.mjs';
import { resolveBundledWorkspaceDependencyBuildOrder } from '../../../scripts/workspaces/resolveWorkspaceDependencyBuildOrder.mjs';
import {
  execYarn as execYarnCommand,
  resolveYarnInvocation as resolveYarnCommandInvocation,
} from '../../../scripts/workspaces/execYarnCommand.mjs';
import { withWorkspaceBundleLock } from '../../../scripts/workspaces/workspaceBundleLock.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

export async function withBuildSharedDepsLock(fn, options = {}) {
  const lockPath = options.lockPath ?? DEFAULT_BUILD_LOCK_PATH;
  return await withWorkspaceBundleLock(fn, { ...options, lockPath });
}

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
  // Fallback for older layouts (repoRoot/apps/cli/scripts).
  return resolve(startDir, '..', '..', '..');
}

const repoRoot = findRepoRoot(__dirname);
const DEFAULT_BUILD_LOCK_PATH = resolve(repoRoot, '.project', 'tmp', 'cli-dist-build.lock');

export function execYarn(args, options = {}) {
  return execYarnCommand(args, options);
}

export function resolveYarnInvocation(npmExecPath = process.env.npm_execpath, options = {}) {
  return resolveYarnCommandInvocation(npmExecPath, options);
}

async function loadCliCommonWorkspacesModule() {
  const modulePath = resolve(repoRoot, 'packages', 'cli-common', 'dist', 'workspaces', 'index.js');

  if (!existsSync(modulePath)) {
    for (const workspaceName of resolveCliBundledWorkspacePackageNames()) {
      execYarn(['-s', 'workspace', `@happier-dev/${workspaceName}`, 'build'], {
        cwd: repoRoot,
        stdio: 'inherit',
      });
      if (workspaceName === 'cli-common' && existsSync(modulePath)) {
        break;
      }
    }
  }

  if (!existsSync(modulePath)) {
    throw new Error(`Missing cli-common workspaces build helpers: ${modulePath}`);
  }

  return await import(pathToFileURL(modulePath).href);
}

const {
  bundleInstalledPackageWithRuntimeDependencies,
  resolveWorkspaceBundlesFromPackageJson,
  vendorBundledPackageRuntimeDependencies,
} = await loadCliCommonWorkspacesModule();
const CLI_BUNDLED_HOST_APPS = ['cli'];
function resolveCliBundledWorkspacePackageNames({ exists = existsSync } = {}) {
  return resolveBundledWorkspaceDependencyBuildOrder({
    repoRoot,
    hostPackageDir: resolve(repoRoot, 'apps', 'cli'),
    existsSync: exists,
  }).filter((workspaceName) => exists(resolve(repoRoot, 'packages', workspaceName, 'tsconfig.json')));
}

export function resolveTscBin({ exists, resolveTypeScriptCliPathImpl = resolveTypeScriptCliPath } = {}) {
  const existsImpl = exists ?? existsSync;
  const candidate = resolveTypeScriptCliPathImpl({ cwd: resolve(repoRoot, 'apps', 'cli') });
  if (!existsImpl(candidate)) {
    throw new Error(`Native TypeScript compiler entrypoint not found: ${candidate}`);
  }
  return candidate;
}

export function runTsc(tsconfigPath, opts) {
  const exec = opts?.execFileSync ?? execFileSync;
  const tsc = opts?.tscBin ?? resolveTscBin();
  try {
    // Execute the exported JavaScript entrypoint via the managed Node runtime on every platform.
    exec(process.execPath, [tsc, '-p', tsconfigPath], { stdio: 'inherit' });
  } catch (error) {
    const suffix = tsconfigPath ? ` (${tsconfigPath})` : '';
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to compile shared workspace deps${suffix}: ${message}`);
  }
}

export function syncBundledWorkspaceDist(opts = {}) {
  const repoRootArg = opts.repoRoot;
  const repoRoot = typeof repoRootArg === 'string' && repoRootArg.trim() ? repoRootArg : findRepoRoot(__dirname);
  syncBundledWorkspacePackages({
    repoRoot,
    hostApps: Array.isArray(opts.bundledHostApps) && opts.bundledHostApps.length > 0 ? opts.bundledHostApps : CLI_BUNDLED_HOST_APPS,
    existsSync: opts.existsSync,
    cpSync: opts.cpSync,
    mkdirSync: opts.mkdirSync,
    rmSync: opts.rmSync,
    readFileSync: opts.readFileSync,
    writeFileSync: opts.writeFileSync,
  });
}

export function syncCliRuntimeDependencies(opts = {}) {
  const repoRootArg = opts.repoRoot;
  const repoRoot = typeof repoRootArg === 'string' && repoRootArg.trim() ? repoRootArg : findRepoRoot(__dirname);
  const cliPackageJsonPath = resolve(repoRoot, 'apps', 'cli', 'package.json');
  const cliNodeModulesDir = resolve(repoRoot, 'apps', 'cli', 'node_modules');
  const cliRequire = createRequire(pathToFileURL(cliPackageJsonPath).href);
  const resolvedTweetnaclEntry = cliRequire.resolve('tweetnacl');
  const resolvedTweetnaclDir = dirname(resolvedTweetnaclEntry);

  if (resolvedTweetnaclDir === resolve(cliNodeModulesDir, 'tweetnacl')) {
    return;
  }

  bundleInstalledPackageWithRuntimeDependencies({
    packageName: 'tweetnacl',
    resolveFromPackageJsonPath: cliPackageJsonPath,
    destNodeModulesDir: cliNodeModulesDir,
  });
}

export function syncBundledWorkspaceRuntimeDependencies(opts = {}) {
  const repoRootArg = opts.repoRoot;
  const repoRoot = typeof repoRootArg === 'string' && repoRootArg.trim() ? repoRootArg : findRepoRoot(__dirname);
  const bundles = resolveWorkspaceBundlesFromPackageJson({
    repoRoot,
    hostPackageDir: resolve(repoRoot, 'apps', 'cli'),
  });

  for (const bundle of bundles) {
    vendorBundledPackageRuntimeDependencies({
      srcPackageJsonPath: resolve(bundle.srcDir, 'package.json'),
      destPackageDir: bundle.destDir,
    });
  }
}

export function main(options = {}) {
  const build = async () => {
    const bundledWorkspaceNames = resolveCliBundledWorkspacePackageNames();
    for (const name of bundledWorkspaceNames) {
      runTsc(resolve(repoRoot, 'packages', name, 'tsconfig.json'));
    }

    const protocolDist = resolve(repoRoot, 'packages', 'protocol', 'dist', 'index.js');
    if (!existsSync(protocolDist)) {
      throw new Error(`Expected @happier-dev/protocol build output missing: ${protocolDist}`);
    }

    // If the CLI currently has bundled workspace deps under apps/cli/node_modules,
    // keep their dist outputs in sync so local builds/tests do not consume stale artifacts.
    syncBundledWorkspaceDist({ repoRoot });
    syncBundledWorkspaceRuntimeDependencies({ repoRoot });
    syncCliRuntimeDependencies({ repoRoot });
  };

  if (options.skipLock === true) {
    return build();
  }
  return withBuildSharedDepsLock(build, options);
}

const invokedAsMain = (() => {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  return import.meta.url === pathToFileURL(argv1).href;
})();

if (invokedAsMain) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
