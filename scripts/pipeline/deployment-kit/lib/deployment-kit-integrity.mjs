// @ts-check

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  opendir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { dirname, isAbsolute, posix, resolve, sep } from 'node:path';

import {
  assertCompleteDeploymentKitArtifactCoverage,
  HAPPIER_DEPLOYMENT_KIT_SCHEMA_VERSION,
} from './deployment-kit-manifest.mjs';
import {
  assertDeploymentKitManifestSchema,
  deploymentKitJsonSchema,
} from './deployment-kit-schema.mjs';
import { createDeploymentKitBootstrapFiles } from './deployment-kit-bootstrap.mjs';
import { createDeploymentKitGuide } from './deployment-kit-guide.mjs';

const INVENTORY_SCHEMA_VERSION = 'happier-artifact-inventory/v1';
const MANIFEST_PATH = 'manifest.json';
const INVENTORY_PATH = 'ARTIFACT-INVENTORY.json';
const SCHEMA_PATH = 'deployment-kit.schema.json';
const GUIDE_PATH = 'README.md';
const CHECKSUMS_PATH = 'SHA256SUMS';

function safeRelativePath(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`[deployment-kit] ${label} is required`);
  }
  if (
    value.includes('\\')
    || value.includes('\0')
    || value.startsWith('/')
    || isAbsolute(value)
    || /^[A-Za-z]:/.test(value)
  ) {
    throw new Error(`[deployment-kit] unsafe ${label}: ${value}`);
  }
  const normalized = posix.normalize(value);
  if (
    normalized !== value
    || normalized === '.'
    || normalized === '..'
    || normalized.startsWith('../')
  ) {
    throw new Error(`[deployment-kit] unsafe ${label}: ${value}`);
  }
  return normalized;
}

function pathInside(root, relativePath) {
  const normalized = safeRelativePath(relativePath, 'kit path');
  const rootPath = resolve(root);
  const targetPath = resolve(rootPath, ...normalized.split('/'));
  if (targetPath !== rootPath && !targetPath.startsWith(`${rootPath}${sep}`)) {
    throw new Error(`[deployment-kit] path escapes kit root: ${relativePath}`);
  }
  return targetPath;
}

async function requireRegularFile(path, label, { requireSingleLink = false } = {}) {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    throw new Error(`[deployment-kit] ${label} is not readable`, { cause: error });
  }
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error(`[deployment-kit] ${label} must be a regular file`);
  }
  if (requireSingleLink && info.nlink !== 1) {
    throw new Error(`[deployment-kit] hard-linked ${label} is forbidden`);
  }
  return info;
}

async function enumerateKitTree(kitRoot) {
  const files = new Set();
  const directories = new Set();

  async function visitDirectory(absoluteDirectory, relativeDirectory) {
    const handle = await opendir(absoluteDirectory).catch((error) => {
      throw new Error(`[deployment-kit] kit directory is not readable: ${relativeDirectory || '.'}`, { cause: error });
    });
    try {
      for await (const entry of handle) {
        const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
        const safePath = safeRelativePath(relativePath, 'kit tree path');
        const absolutePath = pathInside(kitRoot, safePath);
        const info = await lstat(absolutePath).catch((error) => {
          throw new Error(`[deployment-kit] kit tree entry is not readable: ${safePath}`, { cause: error });
        });
        if (entry.isSymbolicLink() || info.isSymbolicLink()) {
          throw new Error(`[deployment-kit] symbolic link or reparse entry is forbidden: ${safePath}`);
        }
        if (info.isDirectory()) {
          directories.add(safePath);
          await visitDirectory(absolutePath, safePath);
          continue;
        }
        if (!info.isFile()) {
          throw new Error(`[deployment-kit] special filesystem entry is forbidden: ${safePath}`);
        }
        if (info.nlink !== 1) {
          throw new Error(`[deployment-kit] hard link is forbidden: ${safePath}`);
        }
        files.add(safePath);
      }
    } finally {
      await handle.close().catch((error) => {
        if (error?.code !== 'ERR_DIR_CLOSED') throw error;
      });
    }
  }

  await visitDirectory(resolve(kitRoot), '');
  return { files, directories };
}

function requiredDirectories(filePaths) {
  const directories = new Set();
  for (const filePath of filePaths) {
    const segments = filePath.split('/');
    segments.pop();
    let current = '';
    for (const segment of segments) {
      current = current ? `${current}/${segment}` : segment;
      directories.add(current);
    }
  }
  return directories;
}

