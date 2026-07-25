import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { collectInternalWorkspaceDependencyNames } from './workspace_dependencies.mjs';
import { isDevServerSharedRuntimePackageId } from '../dev/devReloadTargets.mjs';

export function collectHappyCliRuntimePackageDirs({
  cliDir,
  repoRoot = resolve(cliDir, '..', '..'),
  existsSyncImpl = existsSync,
  readFileSyncImpl = readFileSync,
  logger = console,
}) {
  const packageDirs = [];
  const visited = new Set();

  const visitPackage = (packageJsonPath) => {
    let pkgJson;
    try {
      pkgJson = JSON.parse(readFileSyncImpl(packageJsonPath, 'utf-8'));
    } catch (error) {
      logger.warn?.(
        `[local] watch: cannot read runtime dependency manifest ${packageJsonPath}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }

    const packageName = typeof pkgJson?.name === 'string' ? pkgJson.name : '';
    if (packageName) visited.add(packageName);
    for (const dependencyName of collectInternalWorkspaceDependencyNames(pkgJson, packageName)) {
      if (visited.has(dependencyName)) continue;
      visited.add(dependencyName);
      const packageId = dependencyName.split('/')[1] ?? '';
      const packageDir = join(repoRoot, 'packages', packageId);
      const dependencyManifest = join(packageDir, 'package.json');
      if (!packageId || !existsSyncImpl(dependencyManifest)) {
        logger.warn?.(`[local] watch: runtime dependency ${dependencyName} has no workspace manifest; it will not be watched.`);
        continue;
      }
      packageDirs.push({ id: packageId, dir: packageDir });
      visitPackage(dependencyManifest);
    }
  };

  visitPackage(join(cliDir, 'package.json'));
  return packageDirs;
}

export function resolveHappyCliRuntimeInputGroups({
  cliDir,
  existsSyncImpl = existsSync,
  readFileSyncImpl = readFileSync,
  logger = console,
} = {}) {
  const repoRoot = resolve(cliDir, '..', '..');
  const runtimePackages = collectHappyCliRuntimePackageDirs({
    cliDir,
    repoRoot,
    existsSyncImpl,
    readFileSyncImpl,
    logger,
  });
  const groups = [
    {
      id: 'daemon:cli',
      target: 'daemon',
      paths: [
        join(cliDir, 'src'),
        join(cliDir, 'bin'),
        join(cliDir, 'codex'),
        join(cliDir, 'scripts'),
        join(cliDir, 'package.json'),
        join(cliDir, 'tsconfig.json'),
        join(cliDir, 'tsconfig.build.json'),
        join(cliDir, 'pkgroll.config.mjs'),
      ],
    },
    {
      id: 'build:workspace',
      target: 'daemon',
      paths: [
        join(repoRoot, 'scripts', 'workspaces'),
        join(repoRoot, 'package.json'),
        join(repoRoot, 'yarn.lock'),
      ],
    },
    ...runtimePackages.map(({ id, dir }) => {
      const target = isDevServerSharedRuntimePackageId(id) ? 'shared' : 'daemon';
      return {
        id: `${target}:${id}`,
        target,
        paths: [
          join(dir, 'src'),
          join(dir, 'package.json'),
          join(dir, 'tsconfig.json'),
          join(dir, 'tsconfig.build.json'),
        ],
      };
    }),
  ];

  return groups
    .map((group) => ({ ...group, paths: group.paths.filter((path) => existsSyncImpl(path)) }))
    .filter((group) => group.paths.length > 0);
}

export function resolveHappyCliRuntimeInputPaths(options) {
  return resolveHappyCliRuntimeInputGroups(options).flatMap((group) => group.paths);
}
