// @ts-check

import { createHash } from 'node:crypto';
import { lstat, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';

export const HAPPIER_NATIVE_RELEASE_MATRIX = Object.freeze([
  Object.freeze({ os: 'linux', arch: 'x64' }),
  Object.freeze({ os: 'linux', arch: 'arm64' }),
  Object.freeze({ os: 'darwin', arch: 'x64' }),
  Object.freeze({ os: 'darwin', arch: 'arm64' }),
  Object.freeze({ os: 'windows', arch: 'x64' }),
]);

const MATRIX_KEYS = HAPPIER_NATIVE_RELEASE_MATRIX.map(({ os, arch }) => `${os}-${arch}`);
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/;
const SAFE_NAME_PATTERN = /^[0-9A-Za-z][0-9A-Za-z._+-]*$/;

function fail(message) {
  throw new Error(`[release-evidence] ${message}`);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function jsonBytes(value, jsonLines = false) {
  return Buffer.from(jsonLines ? `${JSON.stringify(value)}\n` : `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function requireSafeName(value, label) {
  const normalized = String(value ?? '').trim();
  if (!SAFE_NAME_PATTERN.test(normalized)) fail(`${label} must be one safe non-empty segment`);
  return normalized;
}

function requirePlainStringRecord(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} is required`);
  const entries = Object.entries(value)
    .map(([key, entry]) => [requireSafeName(key, `${label} key`), String(entry ?? '').trim()])
    .sort(([left], [right]) => left.localeCompare(right, 'en'));
  if (entries.length === 0 || entries.some(([, entry]) => !entry)) fail(`${label} values must be non-empty strings`);
  return Object.fromEntries(entries);
}

function deterministicUuid(hex) {
  const bytes = Buffer.from(hex.slice(0, 32), 'hex');
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const value = bytes.toString('hex');
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

async function readRegularFile(path, label) {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 1) {
    fail(`${label} must be a regular non-symlink file`);
  }
  return readFile(path);
}

function createSbom({ product, version, artifact, artifactSha, source, runner, toolchain }) {
  return {
    bomFormat: 'CycloneDX',
    specVersion: '1.6',
    serialNumber: `urn:uuid:${deterministicUuid(artifactSha)}`,
    version: 1,
    metadata: {
      lifecycles: [{ phase: 'build' }],
      component: {
        type: 'file',
        'bom-ref': `artifact:${artifact.name}`,
        name: artifact.name,
        version,
        hashes: [{ alg: 'SHA-256', content: artifactSha }],
        properties: [
          { name: 'happier:product', value: product },
          { name: 'happier:target', value: `${artifact.os}-${artifact.arch}` },
          { name: 'happier:source-commit', value: source.commitSha },
          { name: 'happier:lockfile-sha256', value: source.lockfileSha256 },
          { name: 'happier:runner', value: JSON.stringify(runner) },
          { name: 'happier:toolchain', value: JSON.stringify(toolchain) },
        ],
      },
    },
    components: [],
  };
}

function createProvenance({ product, version, channel, artifact, artifactSha, source, runner, toolchain }) {
  return {
    _type: 'https://in-toto.io/Statement/v1',
    subject: [{ name: artifact.name, digest: { sha256: artifactSha } }],
    predicateType: 'https://slsa.dev/provenance/v1',
    predicate: {
      buildDefinition: {
        buildType: 'https://happier.dev/build-types/native-release/v1',
        externalParameters: {
          product,
          version,
          channel,
          target: { os: artifact.os, arch: artifact.arch },
        },
        internalParameters: { runner, toolchain },
        resolvedDependencies: [
          { uri: `git+${source.repository}@${source.commitSha}`, digest: { gitCommit: source.commitSha } },
          { uri: source.lockfileName, digest: { sha256: source.lockfileSha256 } },
        ],
      },
      runDetails: {
        builder: { id: 'https://github.com/actions/runner' },
        metadata: { invocationId: `${source.commitSha}:${artifact.os}-${artifact.arch}` },
        byproducts: [],
      },
    },
  };
}

/**
 * Creates deterministic, unsigned evidence bytes. The canonical binary finalizer
 * must include every returned file in its existing checksum/Minisign envelope;
 * this module intentionally does not own signing.
 */
export async function createReleaseEvidence(params) {
  const product = requireSafeName(params.product, 'product');
  const version = requireSafeName(params.version, 'version');
  const channel = requireSafeName(params.channel, 'channel');
  const sourceCommitSha = String(params.sourceCommitSha ?? '').trim();
  if (!COMMIT_PATTERN.test(sourceCommitSha) || params.sourceWorkspaceDirty !== false) {
    fail('attestation requires one clean source commit');
  }
  const sourceRepository = String(params.sourceRepository ?? '').trim();
  if (!/^https:\/\/github\.com\/[0-9A-Za-z][0-9A-Za-z._-]*\/[0-9A-Za-z][0-9A-Za-z._-]*$/.test(sourceRepository)) {
    fail('source repository must be an exact GitHub HTTPS repository URL');
  }
  const outDir = resolve(params.outDir);
  const lockfilePath = resolve(params.lockfilePath);

  if (!Array.isArray(params.artifacts) || params.artifacts.length !== MATRIX_KEYS.length) {
    fail('artifacts must be the exact five-platform matrix');
  }
  const byTarget = new Map();
  for (const artifact of params.artifacts) {
    const os = String(artifact?.os ?? '').trim();
    const arch = String(artifact?.arch ?? '').trim();
    const key = `${os}-${arch}`;
    if (!MATRIX_KEYS.includes(key) || byTarget.has(key)) fail(`artifacts must be the exact five-platform matrix; unsupported target ${key}`);
    const name = requireSafeName(artifact?.name, 'artifact name');
    if (!name.endsWith('.tar.gz')) fail(`artifact must be a tar.gz archive: ${name}`);
    const artifactPath = resolve(artifact?.path);
    if (basename(artifactPath) !== name) fail(`artifact name/path mismatch: ${name}`);
    const runner = requirePlainStringRecord(artifact?.build?.runner, `runner for ${key}`);
    const toolchain = requirePlainStringRecord(artifact?.build?.toolchain, `toolchain for ${key}`);
    byTarget.set(key, { name, path: artifactPath, os, arch, build: { runner, toolchain } });
  }
  if (MATRIX_KEYS.some((key) => !byTarget.has(key))) fail('artifacts must be the exact five-platform matrix');

  const lockfileBytes = await readRegularFile(lockfilePath, 'lockfile');
  const source = {
    repository: sourceRepository,
    commitSha: sourceCommitSha,
    workspaceDirty: false,
    lockfileName: basename(lockfilePath),
    lockfileSha256: sha256(lockfileBytes),
  };
  const admitted = [];
  for (const key of MATRIX_KEYS) {
    const artifact = byTarget.get(key);
    const bytes = await readRegularFile(artifact.path, `artifact ${artifact.name}`);
    admitted.push({ ...artifact, sha256: sha256(bytes), size: bytes.length });
  }

  const createdPaths = [];
  try {
    const catalogEntries = [];
    for (const artifact of admitted) {
      const sbomName = `${artifact.name}.cdx.json`;
      const provenanceName = `${artifact.name}.intoto.jsonl`;
      const sbomBytes = jsonBytes(createSbom({
        product,
        version,
        artifact,
        artifactSha: artifact.sha256,
        source,
        runner: artifact.build.runner,
        toolchain: artifact.build.toolchain,
      }));
      const provenanceBytes = jsonBytes(
        createProvenance({
          product,
          version,
          channel,
          artifact,
          artifactSha: artifact.sha256,
          source,
          runner: artifact.build.runner,
          toolchain: artifact.build.toolchain,
        }),
        true,
      );
      const sbomPath = join(outDir, sbomName);
      const provenancePath = join(outDir, provenanceName);
      await writeFile(sbomPath, sbomBytes, { flag: 'wx' });
      createdPaths.push(sbomPath);
      await writeFile(provenancePath, provenanceBytes, { flag: 'wx' });
      createdPaths.push(provenancePath);
      catalogEntries.push({
        name: artifact.name,
        os: artifact.os,
        arch: artifact.arch,
        size: artifact.size,
        sha256: artifact.sha256,
        build: artifact.build,
        sbom: { name: sbomName, sha256: sha256(sbomBytes) },
        provenance: { name: provenanceName, sha256: sha256(provenanceBytes) },
      });
    }
    const catalog = {
      schemaVersion: 'happier-release-evidence/v1',
      product,
      version,
      channel,
      source,
      unsupportedTargets: [{ os: 'windows', arch: 'arm64', status: 'unsupported' }],
      artifacts: catalogEntries,
    };
    const catalogName = `release-evidence-${product}-v${version}.json`;
    const catalogPath = join(outDir, catalogName);
    await writeFile(catalogPath, jsonBytes(catalog), { flag: 'wx' });
    createdPaths.push(catalogPath);
    return {
      catalogPath,
      evidenceFiles: [
        ...catalogEntries.flatMap((entry) => [entry.sbom.name, entry.provenance.name]),
        catalogName,
      ].map((name) => ({ name, path: join(outDir, name) })),
    };
  } catch (error) {
    await Promise.all(createdPaths.map((path) => rm(path, { force: true })));
    throw error;
  }
}
