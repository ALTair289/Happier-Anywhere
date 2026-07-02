import assert from 'node:assert/strict';
import { access, chmod, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { pruneLogsByCount } from './pruneLogsByCount.mjs';

async function withTempRoot(t, prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  t.after(async () => {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  });
  return root;
}

async function writeFiles(dir, names) {
  await mkdir(dir, { recursive: true });
  await Promise.all(names.map((name) => writeFile(join(dir, name), name, 'utf8')));
}

async function listNames(dir) {
  return (await readdir(dir)).sort();
}

test('pruneLogsByCount keeps newest matching files by filename, preserves keepPath, filters by suffix, and returns the prune count', async (t) => {
  const root = await withTempRoot(t, 'happier-stack-prune-logs-');
  const dir = join(root, 'logs');
  const oldest = '2026-06-22-10-00-00-daemon.log';
  await writeFiles(dir, [
    oldest,
    '2026-06-22-11-00-00-daemon.log',
    '2026-06-22-12-00-00-daemon.log',
    '2026-06-22-13-00-00-daemon.log',
    '2026-06-22-14-00-00-other.txt',
  ]);

  const result = await pruneLogsByCount({
    dir,
    suffix: '-daemon.log',
    keepCount: 2,
    keepPath: join(dir, oldest),
  });

  assert.deepEqual(result, { pruned: 1 });
  assert.deepEqual(await listNames(dir), [
    '2026-06-22-10-00-00-daemon.log',
    '2026-06-22-12-00-00-daemon.log',
    '2026-06-22-13-00-00-daemon.log',
    '2026-06-22-14-00-00-other.txt',
  ]);
});

test('pruneLogsByCount keeps only matching keepPath when keepCount is zero', async (t) => {
  const root = await withTempRoot(t, 'happier-stack-prune-logs-zero-');
  const dir = join(root, 'logs');
  const current = '2026-06-22-10-00-00-daemon.log';
  await writeFiles(dir, [
    current,
    '2026-06-22-11-00-00-daemon.log',
    '2026-06-22-12-00-00-daemon.log',
  ]);

  const result = await pruneLogsByCount({
    dir,
    suffix: '-daemon.log',
    keepCount: 0,
    keepPath: join(dir, current),
  });

  assert.deepEqual(result, { pruned: 2 });
  assert.deepEqual(await listNames(dir), [current]);
});

test('pruneLogsByCount returns zero and never throws when the directory is missing', async (t) => {
  const root = await withTempRoot(t, 'happier-stack-prune-logs-missing-');

  await assert.doesNotReject(async () => {
    assert.deepEqual(await pruneLogsByCount({
      dir: join(root, 'missing'),
      suffix: '.log',
      keepCount: 1,
    }), { pruned: 0 });
  });
});

test('pruneLogsByCount treats deletion failures as non-fatal and counts only successfully removed files', async (t) => {
  const root = await withTempRoot(t, 'happier-stack-prune-logs-rm-failure-');
  const dir = join(root, 'logs');
  await writeFiles(dir, [
    '2026-06-22-10-00-00-daemon.log',
    '2026-06-22-11-00-00-daemon.log',
  ]);
  await mkdir(join(dir, '2026-06-22-09-00-00-daemon.log'));

  const result = await pruneLogsByCount({
    dir,
    suffix: '-daemon.log',
    keepCount: 1,
  });

  assert.deepEqual(result, { pruned: 1 });
  assert.deepEqual(await listNames(dir), [
    '2026-06-22-09-00-00-daemon.log',
    '2026-06-22-11-00-00-daemon.log',
  ]);
});

test('pruneLogsByCount returns zero and never throws when permissions deny reading the directory', async (t) => {
  if (process.platform === 'win32') {
    t.skip('chmod read-denial semantics differ on Windows');
    return;
  }

  const root = await withTempRoot(t, 'happier-stack-prune-logs-permission-');
  const dir = join(root, 'logs');
  await writeFiles(dir, ['2026-06-22-10-00-00-daemon.log']);
  await chmod(dir, 0o000);
  try {
    await assert.doesNotReject(async () => {
      assert.deepEqual(await pruneLogsByCount({
        dir,
        suffix: '-daemon.log',
        keepCount: 1,
      }), { pruned: 0 });
    });
  } finally {
    await chmod(dir, 0o700).catch(() => {});
  }

  await access(join(dir, '2026-06-22-10-00-00-daemon.log'));
});
