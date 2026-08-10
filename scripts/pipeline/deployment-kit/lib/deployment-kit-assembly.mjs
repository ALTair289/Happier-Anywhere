// @ts-check

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readFile } from 'node:fs/promises';
import { posix, resolve, sep } from 'node:path';

import { materializeDeploymentKit } from './deployment-kit-integrity.mjs';
import { createDeploymentKitManifest } from './deployment-kit-manifest.mjs';

const MAX_CANONICAL_CHECKSUM_RECEIPT_BYTES = 1024 * 1024;

function safeSourcePath(value, artifactId) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`[deployment-kit] source path is required for ${artifactId}`);
  }
  if (
    value.includes('\\')
    || value.includes('\0')
    || value.startsWith('/')
    || /^[A-Za-z]:/.test(value)
  ) {
    throw new Error(`[deployment-kit] unsafe source path for ${artifactId}: ${value}`);
  }
  const normalized = posix.normalize(value);
  if (
    normalized !== value
    || normalized === '.'
    || normalized === '..'
    || normalized.startsWith('../')
  ) {
    throw new Error(`[deployment-kit] unsafe source path for ${artifactId}: ${value}`);
  }
  return normalized;
}

function resolveInside(root, relativePath) {
  const rootPath = resolve(root);
  const target = resolve(rootPath, ...relativePath.split('/'));
  if (target !== rootPath && !target.startsWith(`${rootPath}${sep}`)) {
    throw new Error(`[deployment-kit] source path escapes spec root: ${relativePath}`);
  }
  return target;
}

function assertSourceIdentities(manifest, sources) {
  if (!sources || typeof sources !== 'object' || Array.isArray(sources)) {
    throw new Error('[deployment-kit] source identities must match the manifest artifacts');
  }
  const expected = manifest.artifacts.map((artifact) => artifact.id).sort();
  const actual = Object.keys(sources).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error('[deployment-kit] source identities must match the manifest artifacts exactly');
  }
}

function normalizeCanonicalSourceDescriptor(value, artifactId) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`[deployment-kit] canonical archive checksum receipt is required for ${artifactId}`);
  }
  const keys = Object.keys(value).sort();
  if (JSON.stringify(keys) !== JSON.stringify(['archive', 'checksums'])) {
    throw new Error(`[deployment-kit] canonical archive checksum receipt is required for ${artifactId}`);
  }
  return {
    archive: safeSourcePath(value.archive, artifactId),
    checksums: safeSourcePath(value.checksums, `${artifactId} checksums`),
  };
}

export function canonicalArchiveIdentity(manifest, artifact) {
  const role = artifact.role;
  const product = role === 'controller' ? 'happier-server' : 'happier';
  const version = role === 'controller' ? manifest.compatibility.relay : manifest.compatibility.cli;
  const target = `${artifact.target.os}-${artifact.target.arch}`;
  return {
    archiveName: `${product}-v${version}-${target}.tar.gz`,
    checksumsName: `checksums-${product}-v${version}.txt`,
  };
}

function parseCanonicalChecksums(raw, artifactId) {
  const entries = new Map();
  for (const line of raw.split(/\r?\n/).filter(Boolean)) {
    const match = /^([a-f0-9]{64})  ([0-9A-Za-z][0-9A-Za-z._+-]*\.tar\.gz)$/.exec(line);
    if (!match || entries.has(match[2])) {
      throw new Error(`[deployment-kit] invalid canonical archive checksum receipt for ${artifactId}`);
    }
    entries.set(match[2], match[1]);
  }
  if (entries.size === 0) {
    throw new Error(`[deployment-kit] invalid canonical archive checksum receipt for ${artifactId}`);
  }
  return entries;
}

async function verifyCanonicalArchiveReceipt({
  manifest,
  artifact,
  descriptor,
  specRoot,
}) {
  const identity = canonicalArchiveIdentity(manifest, artifact);
  if (artifact.format !== 'tar.gz'
    || posix.basename(descriptor.archive) !== identity.archiveName
    || posix.basename(descriptor.checksums) !== identity.checksumsName) {
    throw new Error(`[deployment-kit] canonical archive identity mismatch for ${artifact.id}`);
  }

  const checksumsPath = resolveInside(specRoot, descriptor.checksums);
  const checksumsInfo = await lstat(checksumsPath);
  if (checksumsInfo.size <= 0 || checksumsInfo.size > MAX_CANONICAL_CHECKSUM_RECEIPT_BYTES) {
    throw new Error(`[deployment-kit] invalid canonical archive checksum receipt for ${artifact.id}`);
  }
  const entries = parseCanonicalChecksums(await readFile(checksumsPath, 'utf8'), artifact.id);
  if (entries.get(identity.archiveName) !== artifact.sha256) {
    throw new Error(`[deployment-kit] canonical archive checksum receipt mismatch for ${artifact.id}`);
  }
}

