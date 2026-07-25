import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ensureWorkspacePackagesBuiltByName,
  ensureWorkspacePackagesBuiltForComponent,
} from '../../../../../scripts/workspaces/ensureWorkspacePackagesBuilt.mjs';
import { ensureCliDeclarationPrerequisites } from '../../../../cli/scripts/buildSharedDeps.mjs';

async function createAtomicBuildBarrier({ timeoutMs = 30_000 } = {}) {
  const sockets = new Set();
  let startedSettled = false;
  let startedResolve;
  let startedReject;
  const started = new Promise((resolve, reject) => {
    startedResolve = resolve;
    startedReject = reject;
  });
  const timer = setTimeout(() => {
    if (startedSettled) return;
    startedSettled = true;
    startedReject(new Error('Timed out waiting for atomic build barrier'));
  }, timeoutMs);
  timer.unref?.();

  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      if (!startedSettled && buffer.includes('started\n')) {
        startedSettled = true;
        clearTimeout(timer);
        startedResolve();
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');

  const closeServer = async () => {
    if (!server.listening) return;
    await new Promise((resolve) => server.close(resolve));
  };
  const cancel = async () => {
    clearTimeout(timer);
    const closing = [...sockets].map((socket) => once(socket, 'close'));
    for (const socket of sockets) socket.destroy();
    await closeServer();
    await Promise.all(closing);
  };
  const release = async () => {
    const socket = [...sockets][0];
    assert.ok(socket, 'expected atomic build barrier socket');
    const closed = once(socket, 'close');
    socket.write('release\n');
    await closed;
    await closeServer();
  };

  return {
    port: address.port,
    started,
    release,
    cancel,
    activeSockets: () => sockets.size,
    isListening: () => server.listening,
  };
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
}

async function writeYarnWorkspaceBuildStub({ binDir, outputPath }) {
  await mkdir(binDir, { recursive: true });
  const yarnPath = join(binDir, 'yarn');
  await writeFile(
    yarnPath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'echo "$(pwd) :: $*" >> "${OUTPUT_PATH:?}"',
      '',
      'if [[ "${1:-}" == "--version" ]]; then',
      '  IFS= read -r _ || true',
      '  echo "1.22.22"',
      '  exit 0',
      'fi',
      '',
      '# Simulate `yarn -s build` creating dist outputs for workspace packages.',
      'if [[ "${1:-}" == "-s" && "${2:-}" == "build" ]]; then',
      '  out="${HAPPIER_WORKSPACE_DIST_OUTPUT_DIR:-dist}"',
      '  if [[ "$(pwd)" == */packages/protocol ]]; then',
      '    mkdir -p "$out"',
      "    printf '%s\\n' 'export const ok = true;' > \"$out/index.js\"",
      "    printf '%s\\n' \"import './machineTransfer/transferStream.js';\" >> \"$out/index.js\"",
      "    printf '%s\\n' 'export const ok = true;' > \"$out/rpcErrors.js\"",
      "    printf '%s\\n' 'export declare const ok: boolean;' > \"$out/index.d.ts\"",
      "    printf '%s\\n' 'export declare const ok: boolean;' > \"$out/rpcErrors.d.ts\"",
      '    mkdir -p "$out/machineTransfer"',
      "    printf '%s\\n' 'export const ok = true;' > \"$out/machineTransfer/transferStream.js\"",
      "    printf '%s\\n' 'export declare const ok: boolean;' > \"$out/machineTransfer/transferStream.d.ts\"",
      '    exit 0',
      '  fi',
      '  if [[ "$(pwd)" == */packages/agents ]]; then',
      '    mkdir -p "$out"',
      "    printf '%s\\n' 'export const ok = true;' > \"$out/index.js\"",
      "    printf '%s\\n' 'export declare const ok: boolean;' > \"$out/index.d.ts\"",
      '    exit 0',
      '  fi',
      '  if [[ "$(pwd)" == */packages/cli-common ]]; then',
      '    mkdir -p "$out"',
      "    printf '%s\\n' 'export const ok = true;' > \"$out/index.js\"",
      "    printf '%s\\n' 'export declare const ok: boolean;' > \"$out/index.d.ts\"",
      '    exit 0',
      '  fi',
      'fi',
      '',
      'exit 0',
    ].join('\n') + '\n',
    'utf-8',
  );
  await chmod(yarnPath, 0o755);
  await writeFile(outputPath, '', 'utf-8');
}

