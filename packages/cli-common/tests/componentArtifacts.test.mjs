import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import cliDistBuildManifest from '../cliDistBuildManifest.cjs';

function writeCliDistFixture(cliDistDir, entrypointSource, additionalFiles = {}) {
  mkdirSync(cliDistDir, { recursive: true });
  const entrypoint = join(cliDistDir, 'index.mjs');
  writeFileSync(entrypoint, entrypointSource, 'utf8');
  for (const [relativePath, content] of Object.entries(additionalFiles)) {
    writeFileSync(join(cliDistDir, relativePath), content, 'utf8');
  }
  cliDistBuildManifest.writeCliDistBuildManifest(entrypoint);
}

async function acceptWorkspacePackageFixtures(_repoRoot, packageNames) {
  return { ok: true, built: [], skipped: [...packageNames] };
}

function writeWorkspacePackageFixture({ repoRoot, packageName, relativeDir }) {
  const packageDir = join(repoRoot, ...relativeDir);
  const distDir = join(packageDir, 'dist');
  mkdirSync(distDir, { recursive: true });
  writeFileSync(
    join(packageDir, 'package.json'),
    JSON.stringify(
      {
        name: packageName,
        version: '0.0.0',
        type: 'module',
        exports: {
          '.': {
            import: {
              default: './dist/index.mjs',
            },
          },
        },
        dependencies: {},
      },
      null,
      2,
    ),
    'utf8',
  );
  writeFileSync(join(distDir, 'index.mjs'), `export const packageName = ${JSON.stringify(packageName)};\n`, 'utf8');
}

function writeNodePackageFixture({ repoRoot, packageName, packageJson = {}, files = { 'index.js': 'module.exports = {};\n' } }) {
  const packageDir = join(repoRoot, 'node_modules', ...packageName.split('/'));
  mkdirSync(packageDir, { recursive: true });
  writeFileSync(
    join(packageDir, 'package.json'),
    JSON.stringify(
      {
        name: packageName,
        version: '1.0.0',
        ...packageJson,
      },
      null,
      2,
    ),
    'utf8',
  );
  for (const [relativePath, content] of Object.entries(files)) {
    const filePath = join(packageDir, ...relativePath.split('/'));
    mkdirSync(join(filePath, '..'), { recursive: true });
    writeFileSync(filePath, content, 'utf8');
  }
}

function writeServerSharpRuntimeFixtures({ repoRoot, platform = 'linux', arch = 'x64' }) {
  const npmPlatform = platform === 'windows' ? 'win32' : platform;
  const nativePackageName = `@img/sharp-${npmPlatform}-${arch}`;
  const libvipsPackageName = platform === 'windows'
    ? nativePackageName
    : `@img/sharp-libvips-${npmPlatform}-${arch}`;
  const optionalDependencies = {
    [nativePackageName]: '0.34.5',
    ...(libvipsPackageName === nativePackageName ? {} : { [libvipsPackageName]: '1.2.4' }),
  };

  writeNodePackageFixture({
    repoRoot,
    packageName: 'sharp',
    packageJson: {
      version: '0.34.5',
      optionalDependencies,
    },
  });
  writeNodePackageFixture({
    repoRoot,
    packageName: nativePackageName,
    packageJson: {
      version: '0.34.5',
      os: [npmPlatform],
      cpu: [arch],
      optionalDependencies: libvipsPackageName === nativePackageName
        ? {}
        : { [libvipsPackageName]: '1.2.4' },
    },
  });
  if (libvipsPackageName !== nativePackageName) {
    writeNodePackageFixture({
      repoRoot,
      packageName: libvipsPackageName,
      packageJson: {
        version: '1.2.4',
        os: [npmPlatform],
        cpu: [arch],
      },
    });
  }
}

function writeCliToolUnpackFixture(repoRoot) {
  const cliDir = join(repoRoot, 'apps', 'cli');
  const cliScriptsDir = join(cliDir, 'scripts');
  const cliToolsArchivesDir = join(cliDir, 'tools', 'archives');
  mkdirSync(cliScriptsDir, { recursive: true });
  mkdirSync(cliToolsArchivesDir, { recursive: true });
  writeFileSync(join(cliToolsArchivesDir, 'checksums.sha256'), '', 'utf8');
  writeFileSync(join(cliToolsArchivesDir, 'zellij-no-web-x86_64-unknown-linux-musl.tar.gz'), 'fake zellij archive\n', 'utf8');
  writeFileSync(join(cliToolsArchivesDir, 'zellij-LICENSE'), 'fake zellij license\n', 'utf8');
  writeFileSync(join(cliScriptsDir, 'unpack-tools.cjs'), `
const fs = require('fs');
const path = require('path');

async function unpackTools(options = {}) {
  const platformDir = options.platformDir || 'unknown';
  const toolsDir = options.toolsDir || path.resolve(__dirname, '..', 'tools');
  const unpackedPath = path.join(toolsDir, 'unpacked');
  fs.mkdirSync(unpackedPath, { recursive: true });
  const binaryName = platformDir === 'x64-win32' ? 'zellij.exe' : 'zellij';
  fs.writeFileSync(path.join(unpackedPath, binaryName), 'zellij 0.44.3 for ' + platformDir + '\\n');
  fs.writeFileSync(path.join(unpackedPath, 'zellij-LICENSE'), 'fake zellij license\\n');
  fs.writeFileSync(path.join(unpackedPath, '.happier-tools-manifest.json'), JSON.stringify({
    platformDir,
    tools: { zellij: { version: '0.44.3' } },
  }, null, 2) + '\\n');
  return { success: true, alreadyUnpacked: false };
}

module.exports = { unpackTools };
`, 'utf8');
}

function writeCliRuntimePackageFixture(
  repoRoot,
  bundledDependencies = [
    '@happier-dev/agents',
    '@happier-dev/cli-common',
    '@happier-dev/connection-supervisor',
    '@happier-dev/protocol',
    '@happier-dev/release-runtime',
  ],
) {
  const cliDir = join(repoRoot, 'apps', 'cli');
  mkdirSync(cliDir, { recursive: true });
  writeFileSync(
    join(cliDir, 'package.json'),
    JSON.stringify(
      {
        name: '@happier-dev/cli',
        version: '0.0.0',
        dependencies: {
          '@huggingface/transformers': '1.0.0',
          'node-pty': '1.0.0',
          '@homebridge/node-pty-prebuilt-multiarch': '1.0.0',
        },
        bundledDependencies,
      },
      null,
      2,
    ),
    'utf8',
  );

  writeCliToolUnpackFixture(repoRoot);

  writeWorkspacePackageFixture({ repoRoot, packageName: '@happier-dev/agents', relativeDir: ['packages', 'agents'] });
  writeWorkspacePackageFixture({ repoRoot, packageName: '@happier-dev/cli-common', relativeDir: ['packages', 'cli-common'] });
  writeWorkspacePackageFixture({ repoRoot, packageName: '@happier-dev/connection-supervisor', relativeDir: ['packages', 'connection-supervisor'] });
  writeWorkspacePackageFixture({ repoRoot, packageName: '@happier-dev/protocol', relativeDir: ['packages', 'protocol'] });
  writeWorkspacePackageFixture({ repoRoot, packageName: '@happier-dev/release-runtime', relativeDir: ['packages', 'release-runtime'] });
}

function prismaEngineFileNameForFixture({ platform = 'linux', arch = 'x64' } = {}) {
  const key = `${platform}-${arch}`;
  switch (key) {
    case 'linux-x64':
      return 'libquery_engine-debian-openssl-3.0.x.so.node';
    case 'linux-arm64':
      return 'libquery_engine-linux-arm64-openssl-3.0.x.so.node';
    case 'darwin-x64':
      return 'libquery_engine-darwin.dylib.node';
    case 'darwin-arm64':
      return 'libquery_engine-darwin-arm64.dylib.node';
    case 'windows-x64':
      return 'query_engine-windows.dll.node';
    default:
      throw new Error(`unsupported fixture platform: ${key}`);
  }
}

function writeServerPrismaEngineFixtures({
  sqliteClientDir,
  mysqlClientDir,
  postgresClientDir,
  providers = ['sqlite'],
  platform = 'linux',
  arch = 'x64',
}) {
  const engineFileName = prismaEngineFileNameForFixture({ platform, arch });
  if (providers.includes('sqlite') && sqliteClientDir) {
    writeFileSync(join(sqliteClientDir, engineFileName), 'sqlite-engine\n', 'utf8');
  }
  if (providers.includes('mysql') && mysqlClientDir) {
    writeFileSync(join(mysqlClientDir, engineFileName), 'mysql-engine\n', 'utf8');
  }
  if (postgresClientDir) {
    writeFileSync(join(postgresClientDir, engineFileName), 'postgres-engine\n', 'utf8');
  }
}

test('resolveCurrentBinaryTarget maps the current platform to a supported binary target', async () => {
  const artifacts = await import('../dist/componentArtifacts/index.js');
  assert.equal(typeof artifacts.resolveCurrentBinaryTarget, 'function');

  const linux = artifacts.resolveCurrentBinaryTarget({
    availableTargets: artifacts.CLI_BINARY_TARGETS,
    platform: 'linux',
    arch: 'x64',
  });
  assert.deepEqual(linux, {
    bunTarget: 'bun-linux-x64-baseline',
    os: 'linux',
    arch: 'x64',
    exeExt: '',
  });

  const windows = artifacts.resolveCurrentBinaryTarget({
    availableTargets: artifacts.CLI_BINARY_TARGETS,
    platform: 'win32',
    arch: 'x64',
  });
  assert.deepEqual(windows, {
    bunTarget: 'bun-windows-x64',
    os: 'windows',
    arch: 'x64',
    exeExt: '.exe',
  });
});

test('resolvePrismaSchemaEngineTarget covers every released server binary target', async () => {
  const artifacts = await import('../dist/componentArtifacts/index.js');
  assert.deepEqual(
    artifacts.SERVER_BINARY_TARGETS.map((target) => [
      `${target.os}-${target.arch}`,
      artifacts.resolvePrismaSchemaEngineTarget(target),
      artifacts.resolveExecutableName({ baseName: 'happier-server-migrate', target }),
    ]),
    [
      ['linux-x64', { binaryTarget: 'debian-openssl-3.0.x', fileName: 'schema-engine-debian-openssl-3.0.x' }, 'happier-server-migrate'],
      ['linux-arm64', { binaryTarget: 'linux-arm64-openssl-3.0.x', fileName: 'schema-engine-linux-arm64-openssl-3.0.x' }, 'happier-server-migrate'],
      ['darwin-x64', { binaryTarget: 'darwin', fileName: 'schema-engine-darwin' }, 'happier-server-migrate'],
      ['darwin-arm64', { binaryTarget: 'darwin-arm64', fileName: 'schema-engine-darwin-arm64' }, 'happier-server-migrate'],
      ['windows-x64', { binaryTarget: 'windows', fileName: 'schema-engine-windows.exe' }, 'happier-server-migrate.exe'],
    ],
  );
});

test('server runtime requirements cover Sharp 0.34.5 and Prisma for every canonical target', async () => {
  const artifacts = await import('../dist/componentArtifacts/index.js');
  assert.deepEqual(
    artifacts.SERVER_BINARY_TARGETS.map((target) => artifacts.resolveServerTargetRuntimeRequirements(target)),
    [
      {
        target: 'linux-x64',
        sharp: {
          javascript: { packageName: 'sharp', version: '0.34.5' },
          native: { packageName: '@img/sharp-linux-x64', version: '0.34.5' },
          libvips: { packageName: '@img/sharp-libvips-linux-x64', version: '1.2.4', delivery: 'separate-package' },
        },
        prisma: {
          queryEngineFileName: 'libquery_engine-debian-openssl-3.0.x.so.node',
          schemaEngineBinaryTarget: 'debian-openssl-3.0.x',
          schemaEngineFileName: 'schema-engine-debian-openssl-3.0.x',
        },
      },
      {
        target: 'linux-arm64',
        sharp: {
          javascript: { packageName: 'sharp', version: '0.34.5' },
          native: { packageName: '@img/sharp-linux-arm64', version: '0.34.5' },
          libvips: { packageName: '@img/sharp-libvips-linux-arm64', version: '1.2.4', delivery: 'separate-package' },
        },
        prisma: {
          queryEngineFileName: 'libquery_engine-linux-arm64-openssl-3.0.x.so.node',
          schemaEngineBinaryTarget: 'linux-arm64-openssl-3.0.x',
          schemaEngineFileName: 'schema-engine-linux-arm64-openssl-3.0.x',
        },
      },
      {
        target: 'darwin-x64',
        sharp: {
          javascript: { packageName: 'sharp', version: '0.34.5' },
          native: { packageName: '@img/sharp-darwin-x64', version: '0.34.5' },
          libvips: { packageName: '@img/sharp-libvips-darwin-x64', version: '1.2.4', delivery: 'separate-package' },
        },
        prisma: {
          queryEngineFileName: 'libquery_engine-darwin.dylib.node',
          schemaEngineBinaryTarget: 'darwin',
          schemaEngineFileName: 'schema-engine-darwin',
        },
      },
      {
        target: 'darwin-arm64',
        sharp: {
          javascript: { packageName: 'sharp', version: '0.34.5' },
          native: { packageName: '@img/sharp-darwin-arm64', version: '0.34.5' },
          libvips: { packageName: '@img/sharp-libvips-darwin-arm64', version: '1.2.4', delivery: 'separate-package' },
        },
        prisma: {
          queryEngineFileName: 'libquery_engine-darwin-arm64.dylib.node',
          schemaEngineBinaryTarget: 'darwin-arm64',
          schemaEngineFileName: 'schema-engine-darwin-arm64',
        },
      },
      {
        target: 'windows-x64',
        sharp: {
          javascript: { packageName: 'sharp', version: '0.34.5' },
          native: { packageName: '@img/sharp-win32-x64', version: '0.34.5' },
          libvips: { packageName: '@img/sharp-win32-x64', version: '0.34.5', delivery: 'embedded-in-native-package' },
        },
        prisma: {
          queryEngineFileName: 'query_engine-windows.dll.node',
          schemaEngineBinaryTarget: 'windows',
          schemaEngineFileName: 'schema-engine-windows.exe',
        },
      },
    ],
  );
});

