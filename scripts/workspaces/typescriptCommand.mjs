import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';

const NATIVE_TYPESCRIPT_PACKAGE_JSON = '@typescript/native/package.json';

export function resolveTypeScriptCliPath({
  cwd = process.cwd(),
  requireResolver,
  readFileSyncImpl = readFileSync,
} = {}) {
  const baseDir = resolve(cwd);
  const resolver = typeof requireResolver === 'function'
    ? requireResolver
    : createRequire(import.meta.url).resolve;
  const packageJsonPath = resolver(NATIVE_TYPESCRIPT_PACKAGE_JSON, { paths: [baseDir] });
  const packageJson = JSON.parse(readFileSyncImpl(packageJsonPath, 'utf8'));
  const tscBin = packageJson?.bin?.tsc;
  if (typeof tscBin !== 'string' || !tscBin.trim()) {
    throw new Error(`${NATIVE_TYPESCRIPT_PACKAGE_JSON} does not declare a tsc binary`);
  }
  return resolve(dirname(packageJsonPath), tscBin);
}

export function resolveTypeScriptCommandInvocation({
  cwd = process.cwd(),
  args = [],
  processExecPath = process.execPath,
  requireResolver,
  readFileSyncImpl,
} = {}) {
  return {
    command: processExecPath,
    args: [
      resolveTypeScriptCliPath({ cwd, requireResolver, readFileSyncImpl }),
      ...args,
    ],
  };
}
