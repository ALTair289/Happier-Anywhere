import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { createDeploymentKitManifest } from '../pipeline/deployment-kit/lib/deployment-kit-manifest.mjs';
import { runGitHubProjectCli } from '../pipeline/deployment-kit/assemble-github-project.mjs';
import {
  createDeploymentGitHubCatalog,
  materializeDeploymentGitHubProject,
  selectDeploymentGitHubAssets,
} from '../pipeline/deployment-kit/lib/deployment-kit-github-project.mjs';
import { assembleDeploymentGitHubProjectFromSpec } from '../pipeline/deployment-kit/lib/deployment-kit-github-project-assembly.mjs';

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

const AGENT_NAME = 'happier-v0.2.10-linux-x64.tar.gz';
const AGENT_CHECKSUMS = 'checksums-happier-v0.2.10.txt';
const CONTROLLER_NAME = 'happier-server-v0.2.10-linux-x64.tar.gz';
const CONTROLLER_CHECKSUMS = 'checksums-happier-server-v0.2.10.txt';
const CANONICAL_RELEASE_PUBLIC_KEY = new URL('./installers/happier-release.pub', import.meta.url);
const PROJECT_RELEASE_PUBLIC_KEY = [
  'untrusted comment: minisign public key 0101010101010101',
  'RWQBAQEBAQEBAQICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIC',
  '',
].join('\n');
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
  return role === 'controller' ? CONTROLLER_CHECKSUMS : AGENT_CHECKSUMS;
}

function mobileInput() {
  return {
    supportedProtocolVersions: ['1'],
    preferredProtocolVersion: '1',
    distribution: { mode: 'external-app', artifactInclusion: 'not-included' },
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
  };
}

function manifestFor(agentBytes, controllerBytes) {
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
    mobile: mobileInput(),
  });
}

function verifiedSources(root) {
  return TARGETS.flatMap((target) => ['agent', 'controller'].map((role) => {
    const name = archiveName(role, target);
    const receipt = checksumsName(role);
    return {
      artifactId: artifactId(role, target),
      archivePath: join(root, 'artifacts', name),
      archiveName: name,
      checksumsPath: join(root, 'artifacts', receipt),
      checksumsName: receipt,
    };
  }));
}

function localSpec(agentBytes, controllerBytes) {
  const manifest = manifestFor(agentBytes, controllerBytes);
  return {
    manifest: {
      kitVersion: manifest.kitVersion,
      channel: manifest.channel,
      source: {
        commitSha: manifest.source.commitSha,
        workspaceDirty: false,
      },
      versions: {
        cli: manifest.compatibility.cli,
        relay: manifest.compatibility.relay,
        webUi: manifest.compatibility.webUi,
        protocol: manifest.compatibility.protocol,
        androidApp: manifest.compatibility.androidApp,
        iosApp: manifest.compatibility.iosApp,
      },
      artifacts: manifest.artifacts,
      mobile: mobileInput(),
    },
    sources: Object.fromEntries(manifest.artifacts.map((entry) => [
      entry.id,
      {
        archive: `artifacts/${archiveName(entry.role, entry.target)}`,
        checksums: `artifacts/${checksumsName(entry.role)}`,
      },
    ])),
  };
}

async function writeSources(root, agentBytes, controllerBytes) {
  const artifacts = join(root, 'artifacts');
  await mkdir(artifacts, { recursive: true });
  for (const target of TARGETS) {
    await writeFile(join(artifacts, archiveName('agent', target)), agentBytes);
    await writeFile(join(artifacts, archiveName('controller', target)), controllerBytes);
  }
  await writeFile(
    join(artifacts, AGENT_CHECKSUMS),
    TARGETS.map((target) => `${sha256(agentBytes)}  ${archiveName('agent', target)}`).join('\n') + '\n',
  );
  await writeFile(
    join(artifacts, CONTROLLER_CHECKSUMS),
    TARGETS.map((target) => `${sha256(controllerBytes)}  ${archiveName('controller', target)}`).join('\n') + '\n',
  );
}