function applyEnvOverrides(t, vars) {
  const previous = {};
  for (const key of Object.keys(vars)) {
    previous[key] = process.env[key];
  }
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  });
  for (const [key, value] of Object.entries(vars)) {
    if (value == null) delete process.env[key];
    else process.env[key] = String(value);
  }
}

test('ensureWorkspacePackagesBuiltForComponent builds internal dist-based workspaces when export targets are missing', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hs-ensure-workspaces-built-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  // Minimal Happy monorepo markers.
  await mkdir(join(root, 'apps', 'ui'), { recursive: true });
  await mkdir(join(root, 'apps', 'cli'), { recursive: true });
  await mkdir(join(root, 'apps', 'server'), { recursive: true });
  await writeJson(join(root, 'apps', 'ui', 'package.json'), {
    name: '@happier-dev/app',
    private: true,
    dependencies: {
      '@happier-dev/protocol': '0.0.0',
    },
  });
  await writeJson(join(root, 'apps', 'cli', 'package.json'), { name: '@happier-dev/cli', private: true });
  await writeJson(join(root, 'apps', 'server', 'package.json'), { name: '@happier-dev/server', private: true });

  const protocolDir = join(root, 'packages', 'protocol');
  await mkdir(protocolDir, { recursive: true });
  await writeJson(join(protocolDir, 'package.json'), {
    name: '@happier-dev/protocol',
    version: '0.0.0',
    type: 'module',
    main: './dist/index.js',
    types: './dist/index.d.ts',
    exports: {
      '.': { default: './dist/index.js', types: './dist/index.d.ts' },
      './rpcErrors': { default: './dist/rpcErrors.js', types: './dist/rpcErrors.d.ts' },
      './runtime': { require: './runtime.cjs', default: './dist/index.js' },
    },
    scripts: { build: 'tsc -p tsconfig.json' },
  });
  await writeFile(join(protocolDir, 'runtime.cjs'), 'module.exports = {};\n', 'utf-8');
  await writeJson(join(protocolDir, 'tsconfig.json'), { compilerOptions: { outDir: 'dist' } });

  const binDir = join(root, 'bin');
  const outputPath = join(root, 'argv.txt');
  await writeYarnWorkspaceBuildStub({ binDir, outputPath });

  applyEnvOverrides(t, {
    PATH: `${binDir}:/usr/bin:/bin`,
    OUTPUT_PATH: outputPath,
    HAPPIER_STACK_ENV_FILE: null,
  });

  await ensureWorkspacePackagesBuiltForComponent(join(root, 'apps', 'ui'), { quiet: true, env: process.env });

  const out = await readFile(outputPath, 'utf-8');
  assert.match(out, /packages\/protocol :: -s build/);
  assert.equal(Boolean(await readFile(join(protocolDir, 'dist', 'rpcErrors.js'), 'utf-8')), true);
  const preservedOutputTime = new Date(Date.now() - 60_000);
  await utimes(join(protocolDir, 'dist', 'index.d.ts'), preservedOutputTime, preservedOutputTime);

  // A valid output is a read-only admission path. Make the package-lock directory impossible to
  // create so this second call fails if it tries to acquire the mutation lock before checking.
  const workspaceLockDir = join(root, '.project', 'tmp', 'workspace-dist-builds');
  await rm(workspaceLockDir, { recursive: true, force: true });
  await mkdir(join(root, '.project', 'tmp'), { recursive: true });
  await writeFile(workspaceLockDir, 'lock-directory-must-not-be-touched\n', 'utf-8');

  // Second run should be a no-op (no additional build or lock acquisition).
  await ensureWorkspacePackagesBuiltForComponent(join(root, 'apps', 'ui'), { quiet: true, env: process.env });
  const out2 = await readFile(outputPath, 'utf-8');
  const occurrences = out2.split('\n').filter((l) => l.includes('/packages/protocol :: -s build')).length;
  assert.equal(occurrences, 1);

  // Source freshness is part of output validity, not an adapter concern.
  await rm(workspaceLockDir, { force: true });
  await new Promise((resolve) => setTimeout(resolve, 20));
  await mkdir(join(protocolDir, 'src'), { recursive: true });
  await writeFile(join(protocolDir, 'src', 'index.ts'), 'export const changed = true;\n', 'utf-8');
  await ensureWorkspacePackagesBuiltForComponent(join(root, 'apps', 'ui'), { quiet: true, env: process.env });
  const out3 = await readFile(outputPath, 'utf-8');
  const occurrencesAfterSourceChange = out3.split('\n').filter((l) => l.includes('/packages/protocol :: -s build')).length;
  assert.equal(occurrencesAfterSourceChange, 2);

  await new Promise((resolve) => setTimeout(resolve, 20));
  const protocolPackage = JSON.parse(await readFile(join(protocolDir, 'package.json'), 'utf-8'));
  await writeJson(join(protocolDir, 'package.json'), { ...protocolPackage, description: 'changed package input' });
  await ensureWorkspacePackagesBuiltForComponent(join(root, 'apps', 'ui'), { quiet: true, env: process.env });

  await new Promise((resolve) => setTimeout(resolve, 20));
  await writeJson(join(protocolDir, 'tsconfig.json'), { compilerOptions: { outDir: 'dist', strict: true } });
  await ensureWorkspacePackagesBuiltForComponent(join(root, 'apps', 'ui'), { quiet: true, env: process.env });

  await new Promise((resolve) => setTimeout(resolve, 20));
  await writeFile(join(protocolDir, 'src', 'rpc.test.ts'), 'export const testOnly = true;\n', 'utf-8');
  await ensureWorkspacePackagesBuiltForComponent(join(root, 'apps', 'ui'), { quiet: true, env: process.env });
  const finalOut = await readFile(outputPath, 'utf-8');
  const finalOccurrences = finalOut.split('\n').filter((l) => l.includes('/packages/protocol :: -s build')).length;
  assert.equal(finalOccurrences, 4, 'source/config/package changes rebuild, while test-only source does not');
});

