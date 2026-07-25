import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { readFile, readdir, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildTypeScriptPackageDist } from '../../../scripts/workspaces/buildTypeScriptPackageDist.mjs';
import { resolveTypeScriptCommandInvocation } from '../../../scripts/workspaces/typescriptCommand.mjs';
import { resolveWorkspacePackageBuildLockPath } from '../../../scripts/workspaces/workspacePackageBuildLock.mjs';
import { withWorkspaceBundleLock } from '../workspaceBundleLock.mjs';

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function resolveCliCommonDistBuildLockPath(packageDir) {
  const resolvedPackageDir = resolve(packageDir);
  const packageJson = readJson(join(resolvedPackageDir, 'package.json'));
  return resolveWorkspacePackageBuildLockPath(resolvedPackageDir, packageJson);
}

function resolveTscBinaryArgs(tscArgs) {
  const args = Array.isArray(tscArgs) ? tscArgs : [];
  if (args[0] === '-s' && args[1] === 'tsc') return args.slice(2);
  if (args[0] === 'tsc') return args.slice(1);
  return args;
}

export function resolveCliCommonBuildTscInvocations({
  packageDir,
  tscArgs,
  resolveTypeScriptCommandInvocationImpl = resolveTypeScriptCommandInvocation,
} = {}) {
  if (typeof packageDir !== 'string' || !packageDir.trim()) {
    throw new Error('cli-common TypeScript compilation requires a package directory');
  }
  return [resolveTypeScriptCommandInvocationImpl({
    cwd: packageDir,
    args: resolveTscBinaryArgs(tscArgs),
    processExecPath: process.execPath,
  })];
}

const legacyBuildArtifactPattern = /^(?:\.dist\.(?:build|backup)\.|\.tsconfig\.build\.).+|^\.tsbuildinfo\.build\..+/;

async function reclaimStaleLegacyBuildArtifacts(packageDir, { staleAfterMs, nowMs }) {
  const entries = await readdir(packageDir, { withFileTypes: true });
  await Promise.all(entries.map(async (entry) => {
    if (!legacyBuildArtifactPattern.test(entry.name)) return;
    const path = join(packageDir, entry.name);
    const stats = await stat(path).catch(() => null);
    if (!stats || nowMs - stats.mtimeMs < staleAfterMs) return;
    await rm(path, { recursive: entry.isDirectory(), force: true });
  }));
}

async function validateCliCommonStagedOutput({ outputDir }) {
  const indexPath = join(outputDir, 'index.js');
  const marker = await readFile(indexPath, 'utf8').catch(() => '');
  if (!marker.trim()) {
    throw new Error('cli-common build produced an empty dist entrypoint: dist/index.js');
  }
}

export async function buildCliCommonDist(options = {}) {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const packageDir = resolve(options.packageDir ?? dirname(scriptsDir));
  const lockPath = options.lockPath ?? resolveCliCommonDistBuildLockPath(packageDir);
  const env = { ...process.env, ...(options.env ?? {}) };
  const outputDir = String(env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR ?? '').trim() || undefined;
  const runBuild = async ({ heldLockValue }) => {
    await reclaimStaleLegacyBuildArtifacts(packageDir, {
      staleAfterMs: options.staleArtifactAfterMs ?? 24 * 60 * 60 * 1_000,
      nowMs: options.nowMs ?? Date.now(),
    });
    return await buildTypeScriptPackageDist({
      packageDir,
      args: ['-p', 'tsconfig.build.json'],
      outputDir,
      env: {
        ...env,
        HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD: heldLockValue,
      },
      stdio: options.stdio ?? 'inherit',
      platform: options.platform ?? process.platform,
      runCommandImpl: options.runCommandImpl ?? spawnSync,
      resolveTypeScriptCommandInvocationImpl: options.resolveTypeScriptCommandInvocationImpl,
      validateStagedOutput: validateCliCommonStagedOutput,
    });
  };

  return await withWorkspaceBundleLock(runBuild, {
    lockPath,
    heldLockValue: env.HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD,
    timeoutMs: options.timeoutMs,
    pollIntervalMs: options.pollIntervalMs,
    staleAfterMs: options.staleAfterMs,
    errorLabel: 'cli-common workspace dist build lock',
  });
}

export async function main() {
  await buildCliCommonDist();
}

const isEntrypoint = (() => {
  const arg = typeof process.argv?.[1] === 'string' ? process.argv[1] : '';
  return arg.endsWith('/scripts/build.mjs') || arg.endsWith('\\scripts\\build.mjs');
})();

if (isEntrypoint) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
