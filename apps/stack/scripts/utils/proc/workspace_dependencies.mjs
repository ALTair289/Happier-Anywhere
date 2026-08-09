export function collectInternalWorkspaceDependencyNames(
  pkgJson,
  currentPkgName = '',
  { workspacePackageNames = null } = {},
) {
  const knownWorkspacePackageNames = workspacePackageNames
    ? new Set(workspacePackageNames)
    : null;
  const names = new Set();
  for (const source of [pkgJson?.dependencies, pkgJson?.optionalDependencies, pkgJson?.devDependencies]) {
    if (!source || typeof source !== 'object') continue;
    for (const name of Object.keys(source)) {
      const isInternalWorkspace = knownWorkspacePackageNames
        ? knownWorkspacePackageNames.has(name)
        : name.startsWith('@happier-dev/');
      if (!isInternalWorkspace || name === currentPkgName) continue;
      names.add(name);
    }
  }
  return Array.from(names);
}