test('ensureWorkspacePackagesBuiltForComponent walks the full internal workspace dependency closure before building', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hs-ensure-workspaces-built-closure-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  await mkdir(join(root, 'apps', 'ui'), { recursive: true });
  await mkdir(join(root, 'apps', 'cli'), { recursive: true });
  await mkdir(join(root, 'apps', 'server'), { recursive: true });
  await writeJson(join(root, 'apps', 'ui', 'package.json'), {
    name: '@happier-dev/app',
    private: true,
    dependencies: {
      '@happier-dev/cli-common': '0.0.0',
    },
  });
  await writeJson(join(root, 'apps', 'cli', 'package.json'), { name: '@happier-dev/cli', private: true });
  await writeJson(join(root, 'apps', 'server', 'package.json'), { name: '@happier-dev/server', private: true });

  const cliCommonDir = join(root, 'packages', 'cli-common');
  const agentsDir = join(root, 'packages', 'agents');
  const protocolDir = join(root, 'packages', 'protocol');
  for (const dir of [cliCommonDir, agentsDir, protocolDir]) {
    await mkdir(dir, { recursive: true });
  }

  await writeJson(join(cliCommonDir, 'package.json'), {
    name: '@happier-dev/cli-common',
    version: '0.0.0',
    type: 'module',
    main: './dist/index.js',
    types: './dist/index.d.ts',
    exports: { '.': { default: './dist/index.js', types: './dist/index.d.ts' } },
    dependencies: {
      '@happier-dev/agents': '0.0.0',
    },
    scripts: { build: 'tsc -p tsconfig.json' },
  });
  await writeJson(join(agentsDir, 'package.json'), {
    name: '@happier-dev/agents',
    version: '0.0.0',
    type: 'module',
    main: './dist/index.js',
    types: './dist/index.d.ts',
    exports: { '.': { default: './dist/index.js', types: './dist/index.d.ts' } },
    dependencies: {
      '@happier-dev/protocol': '0.0.0',
    },
    scripts: { build: 'tsc -p tsconfig.json' },
  });
  await writeJson(join(protocolDir, 'package.json'), {
    name: '@happier-dev/protocol',
    version: '0.0.0',
    type: 'module',
    main: './dist/index.js',
    types: './dist/index.d.ts',
    exports: { '.': { default: './dist/index.js', types: './dist/index.d.ts' } },
    scripts: { build: 'tsc -p tsconfig.json' },
  });

  const binDir = join(root, 'bin');
  const outputPath = join(root, 'argv.txt');
  await writeYarnWorkspaceBuildStub({ binDir, outputPath });

  applyEnvOverrides(t, {
    PATH: `${binDir}:/usr/bin:/bin`,
    OUTPUT_PATH: outputPath,
    HAPPIER_STACK_ENV_FILE: null,
  });

  await ensureWorkspacePackagesBuiltForComponent(join(root, 'apps', 'ui'), { quiet: true, env: process.env });

  const out = await readFile(outputPath, 'utf-8');
  const orderedPackages = out
    .split('\n')
    .filter(Boolean)
    .filter((line) => line.includes(' :: -s build'))
    .map((line) => line.slice(line.indexOf('packages/')));

  assert.deepEqual(orderedPackages, [
    'packages/protocol :: -s build',
    'packages/agents :: -s build',
    'packages/cli-common :: -s build',
  ]);
  assert.equal(Boolean(await readFile(join(protocolDir, 'dist', 'index.js'), 'utf-8')), true);
  assert.equal(Boolean(await readFile(join(agentsDir, 'dist', 'index.js'), 'utf-8')), true);
  assert.equal(Boolean(await readFile(join(cliCommonDir, 'dist', 'index.js'), 'utf-8')), true);

  await rm(join(cliCommonDir, 'dist'), { recursive: true, force: true });
  await ensureWorkspacePackagesBuiltByName(root, ['@happier-dev/cli-common'], {
    quiet: true,
    env: process.env,
  });
  const rebuiltOut = await readFile(outputPath, 'utf-8');
  assert.equal(
    rebuiltOut.split('\n').filter((line) => line.includes('/packages/protocol :: -s build')).length,
    1,
  );
  assert.equal(
    rebuiltOut.split('\n').filter((line) => line.includes('/packages/agents :: -s build')).length,
    1,
  );
  assert.equal(
    rebuiltOut.split('\n').filter((line) => line.includes('/packages/cli-common :: -s build')).length,
    2,
  );
});

