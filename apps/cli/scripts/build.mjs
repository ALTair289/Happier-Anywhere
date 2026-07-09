import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { finalizeDist, readCliDistBuildManifestFingerprint } from './finalizeDist.mjs';
import { withOptionalCliSharedDepsBuildLock } from './optionalWorkspaceBundleLock.mjs';
import { main as rmDist } from './rmDist.mjs';
import { runPkgrollBuild } from './runPkgrollBuild.mjs';
import { syncPackageDist } from './syncPackageDist.mjs';

const require = createRequire(import.meta.url);

function resolveBuildOutputDir(env = process.env) {
  const raw = String(env?.HAPPIER_CLI_BUILD_OUTPUT_DIR ?? '').trim();
  if (raw) return raw;
  return `dist.staging.${process.pid}`;
}

function runNodeScript(scriptPath, args, options = {}) {
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: options.cwd,
    env: options.env,
    stdio: 'inherit',
  });
  if (typeof result.status === 'number' && result.status !== 0) {
    throw new Error(`${scriptPath} exited with status ${result.status}`);
  }
  if (result.error) {
    throw result.error;
  }
}

export async function buildCliDist(options = {}) {
  const packageRoot = resolve(String(options.packageRoot ?? process.cwd()));
  return await withOptionalCliSharedDepsBuildLock(
    () => buildCliDistUnlocked({ ...options, packageRoot }),
    {
      startDir: packageRoot,
      repoRoot: options.repoRoot,
      lockPath: options.lockPath,
      lockTimeoutMs: options.lockTimeoutMs,
      lockPollIntervalMs: options.lockPollIntervalMs,
      lockStaleAfterMs: options.lockStaleAfterMs,
      env: options.env,
    },
  );
}

async function buildCliDistUnlocked(options = {}) {
  const packageRoot = resolve(String(options.packageRoot ?? process.cwd()));
  const env = {
    ...process.env,
    ...(options.env ?? {}),
  };
  const outputDir = resolveBuildOutputDir(env);
  env.HAPPIER_CLI_BUILD_OUTPUT_DIR = outputDir;
  const expectedCurrentFingerprint = readCliDistBuildManifestFingerprint(join(packageRoot, 'dist'));
  const rmDistImpl = options.rmDistImpl ?? rmDist;
  const runTypecheckImpl = options.runTypecheckImpl ?? runNodeScript;
  const runPkgrollBuildImpl = options.runPkgrollBuildImpl ?? runPkgrollBuild;
  const finalizeDistImpl = options.finalizeDistImpl ?? finalizeDist;
  const syncPackageDistImpl = options.syncPackageDistImpl ?? syncPackageDist;

  await rmDistImpl(['node', 'rmDist.mjs', outputDir], {
    env,
    repoRoot: options.repoRoot,
    lockPath: options.lockPath,
    lockModulePath: options.lockModulePath,
    lockTimeoutMs: options.lockTimeoutMs,
    lockPollIntervalMs: options.lockPollIntervalMs,
    lockStaleAfterMs: options.lockStaleAfterMs,
    skipLock: true,
  });

  runTypecheckImpl(require.resolve('typescript/bin/tsc'), ['--noEmit'], {
    cwd: packageRoot,
    env,
  });
  runPkgrollBuildImpl({
    packageJsonPath: resolve(packageRoot, 'package.json'),
    outputDir,
    env,
  });
  finalizeDistImpl({
    packageRoot,
    stagingDir: resolve(packageRoot, outputDir),
    expectedCurrentFingerprint,
  });
  syncPackageDistImpl({
    packageRoot,
    distDir: resolve(packageRoot, 'dist'),
    env,
    skipLock: true,
  });
}

const invokedAsMain = (() => {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  return resolve(argv1) === resolve(fileURLToPath(import.meta.url));
})();

if (invokedAsMain) {
  try {
    await buildCliDist();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