async function listFiles(root, relative = '') {
  const files = [];
  for (const entry of await readdir(join(root, relative), { withFileTypes: true })) {
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await listFiles(root, child));
    else files.push(child);
  }
  return files.sort();
}

test('GitHub catalog pins versioned component release contents and selects only the requested role/target assets', () => {
  const agentBytes = Buffer.from('agent\n');
  const controllerBytes = Buffer.from('controller\n');
  const catalog = createDeploymentGitHubCatalog({
    manifest: manifestFor(agentBytes, controllerBytes),
    verifiedSources: verifiedSources('C:/verified'),
    repository: 'soul667/Happier',
  });

  assert.equal(catalog.schemaVersion, 'happier-deployment-catalog/v1');
  assert.equal(catalog.repository.slug, 'soul667/Happier');
  assert.equal(catalog.repository.availability, 'not-verified');
  assert.deepEqual(catalog.profiles.controller.requiredRoles, ['agent', 'controller']);
  assert.deepEqual(catalog.profiles.agent.requiredRoles, ['agent']);
  assert.deepEqual(catalog.profiles['ssh-agent'].allowedTargetIds, [
    'darwin-arm64',
    'darwin-x64',
    'linux-arm64-glibc',
    'linux-x64-glibc',
  ]);

  const agent = catalog.artifacts.find((entry) => entry.id === 'agent-linux-x64');
  const controller = catalog.artifacts.find((entry) => entry.id === 'controller-linux-x64');
  assert.equal(agent.release.tag, 'cli-v0.2.10');
  assert.equal(
    agent.release.url,
    'https://github.com/soul667/Happier/releases/download/cli-v0.2.10/happier-v0.2.10-linux-x64.tar.gz',
  );
  assert.equal(agent.release.signatureAssetName, `${AGENT_CHECKSUMS}.minisig`);
  assert.equal(controller.release.tag, 'server-v0.2.10');
  assert.equal(
    controller.release.url,
    'https://github.com/soul667/Happier/releases/download/server-v0.2.10/happier-server-v0.2.10-linux-x64.tar.gz',
  );

  assert.deepEqual(
    selectDeploymentGitHubAssets(catalog, { profile: 'agent', targetId: 'linux-x64-glibc' }).map((entry) => entry.id),
    ['agent-linux-x64'],
  );
  assert.deepEqual(
    selectDeploymentGitHubAssets(catalog, { profile: 'controller', targetId: 'linux-x64-glibc' }).map((entry) => entry.id),
    ['agent-linux-x64', 'controller-linux-x64'],
  );
  assert.deepEqual(
    selectDeploymentGitHubAssets(catalog, { profile: 'ssh-agent', targetId: 'linux-x64-glibc' }).map((entry) => entry.id),
    ['agent-linux-x64'],
  );
  assert.throws(
    () => selectDeploymentGitHubAssets(catalog, { profile: 'agent', targetId: 'windows-arm64' }),
    /target.*not available/i,
  );
});

test('verified GitHub catalog rejects a manifest missing an entire canonical target', () => {
  const bytes = Buffer.from('payload\n');
  const manifest = structuredClone(manifestFor(bytes, bytes));
  manifest.artifacts = manifest.artifacts.filter((entry) => (
    [entry.target.os, entry.target.arch, entry.target.libc].filter(Boolean).join('-') !== 'darwin-arm64'
  ));
  const sources = verifiedSources('C:/verified')
    .filter((entry) => !entry.artifactId.endsWith('darwin-arm64'));

  assert.throws(
    () => createDeploymentGitHubCatalog({
      manifest,
      verifiedSources: sources,
      repository: 'soul667/Happier',
      repositoryAvailability: 'verified',
    }),
    /missing artifacts for canonical target.*darwin-arm64/i,
  );
});