test('ensureWorkspacePackagesBuiltForComponent rebuilds internal workspaces when exported entrypoints have missing local imports', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hs-ensure-workspaces-built-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  // Minimal Happy monorepo markers.
  await mkdir(join(root, 'apps', 'ui'), { recursive: true });
  await mkdir(join(root, 'apps', 'cli'), { recursive: true });
  await mkdir(join(root, 'apps', 'server'), { recursive: true });
  await writeJson(join(root, 'apps', 'ui', 'package.json'), {
    name: '@happier-dev/app',
    private: true,
    dependencies: {
      '@happier-dev/protocol': '0.0.0',
    },
  });
  await writeJson(join(root, 'apps', 'cli', 'package.json'), { name: '@happier-dev/cli', private: true });
  await writeJson(join(root, 'apps', 'server', 'package.json'), { name: '@happier-dev/server', private: true });

  const protocolDir = join(root, 'packages', 'protocol');
  await mkdir(protocolDir, { recursive: true });
  await writeJson(join(protocolDir, 'package.json'), {
    name: '@happier-dev/protocol',
    version: '0.0.0',
    type: 'module',
    main: './dist/index.js',
    types: './dist/index.d.ts',
    exports: {
      '.': { default: './dist/index.js', types: './dist/index.d.ts' },
      './rpcErrors': { default: './dist/rpcErrors.js', types: './dist/rpcErrors.d.ts' },
    },
    scripts: { build: 'tsc -p tsconfig.json' },
  });
  await writeJson(join(protocolDir, 'tsconfig.json'), { compilerOptions: { outDir: 'dist' } });

  // Pre-create "complete" export targets, but with a missing local import inside dist/index.js.
  await mkdir(join(protocolDir, 'dist'), { recursive: true });
  await writeFile(
    join(protocolDir, 'dist', 'index.js'),
    ["export const ok = true;", "import './machineTransfer/transferStream.js';"].join('\n') + '\n',
    'utf-8',
  );
  await writeFile(join(protocolDir, 'dist', 'rpcErrors.js'), "export const ok = true;\n", 'utf-8');
  await writeFile(join(protocolDir, 'dist', 'index.d.ts'), "export declare const ok: boolean;\n", 'utf-8');
  await writeFile(join(protocolDir, 'dist', 'rpcErrors.d.ts'), "export declare const ok: boolean;\n", 'utf-8');

  const binDir = join(root, 'bin');
  const outputPath = join(root, 'argv.txt');
  await writeYarnWorkspaceBuildStub({ binDir, outputPath });

  applyEnvOverrides(t, {
    PATH: `${binDir}:/usr/bin:/bin`,
    OUTPUT_PATH: outputPath,
    HAPPIER_STACK_ENV_FILE: null,
  });

  await ensureWorkspacePackagesBuiltForComponent(join(root, 'apps', 'ui'), { quiet: true, env: process.env });

  const out = await readFile(outputPath, 'utf-8');
  assert.match(out, /packages\/protocol :: -s build/);
  assert.equal(Boolean(await readFile(join(protocolDir, 'dist', 'machineTransfer', 'transferStream.js'), 'utf-8')), true);
});

