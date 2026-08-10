// @ts-check

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  canonicalArchiveIdentity,
  verifyDeploymentKitSpecSources,
} from './deployment-kit-assembly.mjs';
import {
  createDeploymentGitHubCatalog,
  materializeDeploymentGitHubProject,
  readCanonicalHappierLicense,
} from './deployment-kit-github-project.mjs';
import { verifyDeploymentKit } from './deployment-kit-integrity.mjs';
import {
  createProjectDeploymentGuide,
  createProjectDeploymentGuideChinese,
} from './deployment-kit-github-readme.mjs';

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

// The landing READMEs are written by materializeDeploymentGitHubProject. The
// operator guides are added here, after materialization, because they live in
// docs/ next to the landing pages. PROJECT-SHA256SUMS is extended afterwards
// so the generated docs stay covered by the project-tree receipt.
async function writeDeploymentGuides(catalog, outDir) {
  const guideEntries = [
    ['docs/DEPLOYMENT.md', createProjectDeploymentGuide(catalog)],
    ['docs/DEPLOYMENT.zh-CN.md', createProjectDeploymentGuideChinese(catalog)],
  ];
  const docsDir = join(outDir, 'docs');
  await mkdir(docsDir, { recursive: true });
  for (const [relativePath, content] of guideEntries) {
    await writeFile(join(outDir, ...relativePath.split('/')), content);
  }
  return guideEntries;
}

async function extendProjectReceipt(outDir, guideEntries) {
  const receiptPath = join(outDir, 'PROJECT-SHA256SUMS');
  const existing = await readFile(receiptPath, 'utf8');
  const lineEnding = existing.includes('\r\n') ? '\r\n' : '\n';
  const lines = existing.split(/\r?\n/).filter((line) => line.length > 0);
  const parsed = lines.map((line) => {
    const match = /^([0-9a-f]{64})  (.+)$/.exec(line);
    if (!match) throw new Error('[deployment-kit] invalid generated project checksum receipt');
    return { sha256: match[1], relativePath: match[2] };
  });
  const additions = guideEntries.map(([relativePath, content]) =>
    ({ sha256: createHash('sha256').update(content, 'utf8').digest('hex'), relativePath }));
  const merged = [...parsed, ...additions]
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath, 'en'));
  const receipt = merged.map((entry) => `${entry.sha256}  ${entry.relativePath}`).join(lineEnding) + lineEnding;
  await writeFile(receiptPath, receipt);
  return receipt;
}

async function materializeFromVerifiedInventory({
  manifest,
  verifiedSources,
  outDir,
  repository,
  repositoryAvailability,
  releasePublicKey,
}) {
  const catalog = createDeploymentGitHubCatalog({
    manifest,
    verifiedSources,
    repository,
    repositoryAvailability,
  });
  const materialized = await materializeDeploymentGitHubProject({
    catalog,
    outDir,
    licenseText: await readCanonicalHappierLicense(REPO_ROOT),
    releasePublicKey,
  });
  const guideEntries = await writeDeploymentGuides(catalog, outDir);
  const receipt = await extendProjectReceipt(outDir, guideEntries);
  return {
    channel: catalog.channel,
    kitVersion: catalog.kitVersion,
    repository: catalog.repository.slug,
    artifactCount: catalog.artifacts.length,
    referencedArtifactBytes: catalog.artifacts.reduce((sum, artifact) => sum + artifact.size, 0),
    embeddedArtifactBytes: materialized.embeddedArtifactBytes,
    projectFileCount: materialized.projectFileCount + guideEntries.length,
    projectTreeSha256: createHash('sha256').update(receipt, 'utf8').digest('hex'),
    outDir: materialized.outDir,
  };
}

export async function assembleDeploymentGitHubProjectFromSpec({
  spec,
  specRoot,
  outDir,
  repository,
  repositoryAvailability,
  releasePublicKey,
}) {
  const verified = await verifyDeploymentKitSpecSources({ spec, specRoot });
  return await materializeFromVerifiedInventory({
    manifest: verified.manifest,
    verifiedSources: verified.verifiedSources,
    outDir,
    repository,
    repositoryAvailability,
    releasePublicKey,
  });
}

export async function assembleDeploymentGitHubProjectFromVerifiedKit({
  kitRoot,
  outDir,
  repository,
  repositoryAvailability,
  releasePublicKey,
}) {
  await verifyDeploymentKit({ kitRoot });
  const manifest = JSON.parse(await readFile(join(kitRoot, 'manifest.json'), 'utf8'));
  const verifiedSources = manifest.artifacts.map((artifact) => {
    const identity = canonicalArchiveIdentity(manifest, artifact);
    return {
      artifactId: artifact.id,
      archivePath: join(kitRoot, ...String(artifact.path).split('/')),
      archiveName: identity.archiveName,
      checksumsPath: '',
      checksumsName: identity.checksumsName,
    };
  });
  return await materializeFromVerifiedInventory({
    manifest,
    verifiedSources,
    outDir,
    repository,
    repositoryAvailability,
    releasePublicKey,
  });
}
