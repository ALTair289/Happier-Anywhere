import assert from 'node:assert/strict';
import { mkdtemp, readFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { writeJsonAtomic } from './json.mjs';

test('writeJsonAtomic retries transient Windows rename failures before publishing', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-json-atomic-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = join(root, 'stack.runtime.json');
  let attempts = 0;
  const waits = [];

  await writeJsonAtomic(target, { daemonPid: 42 }, {
    platform: 'win32',
    renameImpl: async (from, to) => {
      attempts += 1;
      if (attempts < 3) {
        throw Object.assign(new Error('file is temporarily in use'), { code: 'EPERM' });
      }
      await rename(from, to);
    },
    waitImpl: async (delayMs) => {
      waits.push(delayMs);
    },
  });

  assert.equal(attempts, 3);
  assert.deepEqual(waits, [25, 50]);
  assert.deepEqual(JSON.parse(await readFile(target, 'utf8')), { daemonPid: 42 });
});