test('ensureWorkspacePackagesBuiltForComponent serializes concurrent internal workspace builds', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hs-ensure-workspaces-built-concurrent-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  await mkdir(join(root, 'apps', 'ui'), { recursive: true });
  await mkdir(join(root, 'apps', 'cli'), { recursive: true });
  await mkdir(join(root, 'apps', 'server'), { recursive: true });
  await writeJson(join(root, 'apps', 'server', 'package.json'), {
    name: '@happier-dev/server',
    private: true,
    dependencies: {
      '@happier-dev/cli-common': '0.0.0',
    },
  });
  await writeJson(join(root, 'apps', 'ui', 'package.json'), { name: '@happier-dev/app', private: true });
  await writeJson(join(root, 'apps', 'cli', 'package.json'), { name: '@happier-dev/cli', private: true });

  const cliCommonDir = join(root, 'packages', 'cli-common');
  await mkdir(cliCommonDir, { recursive: true });
  await writeJson(join(cliCommonDir, 'package.json'), {
    name: '@happier-dev/cli-common',
    version: '0.0.0',
    type: 'module',
    exports: { '.': { default: './dist/index.js', types: './dist/index.d.ts' } },
    scripts: { build: 'tsc -p tsconfig.json' },
  });

  const binDir = join(root, 'bin');
  const outputPath = join(root, 'argv.txt');
  await mkdir(binDir, { recursive: true });
  await writeFile(
    join(binDir, 'yarn'),
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'echo "$(pwd) :: $*" >> "${OUTPUT_PATH:?}"',
      'if [[ "${1:-}" == "--version" ]]; then IFS= read -r _ || true; echo "1.22.22"; exit 0; fi',
      'if [[ "${1:-}" == "-s" && "${2:-}" == "build" && "$(pwd)" == */packages/cli-common ]]; then',
      '  out="${HAPPIER_WORKSPACE_DIST_OUTPUT_DIR:-dist}"',
      '  sleep 0.12',
      '  mkdir -p "$out"',
      "  printf '%s\\n' 'export const ok = true;' > \"$out/index.js\"",
      "  printf '%s\\n' 'export declare const ok: boolean;' > \"$out/index.d.ts\"",
      '  exit 0',
      'fi',
      'exit 0',
    ].join('\n') + '\n',
    'utf-8',
  );
  await chmod(join(binDir, 'yarn'), 0o755);
  await writeFile(outputPath, '', 'utf-8');

  applyEnvOverrides(t, {
    PATH: `${binDir}:/usr/bin:/bin`,
    OUTPUT_PATH: outputPath,
    HAPPIER_STACK_ENV_FILE: null,
  });

  await Promise.all([
    ensureWorkspacePackagesBuiltForComponent(join(root, 'apps', 'server'), { quiet: true, env: process.env }),
    ensureWorkspacePackagesBuiltForComponent(join(root, 'apps', 'server'), { quiet: true, env: process.env }),
  ]);

  const out = await readFile(outputPath, 'utf-8');
  const occurrences = out.split('\n').filter((line) => line.includes('/packages/cli-common :: -s build')).length;
  assert.equal(occurrences, 1);
});