async function sha256File(path) {
  const hash = createHash('sha256');
  await new Promise((accept, reject) => {
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.once('error', reject);
    stream.once('end', accept);
  });
  return hash.digest('hex');
}

async function requireSpecRoot(specRoot) {
  const info = await lstat(specRoot).catch((error) => {
    throw new Error('[deployment-kit] spec root is not readable', { cause: error });
  });
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error('[deployment-kit] spec root must be a regular directory');
  }
}

async function requireUnlinkedSourcePath(specRoot, relativePath) {
  let current = resolve(specRoot);
  const segments = relativePath.split('/');
  for (let index = 0; index < segments.length; index += 1) {
    current = resolve(current, segments[index]);
    const info = await lstat(current).catch((error) => {
      throw new Error(`[deployment-kit] source path is not readable: ${relativePath}`, { cause: error });
    });
    if (info.isSymbolicLink()) {
      throw new Error(`[deployment-kit] source path contains a symbolic link or reparse point: ${relativePath}`);
    }
    if (index < segments.length - 1 && !info.isDirectory()) {
      throw new Error(`[deployment-kit] source path contains a non-directory component: ${relativePath}`);
    }
    if (index === segments.length - 1 && !info.isFile()) {
      throw new Error(`[deployment-kit] source artifact must be a regular file: ${relativePath}`);
    }
    if (index === segments.length - 1 && info.nlink !== 1) {
      throw new Error(`[deployment-kit] hard-linked source artifact is forbidden: ${relativePath}`);
    }
  }
}

export async function verifyDeploymentKitSpecSources({ spec, specRoot }) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
    throw new Error('[deployment-kit] assembly spec must be an object');
  }
  const requestedChannel = String(spec.manifest?.channel ?? '').trim().toLowerCase();
  if (requestedChannel !== 'local') {
    throw new Error('[deployment-kit] non-local assembly requires the signed release pipeline');
  }

  const manifest = createDeploymentKitManifest(spec.manifest);
  assertSourceIdentities(manifest, spec.sources);

  const normalizedSources = {};
  const relativeSources = {};
  for (const artifact of manifest.artifacts) {
    const descriptor = normalizeCanonicalSourceDescriptor(spec.sources[artifact.id], artifact.id);
    relativeSources[artifact.id] = descriptor;
    normalizedSources[artifact.id] = resolveInside(specRoot, descriptor.archive);
  }

  await requireSpecRoot(specRoot);
  const verifiedSources = [];
  for (const artifact of manifest.artifacts) {
    const descriptor = relativeSources[artifact.id];
    await requireUnlinkedSourcePath(specRoot, descriptor.archive);
    await requireUnlinkedSourcePath(specRoot, descriptor.checksums);
    await verifyCanonicalArchiveReceipt({ manifest, artifact, descriptor, specRoot });
    const archivePath = normalizedSources[artifact.id];
    const archiveInfo = await lstat(archivePath);
    const archiveSha256 = await sha256File(archivePath);
    if (archiveInfo.size !== artifact.size || archiveSha256 !== artifact.sha256) {
      throw new Error(`[deployment-kit] source artifact verification failed: ${artifact.id}`);
    }
    verifiedSources.push({
      artifactId: artifact.id,
      archivePath,
      archiveName: posix.basename(descriptor.archive),
      checksumsPath: resolveInside(specRoot, descriptor.checksums),
      checksumsName: posix.basename(descriptor.checksums),
    });
  }
  return {
    manifest,
    sourceArtifacts: normalizedSources,
    verifiedSources,
  };
}

export async function assembleDeploymentKitFromSpec({ spec, specRoot, outDir }) {
  const verified = await verifyDeploymentKitSpecSources({ spec, specRoot });
  const materialized = await materializeDeploymentKit({
    manifest: verified.manifest,
    sourceArtifacts: verified.sourceArtifacts,
    outDir,
  });
  return {
    channel: verified.manifest.channel,
    kitVersion: verified.manifest.kitVersion,
    artifactCount: verified.manifest.artifacts.length,
    outDir: materialized.outDir,
    treeSha256: materialized.treeSha256,
  };
}
