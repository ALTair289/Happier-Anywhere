#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { buildIntoTempThenReplace } from '../../apps/stack/scripts/utils/fs/atomic_dir_swap.mjs';
import { resolveTypeScriptCommandInvocation } from './typescriptCommand.mjs';
import { withWorkspaceBundleLock } from './workspaceBundleLock.mjs';
import { resolveWorkspacePackageBuildLockPath } from './workspacePackageBuildLock.mjs';

function rand() {
  return Math.random().toString(16).slice(2);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function collectTargetStrings(value, acc) {
  if (typeof value === 'string') {
    acc.push(value);
    return;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return;
  }
  for (const nested of Object.values(value)) {
    collectTargetStrings(nested, acc);
  }
}

function collectExpectedPackageTargets(packageJson) {
  const targets = [];
  for (const key of ['main', 'module', 'types']) {
    const value = packageJson?.[key];
    if (typeof value === 'string' && value.trim()) {
      targets.push(value.trim());
    }
  }
  collectTargetStrings(packageJson?.exports ?? {}, targets);
  return [...new Set(targets.map((target) => String(target).trim()).filter(Boolean))];
}

function resolveTargetPath({ packageDir, outputDir, target }) {
  const normalized = String(target ?? '').replace(/^\.\//, '');
  if (normalized === 'dist') {
    return outputDir;
  }
  if (normalized.startsWith('dist/')) {
    return join(outputDir, normalized.slice('dist/'.length));
  }
  return resolve(packageDir, normalized);
}

export function collectMissingPackageExportTargets({
  packageDir,
  outputDir,
  packageJson,
  existsSyncImpl = existsSync,
}) {
  return collectExpectedPackageTargets(packageJson)
    .filter((target) => target.startsWith('./') || target.startsWith('dist/'))
    .map((target) => ({
      target,
      path: resolveTargetPath({ packageDir, outputDir, target }),
    }))
    .filter(({ path }) => !existsSyncImpl(path));
}

export function verifyStagedPackageExportTargets({ packageDir, outputDir, packageJson, existsSyncImpl }) {
  const missing = collectMissingPackageExportTargets({ packageDir, outputDir, packageJson, existsSyncImpl });

  if (missing.length === 0) return;

  throw new Error(
    `Staged TypeScript package build is missing declared package export files:\n` +
      missing.map(({ target }) => `- ${target}`).join('\n'),
  );
}

function runChecked(command, args, options, runCommandImpl) {
  const result = runCommandImpl(command, args, options);
  if (result?.error) throw result.error;
  if ((result?.status ?? 0) !== 0) {
    throw new Error(`TypeScript package build failed with code ${result?.status ?? 'unknown'}`);
  }
}

function withOutputCompilerArgs(args, outputDir, tsBuildInfoFile) {
  return [
    ...args,
    '--outDir',
    outputDir,
    '--tsBuildInfoFile',
    tsBuildInfoFile,
  ];
}

export async function buildTypeScriptPackageDist({
  packageDir = process.cwd(),
  args = process.argv.slice(2),
  outputDir = process.env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR,
  env = process.env,
  stdio = 'inherit',
  platform = process.platform,
  runCommandImpl = spawnSync,
  resolveTypeScriptCommandInvocationImpl = resolveTypeScriptCommandInvocation,
  validateStagedOutput,
  withWorkspaceBundleLockImpl = withWorkspaceBundleLock,
} = {}) {
  const resolvedPackageDir = resolve(packageDir);
  const packageJson = readJson(join(resolvedPackageDir, 'package.json'));
  const distDir = join(resolvedPackageDir, 'dist');
  const buildId = `${Date.now()}.${process.pid}.${rand()}`;
  const callerOwnedOutputDir = typeof outputDir === 'string' && outputDir.trim()
    ? resolve(outputDir)
    : null;
  const targetDistDir = callerOwnedOutputDir ?? distDir;
  const tsBuildInfoFile = join(resolvedPackageDir, `.tsbuildinfo.build.${buildId}`);
  const commandEnv = { ...process.env, ...env };

  const compileAndValidate = async (stagedDistDir, buildEnv = commandEnv) => {
    const invocation = resolveTypeScriptCommandInvocationImpl({
      cwd: resolvedPackageDir,
      args: withOutputCompilerArgs(Array.isArray(args) ? args : [], stagedDistDir, tsBuildInfoFile),
      processExecPath: process.execPath,
    });
    runChecked(
      invocation.command,
      invocation.args,
      {
        cwd: resolvedPackageDir,
        env: buildEnv,
        stdio,
        ...(invocation.windowsVerbatimArguments
          ? { windowsVerbatimArguments: invocation.windowsVerbatimArguments }
          : {}),
      },
      runCommandImpl,
    );

    verifyStagedPackageExportTargets({ packageDir: resolvedPackageDir, outputDir: stagedDistDir, packageJson });
    if (typeof validateStagedOutput === 'function') {
      await validateStagedOutput({ outputDir: stagedDistDir, packageDir: resolvedPackageDir, packageJson });
    }
  };

  try {
    if (callerOwnedOutputDir) {
      await compileAndValidate(callerOwnedOutputDir);
      return { outputDir: callerOwnedOutputDir, promoted: false };
    }
    const lockPath = resolveWorkspacePackageBuildLockPath(resolvedPackageDir, packageJson);
    return await withWorkspaceBundleLockImpl(
      async ({ heldLockValue }) => {
        await buildIntoTempThenReplace(
          distDir,
          (stagedDistDir) => compileAndValidate(stagedDistDir, {
            ...commandEnv,
            HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD: heldLockValue,
          }),
        );
        return { outputDir: distDir, promoted: true };
      },
      {
        lockPath,
        heldLockValue: commandEnv.HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD,
        errorLabel: `${packageJson?.name ?? resolvedPackageDir} workspace dist build lock`,
      },
    );
  } finally {
    await rm(tsBuildInfoFile, { force: true }).catch(() => {});
  }
}

export async function main() {
  await buildTypeScriptPackageDist();
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error(error?.stack || error);
    process.exit(1);
  });
}
