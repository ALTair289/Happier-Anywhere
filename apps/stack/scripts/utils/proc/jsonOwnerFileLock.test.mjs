import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { withJsonOwnerFileLock } from './jsonOwnerFileLock.mjs';

test('withJsonOwnerFileLock reclaims a fresh lock from a dead owner pid immediately', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-json-owner-lock-'));
  const lockPath = join(root, 'owner.lock');

  try {
    await writeFile(
      lockPath,
      JSON.stringify({
        pid: 999999,
        createdAtMs: Date.now(),
        updatedAtMs: Date.now(),
      }),
      'utf8',
    );

    const result = await withJsonOwnerFileLock(
      async ({ lockPath: heldLockPath, waited }) => {
        assert.equal(heldLockPath, lockPath);
        assert.equal(waited, false);
        const owner = JSON.parse(await readFile(lockPath, 'utf8'));
        assert.equal(owner.pid, process.pid);
        return 'ok';
      },
      {
        lockPath,
        timeoutMs: 200,
        pollIntervalMs: 10,
        staleAfterMs: 120_000,
      },
    );

    assert.equal(result, 'ok');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('withJsonOwnerFileLock reports wait progress while a live owner holds the lock', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-json-owner-lock-wait-'));
  const lockPath = join(root, 'owner.lock');
  const waitEvents = [];

  try {
    const holder = withJsonOwnerFileLock(
      async () => {
        await delay(40);
        return 'held';
      },
      {
        lockPath,
        timeoutMs: 500,
        pollIntervalMs: 10,
        staleAfterMs: 120_000,
      },
    );

    while (true) {
      try {
        const owner = JSON.parse(await readFile(lockPath, 'utf8'));
        assert.equal(owner.pid, process.pid);
        break;
      } catch {
        await delay(1);
      }
    }

    const result = await withJsonOwnerFileLock(
      async ({ waited }) => {
        assert.equal(waited, true);
        return 'ok';
      },
      {
        lockPath,
        timeoutMs: 500,
        pollIntervalMs: 10,
        staleAfterMs: 120_000,
        onWait: (event) => {
          waitEvents.push(event);
        },
      },
    );

    assert.equal(result, 'ok');
    assert.ok(waitEvents.length >= 1);
    assert.equal(waitEvents[0].lockPath, lockPath);
    assert.equal(waitEvents[0].owner.pid, process.pid);

    await holder;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('withJsonOwnerFileLock does not reclaim an old lock while the owner pid is alive', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-json-owner-lock-live-owner-'));
  const lockPath = join(root, 'owner.lock');
  const owner = {
    pid: process.pid,
    createdAtMs: Date.now() - 60_000,
    updatedAtMs: Date.now() - 60_000,
  };
  let enteredCriticalSection = false;

  try {
    await writeFile(lockPath, JSON.stringify(owner), 'utf8');

    await assert.rejects(
      () =>
        withJsonOwnerFileLock(
          async () => {
            enteredCriticalSection = true;
          },
          {
            lockPath,
            timeoutMs: 60,
            pollIntervalMs: 10,
            staleAfterMs: 10,
            errorLabel: 'test owner lock',
          },
        ),
      /Timed out waiting for test owner lock/,
    );

    assert.equal(enteredCriticalSection, false);
    assert.deepEqual(JSON.parse(await readFile(lockPath, 'utf8')), owner);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('withJsonOwnerFileLock reclaims a stale malformed owner using the file mtime fallback', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-json-owner-lock-malformed-'));
  const lockPath = join(root, 'owner.lock');

  try {
    await writeFile(lockPath, '{not json', 'utf8');
    const staleTime = new Date(Date.now() - 60_000);
    await utimes(lockPath, staleTime, staleTime);

    const result = await withJsonOwnerFileLock(
      async () => {
        const owner = JSON.parse(await readFile(lockPath, 'utf8'));
        assert.equal(owner.pid, process.pid);
        return 'ok';
      },
      {
        lockPath,
        timeoutMs: 200,
        pollIntervalMs: 10,
        staleAfterMs: 10,
      },
    );

    assert.equal(result, 'ok');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('withJsonOwnerFileLock does not heartbeat over or unlink a successor owner', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-json-owner-lock-successor-'));
  const lockPath = join(root, 'owner.lock');
  const successorOwner = {
    pid: process.pid + 1_000_000,
    createdAtMs: Date.now() + 1,
    updatedAtMs: Date.now() + 1,
  };

  try {
    await withJsonOwnerFileLock(
      async () => {
        await writeFile(lockPath, JSON.stringify(successorOwner), 'utf8');
        await delay(620);
        assert.deepEqual(JSON.parse(await readFile(lockPath, 'utf8')), successorOwner);
      },
      {
        lockPath,
        timeoutMs: 500,
        pollIntervalMs: 10,
        staleAfterMs: 20,
      },
    );

    assert.deepEqual(JSON.parse(await readFile(lockPath, 'utf8')), successorOwner);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('withJsonOwnerFileLock does not delete a successor owner during stale-owner reclaim', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-json-owner-lock-reclaim-race-'));
  try {
    const moduleUrl = new URL('./jsonOwnerFileLock.mjs', import.meta.url).href;
    const script = `
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';

const originalRenameSync = fs.renameSync;
const originalRmSync = fs.rmSync;
const lockPath = join(${JSON.stringify(tmp)}, 'owner.lock');
const staleOwner = {
  pid: 999999,
  createdAtMs: Date.now() - 60_000,
  updatedAtMs: Date.now() - 60_000,
};
const successorOwner = {
  pid: process.pid,
  createdAtMs: Date.now() + 1,
  updatedAtMs: Date.now() + 1,
};
let replaced = false;
let enteredCriticalSection = false;

fs.writeFileSync(lockPath, JSON.stringify(staleOwner), 'utf8');

function installSuccessorBeforeReclaim(path) {
  if (String(path) !== lockPath || replaced) return;
  replaced = true;
  fs.writeFileSync(lockPath, JSON.stringify(successorOwner), 'utf8');
}

fs.renameSync = function patchedRenameSync(oldPath, newPath) {
  installSuccessorBeforeReclaim(oldPath);
  return originalRenameSync.call(this, oldPath, newPath);
};

fs.rmSync = function patchedRmSync(path, options) {
  installSuccessorBeforeReclaim(path);
  return originalRmSync.call(this, path, options);
};

syncBuiltinESMExports();

const { withJsonOwnerFileLock } = await import(${JSON.stringify(moduleUrl)});

await assert.rejects(
  () =>
    withJsonOwnerFileLock(
      async () => {
        enteredCriticalSection = true;
      },
      {
        lockPath,
        timeoutMs: 80,
        pollIntervalMs: 10,
        staleAfterMs: 1,
        errorLabel: 'test owner lock',
      },
    ),
  /Timed out waiting for test owner lock/,
);

assert.equal(enteredCriticalSection, false);
assert.deepEqual(JSON.parse(fs.readFileSync(lockPath, 'utf8')), successorOwner);
`;

    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8',
      timeout: 1_000,
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('withJsonOwnerFileLock removes and reacquires the lock after cleanup on Windows-shaped filesystems', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-json-owner-lock-cleanup-'));
  try {
    const moduleUrl = new URL('./jsonOwnerFileLock.mjs', import.meta.url).href;
    const script = `
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';

const originalOpenSync = fs.openSync;
const originalCloseSync = fs.closeSync;
const originalUnlinkSync = fs.unlinkSync;
const openLockPaths = new Map();

fs.openSync = function patchedOpenSync(path, flags, mode) {
  const fd = originalOpenSync.call(this, path, flags, mode);
  openLockPaths.set(String(path), fd);
  return fd;
};

fs.closeSync = function patchedCloseSync(fd) {
  for (const [path, openFd] of openLockPaths.entries()) {
    if (openFd === fd) {
      openLockPaths.delete(path);
      break;
    }
  }
  return originalCloseSync.call(this, fd);
};

fs.unlinkSync = function patchedUnlinkSync(path) {
  if (openLockPaths.has(String(path))) {
    const error = new Error(\`EPERM: file is in use, unlink '\${String(path)}'\`);
    error.code = 'EPERM';
    throw error;
  }
  return originalUnlinkSync.call(this, path);
};

syncBuiltinESMExports();

const { withJsonOwnerFileLock } = await import(${JSON.stringify(moduleUrl)});
const lockPath = join(${JSON.stringify(tmp)}, 'locks', 'owner.lock');

await withJsonOwnerFileLock(
  async () => {},
  { lockPath, timeoutMs: 50, pollIntervalMs: 5, staleAfterMs: 50 },
);

await withJsonOwnerFileLock(
  async () => {},
  { lockPath, timeoutMs: 50, pollIntervalMs: 5, staleAfterMs: 50 },
);
`;

    const result = spawnSync(
      process.execPath,
      ['--input-type=module', '--eval', script],
      {
        encoding: 'utf-8',
        timeout: 10_000,
      },
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
