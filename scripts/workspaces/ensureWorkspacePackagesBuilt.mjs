import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';

import { buildIntoTempThenReplace } from '../../apps/stack/scripts/utils/fs/atomic_dir_swap.mjs';
import { withCliDistBuildLock } from '../../apps/stack/scripts/utils/proc/cliDistBuildLock.mjs';
import { collectInternalWorkspaceDependencyNames } from '../../apps/stack/scripts/utils/proc/workspace_dependencies.mjs';
import { coerceHappyMonorepoRootFromPath } from '../../apps/stack/scripts/utils/paths/paths.mjs';
import { resolveYarnCommandInvocation } from './execYarnCommand.mjs';
import { resolveWorkspacePackageBuildLockPath } from './workspacePackageBuildLock.mjs';

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf-8'));
}

function collectExpectedExportFileTargets(exportsField) {
  const out = [];
  const visit = (value) => {
    if (!value) return;
    if (typeof value === 'string') {
      out.push(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const nested of value) visit(nested);
      return;
    }
    if (typeof value === 'object') {
      for (const nested of Object.values(value)) visit(nested);
    }
  };
  visit(exportsField);
  return out;
}

function collectExpectedPackageFilesFromPackageJson(pkgJson) {
  const candidates = [];
  for (const key of ['main', 'module', 'types']) {
    const value = pkgJson?.[key];
    if (typeof value === 'string' && value.trim()) candidates.push(value.trim());
  }
  candidates.push(...collectExpectedExportFileTargets(pkgJson?.exports));

  return [...new Set(candidates)].filter((path) => {
    if (typeof path !== 'string') return false;
    const normalized = path.startsWith('./') ? path.slice(2) : path;
    return normalized === 'dist' || normalized.startsWith('dist/');
  });
}

function extractLocalImportSpecifiersFromJs(text) {
  const source = String(text ?? '');
  const out = new Set();
  const bareImport = /^\s*import\s+["'](\.\/[^"']+|\.\.\/[^"']+)["']/gm;
  for (;;) {
    const match = bareImport.exec(source);
    if (!match) break;
    const specifier = String(match[1] ?? '').trim();
    if (specifier) out.add(specifier);
  }

  const fromImport = /^\s*(?:import|export)\b[\s\w{},*]*?\bfrom\s+["'](\.\/[^"']+|\.\.\/[^"']+)["']/gm;
  for (;;) {
    const match = fromImport.exec(source);
    if (!match) break;
    const specifier = String(match[1] ?? '').trim();
    if (specifier) out.add(specifier);
  }
  return [...out];
}

async function assertNoMissingLocalImports({ distDir, entryPath, label = 'dist build' }) {
  const root = resolve(distDir);
  const visited = new Set();
  const queue = [resolve(entryPath)];
  const missing = [];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || visited.has(current)) continue;
    visited.add(current);

    let contents = '';
    try {
      contents = await readFile(current, 'utf-8');
    } catch {
      missing.push({ from: current, spec: '(unreadable)' });
      continue;
    }

    for (const specifier of extractLocalImportSpecifiersFromJs(contents)) {
      const resolvedImport = resolve(current, '..', specifier);
      if (!existsSync(resolvedImport)) {
        missing.push({ from: current, spec: specifier });
        continue;
      }
      if ((resolvedImport === root || resolvedImport.startsWith(root + sep)) && !visited.has(resolvedImport)) {
        queue.push(resolvedImport);
      }
    }

    if (visited.size > 5_000) {
      throw new Error(`[local] dist import graph too large while validating ${entryPath} (visited=${visited.size})`);
    }
  }

  if (missing.length > 0) {
    const preview = missing.slice(0, 8).map((item) => `- ${item.spec} (from ${item.from})`).join('\n');
    throw new Error(
      `[local] ${label} looks partial (missing local imports).\n`
      + `Entrypoint: ${entryPath}\n`
      + `Missing (${missing.length}):\n${preview}`,
    );
  }
}

