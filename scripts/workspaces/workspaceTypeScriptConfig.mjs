import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

export function resolveWorkspaceDistTypeScriptConfigPath(
  packageDir,
  { existsSyncImpl = existsSync } = {},
) {
  const resolvedPackageDir = resolve(packageDir);
  const buildConfigPath = resolve(resolvedPackageDir, 'tsconfig.build.json');
  if (existsSyncImpl(buildConfigPath)) return buildConfigPath;
  return resolve(resolvedPackageDir, 'tsconfig.json');
}