test('GitHub project materialization rejects a verified catalog missing an entire canonical target', async () => {
  const bytes = Buffer.from('payload\n');
  const catalog = createDeploymentGitHubCatalog({
    manifest: manifestFor(bytes, bytes),
    verifiedSources: verifiedSources('C:/verified'),
    repository: 'soul667/Happier',
    repositoryAvailability: 'verified',
  });
  catalog.artifacts = catalog.artifacts.filter((entry) => (
    [entry.target.os, entry.target.arch, entry.target.libc].filter(Boolean).join('-') !== 'darwin-arm64'
  ));

  await assert.rejects(
    () => materializeDeploymentGitHubProject({
      catalog,
      outDir: 'C:/not-created/partial-project',
      releasePublicKey: PROJECT_RELEASE_PUBLIC_KEY,
      licenseText: 'MIT License\n',
    }),
    /missing artifacts for canonical target.*darwin-arm64/i,
  );
});

test('catalog selection rejects targetId swaps and duplicate role-target artifacts', () => {
  const bytes = Buffer.from('payload\n');
  const original = createDeploymentGitHubCatalog({
    manifest: manifestFor(bytes, bytes),
    verifiedSources: verifiedSources('C:/verified'),
    repository: 'soul667/Happier',
    repositoryAvailability: 'verified',
  });
  const swapped = structuredClone(original);
  const windows = swapped.artifacts.find((entry) => entry.id === 'agent-windows-x64');
  const linux = swapped.artifacts.find((entry) => entry.id === 'agent-linux-x64');
  [windows.targetId, linux.targetId] = [linux.targetId, windows.targetId];
  assert.throws(
    () => selectDeploymentGitHubAssets(swapped, { profile: 'agent', targetId: 'windows-x64' }),
    /artifact targetId mismatch/i,
  );

  const duplicated = structuredClone(original);
  duplicated.artifacts.push({
    ...structuredClone(duplicated.artifacts.find((entry) => entry.id === 'agent-windows-x64')),
    id: 'agent-windows-x64-copy',
  });
  assert.throws(
    () => selectDeploymentGitHubAssets(duplicated, { profile: 'agent', targetId: 'windows-x64' }),
    /duplicate.*role\/target\/variant/i,
  );
});

test('GitHub project materialization rejects verified catalog profile downgrades and incomplete roles', async () => {
  const bytes = Buffer.from('payload\n');
  const original = createDeploymentGitHubCatalog({
    manifest: manifestFor(bytes, bytes),
    verifiedSources: verifiedSources('C:/verified'),
    repository: 'soul667/Happier',
    repositoryAvailability: 'verified',
  });
  const attempts = [
    {
      label: 'profile-downgrade',
      catalog: structuredClone(original),
      mutate(catalog) { catalog.profiles.controller.requiredRoles = ['agent']; },
      pattern: /controller requiredRoles must match/i,
    },
    {
      label: 'missing-role',
      catalog: structuredClone(original),
      mutate(catalog) {
        catalog.artifacts = catalog.artifacts.filter((entry) => !(
          entry.role === 'controller' && entry.target.os === 'darwin' && entry.target.arch === 'arm64'
        ));
      },
      pattern: /missing controller artifact for darwin-arm64/i,
    },
  ];
  for (const attempt of attempts) {
    attempt.mutate(attempt.catalog);
    await assert.rejects(
      () => materializeDeploymentGitHubProject({
        catalog: attempt.catalog,
        outDir: `C:/not-created/${attempt.label}`,
        releasePublicKey: PROJECT_RELEASE_PUBLIC_KEY,
        licenseText: 'MIT License\n',
      }),
      attempt.pattern,
    );
  }
});

