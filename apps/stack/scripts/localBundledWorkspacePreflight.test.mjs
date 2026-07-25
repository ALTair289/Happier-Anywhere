import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runNodeCapture } from './testkit/core/run_node_capture.mjs';
import { coerceHappyMonorepoRootFromPath } from './utils/paths/paths.mjs';

function stackRootDirFromMeta(metaUrl) {
  const scriptsDir = dirname(fileURLToPath(metaUrl));
  return dirname(scriptsDir);
}

test('local bundled workspace preflight falls back to bundleWorkspaceDeps when the monorepo sync helper is unavailable', async () => {
  const rootDir = stackRootDirFromMeta(import.meta.url);
  const repoRoot = coerceHappyMonorepoRootFromPath(rootDir);
  assert.ok(repoRoot, `expected monorepo root for ${rootDir}`);
  const fixtureDir = mkdtempSync(join(tmpdir(), 'local-bundled-preflight-fallback-'));
  try {
    const markerPath = join(fixtureDir, 'bundle.json');
    const bundleStubPath = join(fixtureDir, 'bundleWorkspaceDeps.mjs');
    const resolveSyncModulePathStubPath = join(fixtureDir, 'resolveBundledWorkspaceSyncModulePath.mjs');
    const loaderPath = join(fixtureDir, 'loader.mjs');

    writeFileSync(
      bundleStubPath,
      [
        "import { writeFileSync } from 'node:fs';",
        'export async function bundleWorkspaceDeps(opts) {',
        `  writeFileSync(${JSON.stringify(markerPath)}, JSON.stringify(opts), 'utf8');`,
        '}',
        '',
      ].join('\n'),
      'utf8',
    );
    writeFileSync(
      resolveSyncModulePathStubPath,
      [
        'export function resolveBundledWorkspaceSyncModulePath() {',
        '  return null;',
        '}',
        '',
      ].join('\n'),
      'utf8',
    );
    writeFileSync(
      loaderPath,
      [
        "import { pathToFileURL } from 'node:url';",
        '',
        'export async function resolve(specifier, context, defaultResolve) {',
        "  if (specifier === '../scripts/bundleWorkspaceDeps.mjs') {",
        `    return { url: pathToFileURL(${JSON.stringify(bundleStubPath)}).href, shortCircuit: true };`,
        '  }',
        "  if (specifier === '../scripts/runtime/resolveBundledWorkspaceSyncModulePath.mjs') {",
        `    return { url: pathToFileURL(${JSON.stringify(resolveSyncModulePathStubPath)}).href, shortCircuit: true };`,
        '  }',
        '  return defaultResolve(specifier, context, defaultResolve);',
        '}',
        '',
      ].join('\n'),
      'utf8',
    );

    const modulePath = join(rootDir, 'bin', 'localBundledWorkspacePreflight.mjs');
    const res = await runNodeCapture(
      ['--input-type=module', '-e', `import { refreshLocalBundledWorkspacePackages } from ${JSON.stringify(modulePath)}; await refreshLocalBundledWorkspacePackages(${JSON.stringify(rootDir)});`],
      {
        cwd: rootDir,
        env: {
          ...process.env,
          NODE_OPTIONS: `--experimental-loader=${loaderPath}`,
        },
      },
    );

    assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstderr:\n${res.stderr}\nstdout:\n${res.stdout}`);
    const options = JSON.parse(readFileSync(markerPath, 'utf8'));
    assert.equal(options.repoRoot, repoRoot);
    assert.equal(options.stackDir, rootDir);
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

test('local bundled workspace preflight is importable from a published stack package outside a monorepo', async () => {
  const rootDir = stackRootDirFromMeta(import.meta.url);
  const packageRoot = mkdtempSync(join(tmpdir(), 'happier-stack-published-preflight-'));
  try {
    const publishedFiles = [
      'bin/localBundledWorkspacePreflight.mjs',
      'scripts/runtime/resolveBundledWorkspaceSyncModulePath.mjs',
      'scripts/utils/paths/canonical_home.mjs',
      'scripts/utils/paths/paths.mjs',
      'scripts/utils/workspaces/workspaceBundleLock.mjs',
    ];

    for (const relPath of publishedFiles) {
      const sourcePath = join(rootDir, relPath);
      const targetPath = join(packageRoot, relPath);
      mkdirSync(dirname(targetPath), { recursive: true });
      if (existsSync(sourcePath)) {
        cpSync(sourcePath, targetPath);
      }
    }

    const modulePath = join(packageRoot, 'bin', 'localBundledWorkspacePreflight.mjs');
    const res = await runNodeCapture(
      [
        '--input-type=module',
        '-e',
        `import { refreshLocalBundledWorkspacePackages } from ${JSON.stringify(modulePath)}; await refreshLocalBundledWorkspacePackages(${JSON.stringify(packageRoot)});`,
      ],
      { cwd: packageRoot },
    );

    assert.equal(res.code, 0, `expected importable preflight no-op, got ${res.code}\nstderr:\n${res.stderr}\nstdout:\n${res.stdout}`);
  } finally {
    rmSync(packageRoot, { recursive: true, force: true });
  }
});

function runPreflightProcess({ modulePath, rootDir, loaderPath }) {
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import { refreshLocalBundledWorkspacePackages } from ${JSON.stringify(modulePath)}; await refreshLocalBundledWorkspacePackages(${JSON.stringify(rootDir)});`,
    ],
    {
      cwd: rootDir,
      env: {
        ...process.env,
        NODE_OPTIONS: `--experimental-loader=${loaderPath}`,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += String(chunk);
  });
  child.stderr.on('data', (chunk) => {
    stderr += String(chunk);
  });

  return new Promise((resolvePromise) => {
    child.on('close', (code, signal) => {
      resolvePromise({ code, signal, stdout, stderr });
    });
  });
}

test('local bundled workspace preflight serializes monorepo sync helper refreshes', async () => {
  const rootDir = stackRootDirFromMeta(import.meta.url);
  const repoRoot = coerceHappyMonorepoRootFromPath(rootDir);
  assert.ok(repoRoot, `expected monorepo root for ${rootDir}`);
  const fixtureDir = mkdtempSync(join(tmpdir(), 'local-bundled-preflight-lock-'));
  try {
    const activePath = join(fixtureDir, 'active');
    const overlapPath = join(fixtureDir, 'overlap');
    const syncStubPath = join(fixtureDir, 'syncBundledWorkspacePackages.mjs');
    const resolveSyncModulePathStubPath = join(fixtureDir, 'resolveBundledWorkspaceSyncModulePath.mjs');
    const loaderPath = join(fixtureDir, 'loader.mjs');

    writeFileSync(
      syncStubPath,
      [
        "import { closeSync, openSync, rmSync, writeFileSync } from 'node:fs';",
        '',
        'function sleepSync(ms) {',
        '  const arr = new Int32Array(new SharedArrayBuffer(4));',
        '  Atomics.wait(arr, 0, 0, ms);',
        '}',
        '',
        'export function syncBundledWorkspacePackages() {',
        '  let fd = null;',
        '  try {',
        `    fd = openSync(${JSON.stringify(activePath)}, 'wx');`,
        "    writeFileSync(fd, String(process.pid), 'utf8');",
        '  } catch (error) {',
        "    if (error?.code !== 'EEXIST') throw error;",
        `    writeFileSync(${JSON.stringify(overlapPath)}, 'overlap', 'utf8');`,
        '  }',
        '  sleepSync(350);',
        '  if (fd !== null) {',
        '    closeSync(fd);',
        `    rmSync(${JSON.stringify(activePath)}, { force: true });`,
        '  }',
        '}',
        '',
      ].join('\n'),
      'utf8',
    );
    writeFileSync(
      resolveSyncModulePathStubPath,
      [
        'export function resolveBundledWorkspaceSyncModulePath() {',
        `  return ${JSON.stringify(syncStubPath)};`,
        '}',
        '',
      ].join('\n'),
      'utf8',
    );
    writeFileSync(
      loaderPath,
      [
        "import { pathToFileURL } from 'node:url';",
        '',
        'export async function resolve(specifier, context, defaultResolve) {',
        "  if (specifier === '../scripts/runtime/resolveBundledWorkspaceSyncModulePath.mjs') {",
        `    return { url: pathToFileURL(${JSON.stringify(resolveSyncModulePathStubPath)}).href, shortCircuit: true };`,
        '  }',
        '  return defaultResolve(specifier, context, defaultResolve);',
        '}',
        '',
      ].join('\n'),
      'utf8',
    );

    const modulePath = join(rootDir, 'bin', 'localBundledWorkspacePreflight.mjs');
    const [first, second] = await Promise.all([
      runPreflightProcess({ modulePath, rootDir, loaderPath }),
      runPreflightProcess({ modulePath, rootDir, loaderPath }),
    ]);

    assert.equal(first.code, 0, `first preflight failed\nstderr:\n${first.stderr}\nstdout:\n${first.stdout}`);
    assert.equal(second.code, 0, `second preflight failed\nstderr:\n${second.stderr}\nstdout:\n${second.stdout}`);
    assert.equal(existsSync(overlapPath), false, 'expected preflight refreshes to be serialized');
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});
