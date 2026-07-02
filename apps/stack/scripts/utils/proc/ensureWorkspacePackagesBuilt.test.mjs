import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ensureWorkspacePackagesBuiltForComponent } from './pm.mjs';

async function waitForFile(path, { timeoutMs = 5_000 } = {}) {
  const startedAt = Date.now();
  for (;;) {
    try {
      await readFile(path, 'utf-8');
      return;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      if (Date.now() - startedAt > timeoutMs) {
        throw new Error(`Timed out waiting for file: ${path}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
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
    },
    scripts: { build: 'tsc -p tsconfig.json' },
  });
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

  // Second run should be a no-op (no additional build).
  await ensureWorkspacePackagesBuiltForComponent(join(root, 'apps', 'ui'), { quiet: true, env: process.env });
  const out2 = await readFile(outputPath, 'utf-8');
  const occurrences = out2.split('\n').filter((l) => l.includes('/packages/protocol :: -s build')).length;
  assert.equal(occurrences, 1);
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
      'if [[ "${1:-}" == "--version" ]]; then echo "1.22.22"; exit 0; fi',
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
  const markerPath = join(root, 'build-started');
  const releasePath = join(root, 'release-build');
  await mkdir(binDir, { recursive: true });
  await writeFile(
    join(binDir, 'yarn'),
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'echo "$(pwd) :: $* :: out=${HAPPIER_WORKSPACE_DIST_OUTPUT_DIR:-dist}" >> "${OUTPUT_PATH:?}"',
      'if [[ "${1:-}" == "--version" ]]; then echo "1.22.22"; exit 0; fi',
      'if [[ "${1:-}" == "-s" && "${2:-}" == "build" && "$(pwd)" == */packages/protocol ]]; then',
      '  out="${HAPPIER_WORKSPACE_DIST_OUTPUT_DIR:-dist}"',
      '  rm -rf "$out"',
      `  printf started > ${JSON.stringify(markerPath)}`,
      `  while [[ ! -f ${JSON.stringify(releasePath)} ]]; do sleep 0.02; done`,
      '  mkdir -p "$out"',
      "  printf '%s\\n' 'export const built = true;' > \"$out/index.js\"",
      "  printf '%s\\n' 'export declare const built: boolean;' > \"$out/index.d.ts\"",
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

  const buildPromise = ensureWorkspacePackagesBuiltForComponent(join(root, 'apps', 'cli'), {
    quiet: true,
    env: process.env,
  });

  let assertionError = null;
  try {
    await waitForFile(markerPath);
    assert.equal(
      await readFile(join(protocolDir, 'dist', 'index.js'), 'utf-8'),
      "export const stable = true;\nimport './missing.js';\n",
    );
  } catch (error) {
    assertionError = error;
  } finally {
    await writeFile(releasePath, '1', 'utf-8');
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
});