test('GitHub project assembly verifies local source receipts but emits a small source project with no binary archives', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-github-project-'));
  try {
    const specRoot = join(root, 'spec');
    const outDir = join(root, 'new-parent', 'project');
    const agentBytes = Buffer.from('agent archive\n');
    const controllerBytes = Buffer.from('controller archive\n');
    const canonicalPublicKeyBefore = await readFile(CANONICAL_RELEASE_PUBLIC_KEY, 'utf8');
    assert.equal(
      sha256(canonicalPublicKeyBefore.replaceAll('\r\n', '\n')),
      'bed66f82486a23bb89686587f9a58f3245899c412c96f84fdc85a4823ef0cb55',
    );
    await writeSources(specRoot, agentBytes, controllerBytes);
    await writeFile(join(specRoot, 'kit-spec.json'), `${JSON.stringify(localSpec(agentBytes, controllerBytes))}\n`);
    await writeFile(join(root, 'happier-anywhere.pub'), PROJECT_RELEASE_PUBLIC_KEY);

    const result = await runGitHubProjectCli({
      argv: [
        '--spec', 'spec/kit-spec.json',
        '--out', 'new-parent/project',
        '--repository', 'soul667/Happier',
        '--repository-availability', 'verified',
        '--release-public-key', 'happier-anywhere.pub',
      ],
      cwd: root,
      stdout: { write() {} },
    });

    assert.equal(result.artifactCount, TARGETS.length * 2);
    assert.equal(result.referencedArtifactBytes, TARGETS.length * (agentBytes.length + controllerBytes.length));
    assert.equal(result.embeddedArtifactBytes, 0);
    assert.match(result.projectTreeSha256, /^[a-f0-9]{64}$/);

    const files = await listFiles(outDir);
    assert.equal(files.some((path) => path.endsWith('.tar.gz')), false);
    assert.deepEqual(files, [
      '.gitattributes',
      '.github/workflows/verify.yml',
      '.gitignore',
      'LICENCE',
      'PROJECT-SHA256SUMS',
      'README.md',
      'README.zh-CN.md',
      'assets.tsv',
      'bootstrap/agent.ps1',
      'bootstrap/agent.sh',
      'bootstrap/controller.ps1',
      'bootstrap/controller.sh',
      'bootstrap/ssh-agent.ps1',
      'bootstrap/ssh-agent.sh',
      'catalog.json',
      'deployment-catalog.schema.json',
      'docs/DEPLOYMENT.md',
      'docs/DEPLOYMENT.zh-CN.md',
      'happier-release.pub',
      'scripts/fetch.ps1',
      'scripts/fetch.sh',
      'scripts/safe-extract.mjs',
      'scripts/verify-project.mjs',
      'tests/safe-extract.test.mjs',
    ]);
    assert.equal(result.projectFileCount, files.length);

    const catalog = JSON.parse(await readFile(join(outDir, 'catalog.json'), 'utf8'));
    assert.equal(catalog.artifacts.length, TARGETS.length * 2);
    assert.equal(catalog.repository.availability, 'verified');
    assert.equal(catalog.artifacts.reduce((sum, entry) => sum + entry.size, 0), result.referencedArtifactBytes);
    const licenceContent = await readFile(join(outDir, 'LICENCE'), 'utf8');
    assert.match(licenceContent, /MIT License|LICENSE/i);
    assert.equal(await readFile(join(outDir, 'happier-release.pub'), 'utf8'), PROJECT_RELEASE_PUBLIC_KEY);
    assert.equal(sha256(await readFile(CANONICAL_RELEASE_PUBLIC_KEY)), sha256(canonicalPublicKeyBefore));

    // Landing page assertions (README.md — short, human-readable)
    const readme = await readFile(join(outDir, 'README.md'), 'utf8');
    const readmeZh = await readFile(join(outDir, 'README.zh-CN.md'), 'utf8');

    // Language links
    assert.match(readme, /\[简体中文\]\(README\.zh-CN\.md\)/);
    assert.match(readmeZh, /\[English\]\(README\.md\)/);

    // Human-facing sections present
    assert.match(readme, /^# Happier Anywhere$/m);
    assert.match(readme, /## What is Happier Anywhere\?/);
    assert.match(readme, /## Quick start/);
    assert.match(readme, /docs\/DEPLOYMENT\.md/);
    assert.match(readme, /## Use it from your phone/);
    assert.match(readme, /## What you can do/);
    assert.match(readme, /## How it fits together/);
    assert.match(readme, /## Supported platforms/);
    assert.match(readme, /## Private by default/);
    assert.match(readme, /## Documentation/);
    assert.match(readme, /## Built with Happier/);
    assert.match(readme, /https:\/\/github\.com\/happier-dev\/happier/);
    assert.match(readme, /https:\/\/github\.com\/soul667\/Happier/);
    assert.match(readme, /127\.0\.0\.1:3005/);
    assert.match(readme, /Tailscale Serve/);
    assert.match(readme, /Funnel stays off/);
    assert.match(readme, /Happier App/);
    assert.match(readme, /LICENCE/);
    assert.match(readme, /end to end/);
    assert.match(readme, /\[Supported platforms\]\(#supported-platforms\)/);
    assert.match(readme, /docs\/DEPLOYMENT\.md#security-checklist/);
    assert.match(readme, /linux-x64-glibc/);
    assert.match(readme, /windows-x64/);
    assert.ok(readme.split(/\r?\n/).length < 220, 'English landing README should stay scannable');
    assert.doesNotMatch(readme, /session list --active|service status --mode user --json/);
    // It may say that no PWA is required, but must not claim PWA/offline support.
    assert.doesNotMatch(readme, /installable[ -]?PWA|offline[ -]?PWA|PWA support|service.worker/i);

    // Chinese landing page
    assert.match(readmeZh, /^# Happier Anywhere$/m);
    assert.match(readmeZh, /## Happier Anywhere 是什么\？/);
    assert.match(readmeZh, /## 快速开始/);
    assert.match(readmeZh, /## 默认保持私有/);
    assert.match(readmeZh, /## 文档/);
    assert.match(readmeZh, /## 基于 Happier 构建/);
    assert.match(readmeZh, /端到端加密/);
    assert.match(readmeZh, /\[支持的平台\]\(#支持的平台\)/);
    assert.match(readmeZh, /docs\/DEPLOYMENT\.zh-CN\.md#安全检查表/);
    assert.match(readmeZh, /linux-x64-glibc/);
    assert.match(readmeZh, /windows-x64/);
    assert.ok(readmeZh.split(/\r?\n/).length < 220, 'Chinese landing README should stay scannable');
    assert.doesNotMatch(readmeZh, /session list --active|service status --mode user --json/);
    assert.match(readmeZh, /[\u3400-\u9fff]/u);

    // Deployment guide assertions (DEPLOYMENT.md — exhaustive operations manual)
    const depEng = await readFile(join(outDir, 'docs', 'DEPLOYMENT.md'), 'utf8');
    const depZh = await readFile(join(outDir, 'docs', 'DEPLOYMENT.zh-CN.md'), 'utf8');

    // Deployment guides contain detailed procedures and safety commands
    for (const guide of [depEng, depZh]) {
      assert.match(guide, /cli-v0\.2\.10/);
      assert.match(guide, /server-v0\.2\.10/);
      assert.match(guide, /127\.0\.0\.1:3005/);
      assert.match(guide, /repository\.availability/);
      assert.match(guide, /fetch\.ps1 -Plan -Role controller -TargetId windows-x64/);
      assert.match(guide, /fetch\.sh --plan --role agent --target linux-x64-glibc/);
      assert.match(guide, /bootstrap\\controller\.ps1/);
      assert.match(guide, /bootstrap\\agent\.ps1/);
      assert.match(guide, /bootstrap\\ssh-agent\.ps1/);
      assert.match(guide, /tailscale serve/);
      assert.match(guide, /session list --active/);
      assert.match(guide, /service status --mode user --json/);
      assert.match(guide, /Take over \+ import/);
      assert.match(guide, /--cli-payload/);
      assert.match(guide, /LICENCE/);
      assert.match(guide, /Upgrade and rollback|升级与回滚/);
    }
    assert.match(depEng, /## Security checklist/);
    assert.match(depEng, /## Troubleshooting/);
    assert.match(depEng, /\(\.\.\/LICENCE\)/);
    assert.match(depZh, /## 安全检查表/);
    assert.match(depZh, /## 故障排查/);
    assert.match(depZh, /\(\.\.\/LICENCE\)/);
    // Deployment guides link back to README
    assert.match(depEng, /\[Back to README\]\(README\.md\)|back to \[README\]/i);
    assert.match(depZh, /\[English\]\(DEPLOYMENT\.md\)|返回/);

    // No PWA claim in deployment guide
    assert.doesNotMatch(depEng, /installable.PWA|offline.service.worker|installable-pwa/i);

    // Fetch script content checks
    const fetchPowerShell = await readFile(join(outDir, 'scripts', 'fetch.ps1'), 'utf8');
    assert.match(fetchPowerShell, /Get-FileHash/);
    assert.match(fetchPowerShell, /Assert-SafeAssetName/);
    assert.match(fetchPowerShell, /Resolve-StageAssetPath/);
    const fetchBash = await readFile(join(outDir, 'scripts', 'fetch.sh'), 'utf8');
    assert.match(fetchBash, /minisign/);
    assert.match(fetchBash, /Unsafe archive name metadata/);
    assert.match(fetchBash, /Expected exactly one %s asset/);
    assert.match(fetchBash, /\$\{BASH_SOURCE\[0\]\}/);
    assert.doesNotMatch(fetchBash, /\\\$\{/);

    // Generated repository verification is dependency-free and fail-closed so
    // distribution CI does not fetch mutable validation tooling.
    const verifyWorkflow = await readFile(join(outDir, '.github', 'workflows', 'verify.yml'), 'utf8');
    assert.match(verifyWorkflow, /actions\/checkout@11d5960a326750d5838078e36cf38b85af677262/);
    assert.match(verifyWorkflow, /persist-credentials:\s*false/);
    assert.match(verifyWorkflow, /node scripts\/verify-project\.mjs/);
    assert.match(verifyWorkflow, /node --test tests\/safe-extract\.test\.mjs/);
    assert.doesNotMatch(verifyWorkflow, /actions\/checkout@v\d/);

    const verifyProject = await readFile(join(outDir, 'scripts', 'verify-project.mjs'), 'utf8');
    assert.match(verifyProject, /deployment-catalog\.schema\.json/);
    assert.match(verifyProject, /PROJECT-SHA256SUMS/);
    assert.match(verifyProject, /verifyMinisign/);
    assert.match(verifyProject, /target_commitish/);

    const safeExtract = await readFile(join(outDir, 'scripts', 'safe-extract.mjs'), 'utf8');
    assert.match(safeExtract, /symbolic link|symlink/i);
    assert.match(safeExtract, /hard link|hardlink/i);
    assert.match(safeExtract, /device/i);
    assert.match(safeExtract, /reparse/i);

    const localVerification = spawnSync(process.execPath, ['scripts/verify-project.mjs'], {
      cwd: outDir,
      encoding: 'utf8',
    });
    assert.equal(
      localVerification.status,
      0,
      `generated local verification failed:\n${localVerification.stdout}\n${localVerification.stderr}`,
    );
    const safeExtractionTests = spawnSync(process.execPath, ['--test', 'tests/safe-extract.test.mjs'], {
      cwd: outDir,
      encoding: 'utf8',
    });
    assert.equal(
      safeExtractionTests.status,
      0,
      `generated safe extraction tests failed:\n${safeExtractionTests.stdout}\n${safeExtractionTests.stderr}`,
    );

    const requiredSignature = spawnSync(process.execPath, ['scripts/verify-project.mjs', '--require-project-signature'], {
      cwd: outDir,
      encoding: 'utf8',
    });
    assert.notEqual(requiredSignature.status, 0);
    assert.match(`${requiredSignature.stdout}\n${requiredSignature.stderr}`, /PROJECT-SHA256SUMS\.minisig is required/);

    const verifier = await import(`${pathToFileURL(join(outDir, 'scripts', 'verify-project.mjs')).href}?test=${Date.now()}`);
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const rawPublicKey = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
    const keyId = Buffer.from('0102030405060708', 'hex');
    const minisignPublicKey = [
      'untrusted comment: minisign public key test',
      Buffer.concat([Buffer.from('Ed'), keyId, rawPublicKey]).toString('base64'),
      '',
    ].join('\n');
    const signedMessage = Buffer.from('signed receipt\n');
    const messageSignature = sign(null, signedMessage, privateKey);
    const trustedSuffix = Buffer.from('timestamp:1\tfile:PROJECT-SHA256SUMS');
    const globalSignature = sign(null, Buffer.concat([messageSignature, trustedSuffix]), privateKey);
    const minisignSignature = [
      'untrusted comment: signature from minisign secret key',
      Buffer.concat([Buffer.from('Ed'), keyId, messageSignature]).toString('base64'),
      `trusted comment: ${trustedSuffix.toString('utf8')}`,
      globalSignature.toString('base64'),
      '',
    ].join('\n');
    assert.equal(verifier.verifyMinisign({ message: signedMessage, pubkeyFile: minisignPublicKey, sigFile: minisignSignature }), true);
    assert.equal(verifier.verifyMinisign({ message: Buffer.from('tampered\n'), pubkeyFile: minisignPublicKey, sigFile: minisignSignature }), false);

    const secondOutDir = join(root, 'new-parent', 'project-second');
    const secondResult = await runGitHubProjectCli({
      argv: [
        '--spec', 'spec/kit-spec.json',
        '--out', 'new-parent/project-second',
        '--repository', 'soul667/Happier',
        '--repository-availability', 'verified',
        '--release-public-key', 'happier-anywhere.pub',
      ],
      cwd: root,
      stdout: { write() {} },
    });
    assert.equal(secondResult.projectTreeSha256, result.projectTreeSha256);
    assert.deepEqual(await listFiles(secondOutDir), files);
    for (const file of files) {
      assert.deepEqual(
        await readFile(join(secondOutDir, ...file.split('/'))),
        await readFile(join(outDir, ...file.split('/'))),
        `consecutive generation differs: ${file}`,
      );
    }

    await writeFile(join(outDir, 'README.md'), `${readme}\nunauthorized mutation\n`, 'utf8');
    const tamperedVerification = spawnSync(process.execPath, ['scripts/verify-project.mjs'], {
      cwd: outDir,
      encoding: 'utf8',
    });
    assert.notEqual(tamperedVerification.status, 0);
    assert.match(`${tamperedVerification.stdout}\n${tamperedVerification.stderr}`, /checksum mismatch/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('GitHub project assembly rejects a checksum receipt mismatch before creating output', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-github-project-mismatch-'));
  try {
    const specRoot = join(root, 'spec');
    const outDir = join(root, 'project');
    const agentBytes = Buffer.from('agent archive\n');
    const controllerBytes = Buffer.from('controller archive\n');
    await writeSources(specRoot, agentBytes, controllerBytes);
    await writeFile(join(specRoot, 'artifacts', AGENT_CHECKSUMS), `${'0'.repeat(64)}  ${AGENT_NAME}\n`);

    await assert.rejects(
      () => assembleDeploymentGitHubProjectFromSpec({
        spec: localSpec(agentBytes, controllerBytes),
        specRoot,
        outDir,
        repository: 'soul667/Happier',
      }),
      /checksum receipt mismatch/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('GitHub project assembly requires an explicit valid Minisign project public key', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-github-project-key-'));
  try {
    const specRoot = join(root, 'spec');
    const agentBytes = Buffer.from('agent archive\n');
    const controllerBytes = Buffer.from('controller archive\n');
    await writeSources(specRoot, agentBytes, controllerBytes);

    await assert.rejects(
      () => assembleDeploymentGitHubProjectFromSpec({
        spec: localSpec(agentBytes, controllerBytes),
        specRoot,
        outDir: join(root, 'missing-key'),
        repository: 'soul667/Happier',
      }),
      /release public key.*required/i,
    );
    await assert.rejects(
      () => assembleDeploymentGitHubProjectFromSpec({
        spec: localSpec(agentBytes, controllerBytes),
        specRoot,
        outDir: join(root, 'invalid-key'),
        repository: 'soul667/Happier',
        releasePublicKey: 'not a minisign public key\n',
      }),
      /valid.*minisign public key/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('GitHub catalog rejects malformed repository slugs instead of generating arbitrary download origins', () => {
  const bytes = Buffer.from('payload\n');
  const manifest = manifestFor(bytes, bytes);
  const sources = verifiedSources('C:/verified');
  assert.throws(
    () => createDeploymentGitHubCatalog({ manifest, verifiedSources: sources, repository: 'https://evil.example/repo' }),
    /repository slug/i,
  );
});
