import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const CLI_DIST_BUILD_MANIFEST = '.build-manifest.json';

function runtimeEntrypointCandidates(projectRoot, relativePath) {
  return [
    { outputDir: join(projectRoot, 'dist'), entrypoint: join(projectRoot, 'dist', relativePath) },
    { outputDir: join(projectRoot, 'package-dist'), entrypoint: join(projectRoot, 'package-dist', relativePath) },
    {
      outputDir: join(projectRoot, '.dist.hstack-backup'),
      entrypoint: join(projectRoot, '.dist.hstack-backup', relativePath),
    },
  ];
}

export function readRuntimeSnapshotBuildManifest(entrypoint, outputDir) {
  if (!entrypoint || !existsSync(entrypoint)) {
    return null;
  }

  const manifestPath = join(outputDir ?? dirname(entrypoint), CLI_DIST_BUILD_MANIFEST);
  if (!existsSync(manifestPath)) {
    return null;
  }

  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const fingerprint = String(manifest?.fingerprint ?? '').trim();
    if (!/^[a-f0-9]{16}$/i.test(fingerprint)) {
      return null;
    }
    return manifest;
  } catch {
    return null;
  }
}

export function resolveValidRuntimeSnapshot(projectRoot, relativePath) {
  for (const candidate of runtimeEntrypointCandidates(projectRoot, relativePath)) {
    const manifest = readRuntimeSnapshotBuildManifest(candidate.entrypoint, candidate.outputDir);
    if (manifest) {
      return { ...candidate, manifest };
    }
  }
  return null;
}

export function resolveValidRuntimeEntrypoint(projectRoot, relativePath) {
  return resolveValidRuntimeSnapshot(projectRoot, relativePath)?.entrypoint ?? null;
}

export function resolveRuntimeEntrypoint(projectRoot, relativePath) {
  const validatedEntrypoint = resolveValidRuntimeEntrypoint(projectRoot, relativePath);
  if (validatedEntrypoint) {
    return validatedEntrypoint;
  }

  // Published packages created before the build-manifest corridor still resolve by entrypoint
  // presence. Repo-local callers require a validated snapshot in prepareRuntimeEntrypoint.
  for (const candidate of runtimeEntrypointCandidates(projectRoot, relativePath)) {
    if (existsSync(candidate.entrypoint)) {
      return candidate.entrypoint;
    }
  }

  return join(projectRoot, 'dist', relativePath);
}
