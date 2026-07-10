import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  probeCliDistRuntimeImport,
  readCliDistBuildManifest,
  readCliDistIntegrity,
} from './cliDistIntegrity.mjs';

test('readCliDistIntegrity requires a build manifest next to the entrypoint', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'happy-cli-dist-integrity-'));
  try {
    const distDir = join(tmp, 'dist');
    const entrypoint = join(distDir, 'index.mjs');
    await mkdir(distDir, { recursive: true });
    await writeFile(entrypoint, 'export const ready = true;\n', 'utf-8');

    assert.deepEqual(readCliDistIntegrity(entrypoint), {
      ok: false,
      reason: 'missing_build_manifest',
      fingerprint: null,
      fileCount: 0,
      manifestPath: join(distDir, '.build-manifest.json'),
    });
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('readCliDistBuildManifest reads the manifest fingerprint without rehashing dist files', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'happy-cli-dist-fingerprint-'));
  try {
    const distDir = join(tmp, 'dist');
    const entrypoint = join(distDir, 'index.mjs');
    await mkdir(distDir, { recursive: true });
    await writeFile(entrypoint, "import './missing.mjs';\n", 'utf-8');
    await writeFile(
      join(distDir, '.build-manifest.json'),
      JSON.stringify({
        fingerprint: 'abcdef1234567890',
        builtAt: '2026-07-09T00:00:00.000Z',
        fileCount: 7,
        toolVersion: '1',
      }) + '\n',
      'utf-8',
    );

    const manifest = readCliDistBuildManifest(entrypoint);
    assert.equal(manifest.ok, true);
    assert.equal(manifest.fingerprint, 'abcdef1234567890');
    assert.equal(manifest.fileCount, 7);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('probeCliDistRuntimeImport resolves a valid ESM entrypoint', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'happy-cli-dist-runtime-probe-ok-'));
  try {
    const entrypoint = join(tmp, 'index.mjs');
    await writeFile(entrypoint, 'export const ready = true;\n', 'utf-8');

    await probeCliDistRuntimeImport(entrypoint);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('probeCliDistRuntimeImport rejects ESM link failures', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'happy-cli-dist-runtime-probe-fail-'));
  try {
    const entrypoint = join(tmp, 'index.mjs');
    await writeFile(entrypoint, "import { A } from './chunk.mjs'; export const value = A;\n", 'utf-8');
    await writeFile(join(tmp, 'chunk.mjs'), 'export const B = true;\n', 'utf-8');

    await assert.rejects(
      () => probeCliDistRuntimeImport(entrypoint),
      /does not provide an export named|runtime import probe failed/
    );
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('probeCliDistRuntimeImport rejects when the import process stays alive past the timeout', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'happy-cli-dist-runtime-probe-timeout-'));
  try {
    const entrypoint = join(tmp, 'index.mjs');
    await writeFile(entrypoint, 'setInterval(() => {}, 1000);\n', 'utf-8');

    const result = await Promise.race([
      probeCliDistRuntimeImport(entrypoint, { timeoutMs: 50 }).then(
        () => 'resolved',
        (error) => error,
      ),
      new Promise((resolve) => setTimeout(() => resolve('timed-out'), 500)),
    ]);

    assert.match(result instanceof Error ? result.message : String(result), /timed out/i);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
