export function collectInternalWorkspaceDependencyNames(pkgJson, currentPkgName = '') {
  const names = new Set();
  for (const source of [pkgJson?.dependencies, pkgJson?.optionalDependencies, pkgJson?.devDependencies]) {
    if (!source || typeof source !== 'object') continue;
    for (const name of Object.keys(source)) {
      if (!name.startsWith('@happier-dev/') || name === currentPkgName) continue;
      names.add(name);
    }
  }
  return Array.from(names);
}
