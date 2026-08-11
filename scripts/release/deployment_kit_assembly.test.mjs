import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { assembleDeploymentKitFromSpec } from '../pipeline/deployment-kit/lib/deployment-kit-assembly.mjs';

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

const AGENT_ARCHIVE_NAME = 'happier-v0.2.10-linux-x64.tar.gz';
const AGENT_CHECKSUMS_NAME = 'checksums-happier-v0.2.10.txt';
const CONTROLLER_ARCHIVE_NAME = 'happier-server-v0.2.10-linux-x64.tar.gz';
const CONTROLLER_CHECKSUMS_NAME = 'checksums-happier-server-v0.2.10.txt';
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

function archiveName(role, target) {
  const product = role === 'controller' ? 'happier-server' : 'happier';
  return `${product}-v0.2.10-${target.os}-${target.arch}.tar.gz`;
}

function checksumsName(role) {
  return role === 'controller' ? CONTROLLER_CHECKSUMS_NAME : AGENT_CHECKSUMS_NAME;
}

function checksumReceipt(role, bytes, lineEnding = '\n') {
  return `${TARGETS.map((target) => `${sha256(bytes)}  ${archiveName(role, target)}`).join(lineEnding)}${lineEnding}`;
}

async function writeCanonicalSources(sourceDir, agentBytes, controllerBytes) {
  await mkdir(sourceDir, { recursive: true });
  for (const target of TARGETS) {
    await writeFile(join(sourceDir, archiveName('agent', target)), agentBytes);
    await writeFile(join(sourceDir, archiveName('controller', target)), controllerBytes);
  }
  await writeFile(
    join(sourceDir, AGENT_CHECKSUMS_NAME),
    checksumReceipt('agent', agentBytes),
    'utf8',
  );
  await writeFile(
    join(sourceDir, CONTROLLER_CHECKSUMS_NAME),
    checksumReceipt('controller', controllerBytes),
    'utf8',
  );
}

function localSpec(agentBytes, controllerBytes) {
  return {
    manifest: {
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
        distribution: {
          mode: 'external-app',
          artifactInclusion: 'not-included',
        },
        android: {
          applicationId: 'dev.happier.app',
          appVersion: '0.2.10',
          runtimeVersion: '0.2.10',
          channels: ['google-play'],
        },
        ios: {
          bundleId: 'dev.happier.app',
          appVersion: '0.2.10',
          runtimeVersion: '0.2.10',
          channels: ['app-store', 'testflight'],
          genericSideloadableIpa: false,
        },
        pairing: { deepLinkScheme: 'happier', maxTtlSeconds: 300 },
        push: { mode: 'private' },
      },
    },
    sources: Object.fromEntries(TARGETS.flatMap((target) => ['agent', 'controller'].map((role) => [
      artifactId(role, target),
      {
        archive: `artifacts/${archiveName(role, target)}`,
        checksums: `artifacts/${checksumsName(role)}`,
      },
    ]))),
  };
}

