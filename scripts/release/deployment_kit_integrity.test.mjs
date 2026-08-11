import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createDeploymentKitManifest } from '../pipeline/deployment-kit/lib/deployment-kit-manifest.mjs';
import {
  materializeDeploymentKit,
  verifyDeploymentKit,
} from '../pipeline/deployment-kit/lib/deployment-kit-integrity.mjs';

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

const TARGETS = [
  { os: 'windows', arch: 'x64' },
  { os: 'linux', arch: 'x64', libc: 'glibc' },
  { os: 'linux', arch: 'arm64', libc: 'glibc' },
  { os: 'darwin', arch: 'x64' },
  { os: 'darwin', arch: 'arm64' },
];

function artifactId(role, target) {
  return `${role}-${target.os}-${target.arch}`;
}

function sourceArtifactsFor(agentSource, controllerSource) {
  return Object.fromEntries(TARGETS.flatMap((target) => ['agent', 'controller'].map((role) => [
    artifactId(role, target),
    role === 'controller' ? controllerSource : agentSource,
  ])));
}

function manifestForFiles(agentBytes, controllerBytes) {
  return createDeploymentKitManifest({
    kitVersion: '0.2.10-local.1',
    channel: 'local',
    source: {
      commitSha: 'c65ea282ba582e527e7fa1d94f9cad1cb535b9e7',
      workspaceDirty: false,
    },
    versions: {
      cli: '0.2.10',
      relay: '0.2.10',
      webUi: '0.2.10',
      protocol: '1',
      androidApp: '0.2.10',
      iosApp: '0.2.10',
    },
    artifacts: TARGETS.flatMap((target) => ['agent', 'controller'].map((role) => {
      const bytes = role === 'controller' ? controllerBytes : agentBytes;
      const id = artifactId(role, target);
      return {
        id,
        role,
        target,
        format: 'tar.gz',
        path: `packs/${role}/${id}.tar.gz`,
        sha256: sha256(bytes),
        size: bytes.length,
      };
    })),
    mobile: {
      supportedProtocolVersions: ['1'],
      preferredProtocolVersion: '1',
      android: {
        applicationId: 'dev.happier.app',
        appVersion: '0.2.10',
        runtimeVersion: '0.2.10',
        googlePlay: { buildId: 'android-play-210', signingCertificateSha256: 'c'.repeat(64) },
      },
      ios: {
        bundleId: 'dev.happier.app',
        appVersion: '0.2.10',
        runtimeVersion: '0.2.10',
        teamId: 'L86V3EF623',
        appStore: { buildId: 'ios-store-210', signingCertificateSha256: 'd'.repeat(64) },
        testflight: { buildId: 'ios-testflight-210', signingCertificateSha256: 'd'.repeat(64) },
        mdm: { buildId: 'ios-mdm-210', signingCertificateSha256: 'e'.repeat(64) },
        genericSideloadableIpa: false,
      },
      pairing: { deepLinkScheme: 'happier', maxTtlSeconds: 300 },
      push: { mode: 'private' },
    },
  });
}

async function materializeSampleKit(root) {
  const agentBytes = Buffer.from('agent payload\n');
  const controllerBytes = Buffer.from('controller payload\n');
  const agentSource = join(root, 'agent.tar.gz');
  const controllerSource = join(root, 'controller.tar.gz');
  const outDir = join(root, 'kit');
  await writeFile(agentSource, agentBytes);
  await writeFile(controllerSource, controllerBytes);
  const result = await materializeDeploymentKit({
    manifest: manifestForFiles(agentBytes, controllerBytes),
    sourceArtifacts: sourceArtifactsFor(agentSource, controllerSource),
    outDir,
  });
  return { outDir, result };
}

function withoutCanonicalCoverage(manifest, kind) {
  const clone = structuredClone(manifest);
  clone.artifacts = clone.artifacts.filter((entry) => {
    const isDarwinArm64 = entry.target.os === 'darwin' && entry.target.arch === 'arm64';
    return kind === 'target' ? !isDarwinArm64 : !(isDarwinArm64 && entry.role === 'controller');
  });
  return clone;
}

