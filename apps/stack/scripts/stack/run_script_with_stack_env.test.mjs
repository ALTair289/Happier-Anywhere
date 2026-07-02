import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('buildAlreadyRunningMobileMetroArgs preserves Expo Tailscale mode', async () => {
  const mod = await import('./run_script_with_stack_env.mjs');

  assert.equal(typeof mod.buildAlreadyRunningMobileMetroArgs, 'function');
  assert.deepEqual(
    mod.buildAlreadyRunningMobileMetroArgs(['--mobile', '--expo-tailscale']),
    ['--metro', '--expo-tailscale']
  );
});

test('createStackRunnerLogPath prunes only the matching runner log family and keeps the current path', async () => {
  const mod = await import('./run_script_with_stack_env.mjs');
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stack-runner-log-prune-'));
  try {
    const logsDir = join(tmp, 'logs');
    await mkdir(logsDir, { recursive: true });
    await writeFile(join(logsDir, 'dev.1000.log'), 'old dev 1\n', 'utf-8');
    await writeFile(join(logsDir, 'dev.2000.log'), 'old dev 2\n', 'utf-8');
    await writeFile(join(logsDir, 'dev.3000.log'), 'old dev 3\n', 'utf-8');
    await writeFile(join(logsDir, 'run.1500.log'), 'old run\n', 'utf-8');

    const logPath = await mod.createStackRunnerLogPath({
      logsDir,
      scriptPath: 'dev.mjs',
      nowMs: 4000,
      keepCount: 2,
    });

    assert.equal(logPath, join(logsDir, 'dev.4000.log'));
    assert.deepEqual((await readdir(logsDir)).sort(), [
      'dev.3000.log',
      'dev.4000.log',
      'run.1500.log',
    ]);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