test('assembleDeploymentKitFromSpec produces a verified local kit from spec-root-confined sources', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-deployment-kit-assembly-'));
  try {
    const specRoot = join(root, 'spec');
    const outDir = join(root, 'kit');
    const agentBytes = Buffer.from('linux agent\n');
    const controllerBytes = Buffer.from('linux controller\n');
    await writeCanonicalSources(join(specRoot, 'artifacts'), agentBytes, controllerBytes);

    const result = await assembleDeploymentKitFromSpec({
      spec: localSpec(agentBytes, controllerBytes),
      specRoot,
      outDir,
    });

    assert.equal(result.channel, 'local');
    assert.equal(result.artifactCount, TARGETS.length * 2);
    assert.match(result.treeSha256, /^[a-f0-9]{64}$/);
    const manifest = JSON.parse(await readFile(join(outDir, 'manifest.json'), 'utf8'));
    assert.equal(manifest.source.reproducibility, 'not-verified');
    assert.equal(manifest.mobile.distribution.mode, 'external-app');
    assert.equal(manifest.mobile.distribution.artifactInclusion, 'not-included');
    assert.equal(manifest.mobile.distribution.channelAvailabilityStatus, 'not-verified');
    assert.equal(manifest.mobile.android.requiredClaimV1AppVersion, '0.2.10');
    assert.equal(manifest.mobile.ios.requiredClaimV1AppVersion, '0.2.10');
    assert.equal(manifest.artifacts.every((artifact) => ['agent', 'controller'].includes(artifact.role)), true);
    assert.doesNotMatch(JSON.stringify(manifest.mobile), /buildId|signingCertificateSha256|artifactFormat/);
    const guide = await readFile(join(outDir, 'README.md'), 'utf8');
    assert.match(guide, /external-app/i);
    assert.match(guide, /mobile artifacts.*not included/i);
    assert.match(guide, /channel availability.*not-verified/i);
    assert.match(guide, /no force-legacy QR/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('assembly rejects source paths that escape the spec root', async () => {
  const bytes = Buffer.from('payload\n');
  const spec = localSpec(bytes, bytes);
  spec.sources['agent-linux-x64'].archive = '../outside.tar.gz';
  await assert.rejects(
    () => assembleDeploymentKitFromSpec({ spec, specRoot: 'C:/safe/spec', outDir: 'C:/safe/out' }),
    /unsafe source path|escapes/i,
  );
});

test('assembly rejects missing or extra source identities', async () => {
  const bytes = Buffer.from('payload\n');
  const missing = localSpec(bytes, bytes);
  delete missing.sources['agent-linux-x64'];
  await assert.rejects(
    () => assembleDeploymentKitFromSpec({ spec: missing, specRoot: 'C:/safe/spec', outDir: 'C:/safe/out' }),
    /source identities.*manifest/i,
  );

  const extra = localSpec(bytes, bytes);
  extra.sources.extra = 'artifacts/extra.tar.gz';
  await assert.rejects(
    () => assembleDeploymentKitFromSpec({ spec: extra, specRoot: 'C:/safe/spec', outDir: 'C:/safe/out' }),
    /source identities.*manifest/i,
  );
});

test('unsigned assembly is local-only and rejects release-looking channels', async () => {
  const bytes = Buffer.from('payload\n');
  const spec = localSpec(bytes, bytes);
  spec.manifest.channel = 'stable';
  await assert.rejects(
    () => assembleDeploymentKitFromSpec({ spec, specRoot: 'C:/safe/spec', outDir: 'C:/safe/out' }),
    /non-local.*signed release pipeline/i,
  );
});

test('assembly rejects source artifacts reached through a symlinked directory component', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'happier-deployment-kit-source-link-'));
  try {
    const specRoot = join(root, 'spec');
    const outside = join(root, 'outside');
    const agentBytes = Buffer.from('linux agent\n');
    const controllerBytes = Buffer.from('linux controller\n');
    await mkdir(specRoot);
    await mkdir(outside);
    await writeCanonicalSources(outside, agentBytes, controllerBytes);
    try {
      await symlink(outside, join(specRoot, 'artifacts'), process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      if (error && typeof error === 'object' && ['EPERM', 'EACCES'].includes(error.code)) {
        t.skip(`host cannot create test directory links: ${error.code}`);
        return;
      }
      throw error;
    }

    await assert.rejects(
      () => assembleDeploymentKitFromSpec({
        spec: localSpec(agentBytes, controllerBytes),
        specRoot,
        outDir: join(root, 'kit'),
      }),
      /source path.*symbolic link|reparse|linked source/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('assembly rejects canonical source archives with hard-link aliases', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-deployment-kit-source-hardlink-'));
  try {
    const specRoot = join(root, 'spec');
    const agentBytes = Buffer.from('linux agent\n');
    const controllerBytes = Buffer.from('linux controller\n');
    await writeCanonicalSources(join(specRoot, 'artifacts'), agentBytes, controllerBytes);
    await link(
      join(specRoot, 'artifacts', AGENT_ARCHIVE_NAME),
      join(specRoot, 'artifacts', 'agent-archive-alias.tar.gz'),
    );

    await assert.rejects(
      () => assembleDeploymentKitFromSpec({
        spec: localSpec(agentBytes, controllerBytes),
        specRoot,
        outDir: join(root, 'kit'),
      }),
      /hard.link/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('assembly rejects self-declared arbitrary files without canonical archive checksum receipts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-deployment-kit-unreceipted-'));
  try {
    const specRoot = join(root, 'spec');
    const agentBytes = Buffer.from('not a canonical agent archive\n');
    const controllerBytes = Buffer.from('not a canonical controller archive\n');
    await mkdir(join(specRoot, 'artifacts'), { recursive: true });
    await writeFile(join(specRoot, 'artifacts', 'agent.tar.gz'), agentBytes);
    await writeFile(join(specRoot, 'artifacts', 'controller.tar.gz'), controllerBytes);

    const spec = localSpec(agentBytes, controllerBytes);
    spec.sources = Object.fromEntries(Object.keys(spec.sources).map((id) => [
      id,
      id.startsWith('controller-') ? 'artifacts/controller.tar.gz' : 'artifacts/agent.tar.gz',
    ]));

    await assert.rejects(
      () => assembleDeploymentKitFromSpec({
        spec,
        specRoot,
        outDir: join(root, 'kit'),
      }),
      /canonical archive.*checksum receipt/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('assembly rejects a canonical archive whose checksum receipt disagrees with the manifest', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-deployment-kit-receipt-mismatch-'));
  try {
    const specRoot = join(root, 'spec');
    const agentBytes = Buffer.from('canonical-shaped agent archive\n');
    const controllerBytes = Buffer.from('canonical-shaped controller archive\n');
    await writeCanonicalSources(join(specRoot, 'artifacts'), agentBytes, controllerBytes);
    await writeFile(
      join(specRoot, 'artifacts', CONTROLLER_CHECKSUMS_NAME),
      `${'0'.repeat(64)}  ${CONTROLLER_ARCHIVE_NAME}\n`,
      'utf8',
    );

    await assert.rejects(
      () => assembleDeploymentKitFromSpec({
        spec: localSpec(agentBytes, controllerBytes),
        specRoot,
        outDir: join(root, 'kit'),
      }),
      /canonical archive checksum receipt mismatch/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('assembly rejects duplicate canonical archive entries in a checksum receipt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-deployment-kit-receipt-duplicate-'));
  try {
    const specRoot = join(root, 'spec');
    const agentBytes = Buffer.from('agent archive\n');
    const controllerBytes = Buffer.from('controller archive\n');
    await writeCanonicalSources(join(specRoot, 'artifacts'), agentBytes, controllerBytes);
    const receiptLine = `${sha256(agentBytes)}  ${AGENT_ARCHIVE_NAME}\n`;
    await writeFile(
      join(specRoot, 'artifacts', AGENT_CHECKSUMS_NAME),
      `${receiptLine}${receiptLine}`,
      'utf8',
    );

    await assert.rejects(
      () => assembleDeploymentKitFromSpec({
        spec: localSpec(agentBytes, controllerBytes),
        specRoot,
        outDir: join(root, 'kit'),
      }),
      /invalid canonical archive checksum receipt/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('assembly accepts canonical checksum receipts with CRLF line endings', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-deployment-kit-receipt-crlf-'));
  try {
    const specRoot = join(root, 'spec');
    const agentBytes = Buffer.from('agent archive\n');
    const controllerBytes = Buffer.from('controller archive\n');
    await writeCanonicalSources(join(specRoot, 'artifacts'), agentBytes, controllerBytes);
    await writeFile(
      join(specRoot, 'artifacts', AGENT_CHECKSUMS_NAME),
      checksumReceipt('agent', agentBytes, '\r\n'),
      'utf8',
    );
    await writeFile(
      join(specRoot, 'artifacts', CONTROLLER_CHECKSUMS_NAME),
      checksumReceipt('controller', controllerBytes, '\r\n'),
      'utf8',
    );

    const result = await assembleDeploymentKitFromSpec({
      spec: localSpec(agentBytes, controllerBytes),
      specRoot,
      outDir: join(root, 'kit'),
    });
    assert.equal(result.artifactCount, TARGETS.length * 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('assembly rejects path-qualified checksum entries that create basename ambiguity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-deployment-kit-receipt-basename-'));
  try {
    const specRoot = join(root, 'spec');
    const agentBytes = Buffer.from('agent archive\n');
    const controllerBytes = Buffer.from('controller archive\n');
    await writeCanonicalSources(join(specRoot, 'artifacts'), agentBytes, controllerBytes);
    await writeFile(
      join(specRoot, 'artifacts', AGENT_CHECKSUMS_NAME),
      `${sha256(agentBytes)}  nested/${AGENT_ARCHIVE_NAME}\n`,
      'utf8',
    );

    await assert.rejects(
      () => assembleDeploymentKitFromSpec({
        spec: localSpec(agentBytes, controllerBytes),
        specRoot,
        outDir: join(root, 'kit'),
      }),
      /invalid canonical archive checksum receipt/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('assembly rejects release receipts whose canonical archive identity does not match role and target', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-deployment-kit-identity-mismatch-'));
  try {
    const specRoot = join(root, 'spec');
    const agentBytes = Buffer.from('agent archive\n');
    const controllerBytes = Buffer.from('controller archive\n');
    await writeCanonicalSources(join(specRoot, 'artifacts'), agentBytes, controllerBytes);
    await writeFile(join(specRoot, 'artifacts', 'renamed-controller.tar.gz'), controllerBytes);
    const spec = localSpec(agentBytes, controllerBytes);
    spec.sources['controller-linux-x64'].archive = 'artifacts/renamed-controller.tar.gz';

    await assert.rejects(
      () => assembleDeploymentKitFromSpec({
        spec,
        specRoot,
        outDir: join(root, 'kit'),
      }),
      /canonical archive identity mismatch/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