function assertExactSet(actual, expected, kind) {
  for (const entry of actual) {
    if (!expected.has(entry)) {
      throw new Error(`[deployment-kit] unexpected kit ${kind}: ${entry}`);
    }
  }
  for (const entry of expected) {
    if (!actual.has(entry)) {
      throw new Error(`[deployment-kit] missing kit ${kind}: ${entry}`);
    }
  }
}

async function requireUnlinkedKitPath(kitRoot, relativePath) {
  const segments = safeRelativePath(relativePath, 'kit path').split('/');
  let current = resolve(kitRoot);
  for (let index = 0; index < segments.length; index += 1) {
    current = resolve(current, segments[index]);
    const info = await lstat(current).catch((error) => {
      throw new Error(`[deployment-kit] kit path component is not readable: ${relativePath}`, { cause: error });
    });
    if (info.isSymbolicLink()) {
      throw new Error(`[deployment-kit] symbolic link or reparse path component is forbidden: ${relativePath}`);
    }
    if (index < segments.length - 1 && !info.isDirectory()) {
      throw new Error(`[deployment-kit] non-directory kit path component: ${relativePath}`);
    }
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

function sha256Bytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function jsonBytes(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function validateManifestShape(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('[deployment-kit] manifest must be an object');
  }
  if (manifest.schemaVersion !== HAPPIER_DEPLOYMENT_KIT_SCHEMA_VERSION) {
    throw new Error(`[deployment-kit] unsupported manifest schema: ${String(manifest.schemaVersion)}`);
  }
  if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length === 0) {
    throw new Error('[deployment-kit] manifest must contain artifacts');
  }

  const ids = new Set();
  const paths = new Set();
  for (const artifact of manifest.artifacts) {
    if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)) {
      throw new Error('[deployment-kit] invalid artifact entry');
    }
    if (typeof artifact.id !== 'string' || artifact.id.length === 0 || ids.has(artifact.id)) {
      throw new Error(`[deployment-kit] duplicate or invalid artifact id: ${String(artifact.id)}`);
    }
    ids.add(artifact.id);
    artifact.path = safeRelativePath(artifact.path, `artifact path for ${artifact.id}`);
    if (paths.has(artifact.path)) {
      throw new Error(`[deployment-kit] duplicate artifact path: ${artifact.path}`);
    }
    paths.add(artifact.path);
    if (typeof artifact.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(artifact.sha256)) {
      throw new Error(`[deployment-kit] invalid SHA256 for artifact ${artifact.id}`);
    }
    if (!Number.isSafeInteger(artifact.size) || artifact.size <= 0) {
      throw new Error(`[deployment-kit] invalid size for artifact ${artifact.id}`);
    }
  }
  const normalizedManifest = assertDeploymentKitManifestSchema(manifest);
  assertCompleteDeploymentKitArtifactCoverage(normalizedManifest.artifacts);
  return normalizedManifest;
}

function createInventory(manifest) {
  return {
    schemaVersion: INVENTORY_SCHEMA_VERSION,
    product: manifest.product,
    kitVersion: manifest.kitVersion,
    dependencySbomIncluded: false,
    artifacts: manifest.artifacts.map((artifact) => ({
      id: artifact.id,
      role: artifact.role,
      target: artifact.target,
      variant: artifact.variant,
      format: artifact.format,
      path: artifact.path,
      sha256: artifact.sha256,
      size: artifact.size,
    })),
  };
}

function parseChecksums(contents) {
  const entries = new Map();
  const lines = contents.replace(/\r\n/g, '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  if (lines.length === 0) throw new Error('[deployment-kit] SHA256SUMS is empty');
  for (const line of lines) {
    const match = /^([a-f0-9]{64})  (.+)$/.exec(line);
    if (!match) throw new Error(`[deployment-kit] invalid SHA256SUMS line: ${line}`);
    const relativePath = safeRelativePath(match[2], 'checksum path');
    if (entries.has(relativePath)) {
      throw new Error(`[deployment-kit] duplicate checksum path: ${relativePath}`);
    }
    entries.set(relativePath, match[1]);
  }
  return entries;
}

function checksumContents(entries) {
  return [...entries.entries()]
    .sort(([left], [right]) => left.localeCompare(right, 'en'))
    .map(([relativePath, digest]) => `${digest}  ${relativePath}\n`)
    .join('');
}

function sameInventory(actual, expected) {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

async function pathExists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return false;
    throw error;
  }
}