function remapDistPathToDir(path, { pkgDir, distDir }) {
  const absolutePath = resolve(path);
  const realDistRoot = resolve(join(pkgDir, 'dist'));
  if (absolutePath === realDistRoot) return resolve(distDir);
  if (absolutePath.startsWith(realDistRoot + sep)) {
    return join(resolve(distDir), relative(realDistRoot, absolutePath));
  }
  return absolutePath;
}

function isWorkspaceBuildConfigFile(name) {
  if (name === 'package.json') return true;
  if (/^tsconfig(?:\.[^.]+)*\.json$/.test(name)) {
    return !/\.(?:test|tests|type-tests)\.json$/.test(name);
  }
  return /^(?:rollup|vite|esbuild|babel|swc|rspack|tsup|happier-plugin-ui)\.config\.(?:js|cjs|mjs|ts|json)$/.test(name);
}

async function readNewestWorkspaceBuildInputMtimeNs(pkgDir) {
  let newest = null;
  const visit = async (path) => {
    const name = path.split(sep).at(-1) ?? '';
    if (
      name === '__tests__'
      || name === 'test'
      || name === 'tests'
      || name === 'fixtures'
      || /\.(?:test|spec)\.[^.]+$/.test(name)
    ) {
      return;
    }
    let entryStat;
    try {
      entryStat = await lstat(path, { bigint: true });
    } catch {
      return;
    }
    if (entryStat.isDirectory()) {
      for (const childName of await readdir(path)) await visit(join(path, childName));
      return;
    }
    newest = newest === null || entryStat.mtimeNs > newest ? entryStat.mtimeNs : newest;
  };

  let entries = [];
  try {
    entries = await readdir(pkgDir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (
      (entry.isDirectory() && (entry.name === 'src' || entry.name === 'sources'))
      || (entry.isFile() && isWorkspaceBuildConfigFile(entry.name))
    ) {
      await visit(join(pkgDir, entry.name));
    }
  }
  return newest;
}

async function workspaceOutputsAreFresh(pkgDir, distDir) {
  const newestInput = await readNewestWorkspaceBuildInputMtimeNs(pkgDir);
  if (newestInput === null) return true;
  try {
    const distStat = await lstat(distDir, { bigint: true });
    return distStat.isDirectory() && distStat.mtimeNs >= newestInput;
  } catch {
    return false;
  }
}

async function inspectWorkspacePackageOutput(pkgDir, pkgJson) {
  const expectedFiles = collectExpectedPackageFilesFromPackageJson(pkgJson).map((path) => join(pkgDir, path));
  const missing = expectedFiles.filter((path) => !existsSync(path));
  const distDir = join(pkgDir, 'dist');
  const distRoot = resolve(distDir);
  const distEntrypoints = expectedFiles
    .filter((path) => /\.(?:mjs|cjs|js)$/.test(path))
    .filter((path) => {
      const absolutePath = resolve(path);
      return absolutePath === distRoot || absolutePath.startsWith(distRoot + sep);
    });
  const label = pkgJson?.name ? `${pkgJson.name} dist build` : 'dist build';

  if (missing.length === 0 && await workspaceOutputsAreFresh(pkgDir, distDir)) {
    try {
      for (const entryPath of distEntrypoints) {
        await assertNoMissingLocalImports({ distDir, entryPath, label });
      }
      return { complete: true, expectedFiles, missing, distDir, distEntrypoints, label };
    } catch {
      // A partial import graph is stale even when every package.json target exists.
    }
  }
  return { complete: false, expectedFiles, missing, distDir, distEntrypoints, label };
}

function prepareWorkspaceBuildEnv(pkgDir, envIn) {
  const env = { ...(envIn && typeof envIn === 'object' ? envIn : process.env) };
  env.REDISMS_DISABLE_POSTINSTALL ??= '1';
  const tsconfigPath = join(pkgDir, 'tsconfig.json');
  if (existsSync(tsconfigPath)) env.TSX_TSCONFIG_PATH = tsconfigPath;
  else delete env.TSX_TSCONFIG_PATH;
  return env;
}

async function runYarn(args, { cwd, env, quiet, input = null }) {
  const invocation = resolveYarnCommandInvocation(args, { npmExecPath: '' });
  const outputMode = quiet ? 'ignore' : 'inherit';
  const stdio = input === null ? outputMode : ['pipe', outputMode, outputMode];
  await new Promise((resolvePromise, reject) => {
    const child = spawn(invocation.command, invocation.args, {
      cwd,
      env,
      stdio,
      ...(invocation.windowsVerbatimArguments
        ? { windowsVerbatimArguments: invocation.windowsVerbatimArguments }
        : {}),
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      reject(new Error(
        `Yarn exited unsuccessfully (code=${code ?? 'null'}, signal=${signal ?? 'null'})`,
      ));
    });
    if (input !== null) child.stdin?.end(input);
  });
}

async function runWorkspacePackageBuild(pkgDir, { env, quiet }) {
  try {
    await runYarn(['--version'], {
      cwd: pkgDir,
      env,
      input: 'y\n',
      quiet,
    });
  } catch {
    throw new Error(`[local] yarn is required for component at ${pkgDir}. Install it via Corepack: \`corepack enable\``);
  }
  await runYarn(['-s', 'build'], {
    cwd: pkgDir,
    env,
    quiet,
  });
}

const defaultWorkspaceBuildBoundary = {
  prepareEnv: async (pkgDir, env) => prepareWorkspaceBuildEnv(pkgDir, env),
  runPackageBuild: runWorkspacePackageBuild,
};

async function ensureWorkspacePackageBuiltUnderLock({
  pkgDir,
  pkgJsonPath,
  quiet,
  env,
  heldLockValue,
  workspaceBuildBoundary,
}) {
  const pkgJson = await readJson(pkgJsonPath);
  const state = await inspectWorkspacePackageOutput(pkgDir, pkgJson);
  const {
    expectedFiles,
    missing: missingBefore,
    distDir,
    distEntrypoints,
    label,
  } = state;
  if (expectedFiles.length === 0) return { built: false, reason: 'no-expected-files' };
  if (state.complete) return { built: false, reason: 'already-built' };

  if (!pkgJson?.scripts?.build) {
    throw new Error(
      `[local] missing build outputs for ${pkgJson?.name ?? pkgDir}:\n`
      + missingBefore.map((path) => `- ${path}`).join('\n')
      + '\nFix: add a build script, or ensure the package does not export dist/* paths.',
    );
  }

  await buildIntoTempThenReplace(distDir, async (tmpDistDir) => {
    const buildEnv = {
      ...env,
      HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD: heldLockValue,
      HAPPIER_WORKSPACE_DIST_OUTPUT_DIR: tmpDistDir,
    };
    await workspaceBuildBoundary.runPackageBuild(pkgDir, { env: buildEnv, quiet });

    const stagedExpectedFiles = expectedFiles.map((path) => remapDistPathToDir(path, {
      pkgDir,
      distDir: tmpDistDir,
    }));
    const missingStaged = stagedExpectedFiles.filter((path) => !existsSync(path));
    if (missingStaged.length > 0) {
      throw new Error(
        `[local] build completed but expected staged outputs are still missing for ${pkgJson?.name ?? pkgDir}:\n`
        + missingStaged.map((path) => `- ${path}`).join('\n')
        + '\nFix: ensure the package build honors HAPPIER_WORKSPACE_DIST_OUTPUT_DIR or generates the files referenced by package.json exports/main/types.',
      );
    }

    for (const entryPath of distEntrypoints) {
      await assertNoMissingLocalImports({
        distDir: tmpDistDir,
        entryPath: remapDistPathToDir(entryPath, { pkgDir, distDir: tmpDistDir }),
        label,
      });
    }
  });

  return { built: true, reason: 'rebuilt' };
}

async function ensureWorkspacePackageBuilt(pkgDir, {
  quiet,
  env: envIn,
  workspaceBuildBoundary,
}) {
  const pkgJsonPath = join(pkgDir, 'package.json');
  if (!existsSync(pkgJsonPath)) return { built: false, reason: 'missing-package-json' };

  const pkgJson = await readJson(pkgJsonPath);
  const initial = await inspectWorkspacePackageOutput(pkgDir, pkgJson);
  if (initial.expectedFiles.length === 0) return { built: false, reason: 'no-expected-files' };
  if (initial.complete) return { built: false, reason: 'already-built' };

  const env = await workspaceBuildBoundary.prepareEnv(pkgDir, envIn);
  const lockPath = resolveWorkspacePackageBuildLockPath(pkgDir, pkgJson);
  return await withCliDistBuildLock(
    ({ heldLockValue }) => ensureWorkspacePackageBuiltUnderLock({
      pkgDir,
      pkgJsonPath,
      quiet,
      env,
      heldLockValue,
      workspaceBuildBoundary,
    }),
    { lockPath },
  );
}

async function ensureWorkspacePackageNamesBuilt(monorepoRoot, packageNames, {
  quiet,
  env,
  visitedNames = [],
  workspaceBuildBoundary,
}) {
  const built = [];
  const visited = new Set(visitedNames);
  const buildWorkspaceClosure = async (pkgDir) => {
    const pkgJsonPath = join(pkgDir, 'package.json');
    if (!existsSync(pkgJsonPath)) return;

    const pkgJson = await readJson(pkgJsonPath);
    const pkgName = typeof pkgJson?.name === 'string' ? pkgJson.name : '';
    if (pkgName && visited.has(pkgName)) return;
    if (pkgName) visited.add(pkgName);

    for (const depName of collectInternalWorkspaceDependencyNames(pkgJson, pkgName)) {
      const depId = String(depName).split('/')[1] ?? '';
      if (!depId) continue;
      const depDir = join(monorepoRoot, 'packages', depId);
      if (!existsSync(join(depDir, 'package.json'))) continue;
      await buildWorkspaceClosure(depDir);
    }

    const result = await ensureWorkspacePackageBuilt(pkgDir, {
      quiet,
      env,
      workspaceBuildBoundary,
    });
    if (result.built && pkgName) built.push(pkgName);
  };

  for (const packageName of packageNames ?? []) {
    const packageId = String(packageName).split('/')[1] ?? '';
    if (!packageId) continue;
    const pkgDir = join(monorepoRoot, 'packages', packageId);
    if (!existsSync(join(pkgDir, 'package.json'))) continue;
    await buildWorkspaceClosure(pkgDir);
  }

  return built;
}

export async function ensureWorkspacePackagesBuiltByName(monorepoPath, packageNames, {
  quiet = false,
  env = process.env,
  workspaceBuildBoundary = defaultWorkspaceBuildBoundary,
} = {}) {
  const monorepoRoot = coerceHappyMonorepoRootFromPath(monorepoPath);
  if (!monorepoRoot) return { ok: true, built: [], skipped: ['not-monorepo'] };

  const built = await ensureWorkspacePackageNamesBuilt(monorepoRoot, packageNames, {
    quiet,
    env,
    workspaceBuildBoundary,
  });
  return { ok: true, built, skipped: [] };
}

export async function ensureWorkspacePackagesBuiltForComponent(componentDir, {
  quiet = false,
  env = process.env,
  workspaceBuildBoundary = defaultWorkspaceBuildBoundary,
} = {}) {
  const monorepoRoot = coerceHappyMonorepoRootFromPath(componentDir);
  if (!monorepoRoot) return { ok: true, built: [], skipped: ['not-monorepo'] };

  const componentPkgPath = join(componentDir, 'package.json');
  if (!existsSync(componentPkgPath)) {
    return { ok: true, built: [], skipped: ['missing-component-package-json'] };
  }

  const componentPkg = await readJson(componentPkgPath);
  const componentName = typeof componentPkg?.name === 'string' ? componentPkg.name : '';
  const packageNames = collectInternalWorkspaceDependencyNames(componentPkg, componentName);
  const built = await ensureWorkspacePackageNamesBuilt(monorepoRoot, packageNames, {
    quiet,
    env,
    visitedNames: [componentName].filter(Boolean),
    workspaceBuildBoundary,
  });
  return { ok: true, built, skipped: [] };
}