test('server runtime preflight rejects empty targets and unsupported provider selections', async () => {
  const artifacts = await import('../dist/componentArtifacts/index.js');
  assert.deepEqual(artifacts.resolveRequestedServerDbProviders(' all '), ['sqlite', 'mysql']);
  assert.deepEqual(artifacts.resolveRequestedServerDbProviders('mysql,sqlite,mysql'), ['mysql', 'sqlite']);
  assert.throws(
    () => artifacts.resolveRequestedServerDbProviders('postgres'),
    /unsupported server database provider selection/,
  );
  await assert.rejects(
    artifacts.inspectServerArtifactRuntimeDependencies({
      repoRoot: '/not-inspected-without-targets',
      targets: [],
      buildDbProviders: 'sqlite',
    }),
    /requires at least one target/,
  );
});

test('server runtime preflight reports a structured path-free BLOCKED result for missing target sidecars', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'component-artifacts-runtime-preflight-'));
  try {
    const repoRoot = join(tempRoot, 'private-workspace-name');
    const sqliteClientDir = join(repoRoot, 'apps', 'server', 'generated', 'sqlite-client');
    const postgresClientDir = join(repoRoot, 'node_modules', '.prisma', 'client');
    mkdirSync(sqliteClientDir, { recursive: true });
    mkdirSync(postgresClientDir, { recursive: true });
    writeServerPrismaEngineFixtures({ sqliteClientDir, postgresClientDir, providers: ['sqlite'] });
    writeNodePackageFixture({
      repoRoot,
      packageName: 'sharp',
      packageJson: { version: '0.34.5' },
    });

    const artifacts = await import('../dist/componentArtifacts/index.js');
    const target = artifacts.SERVER_BINARY_TARGETS.find((candidate) => candidate.os === 'linux' && candidate.arch === 'x64');
    const report = await artifacts.inspectServerArtifactRuntimeDependencies({
      repoRoot,
      targets: [target],
      buildDbProviders: 'sqlite',
    });
    assert.deepEqual(report, {
      status: 'BLOCKED',
      code: 'SERVER_ARTIFACT_RUNTIME_DEPENDENCIES_UNAVAILABLE',
      targets: [{
        target: 'linux-x64',
        failures: [
          {
            dependency: 'sharp-native',
            packageName: '@img/sharp-linux-x64',
            expectedVersion: '0.34.5',
            reason: 'missing-package',
          },
          {
            dependency: 'sharp-libvips',
            packageName: '@img/sharp-libvips-linux-x64',
            expectedVersion: '1.2.4',
            reason: 'missing-package',
          },
        ],
      }],
    });

    await assert.rejects(
      artifacts.assertServerArtifactRuntimeDependencies({
        repoRoot,
        targets: [target],
        buildDbProviders: 'sqlite',
      }),
      (error) => {
        assert.equal(error?.name, 'ServerArtifactRuntimeDependenciesBlockedError');
        assert.deepEqual(error?.report, report);
        assert.equal(error?.message, JSON.stringify(report));
        assert.doesNotMatch(error?.message ?? '', /private-workspace-name|[A-Z]:\\|\\\\/i);
        return true;
      },
    );
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('server runtime preflight confirms Sharp sidecars and Prisma engines for all canonical targets', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'component-artifacts-runtime-ready-'));
  try {
    const repoRoot = join(tempRoot, 'repo');
    const sqliteClientDir = join(repoRoot, 'apps', 'server', 'generated', 'sqlite-client');
    const mysqlClientDir = join(repoRoot, 'apps', 'server', 'generated', 'mysql-client');
    const postgresClientDir = join(repoRoot, 'node_modules', '.prisma', 'client');
    mkdirSync(sqliteClientDir, { recursive: true });
    mkdirSync(mysqlClientDir, { recursive: true });
    mkdirSync(postgresClientDir, { recursive: true });

    const artifacts = await import('../dist/componentArtifacts/index.js');
    for (const target of artifacts.SERVER_BINARY_TARGETS) {
      writeServerSharpRuntimeFixtures({ repoRoot, platform: target.os, arch: target.arch });
      writeServerPrismaEngineFixtures({
        sqliteClientDir,
        mysqlClientDir,
        postgresClientDir,
        providers: ['sqlite', 'mysql'],
        platform: target.os,
        arch: target.arch,
      });
    }

    const report = await artifacts.inspectServerArtifactRuntimeDependencies({
      repoRoot,
      targets: artifacts.SERVER_BINARY_TARGETS,
      buildDbProviders: 'all',
    });
    assert.deepEqual(report, {
      status: 'READY',
      code: 'SERVER_ARTIFACT_RUNTIME_DEPENDENCIES_READY',
      targets: artifacts.SERVER_BINARY_TARGETS.map((target) => ({
        target: `${target.os}-${target.arch}`,
        failures: [],
      })),
    });
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('server runtime preflight rejects mismatched Sharp sidecar versions without echoing actual metadata', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'component-artifacts-runtime-version-'));
  try {
    const repoRoot = join(tempRoot, 'repo');
    const sqliteClientDir = join(repoRoot, 'apps', 'server', 'generated', 'sqlite-client');
    const postgresClientDir = join(repoRoot, 'node_modules', '.prisma', 'client');
    mkdirSync(sqliteClientDir, { recursive: true });
    mkdirSync(postgresClientDir, { recursive: true });
    writeServerPrismaEngineFixtures({ sqliteClientDir, postgresClientDir, providers: ['sqlite'] });
    writeServerSharpRuntimeFixtures({ repoRoot });
    writeNodePackageFixture({
      repoRoot,
      packageName: '@img/sharp-linux-x64',
      packageJson: { version: '0.34.4', os: ['linux'], cpu: ['x64'] },
    });

    const artifacts = await import('../dist/componentArtifacts/index.js');
    const target = artifacts.SERVER_BINARY_TARGETS.find((candidate) => candidate.os === 'linux' && candidate.arch === 'x64');
    const report = await artifacts.inspectServerArtifactRuntimeDependencies({
      repoRoot,
      targets: [target],
      buildDbProviders: 'sqlite',
    });
    assert.deepEqual(report, {
      status: 'BLOCKED',
      code: 'SERVER_ARTIFACT_RUNTIME_DEPENDENCIES_UNAVAILABLE',
      targets: [{
        target: 'linux-x64',
        failures: [{
          dependency: 'sharp-native',
          packageName: '@img/sharp-linux-x64',
          expectedVersion: '0.34.5',
          reason: 'version-mismatch',
        }],
      }],
    });
    assert.doesNotMatch(JSON.stringify(report), /0\.34\.4/);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('server artifact builder blocks before commands or payload writes when runtime dependencies are unavailable', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'component-artifacts-runtime-builder-block-'));
  try {
    const repoRoot = join(tempRoot, 'repo');
    const payloadDir = join(tempRoot, 'payload');
    const entrypoint = join(repoRoot, 'apps', 'server', 'sources', 'main.light.ts');
    const sqliteClientDir = join(repoRoot, 'apps', 'server', 'generated', 'sqlite-client');
    const postgresClientDir = join(repoRoot, 'node_modules', '.prisma', 'client');
    mkdirSync(join(entrypoint, '..'), { recursive: true });
    mkdirSync(sqliteClientDir, { recursive: true });
    mkdirSync(postgresClientDir, { recursive: true });
    writeFileSync(entrypoint, 'export {};\n', 'utf8');
    writeServerPrismaEngineFixtures({ sqliteClientDir, postgresClientDir, providers: ['sqlite'] });

    const artifacts = await import('../dist/componentArtifacts/index.js');
    const target = artifacts.SERVER_BINARY_TARGETS.find((candidate) => candidate.os === 'linux' && candidate.arch === 'x64');
    let commandCalls = 0;
    await assert.rejects(
      artifacts.buildServerBinaryArtifactPayload({
        repoRoot,
        payloadDir,
        target,
        entrypoint,
        buildDbProviders: 'sqlite',
        commandProbe: () => true,
        runCommand: () => { commandCalls += 1; },
      }),
      (error) => error?.name === 'ServerArtifactRuntimeDependenciesBlockedError',
    );
    assert.equal(commandCalls, 0);
    assert.equal(existsSync(payloadDir), false);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('server artifact preflight honors the supplied build environment provider selection', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'component-artifacts-runtime-provider-env-'));
  try {
    const repoRoot = join(tempRoot, 'repo');
    const payloadDir = join(tempRoot, 'payload');
    const entrypoint = join(repoRoot, 'apps', 'server', 'sources', 'main.light.ts');
    const sqliteClientDir = join(repoRoot, 'apps', 'server', 'generated', 'sqlite-client');
    const postgresClientDir = join(repoRoot, 'node_modules', '.prisma', 'client');
    mkdirSync(join(entrypoint, '..'), { recursive: true });
    mkdirSync(sqliteClientDir, { recursive: true });
    mkdirSync(postgresClientDir, { recursive: true });
    writeFileSync(entrypoint, 'export {};\n', 'utf8');
    writeServerPrismaEngineFixtures({ sqliteClientDir, postgresClientDir, providers: ['sqlite'] });
    writeServerSharpRuntimeFixtures({ repoRoot });

    const artifacts = await import('../dist/componentArtifacts/index.js');
    const target = artifacts.SERVER_BINARY_TARGETS.find((candidate) => candidate.os === 'linux' && candidate.arch === 'x64');
    await assert.rejects(
      artifacts.buildServerBinaryArtifactPayload({
        repoRoot,
        payloadDir,
        target,
        entrypoint,
        env: { HAPPIER_BUILD_DB_PROVIDERS: 'sqlite' },
        commandProbe: () => true,
        runCommand: () => {
          throw new Error('preflight-passed-provider-env');
        },
      }),
      (error) => {
        assert.equal(error?.name, 'Error');
        assert.match(error?.message ?? '', /preflight-passed-provider-env/);
        return true;
      },
    );
    assert.equal(existsSync(payloadDir), false);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('commandExists does not execute shell metacharacters on Unix', async () => {
  if (process.platform === 'win32') return;

  const tempRoot = mkdtempSync(join(tmpdir(), 'component-artifacts-command-exists-'));
  try {
    const probePath = join(tempRoot, 'probe');
    const artifacts = await import('../dist/componentArtifacts/index.js');
    assert.equal(artifacts.commandExists(`missing-command; touch ${JSON.stringify(probePath)}`), false);
    assert.equal(existsSync(probePath), false);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('buildCliBinaryArtifactPayload compiles the local CLI binary into the payload dir', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'component-artifacts-cli-'));
  try {
    const repoRoot = join(tempRoot, 'repo');
    const payloadDir = join(tempRoot, 'payload');
    const cliDistDir = join(repoRoot, 'apps', 'cli', 'dist');
    const cliScriptsDir = join(repoRoot, 'apps', 'cli', 'scripts');
    const cliShimsDir = join(cliScriptsDir, 'shims');
    const cliRuntimeDir = join(cliScriptsDir, 'runtime');
    const transformersDir = join(repoRoot, 'node_modules', '@huggingface', 'transformers');
    const ortDir = join(repoRoot, 'node_modules', 'onnxruntime-node');
    const ortCommonDir = join(repoRoot, 'node_modules', 'onnxruntime-common');
    const nodePtyDir = join(repoRoot, 'node_modules', 'node-pty');
    const homebridgePtyDir = join(repoRoot, 'node_modules', '@homebridge', 'node-pty-prebuilt-multiarch');

    mkdirSync(cliDistDir, { recursive: true });
    mkdirSync(cliShimsDir, { recursive: true });
    mkdirSync(cliRuntimeDir, { recursive: true });
    mkdirSync(transformersDir, { recursive: true });
    mkdirSync(ortDir, { recursive: true });
    mkdirSync(ortCommonDir, { recursive: true });
    mkdirSync(nodePtyDir, { recursive: true });
    mkdirSync(homebridgePtyDir, { recursive: true });
    writeFileSync(join(repoRoot, 'package.json'), JSON.stringify({ name: 'repo', private: true }, null, 2));
    writeCliRuntimePackageFixture(repoRoot);
    writeCliDistFixture(cliDistDir, 'console.log("cli");\n');
    writeFileSync(join(cliScriptsDir, 'childProcessOptions.cjs'), 'module.exports = { withWindowsHide: (input) => input };\n', 'utf8');
    writeFileSync(join(cliScriptsDir, 'claude_launcher_runtime.cjs'), 'module.exports = { getClaudeCliPath: () => "claude", runClaudeCli: () => {} };\n', 'utf8');
    writeFileSync(join(cliScriptsDir, 'claude_local_launcher.cjs'), 'require("./claude_launcher_runtime.cjs");\n', 'utf8');
    writeFileSync(join(cliScriptsDir, 'claude_remote_launcher.cjs'), 'require("./claude_launcher_runtime.cjs");\n', 'utf8');
    writeFileSync(join(cliScriptsDir, 'session_hook_forwarder.cjs'), 'console.log("session");\n', 'utf8');
    writeFileSync(join(cliScriptsDir, 'permission_hook_forwarder.cjs'), 'console.log("permission");\n', 'utf8');
    writeFileSync(join(cliScriptsDir, 'ripgrep_launcher.cjs'), 'require("./childProcessOptions.cjs");\n', 'utf8');
    writeFileSync(join(cliScriptsDir, 'statusline_forwarder.cjs'), 'console.log("statusline");\n', 'utf8');
    writeFileSync(join(cliScriptsDir, 'terminal_launch_spec_runner.cjs'), 'console.log("terminal launch spec");\n', 'utf8');
    writeFileSync(join(cliScriptsDir, 'node_pty_relay.cjs'), 'console.log("node pty relay");\n', 'utf8');
    writeFileSync(join(cliRuntimeDir, 'loadTransformersFromRuntime.mjs'), 'export const env = {}; export async function pipeline() { return () => null; }\n', 'utf8');
    writeFileSync(join(cliShimsDir, 'git'), '#!/bin/sh\nexit 0\n', 'utf8');
    writeFileSync(join(cliShimsDir, 'rg'), '#!/bin/sh\nexit 0\n', 'utf8');
    writeFileSync(
      join(transformersDir, 'package.json'),
      JSON.stringify({ name: '@huggingface/transformers', version: '1.0.0', dependencies: { 'onnxruntime-node': '1.0.0' } }, null, 2),
    );
    writeFileSync(join(transformersDir, 'index.js'), 'module.exports = {};\n', 'utf8');
    if (process.platform !== 'win32') {
      const externalToolPath = join(repoRoot, 'external-transformers-tool.js');
      writeFileSync(externalToolPath, 'console.log("tool");\n', 'utf8');
      mkdirSync(join(transformersDir, 'node_modules', '.bin'), { recursive: true });
      symlinkSync(externalToolPath, join(transformersDir, 'node_modules', '.bin', 'external-transformers-tool'));
    }
    writeFileSync(
      join(ortDir, 'package.json'),
      JSON.stringify({ name: 'onnxruntime-node', version: '1.0.0', dependencies: { 'onnxruntime-common': '1.0.0' } }, null, 2),
    );
    writeFileSync(join(ortDir, 'index.js'), 'module.exports = {};\n', 'utf8');
    writeFileSync(
      join(ortCommonDir, 'package.json'),
      JSON.stringify({ name: 'onnxruntime-common', version: '1.0.0', dependencies: {} }, null, 2),
    );
    writeFileSync(join(ortCommonDir, 'index.js'), 'module.exports = {};\n', 'utf8');
    writeFileSync(
      join(nodePtyDir, 'package.json'),
      JSON.stringify({ name: 'node-pty', version: '1.0.0', dependencies: {} }, null, 2),
    );
    writeFileSync(join(nodePtyDir, 'index.js'), 'module.exports = { spawn() {} };\n', 'utf8');
    writeFileSync(
      join(homebridgePtyDir, 'package.json'),
      JSON.stringify({ name: '@homebridge/node-pty-prebuilt-multiarch', version: '1.0.0', dependencies: {} }, null, 2),
    );
    writeFileSync(join(homebridgePtyDir, 'index.js'), 'module.exports = { spawn() {} };\n', 'utf8');

    const artifacts = await import('../dist/componentArtifacts/index.js');
    const compileCalls = [];
    const runCalls = [];
    const result = await artifacts.buildCliBinaryArtifactPayload({
      repoRoot,
      payloadDir,
      ensureWorkspacePackagesBuiltByName: acceptWorkspacePackageFixtures,
      target: artifacts.resolveCurrentBinaryTarget({
        availableTargets: artifacts.CLI_BINARY_TARGETS,
        platform: 'linux',
        arch: 'x64',
      }),
      commandProbe: () => true,
      runCommand: (cmd, args) => {
        runCalls.push({ cmd, args });
        writeCliDistFixture(cliDistDir, 'console.log("cli");\n');
      },
      compileBinary: async ({ outfile, externals }) => {
        compileCalls.push({ outfile, externals });
        writeFileSync(outfile, '#!/bin/sh\necho happier\n', 'utf8');
      },
    });

    assert.equal(result.executableName, 'happier');
    assert.equal(result.entrypoint, 'happier');
    assert.deepEqual(runCalls, []);
    assert.equal(compileCalls.length, 1);
    assert.deepEqual(compileCalls[0].externals.sort(), [
      '@homebridge/node-pty-prebuilt-multiarch',
      '@huggingface/transformers',
      'node-pty',
    ]);
    assert.equal(readFileSync(join(payloadDir, 'happier'), 'utf8'), '#!/bin/sh\necho happier\n');
    assert.equal(readFileSync(join(payloadDir, 'package-dist', 'index.mjs'), 'utf8'), 'console.log("cli");\n');
    assert.equal(
      readFileSync(join(payloadDir, 'node_modules', '@happier-dev', 'protocol', 'dist', 'index.mjs'), 'utf8'),
      'export const packageName = "@happier-dev/protocol";\n',
    );
    assert.equal(
      readFileSync(join(payloadDir, 'node_modules', '@happier-dev', 'connection-supervisor', 'dist', 'index.mjs'), 'utf8'),
      'export const packageName = "@happier-dev/connection-supervisor";\n',
    );
    assert.equal(readFileSync(join(payloadDir, 'node_modules', 'node-pty', 'index.js'), 'utf8'), 'module.exports = { spawn() {} };\n');
    assert.equal(
      readFileSync(join(payloadDir, 'node_modules', '@homebridge', 'node-pty-prebuilt-multiarch', 'index.js'), 'utf8'),
      'module.exports = { spawn() {} };\n',
    );
    assert.equal(
      readFileSync(join(payloadDir, 'scripts', 'claude_launcher_runtime.cjs'), 'utf8'),
      'module.exports = { getClaudeCliPath: () => "claude", runClaudeCli: () => {} };\n',
    );
    assert.equal(
      readFileSync(join(payloadDir, 'scripts', 'claude_local_launcher.cjs'), 'utf8'),
      'require("./claude_launcher_runtime.cjs");\n',
    );
    assert.equal(
      readFileSync(join(payloadDir, 'scripts', 'childProcessOptions.cjs'), 'utf8'),
      'module.exports = { withWindowsHide: (input) => input };\n',
    );
    assert.equal(
      readFileSync(join(payloadDir, 'scripts', 'runtime', 'loadTransformersFromRuntime.mjs'), 'utf8'),
      'export const env = {}; export async function pipeline() { return () => null; }\n',
    );
    assert.equal(readFileSync(join(payloadDir, 'scripts', 'shims', 'git'), 'utf8'), '#!/bin/sh\nexit 0\n');
    assert.equal(readFileSync(join(payloadDir, 'tools', 'unpacked', 'zellij'), 'utf8'), 'zellij 0.44.3 for x64-linux\n');
    assert.deepEqual(
      JSON.parse(readFileSync(join(payloadDir, 'tools', 'unpacked', '.happier-tools-manifest.json'), 'utf8')),
      {
        platformDir: 'x64-linux',
        tools: { zellij: { version: '0.44.3' } },
      },
    );
    assert.equal(existsSync(join(payloadDir, 'tools', 'archives')), false);
    if (process.platform !== 'win32') {
      assert.equal(
        existsSync(join(payloadDir, 'node_modules', '@huggingface', 'transformers', 'node_modules', '.bin')),
        false,
        'runtime artifacts must not retain package-manager shims that escape the payload',
      );
    }
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('buildCliBinaryArtifactPayload removes compile-generated node_modules before staging canonical runtime packages', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'component-artifacts-cli-compile-node-modules-'));
  try {
    const repoRoot = join(tempRoot, 'repo');
    const payloadDir = join(tempRoot, 'payload');
    const cliDistDir = join(repoRoot, 'apps', 'cli', 'dist');
    const cliScriptsDir = join(repoRoot, 'apps', 'cli', 'scripts');
    const cliRuntimeDir = join(cliScriptsDir, 'runtime');
    const transformersDir = join(repoRoot, 'node_modules', '@huggingface', 'transformers');
    const ortDir = join(repoRoot, 'node_modules', 'onnxruntime-node');
    const nodePtyDir = join(repoRoot, 'node_modules', 'node-pty');
    const homebridgePtyDir = join(repoRoot, 'node_modules', '@homebridge', 'node-pty-prebuilt-multiarch');
    const tarDir = join(repoRoot, 'node_modules', 'tar');
    const chownrDir = join(repoRoot, 'node_modules', 'chownr');

    mkdirSync(cliDistDir, { recursive: true });
    mkdirSync(join(cliScriptsDir, 'shims'), { recursive: true });
    mkdirSync(cliRuntimeDir, { recursive: true });
    mkdirSync(transformersDir, { recursive: true });
    mkdirSync(ortDir, { recursive: true });
    mkdirSync(nodePtyDir, { recursive: true });
    mkdirSync(homebridgePtyDir, { recursive: true });
    mkdirSync(tarDir, { recursive: true });
    mkdirSync(chownrDir, { recursive: true });
    writeFileSync(join(repoRoot, 'package.json'), JSON.stringify({ name: 'repo', private: true }, null, 2));
    writeCliRuntimePackageFixture(repoRoot);
    writeFileSync(
      join(repoRoot, 'apps', 'cli', 'package.json'),
      JSON.stringify(
        {
          name: '@happier-dev/cli',
          version: '0.0.0',
          dependencies: {
            '@huggingface/transformers': '1.0.0',
            'node-pty': '1.0.0',
            '@homebridge/node-pty-prebuilt-multiarch': '1.0.0',
            tar: '7.0.0',
          },
          bundledDependencies: [
            '@happier-dev/agents',
            '@happier-dev/cli-common',
            '@happier-dev/protocol',
            '@happier-dev/release-runtime',
          ],
        },
        null,
        2,
      ),
      'utf8',
    );
    writeCliDistFixture(cliDistDir, 'console.log("cli");\n');
    writeFileSync(join(cliScriptsDir, 'childProcessOptions.cjs'), 'module.exports = { withWindowsHide: (input) => input };\n', 'utf8');
    writeFileSync(join(cliScriptsDir, 'claude_launcher_runtime.cjs'), 'module.exports = { getClaudeCliPath: () => "claude", runClaudeCli: () => {} };\n', 'utf8');
    writeFileSync(join(cliScriptsDir, 'claude_local_launcher.cjs'), 'require("./claude_launcher_runtime.cjs");\n', 'utf8');
    writeFileSync(join(cliScriptsDir, 'claude_remote_launcher.cjs'), 'require("./claude_launcher_runtime.cjs");\n', 'utf8');
    writeFileSync(join(cliScriptsDir, 'session_hook_forwarder.cjs'), 'console.log("session");\n', 'utf8');
    writeFileSync(join(cliScriptsDir, 'permission_hook_forwarder.cjs'), 'console.log("permission");\n', 'utf8');
    writeFileSync(join(cliScriptsDir, 'ripgrep_launcher.cjs'), 'require("./childProcessOptions.cjs");\n', 'utf8');
    writeFileSync(join(cliScriptsDir, 'statusline_forwarder.cjs'), 'console.log("statusline");\n', 'utf8');
    writeFileSync(join(cliScriptsDir, 'terminal_launch_spec_runner.cjs'), 'console.log("terminal launch spec");\n', 'utf8');
    writeFileSync(join(cliScriptsDir, 'node_pty_relay.cjs'), 'console.log("node pty relay");\n', 'utf8');
    writeFileSync(join(cliRuntimeDir, 'loadTransformersFromRuntime.mjs'), 'export const env = {}; export async function pipeline() { return () => null; }\n', 'utf8');
    writeFileSync(join(cliScriptsDir, 'shims', 'git'), '#!/bin/sh\nexit 0\n', 'utf8');
    writeFileSync(
      join(transformersDir, 'package.json'),
      JSON.stringify({ name: '@huggingface/transformers', version: '1.0.0', dependencies: { 'onnxruntime-node': '1.0.0' } }, null, 2),
    );
    writeFileSync(join(transformersDir, 'index.js'), 'module.exports = {};\n', 'utf8');
    writeFileSync(
      join(ortDir, 'package.json'),
      JSON.stringify({ name: 'onnxruntime-node', version: '1.0.0', dependencies: {} }, null, 2),
    );
    writeFileSync(join(ortDir, 'index.js'), 'module.exports = {};\n', 'utf8');
    writeFileSync(
      join(nodePtyDir, 'package.json'),
      JSON.stringify({ name: 'node-pty', version: '1.0.0', dependencies: {} }, null, 2),
    );
    writeFileSync(join(nodePtyDir, 'index.js'), 'module.exports = { spawn() {} };\n', 'utf8');
    writeFileSync(
      join(homebridgePtyDir, 'package.json'),
      JSON.stringify({ name: '@homebridge/node-pty-prebuilt-multiarch', version: '1.0.0', dependencies: {} }, null, 2),
    );
    writeFileSync(join(homebridgePtyDir, 'index.js'), 'module.exports = { spawn() {} };\n', 'utf8');
    writeFileSync(
      join(tarDir, 'package.json'),
      JSON.stringify({ name: 'tar', version: '7.0.0', type: 'module', dependencies: { chownr: '^3.0.0' } }, null, 2),
      'utf8',
    );
    writeFileSync(join(tarDir, 'index.js'), 'export {};\n', 'utf8');
    writeFileSync(
      join(chownrDir, 'package.json'),
      JSON.stringify({ name: 'chownr', version: '3.0.0', type: 'module' }, null, 2),
      'utf8',
    );
    writeFileSync(join(chownrDir, 'index.js'), 'export const chownr = () => {};\n', 'utf8');

    const artifacts = await import('../dist/componentArtifacts/index.js');
    await artifacts.buildCliBinaryArtifactPayload({
      repoRoot,
      payloadDir,
      ensureWorkspacePackagesBuiltByName: acceptWorkspacePackageFixtures,
      target: artifacts.resolveCurrentBinaryTarget({
        availableTargets: artifacts.CLI_BINARY_TARGETS,
        platform: 'linux',
        arch: 'x64',
      }),
      commandProbe: () => true,
      runCommand: () => {
        writeCliDistFixture(cliDistDir, 'console.log("cli");\n');
      },
      compileBinary: async ({ outfile }) => {
        const compileChownrDir = join(payloadDir, 'node_modules', 'chownr');
        const compileTarFsDir = join(payloadDir, 'node_modules', 'tar-fs');
        mkdirSync(compileChownrDir, { recursive: true });
        mkdirSync(compileTarFsDir, { recursive: true });
        writeFileSync(outfile, '#!/bin/sh\necho happier\n', 'utf8');
        writeFileSync(
          join(compileChownrDir, 'package.json'),
          JSON.stringify({ name: 'chownr', version: '1.1.4', main: 'index.js' }, null, 2),
          'utf8',
        );
        writeFileSync(join(compileChownrDir, 'index.js'), 'module.exports = { legacy: true };\n', 'utf8');
        writeFileSync(
          join(compileTarFsDir, 'package.json'),
          JSON.stringify({ name: 'tar-fs', version: '2.1.4', main: 'index.js' }, null, 2),
          'utf8',
        );
        writeFileSync(join(compileTarFsDir, 'index.js'), 'module.exports = { tarFs: true };\n', 'utf8');
      },
    });

    assert.equal(existsSync(join(payloadDir, 'node_modules', 'chownr', 'package.json')), false);
    assert.equal(existsSync(join(payloadDir, 'node_modules', 'tar-fs', 'package.json')), false);
    assert.equal(
      JSON.parse(readFileSync(join(payloadDir, 'node_modules', 'tar', 'node_modules', 'chownr', 'package.json'), 'utf8')).version,
      '3.0.0',
    );
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('buildCliBinaryArtifactPayload snapshots CLI dist before compile/copy so later live-dist churn does not break packaging', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'component-artifacts-cli-dist-snapshot-'));
  try {
    const repoRoot = join(tempRoot, 'repo');
    const payloadDir = join(tempRoot, 'payload');
    const cliDistDir = join(repoRoot, 'apps', 'cli', 'dist');
    const cliScriptsDir = join(repoRoot, 'apps', 'cli', 'scripts');
    const cliRuntimeDir = join(cliScriptsDir, 'runtime');
    const cliShimsDir = join(cliScriptsDir, 'shims');
    const transformersDir = join(repoRoot, 'node_modules', '@huggingface', 'transformers');
    const ortDir = join(repoRoot, 'node_modules', 'onnxruntime-node');
    const ortCommonDir = join(repoRoot, 'node_modules', 'onnxruntime-common');
    const nodePtyDir = join(repoRoot, 'node_modules', 'node-pty');
    const homebridgePtyDir = join(repoRoot, 'node_modules', '@homebridge', 'node-pty-prebuilt-multiarch');

    mkdirSync(cliScriptsDir, { recursive: true });
    mkdirSync(cliRuntimeDir, { recursive: true });
    mkdirSync(cliShimsDir, { recursive: true });
    mkdirSync(transformersDir, { recursive: true });
    mkdirSync(ortDir, { recursive: true });
    mkdirSync(ortCommonDir, { recursive: true });
    mkdirSync(nodePtyDir, { recursive: true });
    mkdirSync(homebridgePtyDir, { recursive: true });

    writeFileSync(join(repoRoot, 'package.json'), JSON.stringify({ name: 'repo', private: true }, null, 2));
    writeCliRuntimePackageFixture(repoRoot);
    writeFileSync(join(cliScriptsDir, 'childProcessOptions.cjs'), 'module.exports = { withWindowsHide: (input) => input };\n', 'utf8');
    writeFileSync(join(cliScriptsDir, 'claude_launcher_runtime.cjs'), 'module.exports = { getClaudeCliPath: () => "claude", runClaudeCli: () => {} };\n', 'utf8');
    writeFileSync(join(cliScriptsDir, 'claude_local_launcher.cjs'), 'require("./claude_launcher_runtime.cjs");\n', 'utf8');
    writeFileSync(join(cliScriptsDir, 'claude_remote_launcher.cjs'), 'require("./claude_launcher_runtime.cjs");\n', 'utf8');
    writeFileSync(join(cliScriptsDir, 'session_hook_forwarder.cjs'), 'console.log("session");\n', 'utf8');
    writeFileSync(join(cliScriptsDir, 'permission_hook_forwarder.cjs'), 'console.log("permission");\n', 'utf8');
    writeFileSync(join(cliScriptsDir, 'ripgrep_launcher.cjs'), 'require("./childProcessOptions.cjs");\n', 'utf8');
    writeFileSync(join(cliScriptsDir, 'statusline_forwarder.cjs'), 'console.log("statusline");\n', 'utf8');
    writeFileSync(join(cliScriptsDir, 'terminal_launch_spec_runner.cjs'), 'console.log("terminal launch spec");\n', 'utf8');
    writeFileSync(join(cliScriptsDir, 'node_pty_relay.cjs'), 'console.log("node pty relay");\n', 'utf8');
    writeFileSync(join(cliRuntimeDir, 'loadTransformersFromRuntime.mjs'), 'export const env = {}; export async function pipeline() { return () => null; }\n', 'utf8');
    writeFileSync(join(cliShimsDir, 'git'), '#!/bin/sh\nexit 0\n', 'utf8');
    writeFileSync(join(cliShimsDir, 'rg'), '#!/bin/sh\nexit 0\n', 'utf8');
    writeFileSync(
      join(transformersDir, 'package.json'),
      JSON.stringify({ name: '@huggingface/transformers', version: '1.0.0', dependencies: { 'onnxruntime-node': '1.0.0' } }, null, 2),
    );
    writeFileSync(join(transformersDir, 'index.js'), 'module.exports = {};\n', 'utf8');
    writeFileSync(
      join(ortDir, 'package.json'),
      JSON.stringify({ name: 'onnxruntime-node', version: '1.0.0', dependencies: { 'onnxruntime-common': '1.0.0' } }, null, 2),
    );
    writeFileSync(join(ortDir, 'index.js'), 'module.exports = {};\n', 'utf8');
    writeFileSync(
      join(ortCommonDir, 'package.json'),
      JSON.stringify({ name: 'onnxruntime-common', version: '1.0.0', dependencies: {} }, null, 2),
    );
    writeFileSync(join(ortCommonDir, 'index.js'), 'module.exports = {};\n', 'utf8');
    writeFileSync(
      join(nodePtyDir, 'package.json'),
      JSON.stringify({ name: 'node-pty', version: '1.0.0', dependencies: {} }, null, 2),
    );
    writeFileSync(join(nodePtyDir, 'index.js'), 'module.exports = { spawn() {} };\n', 'utf8');
    writeFileSync(
      join(homebridgePtyDir, 'package.json'),
      JSON.stringify({ name: '@homebridge/node-pty-prebuilt-multiarch', version: '1.0.0', dependencies: {} }, null, 2),
    );
    writeFileSync(join(homebridgePtyDir, 'index.js'), 'module.exports = { spawn() {} };\n', 'utf8');

    const artifacts = await import('../dist/componentArtifacts/index.js');
    await artifacts.buildCliBinaryArtifactPayload({
      repoRoot,
      payloadDir,
      ensureWorkspacePackagesBuiltByName: acceptWorkspacePackageFixtures,
      target: artifacts.resolveCurrentBinaryTarget({
        availableTargets: artifacts.CLI_BINARY_TARGETS,
        platform: 'linux',
        arch: 'x64',
      }),
      commandProbe: () => true,
      runCommand: async () => {
        writeCliDistFixture(
          cliDistDir,
          'export { detect } from "./detect-BwxnBwvx.mjs";\n',
          { 'detect-BwxnBwvx.mjs': 'export const detect = true;\n' },
        );
      },
      compileBinary: async ({ outfile }) => {
        rmSync(cliDistDir, { recursive: true, force: true });
        writeFileSync(outfile, '#!/bin/sh\necho happier\n', 'utf8');
      },
    });

    assert.equal(readFileSync(join(payloadDir, 'package-dist', 'index.mjs'), 'utf8'), 'export { detect } from "./detect-BwxnBwvx.mjs";\n');
    assert.equal(readFileSync(join(payloadDir, 'package-dist', 'detect-BwxnBwvx.mjs'), 'utf8'), 'export const detect = true;\n');
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('buildCliBinaryArtifactPayload derives bundled workspace packages from apps/cli package.json', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'component-artifacts-cli-bundle-manifest-'));
  try {
    const repoRoot = join(tempRoot, 'repo');
    const payloadDir = join(tempRoot, 'payload');
    const cliDistDir = join(repoRoot, 'apps', 'cli', 'dist');
    const cliScriptsDir = join(repoRoot, 'apps', 'cli', 'scripts');
    const cliRuntimeDir = join(cliScriptsDir, 'runtime');
    const transformersDir = join(repoRoot, 'node_modules', '@huggingface', 'transformers');
    const nodePtyDir = join(repoRoot, 'node_modules', 'node-pty');
    const homebridgePtyDir = join(repoRoot, 'node_modules', '@homebridge', 'node-pty-prebuilt-multiarch');

    mkdirSync(cliDistDir, { recursive: true });
    mkdirSync(join(cliScriptsDir, 'shims'), { recursive: true });
    mkdirSync(cliRuntimeDir, { recursive: true });
    mkdirSync(transformersDir, { recursive: true });
    mkdirSync(nodePtyDir, { recursive: true });
    mkdirSync(homebridgePtyDir, { recursive: true });
    writeFileSync(join(repoRoot, 'package.json'), JSON.stringify({ name: 'repo', private: true }, null, 2));
    writeCliRuntimePackageFixture(repoRoot, [
      '@happier-dev/agents',
      '@happier-dev/cli-common',
      '@happier-dev/protocol',
      '@happier-dev/release-runtime',
    ]);
    writeCliDistFixture(cliDistDir, 'console.log("cli");\n');
    writeFileSync(join(cliScriptsDir, 'childProcessOptions.cjs'), 'module.exports = { withWindowsHide: (input) => input };\n', 'utf8');
    writeFileSync(join(cliScriptsDir, 'claude_launcher_runtime.cjs'), 'module.exports = { getClaudeCliPath: () => "claude", runClaudeCli: () => {} };\n', 'utf8');
    writeFileSync(join(cliScriptsDir, 'claude_local_launcher.cjs'), 'require("./claude_launcher_runtime.cjs");\n', 'utf8');
    writeFileSync(join(cliScriptsDir, 'claude_remote_launcher.cjs'), 'require("./claude_launcher_runtime.cjs");\n', 'utf8');
    writeFileSync(join(cliScriptsDir, 'session_hook_forwarder.cjs'), 'console.log("session");\n', 'utf8');
    writeFileSync(join(cliScriptsDir, 'permission_hook_forwarder.cjs'), 'console.log("permission");\n', 'utf8');
    writeFileSync(join(cliScriptsDir, 'ripgrep_launcher.cjs'), 'require("./childProcessOptions.cjs");\n', 'utf8');
    writeFileSync(join(cliScriptsDir, 'statusline_forwarder.cjs'), 'console.log("statusline");\n', 'utf8');
    writeFileSync(join(cliScriptsDir, 'terminal_launch_spec_runner.cjs'), 'console.log("terminal launch spec");\n', 'utf8');
    writeFileSync(join(cliScriptsDir, 'node_pty_relay.cjs'), 'console.log("node pty relay");\n', 'utf8');
    writeFileSync(join(cliRuntimeDir, 'loadTransformersFromRuntime.mjs'), 'export const env = {}; export async function pipeline() { return () => null; }\n', 'utf8');
    writeFileSync(join(cliScriptsDir, 'shims', 'git'), '#!/bin/sh\nexit 0\n', 'utf8');
    writeFileSync(
      join(transformersDir, 'package.json'),
      JSON.stringify({ name: '@huggingface/transformers', version: '1.0.0', dependencies: {} }, null, 2),
    );
    writeFileSync(join(transformersDir, 'index.js'), 'module.exports = {};\n', 'utf8');
    writeFileSync(
      join(nodePtyDir, 'package.json'),
      JSON.stringify({ name: 'node-pty', version: '1.0.0', dependencies: {} }, null, 2),
      'utf8',
    );
    writeFileSync(join(nodePtyDir, 'index.js'), 'module.exports = { spawn() {} };\n', 'utf8');
    writeFileSync(
      join(homebridgePtyDir, 'package.json'),
      JSON.stringify({ name: '@homebridge/node-pty-prebuilt-multiarch', version: '1.0.0', dependencies: {} }, null, 2),
      'utf8',
    );
    writeFileSync(join(homebridgePtyDir, 'index.js'), 'module.exports = { spawn() {} };\n', 'utf8');

    const artifacts = await import('../dist/componentArtifacts/index.js');
    await artifacts.buildCliBinaryArtifactPayload({
      repoRoot,
      payloadDir,
      ensureWorkspacePackagesBuiltByName: acceptWorkspacePackageFixtures,
      target: artifacts.resolveCurrentBinaryTarget({
        availableTargets: artifacts.CLI_BINARY_TARGETS,
        platform: 'linux',
        arch: 'x64',
      }),
      commandProbe: () => true,
      runCommand: () => {
        writeCliDistFixture(cliDistDir, 'console.log("cli");\n');
      },
      compileBinary: async ({ outfile }) => {
        writeFileSync(outfile, '#!/bin/sh\necho happier\n', 'utf8');
      },
    });

    assert.equal(existsSync(join(payloadDir, 'node_modules', '@happier-dev', 'connection-supervisor')), false);
    assert.equal(existsSync(join(payloadDir, 'node_modules', '@happier-dev', 'protocol')), true);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('buildCliBinaryArtifactPayload restores runtime sidecars after compile rewrites the payload dir', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'component-artifacts-cli-sidecars-after-compile-'));
  try {
    const repoRoot = join(tempRoot, 'repo');
    const payloadDir = join(tempRoot, 'payload');
    const cliDistDir = join(repoRoot, 'apps', 'cli', 'dist');
    const cliScriptsDir = join(repoRoot, 'apps', 'cli', 'scripts');
    const cliRuntimeDir = join(cliScriptsDir, 'runtime');
    const transformersDir = join(repoRoot, 'node_modules', '@huggingface', 'transformers');
    const ortDir = join(repoRoot, 'node_modules', 'onnxruntime-node');
    const nodePtyDir = join(repoRoot, 'node_modules', 'node-pty');
    const homebridgePtyDir = join(repoRoot, 'node_modules', '@homebridge', 'node-pty-prebuilt-multiarch');

    mkdirSync(cliDistDir, { recursive: true });
    mkdirSync(join(cliScriptsDir, 'shims'), { recursive: true });
    mkdirSync(cliRuntimeDir, { recursive: true });
    mkdirSync(transformersDir, { recursive: true });
    mkdirSync(ortDir, { recursive: true });
    mkdirSync(nodePtyDir, { recursive: true });
    mkdirSync(homebridgePtyDir, { recursive: true });
    writeFileSync(join(repoRoot, 'package.json'), JSON.stringify({ name: 'repo', private: true }, null, 2));
    writeCliRuntimePackageFixture(repoRoot);
    writeCliDistFixture(cliDistDir, 'console.log("cli");\n');
    writeFileSync(join(cliScriptsDir, 'childProcessOptions.cjs'), 'module.exports = { withWindowsHide: (input) => input };\n', 'utf8');
    writeFileSync(join(cliScriptsDir, 'claude_launcher_runtime.cjs'), 'module.exports = { getClaudeCliPath: () => "claude", runClaudeCli: () => {} };\n', 'utf8');
    writeFileSync(join(cliScriptsDir, 'claude_local_launcher.cjs'), 'require("./claude_launcher_runtime.cjs");\n', 'utf8');
    writeFileSync(join(cliScriptsDir, 'claude_remote_launcher.cjs'), 'require("./claude_launcher_runtime.cjs");\n', 'utf8');
    writeFileSync(join(cliScriptsDir, 'session_hook_forwarder.cjs'), 'console.log("session");\n', 'utf8');
    writeFileSync(join(cliScriptsDir, 'permission_hook_forwarder.cjs'), 'console.log("permission");\n', 'utf8');
    writeFileSync(join(cliScriptsDir, 'ripgrep_launcher.cjs'), 'require("./childProcessOptions.cjs");\n', 'utf8');
    writeFileSync(join(cliScriptsDir, 'statusline_forwarder.cjs'), 'console.log("statusline");\n', 'utf8');
    writeFileSync(join(cliScriptsDir, 'terminal_launch_spec_runner.cjs'), 'console.log("terminal launch spec");\n', 'utf8');
    writeFileSync(join(cliScriptsDir, 'node_pty_relay.cjs'), 'console.log("node pty relay");\n', 'utf8');
    writeFileSync(join(cliRuntimeDir, 'loadTransformersFromRuntime.mjs'), 'export const env = {}; export async function pipeline() { return () => null; }\n', 'utf8');
    writeFileSync(join(cliScriptsDir, 'shims', 'git'), '#!/bin/sh\nexit 0\n', 'utf8');
    writeFileSync(
      join(transformersDir, 'package.json'),
      JSON.stringify({ name: '@huggingface/transformers', version: '1.0.0', dependencies: { 'onnxruntime-node': '1.0.0' } }, null, 2),
    );
    writeFileSync(join(transformersDir, 'index.js'), 'module.exports = {};\n', 'utf8');
    writeFileSync(
      join(ortDir, 'package.json'),
      JSON.stringify({ name: 'onnxruntime-node', version: '1.0.0', dependencies: {} }, null, 2),
    );
    writeFileSync(join(ortDir, 'index.js'), 'module.exports = {};\n', 'utf8');
    writeFileSync(
      join(nodePtyDir, 'package.json'),
      JSON.stringify({ name: 'node-pty', version: '1.0.0', dependencies: {} }, null, 2),
    );
    writeFileSync(join(nodePtyDir, 'index.js'), 'module.exports = { spawn() {} };\n', 'utf8');
    writeFileSync(
      join(homebridgePtyDir, 'package.json'),
      JSON.stringify({ name: '@homebridge/node-pty-prebuilt-multiarch', version: '1.0.0', dependencies: {} }, null, 2),
    );
    writeFileSync(join(homebridgePtyDir, 'index.js'), 'module.exports = { spawn() {} };\n', 'utf8');

    const artifacts = await import('../dist/componentArtifacts/index.js');
    await artifacts.buildCliBinaryArtifactPayload({
      repoRoot,
      payloadDir,
      ensureWorkspacePackagesBuiltByName: acceptWorkspacePackageFixtures,
      target: artifacts.resolveCurrentBinaryTarget({
        availableTargets: artifacts.CLI_BINARY_TARGETS,
        platform: 'linux',
        arch: 'x64',
      }),
      commandProbe: () => true,
      runCommand: () => {
        writeCliDistFixture(cliDistDir, 'console.log("cli");\n');
      },
      compileBinary: async ({ outfile }) => {
        rmSync(payloadDir, { recursive: true, force: true });
        mkdirSync(payloadDir, { recursive: true });
        writeFileSync(outfile, '#!/bin/sh\necho happier\n', 'utf8');
      },
    });

    assert.equal(readFileSync(join(payloadDir, 'scripts', 'claude_local_launcher.cjs'), 'utf8'), 'require("./claude_launcher_runtime.cjs");\n');
    assert.equal(
      readFileSync(join(payloadDir, 'scripts', 'runtime', 'loadTransformersFromRuntime.mjs'), 'utf8'),
      'export const env = {}; export async function pipeline() { return () => null; }\n',
    );
    assert.equal(readFileSync(join(payloadDir, 'scripts', 'shims', 'git'), 'utf8'), '#!/bin/sh\nexit 0\n');
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('buildCliBinaryArtifactPayload stages embeddings runtime packages and externalizes transformers', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'component-artifacts-cli-embeddings-'));
  try {
    const repoRoot = join(tempRoot, 'repo');
    const payloadDir = join(tempRoot, 'payload');
    const cliDistDir = join(repoRoot, 'apps', 'cli', 'dist');
    const cliScriptsDir = join(repoRoot, 'apps', 'cli', 'scripts');
    const cliShimsDir = join(cliScriptsDir, 'shims');
    const cliRuntimeDir = join(cliScriptsDir, 'runtime');
    const transformersDir = join(repoRoot, 'node_modules', '@huggingface', 'transformers');
    const ortDir = join(repoRoot, 'node_modules', 'onnxruntime-node');
    const ortCommonDir = join(repoRoot, 'node_modules', 'onnxruntime-common');
    const nodePtyDir = join(repoRoot, 'node_modules', 'node-pty');
    const homebridgePtyDir = join(repoRoot, 'node_modules', '@homebridge', 'node-pty-prebuilt-multiarch');

    mkdirSync(cliDistDir, { recursive: true });
    mkdirSync(cliShimsDir, { recursive: true });
    mkdirSync(cliRuntimeDir, { recursive: true });
    mkdirSync(transformersDir, { recursive: true });
    mkdirSync(ortDir, { recursive: true });
    mkdirSync(ortCommonDir, { recursive: true });
    mkdirSync(nodePtyDir, { recursive: true });
    mkdirSync(homebridgePtyDir, { recursive: true });
    writeFileSync(join(repoRoot, 'package.json'), JSON.stringify({ name: 'repo', private: true }, null, 2));
    writeCliRuntimePackageFixture(repoRoot);
    writeCliDistFixture(cliDistDir, 'console.log("cli");\n');
    writeFileSync(join(cliScriptsDir, 'childProcessOptions.cjs'), 'module.exports = { withWindowsHide: (input) => input };\n', 'utf8');
    writeFileSync(join(cliScriptsDir, 'claude_launcher_runtime.cjs'), 'module.exports = { getClaudeCliPath: () => "claude", runClaudeCli: () => {} };\n', 'utf8');
    writeFileSync(join(cliScriptsDir, 'claude_local_launcher.cjs'), 'require("./claude_launcher_runtime.cjs");\n', 'utf8');
    writeFileSync(join(cliScriptsDir, 'claude_remote_launcher.cjs'), 'require("./claude_launcher_runtime.cjs");\n', 'utf8');
    writeFileSync(join(cliScriptsDir, 'session_hook_forwarder.cjs'), 'console.log("session");\n', 'utf8');
    writeFileSync(join(cliScriptsDir, 'permission_hook_forwarder.cjs'), 'console.log("permission");\n', 'utf8');
    writeFileSync(join(cliScriptsDir, 'ripgrep_launcher.cjs'), 'require("./childProcessOptions.cjs");\n', 'utf8');
    writeFileSync(join(cliScriptsDir, 'statusline_forwarder.cjs'), 'console.log("statusline");\n', 'utf8');
    writeFileSync(join(cliScriptsDir, 'terminal_launch_spec_runner.cjs'), 'console.log("terminal launch spec");\n', 'utf8');
    writeFileSync(join(cliScriptsDir, 'node_pty_relay.cjs'), 'console.log("node pty relay");\n', 'utf8');
    writeFileSync(join(cliRuntimeDir, 'loadTransformersFromRuntime.mjs'), 'export const env = {}; export async function pipeline() { return () => null; }\n', 'utf8');
    writeFileSync(join(cliShimsDir, 'git'), '#!/bin/sh\nexit 0\n', 'utf8');
    writeFileSync(
      join(transformersDir, 'package.json'),
      JSON.stringify({ name: '@huggingface/transformers', version: '1.0.0', dependencies: { 'onnxruntime-node': '1.0.0' } }, null, 2),
    );
    writeFileSync(join(transformersDir, 'index.js'), 'module.exports = {};\n', 'utf8');
    writeFileSync(
      join(ortDir, 'package.json'),
      JSON.stringify({ name: 'onnxruntime-node', version: '1.0.0', dependencies: { 'onnxruntime-common': '1.0.0' } }, null, 2),
    );
    writeFileSync(join(ortDir, 'index.js'), 'module.exports = {};\n', 'utf8');
    writeFileSync(
      join(ortCommonDir, 'package.json'),
      JSON.stringify({ name: 'onnxruntime-common', version: '1.0.0', dependencies: {} }, null, 2),
    );
    writeFileSync(join(ortCommonDir, 'index.js'), 'module.exports = {};\n', 'utf8');
    writeFileSync(
      join(nodePtyDir, 'package.json'),
      JSON.stringify({ name: 'node-pty', version: '1.0.0', dependencies: {} }, null, 2),
    );
    writeFileSync(join(nodePtyDir, 'index.js'), 'module.exports = { spawn() {} };\n', 'utf8');
    writeFileSync(
      join(homebridgePtyDir, 'package.json'),
      JSON.stringify({ name: '@homebridge/node-pty-prebuilt-multiarch', version: '1.0.0', dependencies: {} }, null, 2),
    );
    writeFileSync(join(homebridgePtyDir, 'index.js'), 'module.exports = { spawn() {} };\n', 'utf8');

    const artifacts = await import('../dist/componentArtifacts/index.js');
    const compileCalls = [];
    await artifacts.buildCliBinaryArtifactPayload({
      repoRoot,
      payloadDir,
      ensureWorkspacePackagesBuiltByName: acceptWorkspacePackageFixtures,
      target: artifacts.resolveCurrentBinaryTarget({
        availableTargets: artifacts.CLI_BINARY_TARGETS,
        platform: 'linux',
        arch: 'x64',
      }),
      commandProbe: () => true,
      runCommand: () => {
        writeCliDistFixture(cliDistDir, 'console.log("cli");\n');
      },
      compileBinary: async (args) => {
        compileCalls.push(args);
        writeFileSync(args.outfile, '#!/bin/sh\necho happier\n', 'utf8');
      },
    });

    assert.deepEqual(compileCalls[0]?.externals, [
      '@huggingface/transformers',
      'node-pty',
      '@homebridge/node-pty-prebuilt-multiarch',
    ]);
    assert.equal(
      readFileSync(join(payloadDir, 'node_modules', '@huggingface', 'transformers', 'package.json'), 'utf8'),
      JSON.stringify({ name: '@huggingface/transformers', version: '1.0.0', dependencies: { 'onnxruntime-node': '1.0.0' } }, null, 2),
    );
    assert.equal(
      readFileSync(join(payloadDir, 'node_modules', '@huggingface', 'transformers', 'node_modules', 'onnxruntime-node', 'package.json'), 'utf8'),
      JSON.stringify({ name: 'onnxruntime-node', version: '1.0.0', dependencies: { 'onnxruntime-common': '1.0.0' } }, null, 2),
    );
    assert.equal(
      readFileSync(
        join(
          payloadDir,
          'node_modules',
          '@huggingface',
          'transformers',
          'node_modules',
          'onnxruntime-node',
          'node_modules',
          'onnxruntime-common',
          'package.json',
        ),
        'utf8',
      ),
      JSON.stringify({ name: 'onnxruntime-common', version: '1.0.0', dependencies: {} }, null, 2),
    );
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('buildServerBinaryArtifactPayload stages the compiled binary and runtime sidecars', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'component-artifacts-server-'));
  try {
    const repoRoot = join(tempRoot, 'repo');
    const payloadDir = join(tempRoot, 'payload');
    const serverSourcesDir = join(repoRoot, 'apps', 'server', 'sources');
    const uiDistDir = join(repoRoot, 'apps', 'ui', 'dist');
    const sqliteClientDir = join(repoRoot, 'apps', 'server', 'generated', 'sqlite-client');
    const mysqlClientDir = join(repoRoot, 'apps', 'server', 'generated', 'mysql-client');
    const sqliteMigrationsDir = join(repoRoot, 'apps', 'server', 'prisma', 'sqlite', 'migrations');
    const postgresClientDir = join(repoRoot, 'node_modules', '.prisma', 'client');
    const prismaClientPackageDir = join(repoRoot, 'node_modules', '@prisma', 'client');
    mkdirSync(serverSourcesDir, { recursive: true });
    mkdirSync(uiDistDir, { recursive: true });
    mkdirSync(sqliteClientDir, { recursive: true });
    mkdirSync(mysqlClientDir, { recursive: true });
    mkdirSync(sqliteMigrationsDir, { recursive: true });
    mkdirSync(postgresClientDir, { recursive: true });
    mkdirSync(prismaClientPackageDir, { recursive: true });

    writeFileSync(join(serverSourcesDir, 'main.light.ts'), 'export {};\n', 'utf8');
    writeFileSync(join(uiDistDir, 'index.html'), '<html>ui</html>\n', 'utf8');
    writeFileSync(join(sqliteClientDir, 'schema.prisma'), '// sqlite\n', 'utf8');
    writeFileSync(join(mysqlClientDir, 'schema.prisma'), '// mysql\n', 'utf8');
    writeFileSync(join(sqliteMigrationsDir, 'migration.sql'), '-- sql\n', 'utf8');
    writeServerPrismaEngineFixtures({
      sqliteClientDir,
      mysqlClientDir,
      postgresClientDir,
      providers: ['sqlite', 'mysql'],
    });
    writeServerSharpRuntimeFixtures({ repoRoot });
    writeFileSync(join(prismaClientPackageDir, 'index.js'), 'module.exports = { PrismaClient: class PrismaClient {} };\n', 'utf8');
    if (process.platform !== 'win32') {
      const externalToolPath = join(repoRoot, 'external-prisma-tool.js');
      writeFileSync(externalToolPath, 'console.log("tool");\n', 'utf8');
      mkdirSync(join(prismaClientPackageDir, 'node_modules', '.bin'), { recursive: true });
      symlinkSync(externalToolPath, join(prismaClientPackageDir, 'node_modules', '.bin', 'external-prisma-tool'));
    }

    const artifacts = await import('../dist/componentArtifacts/index.js');
    const compileCalls = [];
    const runCalls = [];
    const result = await artifacts.buildServerBinaryArtifactPayload({
      repoRoot,
      payloadDir,
      serverComponent: 'happier-server-light',
      entrypoint: join(serverSourcesDir, 'main.light.ts'),
      buildDbProviders: 'all',
      target: artifacts.resolveCurrentBinaryTarget({
        availableTargets: artifacts.SERVER_BINARY_TARGETS,
        platform: 'linux',
        arch: 'x64',
      }),
      commandProbe: () => true,
      runCommand: (cmd, args) => {
        runCalls.push({ cmd, args });
      },
      compileBinary: async ({ outfile }) => {
        compileCalls.push(outfile);
        writeFileSync(outfile, '#!/bin/sh\necho happier-server\n', 'utf8');
      },
    });

    assert.equal(result.executableName, 'happier-server');
    assert.equal(result.entrypoint, 'happier-server');
    assert.equal(result.migrationEntrypoint, undefined);
    assert.equal(compileCalls.length, 1);
    assert.deepEqual(runCalls, [
      { cmd: process.execPath, args: ['apps/server/scripts/buildSharedDeps.mjs', '--quiet'] },
      { cmd: 'yarn', args: ['--cwd', 'apps/server', '-s', 'generate:providers'] },
      { cmd: process.execPath, args: ['apps/ui/scripts/ensureWorkspacePackagesBuilt.mjs'] },
      { cmd: 'yarn', args: ['--cwd', 'apps/ui', '-s', 'expo', 'export', '--platform', 'web', '--output-dir', 'dist', '--max-workers', '2'] },
      { cmd: process.execPath, args: ['scripts/pipeline/release/precompress-ui-web-assets.mjs', '--dir', 'apps/ui/dist'] },
    ]);
    assert.equal(readFileSync(join(payloadDir, 'happier-server'), 'utf8'), '#!/bin/sh\necho happier-server\n');
    assert.equal(readFileSync(join(payloadDir, 'generated', 'sqlite-client', 'schema.prisma'), 'utf8'), '// sqlite\n');
    assert.equal(readFileSync(join(payloadDir, 'generated', 'mysql-client', 'schema.prisma'), 'utf8'), '// mysql\n');
    assert.equal(readFileSync(join(payloadDir, 'prisma', 'sqlite', 'migrations', 'migration.sql'), 'utf8'), '-- sql\n');
    assert.equal(existsSync(join(payloadDir, 'happier-server-migrate')), false);
    assert.equal(existsSync(join(payloadDir, 'prisma', 'schema.prisma')), false);
    assert.equal(existsSync(join(payloadDir, 'prisma', 'mysql', 'schema.prisma')), false);
    assert.equal(readFileSync(join(payloadDir, 'ui-web', 'current', 'index.html'), 'utf8'), '<html>ui</html>\n');
    assert.equal(
      readFileSync(join(payloadDir, 'node_modules', '.prisma', 'client', 'libquery_engine-debian-openssl-3.0.x.so.node'), 'utf8'),
      'postgres-engine\n',
    );
    assert.equal(
      readFileSync(join(payloadDir, 'node_modules', '@prisma', 'client', 'index.js'), 'utf8'),
      'module.exports = { PrismaClient: class PrismaClient {} };\n'
    );
    if (process.platform !== 'win32') {
      assert.equal(
        existsSync(join(payloadDir, 'node_modules', '@prisma', 'client', 'node_modules', '.bin')),
        false,
        'runtime artifacts must not retain package-manager shims that escape the payload',
      );
    }
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('buildServerBinaryArtifactPayload packages the complete full-server migrate deploy closure', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'component-artifacts-full-server-'));
  try {
    const repoRoot = join(tempRoot, 'repo');
    const payloadDir = join(tempRoot, 'payload');
    const serverRoot = join(repoRoot, 'apps', 'server');
    const serverSourcesDir = join(serverRoot, 'sources');
    const runtimeScriptsDir = join(serverRoot, 'scripts', 'runtime');
    const uiDistDir = join(repoRoot, 'apps', 'ui', 'dist');
    const mysqlClientDir = join(serverRoot, 'generated', 'mysql-client');
    const postgresMigrationsDir = join(serverRoot, 'prisma', 'migrations', '20260719000100_pg_sentinel');
    const mysqlMigrationsDir = join(serverRoot, 'prisma', 'mysql', 'migrations', '20260719000100_mysql_sentinel');
    const schemaEngineDir = join(serverRoot, 'generated', 'runtime-migration-engines', 'linux-x64');
    const postgresClientDir = join(repoRoot, 'node_modules', '.prisma', 'client');
    const prismaClientPackageDir = join(repoRoot, 'node_modules', '@prisma', 'client');
    const prismaBuildDir = join(repoRoot, 'node_modules', 'prisma', 'build');

    for (const dir of [
      serverSourcesDir,
      runtimeScriptsDir,
      uiDistDir,
      mysqlClientDir,
      postgresMigrationsDir,
      mysqlMigrationsDir,
      schemaEngineDir,
      postgresClientDir,
      prismaClientPackageDir,
      prismaBuildDir,
    ]) {
      mkdirSync(dir, { recursive: true });
    }

    writeFileSync(join(serverSourcesDir, 'main.ts'), 'export {};\n', 'utf8');
    writeFileSync(join(runtimeScriptsDir, 'migrateFullRuntime.ts'), 'export {};\n', 'utf8');
    writeFileSync(join(uiDistDir, 'index.html'), '<html>full ui</html>\n', 'utf8');
    writeFileSync(join(mysqlClientDir, 'schema.prisma'), '// generated mysql\n', 'utf8');
    writeFileSync(join(serverRoot, 'prisma', 'schema.prisma'), '// postgres schema sentinel\n', 'utf8');
    writeFileSync(join(serverRoot, 'prisma', 'migrations', 'migration_lock.toml'), 'provider = "postgresql"\n', 'utf8');
    writeFileSync(join(postgresMigrationsDir, 'migration.sql'), '-- postgres migration sentinel\n', 'utf8');
    writeFileSync(join(serverRoot, 'prisma', 'mysql', 'schema.prisma'), '// mysql schema sentinel\n', 'utf8');
    writeFileSync(join(serverRoot, 'prisma', 'mysql', 'migrations', 'migration_lock.toml'), 'provider = "mysql"\n', 'utf8');
    writeFileSync(join(mysqlMigrationsDir, 'migration.sql'), '-- mysql migration sentinel\n', 'utf8');
    writeFileSync(
      join(schemaEngineDir, 'schema-engine-debian-openssl-3.0.x'),
      'schema engine sentinel\n',
      'utf8',
    );
    writeServerPrismaEngineFixtures({
      mysqlClientDir,
      postgresClientDir,
      providers: ['mysql'],
    });
    writeServerSharpRuntimeFixtures({ repoRoot });
    writeFileSync(join(prismaClientPackageDir, 'index.js'), 'module.exports = {};\n', 'utf8');
    writeFileSync(join(prismaBuildDir, 'prisma_schema_build_bg.wasm'), 'schema wasm sentinel\n', 'utf8');

    const artifacts = await import('../dist/componentArtifacts/index.js');
    const compileCalls = [];
    const result = await artifacts.buildServerBinaryArtifactPayload({
      repoRoot,
      payloadDir,
      serverComponent: 'happier-server',
      entrypoint: join(serverSourcesDir, 'main.ts'),
      buildDbProviders: 'postgresql',
      target: artifacts.resolveCurrentBinaryTarget({
        availableTargets: artifacts.SERVER_BINARY_TARGETS,
        platform: 'linux',
        arch: 'x64',
      }),
      commandProbe: () => true,
      runCommand: () => undefined,
      compileBinary: async (args) => {
        compileCalls.push(args);
        writeFileSync(args.outfile, `compiled:${args.entrypoint}\n`, 'utf8');
      },
      compilePrismaBinary: async (args) => {
        writeFileSync(args.outfile, 'packaged Prisma migrate runner\n', 'utf8');
      },
    });

    assert.equal(result.migrationEntrypoint, 'happier-server-migrate');
    assert.deepEqual(
      compileCalls.map(({ entrypoint, outfile }) => [entrypoint, outfile.slice(payloadDir.length + 1)]),
      [
        [join(serverSourcesDir, 'main.ts'), 'happier-server'],
        [join(runtimeScriptsDir, 'migrateFullRuntime.ts'), 'happier-server-migrate'],
      ],
    );
    assert.match(readFileSync(join(payloadDir, 'happier-server-migrate'), 'utf8'), /migrateFullRuntime\.ts/);
    assert.equal(
      readFileSync(join(payloadDir, 'runtime', 'prisma-migrate'), 'utf8'),
      'packaged Prisma migrate runner\n',
    );
    assert.equal(readFileSync(join(payloadDir, 'prisma', 'schema.prisma'), 'utf8'), '// postgres schema sentinel\n');
    assert.equal(
      readFileSync(join(payloadDir, 'prisma', 'migrations', '20260719000100_pg_sentinel', 'migration.sql'), 'utf8'),
      '-- postgres migration sentinel\n',
    );
    assert.equal(readFileSync(join(payloadDir, 'prisma', 'mysql', 'schema.prisma'), 'utf8'), '// mysql schema sentinel\n');
    assert.equal(
      readFileSync(join(payloadDir, 'prisma', 'mysql', 'migrations', '20260719000100_mysql_sentinel', 'migration.sql'), 'utf8'),
      '-- mysql migration sentinel\n',
    );
    assert.equal(
      readFileSync(join(payloadDir, 'runtime', 'schema-engine'), 'utf8'),
      'schema engine sentinel\n',
    );
    assert.equal(
      readFileSync(join(payloadDir, 'runtime', 'prisma_schema_build_bg.wasm'), 'utf8'),
      'schema wasm sentinel\n',
    );
    assert.equal(existsSync(join(payloadDir, 'prisma', 'sqlite')), false);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('buildServerBinaryArtifactPayload rejects non-bin sidecar symlinks that escape the payload', async () => {
  if (process.platform === 'win32') return;

  const tempRoot = mkdtempSync(join(tmpdir(), 'component-artifacts-server-external-symlink-'));
  try {
    const repoRoot = join(tempRoot, 'repo');
    const payloadDir = join(tempRoot, 'payload');
    const serverSourcesDir = join(repoRoot, 'apps', 'server', 'sources');
    const uiDistDir = join(repoRoot, 'apps', 'ui', 'dist');
    const sqliteClientDir = join(repoRoot, 'apps', 'server', 'generated', 'sqlite-client');
    const sqliteMigrationsDir = join(repoRoot, 'apps', 'server', 'prisma', 'sqlite', 'migrations');
    const postgresClientDir = join(repoRoot, 'node_modules', '.prisma', 'client');
    const prismaClientPackageDir = join(repoRoot, 'node_modules', '@prisma', 'client');

    mkdirSync(serverSourcesDir, { recursive: true });
    mkdirSync(uiDistDir, { recursive: true });
    mkdirSync(sqliteClientDir, { recursive: true });
    mkdirSync(sqliteMigrationsDir, { recursive: true });
    mkdirSync(postgresClientDir, { recursive: true });
    mkdirSync(prismaClientPackageDir, { recursive: true });

    writeFileSync(join(serverSourcesDir, 'main.light.ts'), 'export {};\n', 'utf8');
    writeFileSync(join(uiDistDir, 'index.html'), '<html>ui</html>\n', 'utf8');
    writeFileSync(join(sqliteClientDir, 'schema.prisma'), '// sqlite\n', 'utf8');
    writeFileSync(join(sqliteMigrationsDir, 'migration.sql'), '-- sql\n', 'utf8');
    writeServerPrismaEngineFixtures({ sqliteClientDir, postgresClientDir, providers: ['sqlite'] });
    writeServerSharpRuntimeFixtures({ repoRoot });
    writeFileSync(join(prismaClientPackageDir, 'index.js'), 'module.exports = {};\n', 'utf8');
    const externalRuntimePath = join(repoRoot, 'external-prisma-runtime.js');
    writeFileSync(externalRuntimePath, 'module.exports = {};\n', 'utf8');
    symlinkSync(externalRuntimePath, join(prismaClientPackageDir, 'external-runtime-link.js'));

    const artifacts = await import('../dist/componentArtifacts/index.js');
    await assert.rejects(
      artifacts.buildServerBinaryArtifactPayload({
        repoRoot,
        payloadDir,
        entrypoint: join(serverSourcesDir, 'main.light.ts'),
        buildDbProviders: 'sqlite',
        target: artifacts.resolveCurrentBinaryTarget({
          availableTargets: artifacts.SERVER_BINARY_TARGETS,
          platform: 'linux',
          arch: 'x64',
        }),
        commandProbe: () => true,
        runCommand: () => {},
        compileBinary: async ({ outfile }) => {
          writeFileSync(outfile, '#!/bin/sh\necho happier-server\n', 'utf8');
        },
      }),
      /runtime payload symlink escapes the artifact/,
    );
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('buildServerBinaryArtifactPayload stages sharp native runtime sidecars for the binary target', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'component-artifacts-server-sharp-'));
  try {
    const repoRoot = join(tempRoot, 'repo');
    const payloadDir = join(tempRoot, 'payload');
    const serverSourcesDir = join(repoRoot, 'apps', 'server', 'sources');
    const uiDistDir = join(repoRoot, 'apps', 'ui', 'dist');
    const sqliteClientDir = join(repoRoot, 'apps', 'server', 'generated', 'sqlite-client');
    const sqliteMigrationsDir = join(repoRoot, 'apps', 'server', 'prisma', 'sqlite', 'migrations');
    const postgresClientDir = join(repoRoot, 'node_modules', '.prisma', 'client');

    mkdirSync(serverSourcesDir, { recursive: true });
    mkdirSync(uiDistDir, { recursive: true });
    mkdirSync(sqliteClientDir, { recursive: true });
    mkdirSync(sqliteMigrationsDir, { recursive: true });
    mkdirSync(postgresClientDir, { recursive: true });

    writeFileSync(join(serverSourcesDir, 'main.light.ts'), 'export {};\n', 'utf8');
    writeFileSync(join(uiDistDir, 'index.html'), '<html>ui</html>\n', 'utf8');
    writeFileSync(join(sqliteClientDir, 'schema.prisma'), '// sqlite\n', 'utf8');
    writeFileSync(join(sqliteMigrationsDir, 'migration.sql'), '-- sql\n', 'utf8');
    writeServerPrismaEngineFixtures({
      sqliteClientDir,
      postgresClientDir,
      providers: ['sqlite'],
      platform: 'darwin',
      arch: 'arm64',
    });

    writeNodePackageFixture({
      repoRoot,
      packageName: '@prisma/client',
      files: { 'index.js': 'module.exports = { PrismaClient: class PrismaClient {} };\n' },
    });
    writeNodePackageFixture({
      repoRoot,
      packageName: 'sharp',
      packageJson: {
        version: '0.34.5',
        dependencies: {
          '@img/colour': '^1.0.0',
          'detect-libc': '^2.1.2',
          semver: '^7.7.3',
        },
        optionalDependencies: {
          '@img/sharp-darwin-arm64': '0.34.5',
          '@img/sharp-libvips-darwin-arm64': '1.2.4',
          '@img/sharp-linux-x64': '0.34.5',
        },
      },
      files: { 'lib/index.js': 'module.exports = require("@img/sharp-darwin-arm64");\n' },
    });
    writeNodePackageFixture({ repoRoot, packageName: '@img/colour' });
    writeNodePackageFixture({ repoRoot, packageName: 'detect-libc' });
    writeNodePackageFixture({ repoRoot, packageName: 'semver' });
    writeNodePackageFixture({
      repoRoot,
      packageName: '@img/sharp-darwin-arm64',
      packageJson: {
        version: '0.34.5',
        os: ['darwin'],
        cpu: ['arm64'],
        optionalDependencies: {
          '@img/sharp-libvips-darwin-arm64': '1.2.4',
        },
      },
    });
    writeNodePackageFixture({
      repoRoot,
      packageName: '@img/sharp-libvips-darwin-arm64',
      packageJson: {
        version: '1.2.4',
        os: ['darwin'],
        cpu: ['arm64'],
      },
    });
    writeNodePackageFixture({
      repoRoot,
      packageName: '@img/sharp-linux-x64',
      packageJson: {
        os: ['linux'],
        cpu: ['x64'],
      },
    });

    const artifacts = await import('../dist/componentArtifacts/index.js');
    const compileCalls = [];
    await artifacts.buildServerBinaryArtifactPayload({
      repoRoot,
      payloadDir,
      entrypoint: join(serverSourcesDir, 'main.light.ts'),
      buildDbProviders: 'sqlite',
      target: artifacts.resolveCurrentBinaryTarget({
        availableTargets: artifacts.SERVER_BINARY_TARGETS,
        platform: 'darwin',
        arch: 'arm64',
      }),
      commandProbe: () => true,
      runCommand: () => {},
      compileBinary: async ({ outfile, externals, buildRunnerEntrypoint }) => {
        compileCalls.push({ outfile, externals, buildRunnerEntrypoint });
        writeFileSync(outfile, '#!/bin/sh\necho happier-server\n', 'utf8');
      },
    });

    assert.deepEqual(compileCalls[0]?.externals, ['redis']);
    assert.equal(
      compileCalls[0]?.buildRunnerEntrypoint,
      join(repoRoot, 'packages', 'cli-common', 'scripts', 'buildServerBunBinary.mjs'),
    );
    assert.equal(readFileSync(join(payloadDir, 'node_modules', 'sharp', 'lib', 'index.js'), 'utf8'), 'module.exports = require("@img/sharp-darwin-arm64");\n');
    assert.equal(readFileSync(join(payloadDir, 'node_modules', '@img', 'colour', 'index.js'), 'utf8'), 'module.exports = {};\n');
    assert.equal(readFileSync(join(payloadDir, 'node_modules', 'detect-libc', 'index.js'), 'utf8'), 'module.exports = {};\n');
    assert.equal(readFileSync(join(payloadDir, 'node_modules', 'semver', 'index.js'), 'utf8'), 'module.exports = {};\n');
    assert.equal(readFileSync(join(payloadDir, 'node_modules', '@img', 'sharp-darwin-arm64', 'index.js'), 'utf8'), 'module.exports = {};\n');
    assert.equal(readFileSync(join(payloadDir, 'node_modules', '@img', 'sharp-libvips-darwin-arm64', 'index.js'), 'utf8'), 'module.exports = {};\n');
    assert.equal(existsSync(join(payloadDir, 'node_modules', '@img', 'sharp-linux-x64')), false);

    rmSync(join(repoRoot, 'node_modules', '@img', 'sharp-libvips-darwin-arm64'), { recursive: true, force: true });
    await assert.rejects(
      artifacts.buildServerBinaryArtifactPayload({
        repoRoot,
        payloadDir: join(tempRoot, 'payload-missing-sharp'),
        entrypoint: join(serverSourcesDir, 'main.light.ts'),
        buildDbProviders: 'sqlite',
        target: artifacts.resolveCurrentBinaryTarget({
          availableTargets: artifacts.SERVER_BINARY_TARGETS,
          platform: 'darwin',
          arch: 'arm64',
        }),
        commandProbe: () => true,
        runCommand: () => {},
        compileBinary: async ({ outfile }) => writeFileSync(outfile, '#!/bin/sh\necho happier-server\n', 'utf8'),
      }),
      (error) => error?.name === 'ServerArtifactRuntimeDependenciesBlockedError'
        && error?.report?.status === 'BLOCKED'
        && error?.report?.targets?.[0]?.failures?.some((failure) => (
          failure.packageName === '@img/sharp-libvips-darwin-arm64'
          && failure.reason === 'missing-package'
        )),
    );
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('buildServerBinaryArtifactPayload fails darwin artifacts without the darwin Prisma engine', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'component-artifacts-server-darwin-engine-'));
  try {
    const repoRoot = join(tempRoot, 'repo');
    const payloadDir = join(tempRoot, 'payload');
    const serverSourcesDir = join(repoRoot, 'apps', 'server', 'sources');
    const uiDistDir = join(repoRoot, 'apps', 'ui', 'dist');
    const sqliteClientDir = join(repoRoot, 'apps', 'server', 'generated', 'sqlite-client');
    const sqliteMigrationsDir = join(repoRoot, 'apps', 'server', 'prisma', 'sqlite', 'migrations');
    const postgresClientDir = join(repoRoot, 'node_modules', '.prisma', 'client');
    const prismaClientPackageDir = join(repoRoot, 'node_modules', '@prisma', 'client');

    mkdirSync(serverSourcesDir, { recursive: true });
    mkdirSync(uiDistDir, { recursive: true });
    mkdirSync(sqliteClientDir, { recursive: true });
    mkdirSync(sqliteMigrationsDir, { recursive: true });
    mkdirSync(postgresClientDir, { recursive: true });
    mkdirSync(prismaClientPackageDir, { recursive: true });

    writeFileSync(join(serverSourcesDir, 'main.light.ts'), 'export {};\n', 'utf8');
    writeFileSync(join(uiDistDir, 'index.html'), '<html>ui</html>\n', 'utf8');
    writeFileSync(join(sqliteClientDir, 'schema.prisma'), '// sqlite\n', 'utf8');
    writeFileSync(join(sqliteClientDir, 'libquery_engine-linux-arm64-openssl-3.0.x.so.node'), 'wrong-platform\n', 'utf8');
    writeFileSync(join(sqliteMigrationsDir, 'migration.sql'), '-- sql\n', 'utf8');
    writeServerPrismaEngineFixtures({
      sqliteClientDir: null,
      mysqlClientDir: null,
      postgresClientDir,
      providers: [],
      platform: 'darwin',
      arch: 'arm64',
    });
    writeServerSharpRuntimeFixtures({ repoRoot, platform: 'darwin', arch: 'arm64' });
    writeFileSync(join(prismaClientPackageDir, 'index.js'), 'module.exports = { PrismaClient: class PrismaClient {} };\n', 'utf8');

    const artifacts = await import('../dist/componentArtifacts/index.js');
    await assert.rejects(
      artifacts.buildServerBinaryArtifactPayload({
        repoRoot,
        payloadDir,
        entrypoint: join(serverSourcesDir, 'main.light.ts'),
        buildDbProviders: 'sqlite',
        target: artifacts.resolveCurrentBinaryTarget({
          availableTargets: artifacts.SERVER_BINARY_TARGETS,
          platform: 'darwin',
          arch: 'arm64',
        }),
        commandProbe: () => true,
        runCommand: () => {},
        compileBinary: async ({ outfile }) => {
          writeFileSync(outfile, '#!/bin/sh\necho happier-server\n', 'utf8');
        },
      }),
      (error) => {
        assert.equal(error?.name, 'ServerArtifactRuntimeDependenciesBlockedError');
        assert.deepEqual(error?.report?.targets, [{
          target: 'darwin-arm64',
          failures: [{
            dependency: 'prisma-sqlite-query-engine',
            engineFileName: 'libquery_engine-darwin-arm64.dylib.node',
            reason: 'missing-engine',
          }],
        }]);
        return true;
      },
    );
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('buildServerBinaryArtifactPayload retries transient ENOENT failures while copying sidecars', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'component-artifacts-server-retry-'));
  try {
    const repoRoot = join(tempRoot, 'repo');
    const payloadDir = join(tempRoot, 'payload');
    const serverSourcesDir = join(repoRoot, 'apps', 'server', 'sources');
    const uiDistDir = join(repoRoot, 'apps', 'ui', 'dist');
    const sqliteClientDir = join(repoRoot, 'apps', 'server', 'generated', 'sqlite-client');
    const sqliteMigrationsDir = join(repoRoot, 'apps', 'server', 'prisma', 'sqlite', 'migrations');
    const postgresClientDir = join(repoRoot, 'node_modules', '.prisma', 'client');
    const prismaClientPackageDir = join(repoRoot, 'node_modules', '@prisma', 'client');

    mkdirSync(serverSourcesDir, { recursive: true });
    mkdirSync(uiDistDir, { recursive: true });
    mkdirSync(sqliteClientDir, { recursive: true });
    mkdirSync(sqliteMigrationsDir, { recursive: true });
    mkdirSync(postgresClientDir, { recursive: true });
    mkdirSync(prismaClientPackageDir, { recursive: true });

    writeFileSync(join(serverSourcesDir, 'main.light.ts'), 'export {};\n', 'utf8');
    writeFileSync(join(uiDistDir, 'index.html'), '<html>ui</html>\n', 'utf8');
    writeFileSync(join(sqliteClientDir, 'schema.prisma'), '// sqlite\n', 'utf8');
    writeFileSync(join(sqliteMigrationsDir, 'migration.sql'), '-- sql\n', 'utf8');
    writeFileSync(join(postgresClientDir, 'client.d.ts'), 'export {};\n', 'utf8');
    writeServerPrismaEngineFixtures({ sqliteClientDir, postgresClientDir });
    writeServerSharpRuntimeFixtures({ repoRoot });
    writeFileSync(join(prismaClientPackageDir, 'index.js'), 'module.exports = {};\n', 'utf8');

    const artifacts = await import('../dist/componentArtifacts/index.js');
    let copyAttempts = 0;
    await artifacts.buildServerBinaryArtifactPayload({
      repoRoot,
      payloadDir,
      buildDbProviders: 'sqlite',
      target: artifacts.resolveCurrentBinaryTarget({
        availableTargets: artifacts.SERVER_BINARY_TARGETS,
        platform: 'linux',
        arch: 'x64',
      }),
      commandProbe: () => true,
      runCommand: () => {},
      compileBinary: async ({ outfile }) => {
        writeFileSync(outfile, '#!/bin/sh\necho happier-server\n', 'utf8');
      },
      copyPath: async ({ sourcePath, destPath, recursive }, fallbackCopyPath) => {
        copyAttempts += 1;
        if (copyAttempts === 1) {
          const error = new Error(`ENOENT: no such file or directory, lstat '${sourcePath}'`);
          error.code = 'ENOENT';
          throw error;
        }
        return await fallbackCopyPath({ sourcePath, destPath, recursive });
      },
    });

    assert.ok(copyAttempts >= 2);
    assert.equal(readFileSync(join(payloadDir, 'node_modules', '.prisma', 'client', 'client.d.ts'), 'utf8'), 'export {};\n');
    assert.equal(readFileSync(join(payloadDir, 'node_modules', '@prisma', 'client', 'index.js'), 'utf8'), 'module.exports = {};\n');
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('buildServerBinaryArtifactPayload builds ui-web dist when it is missing', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'component-artifacts-server-ui-build-'));
  try {
    const repoRoot = join(tempRoot, 'repo');
    const payloadDir = join(tempRoot, 'payload');
    const serverSourcesDir = join(repoRoot, 'apps', 'server', 'sources');
    const sqliteClientDir = join(repoRoot, 'apps', 'server', 'generated', 'sqlite-client');
    const sqliteMigrationsDir = join(repoRoot, 'apps', 'server', 'prisma', 'sqlite', 'migrations');
    const postgresClientDir = join(repoRoot, 'node_modules', '.prisma', 'client');
    const prismaClientPackageDir = join(repoRoot, 'node_modules', '@prisma', 'client');

    mkdirSync(serverSourcesDir, { recursive: true });
    mkdirSync(sqliteClientDir, { recursive: true });
    mkdirSync(sqliteMigrationsDir, { recursive: true });
    mkdirSync(postgresClientDir, { recursive: true });
    mkdirSync(prismaClientPackageDir, { recursive: true });

    writeFileSync(join(serverSourcesDir, 'main.light.ts'), 'export {};\n', 'utf8');
    writeFileSync(join(sqliteClientDir, 'schema.prisma'), '// sqlite\n', 'utf8');
    writeFileSync(join(sqliteMigrationsDir, 'migration.sql'), '-- sql\n', 'utf8');
    writeFileSync(join(postgresClientDir, 'client.d.ts'), 'export {};\n', 'utf8');
    writeServerPrismaEngineFixtures({ sqliteClientDir, postgresClientDir });
    writeServerSharpRuntimeFixtures({ repoRoot });
    writeFileSync(join(prismaClientPackageDir, 'index.js'), 'module.exports = {};\n', 'utf8');

    const artifacts = await import('../dist/componentArtifacts/index.js');
    const runCalls = [];
    const uiBuildEnvs = [];
    await artifacts.buildServerBinaryArtifactPayload({
      repoRoot,
      payloadDir,
      buildDbProviders: 'sqlite',
      env: { HAPPIER_INSTALL_SCOPE: 'ui,protocol' },
      uiBuildProfile: { kind: 'deployment', releaseRing: 'stable' },
      target: artifacts.resolveCurrentBinaryTarget({
        availableTargets: artifacts.SERVER_BINARY_TARGETS,
        platform: 'linux',
        arch: 'x64',
      }),
      commandProbe: () => true,
      runCommand: (cmd, args, options) => {
        runCalls.push({ cmd, args });
        const argsText = Array.isArray(args) ? args.join(' ') : '';
        if (cmd === process.execPath && argsText.includes('apps/ui/scripts/ensureWorkspacePackagesBuilt.mjs')) {
          uiBuildEnvs.push(options?.env ?? null);
          return;
        }
        if (argsText.includes('--cwd apps/ui') && argsText.includes('expo export --platform web --output-dir dist')) {
          uiBuildEnvs.push(options?.env ?? null);
          const uiDistDir = join(repoRoot, 'apps', 'ui', 'dist');
          mkdirSync(uiDistDir, { recursive: true });
          writeFileSync(join(uiDistDir, 'index.html'), '<html>ui built</html>\n', 'utf8');
          writeFileSync(join(uiDistDir, 'main.js'), 'console.log("fresh ui");\n'.repeat(200), 'utf8');
          return;
        }
        if (cmd === process.execPath && argsText.includes('precompress-ui-web-assets.mjs --dir apps/ui/dist')) {
          uiBuildEnvs.push(options?.env ?? null);
          const uiDistDir = join(repoRoot, 'apps', 'ui', 'dist');
          writeFileSync(join(uiDistDir, 'main.js.br'), 'br-sidecar\n', 'utf8');
          writeFileSync(join(uiDistDir, 'main.js.gz'), 'gz-sidecar\n', 'utf8');
          return;
        }
      },
      compileBinary: async ({ outfile }) => {
        writeFileSync(outfile, '#!/bin/sh\necho happier-server\n', 'utf8');
      },
    });

    assert.deepEqual(runCalls, [
      { cmd: process.execPath, args: ['apps/server/scripts/buildSharedDeps.mjs', '--quiet'] },
      { cmd: 'yarn', args: ['--cwd', 'apps/server', '-s', 'generate:providers'] },
      { cmd: process.execPath, args: ['apps/ui/scripts/ensureWorkspacePackagesBuilt.mjs'] },
      { cmd: 'yarn', args: ['--cwd', 'apps/ui', '-s', 'expo', 'export', '--platform', 'web', '--output-dir', 'dist', '--max-workers', '2'] },
      { cmd: process.execPath, args: ['scripts/pipeline/release/precompress-ui-web-assets.mjs', '--dir', 'apps/ui/dist'] },
    ]);
    assert.equal(uiBuildEnvs.length, 3);
    assert.equal(uiBuildEnvs[0], uiBuildEnvs[1]);
    assert.equal(uiBuildEnvs[1], uiBuildEnvs[2]);
    assert.deepEqual(
      {
        APP_ENV: uiBuildEnvs[0]?.APP_ENV,
        EXPO_UPDATES_CHANNEL: uiBuildEnvs[0]?.EXPO_UPDATES_CHANNEL,
        EXPO_PUBLIC_HAPPIER_FEATURE_POLICY_ENV: uiBuildEnvs[0]?.EXPO_PUBLIC_HAPPIER_FEATURE_POLICY_ENV,
        EXPO_NO_DOTENV: uiBuildEnvs[0]?.EXPO_NO_DOTENV,
        EXPO_UNSTABLE_WEB_MODAL: uiBuildEnvs[0]?.EXPO_UNSTABLE_WEB_MODAL,
        NODE_ENV: uiBuildEnvs[0]?.NODE_ENV,
        BABEL_ENV: uiBuildEnvs[0]?.BABEL_ENV,
        CI: uiBuildEnvs[0]?.CI,
        HAPPIER_INSTALL_SCOPE: uiBuildEnvs[0]?.HAPPIER_INSTALL_SCOPE,
      },
      {
        APP_ENV: 'production',
        EXPO_UPDATES_CHANNEL: 'production',
        EXPO_PUBLIC_HAPPIER_FEATURE_POLICY_ENV: 'production',
        EXPO_NO_DOTENV: '1',
        EXPO_UNSTABLE_WEB_MODAL: '1',
        NODE_ENV: 'production',
        BABEL_ENV: 'production',
        CI: '1',
        HAPPIER_INSTALL_SCOPE: 'ui,protocol',
      },
    );
    assert.equal(readFileSync(join(payloadDir, 'ui-web', 'current', 'index.html'), 'utf8'), '<html>ui built</html>\n');
    assert.equal(readFileSync(join(payloadDir, 'ui-web', 'current', 'main.js.br'), 'utf8'), 'br-sidecar\n');
    assert.equal(readFileSync(join(payloadDir, 'ui-web', 'current', 'main.js.gz'), 'utf8'), 'gz-sidecar\n');
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('buildServerBinaryArtifactPayload reuses one verified ui-web generation within a multi-target build invocation', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'component-artifacts-server-ui-invocation-'));
  try {
    const repoRoot = join(tempRoot, 'repo');
    const serverSourcesDir = join(repoRoot, 'apps', 'server', 'sources');
    const sqliteClientDir = join(repoRoot, 'apps', 'server', 'generated', 'sqlite-client');
    const sqliteMigrationsDir = join(repoRoot, 'apps', 'server', 'prisma', 'sqlite', 'migrations');
    const postgresClientDir = join(repoRoot, 'node_modules', '.prisma', 'client');
    const prismaClientPackageDir = join(repoRoot, 'node_modules', '@prisma', 'client');

    mkdirSync(serverSourcesDir, { recursive: true });
    mkdirSync(sqliteClientDir, { recursive: true });
    mkdirSync(sqliteMigrationsDir, { recursive: true });
    mkdirSync(postgresClientDir, { recursive: true });
    mkdirSync(prismaClientPackageDir, { recursive: true });
    writeFileSync(join(serverSourcesDir, 'main.light.ts'), 'export {};\n', 'utf8');
    writeFileSync(join(sqliteClientDir, 'schema.prisma'), '// sqlite\n', 'utf8');
    writeFileSync(join(sqliteMigrationsDir, 'migration.sql'), '-- sql\n', 'utf8');
    writeFileSync(join(postgresClientDir, 'client.d.ts'), 'export {};\n', 'utf8');
    writeFileSync(join(prismaClientPackageDir, 'index.js'), 'module.exports = {};\n', 'utf8');
    const targetFixtures = [
      { label: 'linux-x64', resolvePlatform: 'linux', fixturePlatform: 'linux', arch: 'x64' },
      { label: 'linux-arm64', resolvePlatform: 'linux', fixturePlatform: 'linux', arch: 'arm64' },
      { label: 'darwin-x64', resolvePlatform: 'darwin', fixturePlatform: 'darwin', arch: 'x64' },
      { label: 'darwin-arm64', resolvePlatform: 'darwin', fixturePlatform: 'darwin', arch: 'arm64' },
      { label: 'windows-x64', resolvePlatform: 'win32', fixturePlatform: 'windows', arch: 'x64' },
    ];
    for (const targetFixture of targetFixtures) {
      writeServerPrismaEngineFixtures({
        sqliteClientDir,
        postgresClientDir,
        platform: targetFixture.fixturePlatform,
        arch: targetFixture.arch,
      });
      writeServerSharpRuntimeFixtures({
        repoRoot,
        platform: targetFixture.fixturePlatform,
        arch: targetFixture.arch,
      });
    }

    const artifacts = await import('../dist/componentArtifacts/index.js');
    const buildInvocation = artifacts.createServerArtifactBuildInvocation();
    const env = { HAPPIER_INSTALL_SCOPE: 'ui,protocol' };
    let uiExportCount = 0;
    let uiPrecompressCount = 0;
    const runCommand = async (cmd, args) => {
      const argsText = Array.isArray(args) ? args.join(' ') : '';
      if (argsText.includes('--cwd apps/ui') && argsText.includes('expo export --platform web --output-dir dist')) {
        uiExportCount += 1;
        if (uiExportCount > 1) {
          const error = new Error('simulated Windows rmdir failure during a repeated UI export');
          error.code = 'EPERM';
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 0));
        const uiDistDir = join(repoRoot, 'apps', 'ui', 'dist');
        mkdirSync(uiDistDir, { recursive: true });
        writeFileSync(join(uiDistDir, 'index.html'), '<html>single generation</html>\n', 'utf8');
        return;
      }
      if (cmd === process.execPath && argsText.includes('precompress-ui-web-assets.mjs --dir apps/ui/dist')) {
        uiPrecompressCount += 1;
      }
    };

    const buildTarget = async ({
      targetFixture,
      invocation = buildInvocation,
      profile = { kind: 'deployment', releaseRing: 'stable' },
      buildEnv = env,
      payloadName = `payload-${targetFixture.label}`,
    }) => {
      await artifacts.buildServerBinaryArtifactPayload({
        repoRoot,
        payloadDir: join(tempRoot, payloadName),
        buildDbProviders: 'sqlite',
        env: buildEnv,
        uiBuildProfile: profile,
        buildInvocation: invocation,
        target: artifacts.resolveCurrentBinaryTarget({
          availableTargets: artifacts.SERVER_BINARY_TARGETS,
          platform: targetFixture.resolvePlatform,
          arch: targetFixture.arch,
        }),
        commandProbe: () => true,
        runCommand,
        compileBinary: async ({ outfile }) => {
          writeFileSync(outfile, '#!/bin/sh\necho happier-server\n', 'utf8');
        },
      });
    };

    for (const targetFixture of targetFixtures) {
      await buildTarget({ targetFixture });
    }

    assert.equal(uiExportCount, 1);
    assert.equal(uiPrecompressCount, 1);
    for (const targetFixture of targetFixtures) {
      assert.equal(
        readFileSync(
          join(tempRoot, `payload-${targetFixture.label}`, 'ui-web', 'current', 'index.html'),
          'utf8',
        ),
        '<html>single generation</html>\n',
      );
    }

    await assert.rejects(
      () => buildTarget({
        targetFixture: targetFixtures[0],
        profile: { kind: 'deployment', releaseRing: 'preview' },
        payloadName: 'payload-profile-drift',
      }),
      /build invocation UI inputs changed/i,
    );
    await assert.rejects(
      () => buildTarget({
        targetFixture: targetFixtures[0],
        buildEnv: { ...env, NON_UI_AMBIENT_INPUT: 'changed' },
        payloadName: 'payload-env-drift',
      }),
      /build invocation UI inputs changed/i,
    );
    assert.equal(uiExportCount, 1, 'profile or environment drift must fail before another export');

    await assert.rejects(
      () => buildTarget({
        targetFixture: targetFixtures[0],
        invocation: artifacts.createServerArtifactBuildInvocation(),
        payloadName: 'payload-new-invocation',
      }),
      /simulated Windows rmdir failure/i,
    );
    assert.equal(uiExportCount, 2, 'a new invocation must not reuse the previous UI generation');

    await assert.rejects(
      () => buildTarget({
        targetFixture: targetFixtures[0],
        invocation: Object.freeze({}),
        payloadName: 'payload-forged-invocation',
      }),
      /invalid server artifact build invocation/i,
    );
    assert.equal(uiExportCount, 2, 'a forged invocation must fail before UI generation');
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('buildServerBinaryArtifactPayload rebuilds ui-web dist even when a stale dist directory already exists', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'component-artifacts-server-ui-refresh-'));
  try {
    const repoRoot = join(tempRoot, 'repo');
    const payloadDir = join(tempRoot, 'payload');
    const serverSourcesDir = join(repoRoot, 'apps', 'server', 'sources');
    const uiDistDir = join(repoRoot, 'apps', 'ui', 'dist');
    const sqliteClientDir = join(repoRoot, 'apps', 'server', 'generated', 'sqlite-client');
    const sqliteMigrationsDir = join(repoRoot, 'apps', 'server', 'prisma', 'sqlite', 'migrations');
    const postgresClientDir = join(repoRoot, 'node_modules', '.prisma', 'client');
    const prismaClientPackageDir = join(repoRoot, 'node_modules', '@prisma', 'client');

    mkdirSync(serverSourcesDir, { recursive: true });
    mkdirSync(uiDistDir, { recursive: true });
    mkdirSync(sqliteClientDir, { recursive: true });
    mkdirSync(sqliteMigrationsDir, { recursive: true });
    mkdirSync(postgresClientDir, { recursive: true });
    mkdirSync(prismaClientPackageDir, { recursive: true });

    writeFileSync(join(serverSourcesDir, 'main.light.ts'), 'export {};\n', 'utf8');
    writeFileSync(join(uiDistDir, 'index.html'), '<html>stale ui</html>\n', 'utf8');
    writeFileSync(join(sqliteClientDir, 'schema.prisma'), '// sqlite\n', 'utf8');
    writeFileSync(join(sqliteMigrationsDir, 'migration.sql'), '-- sql\n', 'utf8');
    writeFileSync(join(postgresClientDir, 'client.d.ts'), 'export {};\n', 'utf8');
    writeServerPrismaEngineFixtures({ sqliteClientDir, postgresClientDir });
    writeServerSharpRuntimeFixtures({ repoRoot });
    writeFileSync(join(prismaClientPackageDir, 'index.js'), 'module.exports = {};\n', 'utf8');

    const artifacts = await import('../dist/componentArtifacts/index.js');
    const runCalls = [];
    await artifacts.buildServerBinaryArtifactPayload({
      repoRoot,
      payloadDir,
      buildDbProviders: 'sqlite',
      target: artifacts.resolveCurrentBinaryTarget({
        availableTargets: artifacts.SERVER_BINARY_TARGETS,
        platform: 'linux',
        arch: 'x64',
      }),
      commandProbe: () => true,
      runCommand: (cmd, args) => {
        runCalls.push({ cmd, args });
        const argsText = Array.isArray(args) ? args.join(' ') : '';
        if (cmd === process.execPath && argsText.includes('apps/ui/scripts/ensureWorkspacePackagesBuilt.mjs')) {
          return;
        }
        if (argsText.includes('--cwd apps/ui') && argsText.includes('expo export --platform web --output-dir dist')) {
          writeFileSync(join(uiDistDir, 'index.html'), '<html>fresh ui</html>\n', 'utf8');
        }
      },
      compileBinary: async ({ outfile }) => {
        writeFileSync(outfile, '#!/bin/sh\necho happier-server\n', 'utf8');
      },
    });

    assert.deepEqual(runCalls, [
      { cmd: process.execPath, args: ['apps/server/scripts/buildSharedDeps.mjs', '--quiet'] },
      { cmd: 'yarn', args: ['--cwd', 'apps/server', '-s', 'generate:providers'] },
      { cmd: process.execPath, args: ['apps/ui/scripts/ensureWorkspacePackagesBuilt.mjs'] },
      { cmd: 'yarn', args: ['--cwd', 'apps/ui', '-s', 'expo', 'export', '--platform', 'web', '--output-dir', 'dist', '--max-workers', '2'] },
      { cmd: process.execPath, args: ['scripts/pipeline/release/precompress-ui-web-assets.mjs', '--dir', 'apps/ui/dist'] },
    ]);
    assert.equal(readFileSync(join(payloadDir, 'ui-web', 'current', 'index.html'), 'utf8'), '<html>fresh ui</html>\n');
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