export async function materializeDeploymentKit({ manifest, sourceArtifacts, outDir }) {
  if (typeof outDir !== 'string' || outDir.length === 0) {
    throw new Error('[deployment-kit] output directory is required');
  }
  if (await pathExists(outDir)) {
    throw new Error(`[deployment-kit] output directory already exists: ${outDir}`);
  }

  const normalizedManifest = validateManifestShape(structuredClone(manifest));
  await mkdir(dirname(resolve(outDir)), { recursive: true });
  const stagingDir = await mkdtemp(`${resolve(outDir)}.staging-`);

  try {
    const copiedDigests = new Map();
    for (const artifact of normalizedManifest.artifacts) {
      const sourcePath = sourceArtifacts?.[artifact.id];
      if (typeof sourcePath !== 'string' || sourcePath.length === 0) {
        throw new Error(`[deployment-kit] source artifact verification failed: ${artifact.id}`);
      }
      const sourceInfo = await requireRegularFile(
        sourcePath,
        `source artifact ${artifact.id}`,
        { requireSingleLink: true },
      );
      const sourceDigest = await sha256File(sourcePath);
      if (sourceInfo.size !== artifact.size || sourceDigest !== artifact.sha256) {
        throw new Error(`[deployment-kit] source artifact verification failed: ${artifact.id}`);
      }

      const destination = pathInside(stagingDir, artifact.path);
      await mkdir(dirname(destination), { recursive: true });
      await copyFile(sourcePath, destination);
      const destinationInfo = await requireRegularFile(destination, `copied artifact ${artifact.id}`);
      const destinationDigest = await sha256File(destination);
      if (destinationInfo.size !== artifact.size || destinationDigest !== artifact.sha256) {
        throw new Error(`[deployment-kit] copied artifact verification failed: ${artifact.id}`);
      }
      copiedDigests.set(artifact.path, destinationDigest);
    }

    const manifestContents = jsonBytes(normalizedManifest);
    const inventoryContents = jsonBytes(createInventory(normalizedManifest));
    const schemaContents = jsonBytes(deploymentKitJsonSchema);
    const guideContents = createDeploymentKitGuide(normalizedManifest);
    await writeFile(pathInside(stagingDir, MANIFEST_PATH), manifestContents, { flag: 'wx' });
    await writeFile(pathInside(stagingDir, INVENTORY_PATH), inventoryContents, { flag: 'wx' });
    await writeFile(pathInside(stagingDir, SCHEMA_PATH), schemaContents, { flag: 'wx' });
    await writeFile(pathInside(stagingDir, GUIDE_PATH), guideContents, { flag: 'wx' });

    const bootstrapFiles = createDeploymentKitBootstrapFiles();
    const bootstrapDigests = new Map();
    for (const bootstrap of bootstrapFiles) {
      const bootstrapPath = pathInside(stagingDir, bootstrap.path);
      await mkdir(dirname(bootstrapPath), { recursive: true });
      await writeFile(bootstrapPath, bootstrap.contents, { flag: 'wx', mode: bootstrap.mode });
      bootstrapDigests.set(bootstrap.path, sha256Bytes(bootstrap.contents));
    }

    const entries = new Map([
      [MANIFEST_PATH, sha256Bytes(manifestContents)],
      [INVENTORY_PATH, sha256Bytes(inventoryContents)],
      [SCHEMA_PATH, sha256Bytes(schemaContents)],
      [GUIDE_PATH, sha256Bytes(guideContents)],
      ...bootstrapDigests.entries(),
      ...copiedDigests.entries(),
    ]);
    const checksums = checksumContents(entries);
    await writeFile(pathInside(stagingDir, CHECKSUMS_PATH), checksums, { flag: 'wx' });

    const verified = await verifyDeploymentKit({ kitRoot: stagingDir });
    await rename(stagingDir, outDir);
    return {
      outDir,
      manifestPath: pathInside(outDir, MANIFEST_PATH),
      checksumsPath: pathInside(outDir, CHECKSUMS_PATH),
      treeSha256: verified.treeSha256,
    };
  } catch (error) {
    await rm(stagingDir, { recursive: true, force: true });
    throw error;
  }
}

