import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createReleaseEvidence } from './release-evidence.mjs';

const MATRIX = [
  ['linux', 'x64'],
  ['linux', 'arm64'],
  ['darwin', 'x64'],
  ['darwin', 'arm64'],
  ['windows', 'x64'],
];

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function fixture(root) {
  const artifacts = [];
  for (const [os, arch] of MATRIX) {
    const name = `happier-v1.2.3-${os}-${arch}.tar.gz`;
    const path = join(root, name);
    await writeFile(path, `${os}-${arch}\n`);
    artifacts.push({
      name,
      path,
      os,
      arch,
      build: {
        runner: { os, arch, image: `${os}-${arch}-image` },
        toolchain: { node: '24.14.0', bun: '1.2.0', rust: '1.90.0' },
      },
    });
  }
  const lockfilePath = join(root, 'yarn.lock');
  await writeFile(lockfilePath, 'fixed lock bytes\n');
  return { artifacts, lockfilePath };
}

test('creates deterministic CycloneDX 1.6, in-toto provenance, and a one-to-one five-platform catalog', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-release-evidence-'));
  try {
    const { artifacts, lockfilePath } = await fixture(root);
    const params = {
      artifacts,
      outDir: root,
      product: 'happier',
      version: '1.2.3',
      channel: 'preview',
      sourceRepository: 'https://github.com/ALTair289/Happier-Anywhere',
      sourceCommitSha: '1'.repeat(40),
      sourceWorkspaceDirty: false,
      lockfilePath,
    };
    const first = await createReleaseEvidence(params);
    const catalog = JSON.parse(await readFile(first.catalogPath, 'utf8'));

    assert.equal(catalog.schemaVersion, 'happier-release-evidence/v1');
    assert.equal(catalog.source.commitSha, '1'.repeat(40));
    assert.equal(catalog.source.lockfileSha256, sha256('fixed lock bytes\n'));
    assert.deepEqual(catalog.unsupportedTargets, [{ os: 'windows', arch: 'arm64', status: 'unsupported' }]);
    assert.deepEqual(catalog.artifacts.map(({ os, arch }) => [os, arch]), MATRIX);
    assert.equal(new Set(catalog.artifacts.map((entry) => entry.sbom.name)).size, 5);
    assert.equal(new Set(catalog.artifacts.map((entry) => entry.provenance.name)).size, 5);

    for (const entry of catalog.artifacts) {
      assert.match(entry.sha256, /^[a-f0-9]{64}$/);
      const sbomBytes = await readFile(join(root, entry.sbom.name));
      const provenanceBytes = await readFile(join(root, entry.provenance.name));
      assert.equal(sha256(sbomBytes), entry.sbom.sha256);
      assert.equal(sha256(provenanceBytes), entry.provenance.sha256);
      const sbom = JSON.parse(sbomBytes.toString('utf8'));
      assert.equal(sbom.bomFormat, 'CycloneDX');
      assert.equal(sbom.specVersion, '1.6');
      assert.equal(sbom.metadata.component.hashes[0].content, entry.sha256);
      const provenance = JSON.parse(provenanceBytes.toString('utf8'));
      assert.equal(provenance._type, 'https://in-toto.io/Statement/v1');
      assert.equal(provenance.subject[0].digest.sha256, entry.sha256);
      assert.equal(provenance.predicate.buildDefinition.resolvedDependencies[0].digest.gitCommit, '1'.repeat(40));
      assert.deepEqual(entry.build.runner, { arch: entry.arch, image: `${entry.os}-${entry.arch}-image`, os: entry.os });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('fails closed for an incomplete matrix, Windows arm64, dirty source, and symlink artifacts', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'happier-release-evidence-reject-'));
  try {
    const { artifacts, lockfilePath } = await fixture(root);
    const base = {
      artifacts,
      outDir: root,
      product: 'happier',
      version: '1.2.3',
      channel: 'preview',
      sourceRepository: 'https://github.com/ALTair289/Happier-Anywhere',
      sourceCommitSha: '1'.repeat(40),
      sourceWorkspaceDirty: false,
      lockfilePath,
    };
    await assert.rejects(() => createReleaseEvidence({ ...base, artifacts: artifacts.slice(1) }), /exact five-platform matrix/i);
    await assert.rejects(() => createReleaseEvidence({
      ...base,
      artifacts: [...artifacts.slice(0, 4), { ...artifacts[4], arch: 'arm64' }],
    }), /windows-arm64|exact five-platform matrix/i);
    await assert.rejects(() => createReleaseEvidence({ ...base, sourceWorkspaceDirty: true }), /clean source/i);

    const symlinkPath = join(root, 'linked.tar.gz');
    try {
      await symlink(artifacts[0].path, symlinkPath, 'file');
      await assert.rejects(() => createReleaseEvidence({
        ...base,
        artifacts: [{ ...artifacts[0], path: symlinkPath }, ...artifacts.slice(1)],
      }), /regular non-symlink/i);
    } catch (error) {
      if (!error || error.code !== 'EPERM') throw error;
      t.diagnostic('Windows host does not grant symlink creation; lstat rejection remains covered on symlink-capable CI.');
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