test('CLI declaration preparation waits for the canonical workspace package publication owner', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hs-ensure-workspaces-built-cli-owner-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  await mkdir(join(root, 'apps', 'cli'), { recursive: true });
  await mkdir(join(root, 'apps', 'ui'), { recursive: true });
  await mkdir(join(root, 'apps', 'server'), { recursive: true });
  await writeJson(join(root, 'apps', 'cli', 'package.json'), {
    name: '@happier-dev/cli',
    private: true,
    dependencies: {
      '@happier-dev/protocol': '0.0.0',
    },
    bundledDependencies: [
      '@happier-dev/protocol',
    ],
  });
  await writeJson(join(root, 'apps', 'ui', 'package.json'), { name: '@happier-dev/app', private: true });
  await writeJson(join(root, 'apps', 'server', 'package.json'), { name: '@happier-dev/server', private: true });

  const protocolDir = join(root, 'packages', 'protocol');
  await mkdir(join(protocolDir, 'src'), { recursive: true });
  await mkdir(join(protocolDir, 'dist'), { recursive: true });
  await writeJson(join(protocolDir, 'package.json'), {
    name: '@happier-dev/protocol',
    version: '0.0.0',
    type: 'module',
    exports: { '.': { default: './dist/index.js', types: './dist/index.d.ts' } },
    scripts: { build: 'tsc -p tsconfig.json' },
  });
  await writeJson(join(protocolDir, 'tsconfig.json'), { compilerOptions: { outDir: 'dist' } });
  await writeFile(join(protocolDir, 'src', 'index.ts'), 'export const next = true;\n', 'utf-8');
  await writeFile(
    join(protocolDir, 'dist', 'index.js'),
    "export const stable = true;\nimport './missing.js';\n",
    'utf-8',
  );
  await writeFile(join(protocolDir, 'dist', 'index.d.ts'), 'export declare const stable: boolean;\n', 'utf-8');

  const bundledProtocolDir = join(root, 'apps', 'cli', 'node_modules', '@happier-dev', 'protocol');
  await mkdir(join(bundledProtocolDir, 'dist'), { recursive: true });
  await writeJson(join(bundledProtocolDir, 'package.json'), {
    name: '@happier-dev/protocol',
    exports: { '.': { default: './dist/index.js', types: './dist/index.d.ts' } },
  });
  await writeFile(join(bundledProtocolDir, 'dist', 'index.d.ts'), 'export declare const old: boolean;\n', 'utf-8');
  await new Promise((resolve) => setTimeout(resolve, 20));
  await writeFile(join(protocolDir, 'src', 'index.ts'), 'export const next = true;\n', 'utf-8');

  const binDir = join(root, 'bin');
  const outputPath = join(root, 'argv.txt');
  await mkdir(binDir, { recursive: true });
  await writeFile(
    join(binDir, 'yarn'),
    `#!${process.execPath}
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const args = process.argv.slice(2);
const out = process.env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR || 'dist';
fs.appendFileSync(process.env.OUTPUT_PATH, process.cwd() + ' :: ' + args.join(' ') + ' :: out=' + out + '\\n');
if (args[0] === '--version') {
  process.stdin.resume();
  process.stdin.once('data', () => {
    process.stdout.write('1.22.22\\n');
    process.exit(0);
  });
} else if (args[0] === '-s' && args[1] === 'build' && process.cwd().endsWith('/packages/protocol')) {
  const socket = net.createConnection({ host: '127.0.0.1', port: Number(process.env.TEST_ATOMIC_BUILD_BARRIER_PORT) });
  let released = false;
  let buffer = '';
  socket.once('connect', () => socket.write('started\\n'));
  socket.on('data', (chunk) => {
    buffer += chunk.toString();
    if (!released && buffer.includes('release\\n')) {
      released = true;
      fs.mkdirSync(out, { recursive: true });
      fs.writeFileSync(path.join(out, 'index.js'), 'export const built = true;\\n');
      fs.writeFileSync(path.join(out, 'index.d.ts'), 'export declare const built: boolean;\\n');
      socket.end();
    }
  });
  socket.once('error', () => process.exit(4));
  socket.once('close', () => process.exit(released ? 0 : 4));
} else {
  process.exit(0);
}
`,
    'utf-8',
  );
  await chmod(join(binDir, 'yarn'), 0o755);
  await writeFile(outputPath, '', 'utf-8');

  applyEnvOverrides(t, {
    PATH: `${binDir}:/usr/bin:/bin`,
    OUTPUT_PATH: outputPath,
    HAPPIER_STACK_ENV_FILE: null,
  });

  const buildBarrier = await createAtomicBuildBarrier();
  const canonicalBuild = ensureWorkspacePackagesBuiltForComponent(join(root, 'apps', 'cli'), {
    quiet: true,
    env: {
      ...process.env,
      TEST_ATOMIC_BUILD_BARRIER_PORT: String(buildBarrier.port),
    },
  });

  let bypassCompileStarted = false;
  let assertionError = null;
  let cliPreparation;
  try {
    await buildBarrier.started;
    cliPreparation = ensureCliDeclarationPrerequisites({
      repoRoot: root,
      lockPath: join(root, '.project', 'tmp', 'cli-dist-build.lock'),
      workspaceNames: ['protocol'],
      runTscImpl: () => {
        bypassCompileStarted = true;
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(
      bypassCompileStarted,
      false,
      'CLI must not bypass the canonical per-package owner with its own direct compiler writer',
    );
  } catch (error) {
    assertionError = error;
  } finally {
    if (buildBarrier.isListening()) {
      await buildBarrier.release();
    }
    await Promise.allSettled([canonicalBuild, cliPreparation]);
  }
  if (assertionError) throw assertionError;

  await Promise.all([canonicalBuild, cliPreparation]);
  const out = await readFile(outputPath, 'utf-8');
  const occurrences = out.split('\n').filter((line) => line.includes('/packages/protocol :: -s build')).length;
  assert.equal(occurrences, 1);
});

test('ensureWorkspacePackagesBuiltForComponent keeps previous dist readable while rebuilding a workspace package', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hs-ensure-workspaces-built-live-dist-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  await mkdir(join(root, 'apps', 'cli'), { recursive: true });
  await mkdir(join(root, 'apps', 'ui'), { recursive: true });
  await mkdir(join(root, 'apps', 'server'), { recursive: true });
  await writeJson(join(root, 'apps', 'cli', 'package.json'), {
    name: '@happier-dev/cli',
    private: true,
    dependencies: {
      '@happier-dev/protocol': '0.0.0',
    },
  });
  await writeJson(join(root, 'apps', 'ui', 'package.json'), { name: '@happier-dev/app', private: true });
  await writeJson(join(root, 'apps', 'server', 'package.json'), { name: '@happier-dev/server', private: true });

  const protocolDir = join(root, 'packages', 'protocol');
  await mkdir(join(protocolDir, 'dist'), { recursive: true });
  await writeJson(join(protocolDir, 'package.json'), {
    name: '@happier-dev/protocol',
    version: '0.0.0',
    type: 'module',
    exports: { '.': { default: './dist/index.js', types: './dist/index.d.ts' } },
    scripts: { build: 'tsc -p tsconfig.json' },
  });
  await writeJson(join(protocolDir, 'tsconfig.json'), { compilerOptions: { outDir: 'dist' } });
  await writeFile(
    join(protocolDir, 'dist', 'index.js'),
    "export const stable = true;\nimport './missing.js';\n",
    'utf-8',
  );
  await writeFile(join(protocolDir, 'dist', 'index.d.ts'), 'export declare const stable: boolean;\n', 'utf-8');

  const binDir = join(root, 'bin');
  const outputPath = join(root, 'argv.txt');
  await mkdir(binDir, { recursive: true });
  await writeFile(
    join(binDir, 'yarn'),
    `#!${process.execPath}
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const args = process.argv.slice(2);
const out = process.env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR || 'dist';
fs.appendFileSync(process.env.OUTPUT_PATH, process.cwd() + ' :: ' + args.join(' ') + ' :: out=' + out + '\\n');
if (args[0] === '--version') {
  process.stdin.resume();
  process.stdin.once('data', () => {
    process.stdout.write('1.22.22\\n');
    process.exit(0);
  });
} else if (args[0] === '-s' && args[1] === 'build' && process.cwd().endsWith('/packages/protocol')) {
  fs.rmSync(out, { recursive: true, force: true });
  const socket = net.createConnection({ host: '127.0.0.1', port: Number(process.env.TEST_ATOMIC_BUILD_BARRIER_PORT) });
  let released = false;
  let buffer = '';
  socket.once('connect', () => socket.write('started\\n'));
  socket.on('data', (chunk) => {
    buffer += chunk.toString();
    if (!released && buffer.includes('release\\n')) {
      released = true;
      fs.mkdirSync(out, { recursive: true });
      fs.writeFileSync(path.join(out, 'index.js'), 'export const built = true;\\n');
      fs.writeFileSync(path.join(out, 'index.d.ts'), 'export declare const built: boolean;\\n');
      socket.end();
    }
  });
  socket.once('error', () => process.exit(4));
  socket.once('close', () => process.exit(released ? 0 : 4));
} else {
  process.exit(0);
}
`,
    'utf-8',
  );
  await chmod(join(binDir, 'yarn'), 0o755);
  await writeFile(outputPath, '', 'utf-8');

  applyEnvOverrides(t, {
    PATH: `${binDir}:/usr/bin:/bin`,
    OUTPUT_PATH: outputPath,
    HAPPIER_STACK_ENV_FILE: null,
  });

  const cleanupProbe = await createAtomicBuildBarrier();
  const cleanupChild = spawn(
    process.execPath,
    ['-e', `const net=require('node:net');const s=net.createConnection({host:'127.0.0.1',port:${cleanupProbe.port}},()=>s.write('started\\n'));s.on('close',()=>process.exit(0));`],
    { stdio: 'ignore' },
  );
  const cleanupChildExit = once(cleanupChild, 'exit');
  await cleanupProbe.started;
  await cleanupProbe.cancel();
  await cleanupChildExit;
  assert.equal(cleanupProbe.activeSockets(), 0);
  assert.equal(cleanupProbe.isListening(), false);

  const buildBarrier = await createAtomicBuildBarrier();
  const buildPromise = ensureWorkspacePackagesBuiltForComponent(join(root, 'apps', 'cli'), {
    quiet: true,
    env: {
      ...process.env,
      TEST_ATOMIC_BUILD_BARRIER_PORT: String(buildBarrier.port),
    },
  });

  let assertionError = null;
  try {
    await buildBarrier.started;
    assert.equal(
      await readFile(join(protocolDir, 'dist', 'index.js'), 'utf-8'),
      "export const stable = true;\nimport './missing.js';\n",
    );
  } catch (error) {
    assertionError = error;
  } finally {
    if (!assertionError) {
      await buildBarrier.release();
    } else {
      await buildBarrier.cancel();
    }
    await buildPromise.catch(() => {});
  }
  if (assertionError) throw assertionError;

  await buildPromise;
  assert.equal(await readFile(join(protocolDir, 'dist', 'index.js'), 'utf-8'), 'export const built = true;\n');
  const buildLine = (await readFile(outputPath, 'utf-8'))
    .split('\n')
    .find((line) => line.includes('/packages/protocol :: -s build'));
  assert.ok(buildLine, 'expected the protocol package build to run');
  assert.match(buildLine, /out=.*\/packages\/protocol\/\.tmp\./);
  assert.doesNotMatch(buildLine, /out=dist(?:\s|$)/);
  assert.equal(buildBarrier.activeSockets(), 0);
  assert.equal(buildBarrier.isListening(), false);
});
