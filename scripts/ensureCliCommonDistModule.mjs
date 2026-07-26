import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

function resolveCliCommonDistModulePath(repoRoot, subpath) {
  return resolve(repoRoot, 'packages', 'cli-common', 'dist', subpath, 'index.js');
}

function resolveCliCommonBuildScriptPath(repoRoot) {
  return resolve(repoRoot, 'apps', 'cli', 'scripts', 'buildSharedDeps.mjs');
}

function runCliCommonBuild(repoRoot, exec = execFileSync) {
  exec(process.execPath, [resolveCliCommonBuildScriptPath(repoRoot), '--declarations'], {
    cwd: repoRoot,
    stdio: 'inherit',
  });
}

/**
 * Loads a built `@happier-dev/cli-common` dist submodule after canonical stale-only admission.
 * @param {{ repoRoot: string; subpath: string; execFileSync?: typeof execFileSync; importModule?: (url: string) => Promise<any>; }} options
 */
export async function loadCliCommonDistModule(options) {
  const repoRoot = String(options.repoRoot ?? '').trim();
  const subpath = String(options.subpath ?? '').trim();
  if (!repoRoot) throw new Error('[release] loadCliCommonDistModule requires repoRoot');
  if (!subpath) throw new Error('[release] loadCliCommonDistModule requires subpath');

  const exec = options.execFileSync ?? execFileSync;
  const importModule = options.importModule ?? ((url) => import(url));
  const modulePath = resolveCliCommonDistModulePath(repoRoot, subpath);

  const importOnce = async () => importModule(pathToFileURL(modulePath).href);

  runCliCommonBuild(repoRoot, exec);
  return await importOnce();
}

export function resolveCliCommonDistModulePathForTests(repoRoot, subpath) {
  return resolveCliCommonDistModulePath(repoRoot, subpath);
}