export async function verifyDeploymentKit({ kitRoot }) {
  const rootInfo = await lstat(kitRoot);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
    throw new Error('[deployment-kit] kit root must be a regular directory');
  }

  const actualTree = await enumerateKitTree(kitRoot);

  const checksumsFile = pathInside(kitRoot, CHECKSUMS_PATH);
  await requireRegularFile(checksumsFile, CHECKSUMS_PATH, { requireSingleLink: true });
  const checksumsContents = await readFile(checksumsFile, 'utf8');
  const checksums = parseChecksums(checksumsContents);

  const manifestFile = pathInside(kitRoot, MANIFEST_PATH);
  const inventoryFile = pathInside(kitRoot, INVENTORY_PATH);
  const schemaFile = pathInside(kitRoot, SCHEMA_PATH);
  const guideFile = pathInside(kitRoot, GUIDE_PATH);
  await requireRegularFile(manifestFile, MANIFEST_PATH, { requireSingleLink: true });
  await requireRegularFile(inventoryFile, INVENTORY_PATH, { requireSingleLink: true });
  await requireRegularFile(schemaFile, SCHEMA_PATH, { requireSingleLink: true });
  await requireRegularFile(guideFile, GUIDE_PATH, { requireSingleLink: true });

  let manifest;
  let inventory;
  let schema;
  try {
    manifest = validateManifestShape(JSON.parse(await readFile(manifestFile, 'utf8')));
    inventory = JSON.parse(await readFile(inventoryFile, 'utf8'));
    schema = JSON.parse(await readFile(schemaFile, 'utf8'));
  } catch (error) {
    throw new Error('[deployment-kit] manifest or inventory is invalid', { cause: error });
  }

  const expectedPaths = new Set([
    MANIFEST_PATH,
    INVENTORY_PATH,
    SCHEMA_PATH,
    GUIDE_PATH,
    ...createDeploymentKitBootstrapFiles().map((bootstrap) => bootstrap.path),
    ...manifest.artifacts.map((artifact) => artifact.path),
  ]);
  for (const expectedPath of expectedPaths) {
    if (!checksums.has(expectedPath)) {
      throw new Error(`[deployment-kit] missing checksum: ${expectedPath}`);
    }
  }
  for (const checksumPath of checksums.keys()) {
    if (!expectedPaths.has(checksumPath)) {
      throw new Error(`[deployment-kit] unexpected checksum entry: ${checksumPath}`);
    }
  }

  const expectedKitFiles = new Set([...expectedPaths, CHECKSUMS_PATH]);
  assertExactSet(actualTree.files, expectedKitFiles, 'file');
  assertExactSet(actualTree.directories, requiredDirectories(expectedKitFiles), 'directory');

  for (const [relativePath, expectedDigest] of checksums) {
    await requireUnlinkedKitPath(kitRoot, relativePath);
    const filePath = pathInside(kitRoot, relativePath);
    await requireRegularFile(filePath, `kit file ${relativePath}`, { requireSingleLink: true });
    const actualDigest = await sha256File(filePath);
    if (actualDigest !== expectedDigest) {
      throw new Error(`[deployment-kit] checksum mismatch: ${relativePath}`);
    }
  }

  for (const artifact of manifest.artifacts) {
    const artifactPath = pathInside(kitRoot, artifact.path);
    const info = await requireRegularFile(artifactPath, `artifact ${artifact.id}`, { requireSingleLink: true });
    if (info.size !== artifact.size || checksums.get(artifact.path) !== artifact.sha256) {
      throw new Error(`[deployment-kit] manifest artifact mismatch: ${artifact.id}`);
    }
  }

  const expectedInventory = createInventory(manifest);
  if (!sameInventory(inventory, expectedInventory)) {
    throw new Error('[deployment-kit] artifact inventory does not match manifest');
  }
  if (JSON.stringify(schema) !== JSON.stringify(deploymentKitJsonSchema)) {
    throw new Error('[deployment-kit] deployment kit schema does not match the supported v1 contract');
  }
  for (const bootstrap of createDeploymentKitBootstrapFiles()) {
    const actual = await readFile(pathInside(kitRoot, bootstrap.path), 'utf8');
    if (actual !== bootstrap.contents) {
      throw new Error(`[deployment-kit] bootstrap does not match the supported contract: ${bootstrap.path}`);
    }
  }
  const actualGuide = await readFile(guideFile, 'utf8');
  if (actualGuide !== createDeploymentKitGuide(manifest)) {
    throw new Error('[deployment-kit] README does not match the supported manifest guide');
  }

  return {
    ok: true,
    kitRoot,
    treeSha256: sha256Bytes(checksumsContents),
    artifactCount: manifest.artifacts.length,
  };
}
