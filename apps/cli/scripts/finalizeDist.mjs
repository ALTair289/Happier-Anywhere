import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { atomicPromoteDirectorySync, resolveCliPackageRoot } from './syncPackageDist.mjs';

export const CLI_DIST_BUILD_MANIFEST = '.build-manifest.json';
export const CLI_DIST_BUILD_MANIFEST_TOOL_VERSION = '1';

function extractRelativeMjsImportSpecifiers(source) {
  const specs = new Set();
  const patterns = [
    /(?:^|[^\w$])import\s+(?:[^'"]*?\s+from\s*)?['"]([^'"]+)['"]/gm,
    /(?:^|[^\w$])export\s+[^'"]*?\s+from\s*['"]([^'"]+)['"]/gm,
    /import\s*\(\s*['"]([^'"]+)['"]\s*\)/gm,
  ];
  for (const re of patterns) {
    for (const match of source.matchAll(re)) {
      const spec = String(match?.[1] ?? '').trim();
      if (!spec || !spec.startsWith('.') || !spec.endsWith('.mjs')) continue;
      specs.add(spec);
    }
  }
  return [...specs];
}

export function readCliDistClosure(entrypoint, maxFiles = 400) {
  const normalizedEntrypoint = String(entrypoint ?? '').trim();
  const missing = [];
  const reachableFiles = [];
  const seenFiles = new Set();
  const queue = normalizedEntrypoint ? [normalizedEntrypoint] : [];

  while (queue.length > 0 && reachableFiles.length < maxFiles) {
    const filePath = queue.shift();
    if (!filePath || seenFiles.has(filePath)) continue;
    seenFiles.add(filePath);
    reachableFiles.push(filePath);

    let source = '';
    try {
      source = readFileSync(filePath, 'utf-8');
    } catch {
      missing.push(filePath);
      continue;
    }

    for (const spec of extractRelativeMjsImportSpecifiers(source)) {
      const target = join(dirname(filePath), spec);
      if (!existsSync(target)) {
        missing.push(target);
        continue;
      }
      if (!seenFiles.has(target)) {
        queue.push(target);
      }
    }
  }

  return {
    files: [...new Set(reachableFiles)].sort(),
    missing: [...new Set(missing)].sort(),
  };
}

export function buildCliDistManifest(entrypoint, options = {}) {
  if (!entrypoint || !existsSync(entrypoint)) {
    throw new Error(`[finalize-dist] missing entrypoint: ${entrypoint}`);
  }
  const closure = readCliDistClosure(entrypoint, options.maxFiles);
  if (closure.missing.length > 0) {
    throw new Error(`[finalize-dist] incomplete dist import closure: ${closure.missing[0]}`);
  }

  const rootDir = dirname(resolve(entrypoint));
  const hash = createHash('sha256');
  for (const filePath of closure.files) {
    const stats = statSync(filePath);
    const source = readFileSync(filePath);
    hash.update(relative(rootDir, filePath).replace(/\\/g, '/'));
    hash.update('\0');
    hash.update(String(Number(stats.size) || 0));
    hash.update('\0');
    hash.update(source);
    hash.update('\0');
  }

  return {
    fingerprint: hash.digest('hex').slice(0, 16),
    builtAt: new Date().toISOString(),
    fileCount: closure.files.length,
    toolVersion: CLI_DIST_BUILD_MANIFEST_TOOL_VERSION,
  };
}

export function readCliDistBuildManifestFingerprint(distDir) {
  try {
    const manifestPath = join(resolve(String(distDir ?? '')), CLI_DIST_BUILD_MANIFEST);
    const parsed = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    const fingerprint = typeof parsed?.fingerprint === 'string' ? parsed.fingerprint.trim() : '';
    return fingerprint || null;
  } catch {
    return null;
  }
}

export function finalizeDist(options = {}) {
  const packageRoot = resolve(String(options.packageRoot ?? resolveCliPackageRoot()));
  const stagingDir = resolve(String(options.stagingDir ?? join(packageRoot, process.env.HAPPIER_CLI_BUILD_OUTPUT_DIR ?? 'dist.staging')));
  const distDir = resolve(String(options.distDir ?? join(packageRoot, 'dist')));
  const entrypoint = join(stagingDir, 'index.mjs');
  const manifest = buildCliDistManifest(entrypoint, options);
  writeFileSync(join(stagingDir, CLI_DIST_BUILD_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8');
  if (Object.prototype.hasOwnProperty.call(options, 'expectedCurrentFingerprint')) {
    const expected = options.expectedCurrentFingerprint ?? null;
    const current = readCliDistBuildManifestFingerprint(distDir);
    if (current !== expected) {
      throw new Error(
        `[finalize-dist] dist changed while this build was running (expected ${expected ?? 'none'}, found ${current ?? 'none'}); refusing to promote stale output.`,
      );
    }
  }

  const suffix = `${process.pid}.${Date.now()}`;
  atomicPromoteDirectorySync({
    sourceDir: stagingDir,
    targetDir: distDir,
    backupDir: `${distDir}.__finalize_backup__.${suffix}`,
    removeSourceOnFailure: false,
  });

  return {
    packageRoot,
    stagingDir,
    distDir,
    manifest,
  };
}

const invokedAsMain = (() => {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  return resolve(argv1) === resolve(fileURLToPath(import.meta.url));
})();

if (invokedAsMain) {
  try {
    finalizeDist({ stagingDir: process.argv[2] });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
