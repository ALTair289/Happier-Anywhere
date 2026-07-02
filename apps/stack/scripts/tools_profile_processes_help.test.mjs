import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { getStackRootFromMeta, hstackBinPath, runNodeCapture } from './testkit/auth_testkit.mjs';

test('hstack tools help includes profiling tools', async () => {
  const rootDir = getStackRootFromMeta(import.meta.url);
  const env = {
    ...process.env,
    HAPPIER_STACK_STACK: 'test-stack',
    HAPPIER_STACK_ENV_FILE: join(rootDir, 'scripts', 'nonexistent-env'),
  };

  const res = await runNodeCapture([hstackBinPath(rootDir), 'tools', '--help'], { cwd: rootDir, env });
  assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstderr:\n${res.stderr}\nstdout:\n${res.stdout}`);
  assert.match(res.stdout, /profile-processes/, `expected tools help to include profile-processes\nstdout:\n${res.stdout}`);
  assert.match(res.stdout, /profile-mobile-scenario/, `expected tools help to include profile-mobile-scenario\nstdout:\n${res.stdout}`);
});

test('hstack tools profile-processes samples the selected pid', async (t) => {
  const rootDir = getStackRootFromMeta(import.meta.url);
  const outputDir = await mkdtemp(join(tmpdir(), 'happier-tools-profile-processes-'));
  t.after(async () => {
    await rm(outputDir, { recursive: true, force: true }).catch(() => {});
  });
  const env = {
    ...process.env,
    HAPPIER_STACK_STACK: 'test-stack',
    HAPPIER_STACK_ENV_FILE: join(rootDir, 'scripts', 'nonexistent-env'),
  };

  const res = await runNodeCapture(
    [
      hstackBinPath(rootDir),
      'tools',
      'profile-processes',
      `--pid=${process.pid}`,
      '--duration=1s',
      '--interval=1s',
      `--out-dir=${outputDir}`,
      '--json',
    ],
    { cwd: rootDir, env },
  );
  assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstderr:\n${res.stderr}\nstdout:\n${res.stdout}`);
  const parsed = JSON.parse(res.stdout);
  assert.equal(parsed.target.pid, process.pid);
  assert.equal(parsed.summary.sampleCount, 2);
  assert.match(parsed.artifacts.samples, /samples\.ndjson$/);
  const samples = (await readFile(parsed.artifacts.samples, 'utf-8')).trim().split('\n');
  assert.equal(samples.length, 2);
});

test('hstack tools profile-mobile-scenario lists canonical mobile scenarios', async () => {
  const rootDir = getStackRootFromMeta(import.meta.url);
  const env = {
    ...process.env,
    HAPPIER_STACK_STACK: 'test-stack',
    HAPPIER_STACK_ENV_FILE: join(rootDir, 'scripts', 'nonexistent-env'),
  };

  const res = await runNodeCapture([hstackBinPath(rootDir), 'tools', 'profile-mobile-scenario', '--list', '--json'], {
    cwd: rootDir,
    env,
  });
  assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstderr:\n${res.stderr}\nstdout:\n${res.stdout}`);
  const parsed = JSON.parse(res.stdout);
  const names = parsed.scenarios.map((scenario) => scenario.name);
  assert.ok(names.includes('ios-session-list'));
  assert.ok(names.includes('ios-streaming-session'));
  assert.ok(names.includes('ios-cockpit-tabs'));
  assert.ok(names.includes('ios-back-swipe'));
});

test('hstack tools profile-mobile-scenario generates current-device Argent flow and manifest', async (t) => {
  const rootDir = getStackRootFromMeta(import.meta.url);
  const projectRoot = await mkdtemp(join(tmpdir(), 'happier-tools-mobile-profile-project-'));
  const outputDir = await mkdtemp(join(tmpdir(), 'happier-tools-mobile-profile-output-'));
  t.after(async () => {
    await rm(projectRoot, { recursive: true, force: true }).catch(() => {});
    await rm(outputDir, { recursive: true, force: true }).catch(() => {});
  });
  const env = {
    ...process.env,
    HAPPIER_STACK_STACK: 'test-stack',
    HAPPIER_STACK_ENV_FILE: join(rootDir, 'scripts', 'nonexistent-env'),
  };

  const res = await runNodeCapture(
    [
      hstackBinPath(rootDir),
      'tools',
      'profile-mobile-scenario',
      '--scenario=ios-root-tabs',
      '--udid=SIM-CLI-123',
      '--metro-port=18829',
      `--project-root=${projectRoot}`,
      `--out-dir=${outputDir}`,
      '--json',
    ],
    { cwd: rootDir, env },
  );

  assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstderr:\n${res.stderr}\nstdout:\n${res.stdout}`);
  const parsed = JSON.parse(res.stdout);
  assert.equal(parsed.scenario.name, 'ios-root-tabs');
  assert.equal(parsed.executed, false);
  assert.match(parsed.flow.file, /happier-ios-root-tabs-profile\.yaml$/);
  assert.match(parsed.artifacts.manifest, /ios-root-tabs-mobile-profile-manifest\.json$/);

  const flow = await readFile(parsed.flow.file, 'utf-8');
  assert.match(flow, /SIM-CLI-123/);
  assert.match(flow, /Open Settings root tab/);

  const manifest = JSON.parse(await readFile(parsed.artifacts.manifest, 'utf-8'));
  assert.equal(manifest.scenario.name, 'ios-root-tabs');
  assert.equal(manifest.flow.file, parsed.flow.file);
});
