import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { withWorkspaceBundleLock, withWorkspaceBundleLockSync } from './workspaceBundleLock.mjs';

async function waitForFile(path, { timeoutMs = 1_000 } = {}) {
  const startedAt = Date.now();
  while (!existsSync(path)) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`Timed out waiting for ${path}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test('withWorkspaceBundleLock serializes concurrent workspace bundling through a single lock', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'happier-workspace-bundle-lock-'));
  try {
    const lockPath = join(tempRoot, 'workspace-bundling.lock');
    const events = [];
    let releaseFirst = null;

    const first = withWorkspaceBundleLock(
      async () => {
        events.push('first:start');
        await new Promise((resolve) => {
          releaseFirst = resolve;
        });
        events.push('first:end');
      },
      {
        lockPath,
        timeoutMs: 2_000,
        pollIntervalMs: 10,
        staleAfterMs: 1_000,
      },
    );

    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(events, ['first:start']);

    const second = withWorkspaceBundleLock(
      async () => {
        events.push('second:start');
      },
      {
        lockPath,
        timeoutMs: 2_000,
        pollIntervalMs: 10,
        staleAfterMs: 1_000,
      },
    );

    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(events, ['first:start']);

    releaseFirst?.();
    await Promise.all([first, second]);

    assert.deepEqual(events, ['first:start', 'first:end', 'second:start']);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('withWorkspaceBundleLock lets a child continue when its parent handed off the same lock', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'happier-workspace-bundle-lock-parent-held-'));
  try {
    const lockPath = join(tempRoot, 'workspace-bundling.lock');
    const events = [];

    await withWorkspaceBundleLock(
      async () => {
        events.push('parent:start');
        await withWorkspaceBundleLock(
          async () => {
            events.push('child:start');
          },
          {
            lockPath,
            timeoutMs: 50,
            pollIntervalMs: 10,
            staleAfterMs: 1_000,
            env: { HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD: lockPath },
          },
        );
        events.push('parent:end');
      },
      {
        lockPath,
        timeoutMs: 2_000,
        pollIntervalMs: 10,
        staleAfterMs: 1_000,
      },
    );

    assert.deepEqual(events, ['parent:start', 'child:start', 'parent:end']);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('withWorkspaceBundleLock still blocks a foreign process without a parent handoff token', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'happier-workspace-bundle-lock-foreign-'));
  try {
    const lockPath = join(tempRoot, 'workspace-bundling.lock');

    await assert.rejects(
      withWorkspaceBundleLock(
        async () => {
          await withWorkspaceBundleLock(
            async () => {},
            {
              lockPath,
              timeoutMs: 50,
              pollIntervalMs: 10,
              staleAfterMs: 1_000,
            },
          );
        },
        {
          lockPath,
          timeoutMs: 2_000,
          pollIntervalMs: 10,
          staleAfterMs: 1_000,
        },
      ),
      /Timed out waiting for workspace bundle lock/,
    );
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('withWorkspaceBundleLock still reclaims a stale dead-owner lock', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'happier-workspace-bundle-lock-dead-owner-'));
  try {
    const lockPath = join(tempRoot, 'workspace-bundling.lock');
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: 999_999_999, createdAtMs: Date.now(), token: 'dead-owner' }),
      'utf8',
    );

    let entered = false;
    await withWorkspaceBundleLock(
      async () => {
        entered = true;
      },
      {
        lockPath,
        timeoutMs: 2_000,
        pollIntervalMs: 10,
        staleAfterMs: 1_000,
      },
    );

    assert.equal(entered, true);
    assert.equal(existsSync(lockPath), false);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('withWorkspaceBundleLock does not remove a lock file that was replaced by a successor owner', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'happier-workspace-bundle-lock-successor-'));
  try {
    const lockPath = join(tempRoot, 'workspace-bundling.lock');
    const successorOwner = { pid: process.pid, createdAtMs: Date.now(), token: 'successor-owner' };

    await withWorkspaceBundleLock(
      async () => {
        writeFileSync(lockPath, JSON.stringify(successorOwner), 'utf8');
      },
      {
        lockPath,
        timeoutMs: 2_000,
        pollIntervalMs: 10,
        staleAfterMs: 1_000,
      },
    );

    assert.equal(existsSync(lockPath), true);
    assert.deepEqual(JSON.parse(readFileSync(lockPath, 'utf8')), successorOwner);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('withWorkspaceBundleLockSync uses the shared workspace bundle lock owner format', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'happier-workspace-bundle-lock-sync-'));
  try {
    const lockPath = join(tempRoot, 'workspace-bundling.lock');
    let observedOwner = null;

    const result = withWorkspaceBundleLockSync(
      () => {
        observedOwner = JSON.parse(readFileSync(lockPath, 'utf8'));
        return 'ok';
      },
      {
        lockPath,
        timeoutMs: 2_000,
        pollIntervalMs: 10,
        staleAfterMs: 1_000,
      },
    );

    assert.equal(result, 'ok');
    assert.equal(observedOwner.pid, process.pid);
    assert.equal(typeof observedOwner.createdAtMs, 'number');
    assert.equal(typeof observedOwner.token, 'string');
    assert.equal(existsSync(lockPath), false);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('withWorkspaceBundleLock does not reclaim a stale lock while the owner pid is alive', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'happier-workspace-bundle-lock-live-stale-owner-'));
  const modulePath = fileURLToPath(new URL('./workspaceBundleLock.mjs', import.meta.url));
  try {
    const lockPath = join(tempRoot, 'workspace-bundling.lock');
    const activePath = join(tempRoot, 'active');
    const child = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        [
          "import { rmSync, writeFileSync } from 'node:fs';",
          `import { withWorkspaceBundleLock } from ${JSON.stringify(modulePath)};`,
          'function sleepSync(ms) {',
          '  const arr = new Int32Array(new SharedArrayBuffer(4));',
          '  Atomics.wait(arr, 0, 0, ms);',
          '}',
          'await withWorkspaceBundleLock(() => {',
          `  writeFileSync(${JSON.stringify(activePath)}, 'active', 'utf8');`,
          '  sleepSync(350);',
          `  rmSync(${JSON.stringify(activePath)}, { force: true });`,
          `}, { lockPath: ${JSON.stringify(lockPath)}, timeoutMs: 2_000, pollIntervalMs: 10, staleAfterMs: 100 });`,
          '',
        ].join('\n'),
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );

    let childStderr = '';
    child.stderr.on('data', (chunk) => {
      childStderr += String(chunk);
    });
    const childResultPromise = new Promise((resolve) => {
      child.on('close', (code, signal) => resolve({ code, signal }));
    });

    await waitForFile(activePath);

    let overlapped = false;
    await withWorkspaceBundleLock(
      async () => {
        overlapped = existsSync(activePath);
      },
      {
        lockPath,
        timeoutMs: 2_000,
        pollIntervalMs: 10,
        staleAfterMs: 100,
      },
    );

    const childResult = await childResultPromise;

    assert.deepEqual(childResult, { code: 0, signal: null }, childStderr);
    assert.equal(overlapped, false, 'expected live lock owner to keep exclusive access even when its heartbeat is stale');
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('withWorkspaceBundleLock heartbeat does not overwrite a successor lock file', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'happier-workspace-bundle-lock-heartbeat-successor-'));
  try {
    const lockPath = join(tempRoot, 'workspace-bundling.lock');
    const successorOwner = { pid: process.pid, createdAtMs: Date.now(), token: 'heartbeat-successor-owner' };

    await withWorkspaceBundleLock(
      async () => {
        writeFileSync(lockPath, JSON.stringify(successorOwner), 'utf8');
        await new Promise((resolve) => setTimeout(resolve, 350));
      },
      {
        lockPath,
        timeoutMs: 2_000,
        pollIntervalMs: 10,
        staleAfterMs: 1_000,
      },
    );

    assert.equal(existsSync(lockPath), true);
    assert.deepEqual(JSON.parse(readFileSync(lockPath, 'utf8')), successorOwner);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