test('materializeDeploymentKit copies verified artifacts and verifyDeploymentKit closes the final directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-deployment-kit-integrity-'));
  try {
    const agentBytes = Buffer.from('agent payload\n');
    const controllerBytes = Buffer.from('controller payload\n');
    const agentSource = join(root, 'agent.tar.gz');
    const controllerSource = join(root, 'controller.tar.gz');
    const outDir = join(root, 'kit');
    await writeFile(agentSource, agentBytes);
    await writeFile(controllerSource, controllerBytes);
    const manifest = manifestForFiles(agentBytes, controllerBytes);

    const result = await materializeDeploymentKit({
      manifest,
      sourceArtifacts: sourceArtifactsFor(agentSource, controllerSource),
      outDir,
    });

    assert.equal(result.outDir, outDir);
    assert.match(result.treeSha256, /^[a-f0-9]{64}$/);
    const writtenManifest = JSON.parse(await readFile(join(outDir, 'manifest.json'), 'utf8'));
    assert.equal(writtenManifest.kitVersion, '0.2.10-local.1');
    const writtenSchema = JSON.parse(await readFile(join(outDir, 'deployment-kit.schema.json'), 'utf8'));
    assert.equal(writtenSchema.$id, 'https://happier.dev/schemas/deployment-kit/v1.json');
    assert.match(await readFile(join(outDir, 'README.md'), 'utf8'), /exactly one Controller/i);
    assert.match(
      await readFile(join(outDir, 'bootstrap', 'controller.sh'), 'utf8'),
      /relay host install/,
    );
    assert.match(
      await readFile(join(outDir, 'bootstrap', 'agent.ps1'), 'utf8'),
      /auth login/,
    );
    assert.match(await readFile(join(outDir, 'SHA256SUMS'), 'utf8'), /packs\/agent\/agent-windows-x64\.tar\.gz/);
    assert.match(await readFile(join(outDir, 'SHA256SUMS'), 'utf8'), /deployment-kit\.schema\.json/);
    assert.match(await readFile(join(outDir, 'SHA256SUMS'), 'utf8'), /README\.md/);
    assert.match(await readFile(join(outDir, 'SHA256SUMS'), 'utf8'), /bootstrap\/controller\.sh/);
    const verified = await verifyDeploymentKit({ kitRoot: outDir });
    assert.equal(verified.treeSha256, result.treeSha256);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('materializeDeploymentKit and verifyDeploymentKit reject raw manifests with incomplete canonical coverage', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-deployment-kit-incomplete-'));
  try {
    const agentBytes = Buffer.from('agent payload\n');
    const controllerBytes = Buffer.from('controller payload\n');
    const agentSource = join(root, 'agent.tar.gz');
    const controllerSource = join(root, 'controller.tar.gz');
    await writeFile(agentSource, agentBytes);
    await writeFile(controllerSource, controllerBytes);
    const completeManifest = manifestForFiles(agentBytes, controllerBytes);
    const sources = sourceArtifactsFor(agentSource, controllerSource);

    for (const kind of ['target', 'role']) {
      const incompleteManifest = withoutCanonicalCoverage(completeManifest, kind);
      await assert.rejects(
        () => materializeDeploymentKit({
          manifest: incompleteManifest,
          sourceArtifacts: sources,
          outDir: join(root, `materialize-${kind}`),
        }),
        kind === 'target'
          ? /missing artifacts for canonical target.*darwin-arm64/i
          : /missing controller artifact for darwin-arm64/i,
      );

      const verifyRoot = join(root, `verify-${kind}`);
      await mkdir(verifyRoot);
      const { outDir } = await materializeSampleKit(verifyRoot);
      await writeFile(
        join(outDir, 'manifest.json'),
        `${JSON.stringify(withoutCanonicalCoverage(completeManifest, kind), null, 2)}\n`,
        'utf8',
      );
      await assert.rejects(
        () => verifyDeploymentKit({ kitRoot: outDir }),
        (error) => {
          assert.match(error.cause?.message ?? '', kind === 'target'
            ? /missing artifacts for canonical target.*darwin-arm64/i
            : /missing controller artifact for darwin-arm64/i);
          return true;
        },
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('verifyDeploymentKit rejects an untracked regular file anywhere in the kit tree', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-deployment-kit-untracked-'));
  try {
    const { outDir } = await materializeSampleKit(root);
    await writeFile(join(outDir, 'packs', 'untracked.txt'), 'not inventoried\n');

    await assert.rejects(
      () => verifyDeploymentKit({ kitRoot: outDir }),
      /untracked|unexpected kit file/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('verifyDeploymentKit rejects duplicate checksum paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-deployment-kit-duplicate-checksum-'));
  try {
    const { outDir } = await materializeSampleKit(root);
    const checksumsPath = join(outDir, 'SHA256SUMS');
    const checksums = await readFile(checksumsPath, 'utf8');
    const firstLine = checksums.split('\n')[0];
    await writeFile(checksumsPath, `${checksums}${firstLine}\n`, 'utf8');

    await assert.rejects(
      () => verifyDeploymentKit({ kitRoot: outDir }),
      /duplicate checksum path/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('verifyDeploymentKit accepts CRLF checksum receipts without path ambiguity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-deployment-kit-checksum-crlf-'));
  try {
    const { outDir } = await materializeSampleKit(root);
    const checksumsPath = join(outDir, 'SHA256SUMS');
    const checksums = await readFile(checksumsPath, 'utf8');
    await writeFile(checksumsPath, checksums.replace(/\n/g, '\r\n'), 'utf8');

    const verified = await verifyDeploymentKit({ kitRoot: outDir });
    assert.equal(verified.ok, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('verifyDeploymentKit rejects normalized checksum path aliases', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-deployment-kit-checksum-alias-'));
  try {
    const { outDir } = await materializeSampleKit(root);
    const checksumsPath = join(outDir, 'SHA256SUMS');
    const checksums = await readFile(checksumsPath, 'utf8');
    await writeFile(
      checksumsPath,
      checksums.replace('  README.md\n', '  docs/../README.md\n'),
      'utf8',
    );

    await assert.rejects(
      () => verifyDeploymentKit({ kitRoot: outDir }),
      /unsafe checksum path/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('verifyDeploymentKit rejects an untracked directory so the complete tree shape is locked', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-deployment-kit-untracked-dir-'));
  try {
    const { outDir } = await materializeSampleKit(root);
    await mkdir(join(outDir, 'empty-untracked-directory'));

    await assert.rejects(
      () => verifyDeploymentKit({ kitRoot: outDir }),
      /unexpected kit directory/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('verifyDeploymentKit rejects hard-linked files even when the tracked bytes are unchanged', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-deployment-kit-hardlink-'));
  try {
    const { outDir } = await materializeSampleKit(root);
    await link(join(outDir, 'README.md'), join(outDir, 'README-copy.md'));

    await assert.rejects(
      () => verifyDeploymentKit({ kitRoot: outDir }),
      /hard link/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('verifyDeploymentKit rejects untracked symbolic links or reparse points', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'happier-deployment-kit-untracked-link-'));
  try {
    const { outDir } = await materializeSampleKit(root);
    const outside = join(root, 'outside-directory');
    await mkdir(outside);
    try {
      await symlink(outside, join(outDir, 'untracked-link'), process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      if (error && typeof error === 'object' && ['EPERM', 'EACCES'].includes(error.code)) {
        t.skip(`host cannot create test links: ${error.code}`);
        return;
      }
      throw error;
    }

    await assert.rejects(
      () => verifyDeploymentKit({ kitRoot: outDir }),
      /symbolic link|reparse/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('verifyDeploymentKit rejects untracked special filesystem entries', async (t) => {
  if (process.platform === 'win32') {
    t.skip('portable Node APIs cannot create a Windows special filesystem entry');
    return;
  }
  const root = await mkdtemp(join(tmpdir(), 'happier-deployment-kit-special-'));
  try {
    const { outDir } = await materializeSampleKit(root);
    const specialPath = join(outDir, 'untracked-pipe');
    const mkfifo = spawnSync('mkfifo', [specialPath], { encoding: 'utf8', windowsHide: true });
    if (mkfifo.error?.code === 'ENOENT') {
      t.skip('mkfifo is unavailable on this host');
      return;
    }
    assert.equal(mkfifo.status, 0, mkfifo.stderr);

    await assert.rejects(
      () => verifyDeploymentKit({ kitRoot: outDir }),
      /special filesystem entry/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('materializeDeploymentKit rejects source bytes that do not match the manifest', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-deployment-kit-source-mismatch-'));
  try {
    const agentBytes = Buffer.from('agent payload\n');
    const controllerBytes = Buffer.from('controller payload\n');
    const agentSource = join(root, 'agent.tar.gz');
    const controllerSource = join(root, 'controller.tar.gz');
    await writeFile(agentSource, 'tampered\n');
    await writeFile(controllerSource, controllerBytes);

    await assert.rejects(
      () => materializeDeploymentKit({
        manifest: manifestForFiles(agentBytes, controllerBytes),
        sourceArtifacts: sourceArtifactsFor(agentSource, controllerSource),
        outDir: join(root, 'kit'),
      }),
      /source artifact verification failed.*agent-/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('materializeDeploymentKit rejects hard-linked source artifacts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-deployment-kit-source-hardlink-'));
  try {
    const agentBytes = Buffer.from('agent payload\n');
    const controllerBytes = Buffer.from('controller payload\n');
    const agentSource = join(root, 'agent.tar.gz');
    const agentAlias = join(root, 'agent-alias.tar.gz');
    const controllerSource = join(root, 'controller.tar.gz');
    await writeFile(agentSource, agentBytes);
    await link(agentSource, agentAlias);
    await writeFile(controllerSource, controllerBytes);

    await assert.rejects(
      () => materializeDeploymentKit({
        manifest: manifestForFiles(agentBytes, controllerBytes),
        sourceArtifacts: sourceArtifactsFor(agentSource, controllerSource),
        outDir: join(root, 'kit'),
      }),
      /hard.link/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('verifyDeploymentKit rejects post-materialization tampering', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-deployment-kit-post-tamper-'));
  try {
    const agentBytes = Buffer.from('agent payload\n');
    const controllerBytes = Buffer.from('controller payload\n');
    const agentSource = join(root, 'agent.tar.gz');
    const controllerSource = join(root, 'controller.tar.gz');
    const outDir = join(root, 'kit');
    await writeFile(agentSource, agentBytes);
    await writeFile(controllerSource, controllerBytes);
    await materializeDeploymentKit({
      manifest: manifestForFiles(agentBytes, controllerBytes),
      sourceArtifacts: sourceArtifactsFor(agentSource, controllerSource),
      outDir,
    });

    await writeFile(join(outDir, 'packs', 'agent', 'agent-windows-x64.tar.gz'), 'changed\n');
    await assert.rejects(
      () => verifyDeploymentKit({ kitRoot: outDir }),
      /checksum mismatch.*agent-windows-x64/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('materializeDeploymentKit refuses to overwrite an existing output directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-deployment-kit-existing-'));
  try {
    const bytes = Buffer.from('payload\n');
    await assert.rejects(
      () => materializeDeploymentKit({
        manifest: manifestForFiles(bytes, bytes),
        sourceArtifacts: {},
        outDir: root,
      }),
      /output directory already exists/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('verifyDeploymentKit rejects an artifact reached through a symlinked directory component', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'happier-deployment-kit-link-component-'));
  try {
    const agentBytes = Buffer.from('agent payload\n');
    const controllerBytes = Buffer.from('controller payload\n');
    const agentSource = join(root, 'agent.tar.gz');
    const controllerSource = join(root, 'controller.tar.gz');
    const outDir = join(root, 'kit');
    await writeFile(agentSource, agentBytes);
    await writeFile(controllerSource, controllerBytes);
    await materializeDeploymentKit({
      manifest: manifestForFiles(agentBytes, controllerBytes),
      sourceArtifacts: sourceArtifactsFor(agentSource, controllerSource),
      outDir,
    });

    const outside = join(root, 'outside-agent');
    await mkdir(outside);
    await writeFile(join(outside, 'agent-windows-x64.tar.gz'), agentBytes);
    const linkedDirectory = join(outDir, 'packs', 'agent');
    await rm(linkedDirectory, { recursive: true });
    try {
      await symlink(outside, linkedDirectory, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      if (error && typeof error === 'object' && ['EPERM', 'EACCES'].includes(error.code)) {
        t.skip(`host cannot create test directory links: ${error.code}`);
        return;
      }
      throw error;
    }

    await assert.rejects(
      () => verifyDeploymentKit({ kitRoot: outDir }),
      /symbolic link|reparse|linked path component/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
