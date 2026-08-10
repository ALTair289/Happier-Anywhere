import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

test('package postinstall delegates to the fail-closed consumer', async () => {
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(packageJson.scripts.postinstall, 'node scripts/postinstall.cjs');
});

test('postinstall fails when the required unpack consumer is missing or exits non-zero', () => {
  const { runCliPostinstall } = require('./postinstall.cjs');
  const missing = Object.assign(new Error('missing'), { code: 'ENOENT' });
  assert.throws(() => runCliPostinstall({
    packageRoot: 'C:/package',
    gateDecision: true,
    lstatSync() { throw missing; },
  }), /required postinstall consumer .* is missing/i);

  assert.throws(() => runCliPostinstall({
    packageRoot: 'C:/package',
    gateDecision: true,
    lstatSync() { return { isFile: () => true, isSymbolicLink: () => false }; },
    existsSync: () => false,
    spawnSync: () => ({ status: 9 }),
  }), /unpack-tools.*status 9/i);
});

test('postinstall propagates permission-helper failure after a successful fixed download consumer', () => {
  const { runCliPostinstall } = require('./postinstall.cjs');
  let calls = 0;
  assert.throws(() => runCliPostinstall({
    packageRoot: 'C:/package',
    gateDecision: true,
    lstatSync() { return { isFile: () => true, isSymbolicLink: () => false }; },
    existsSync: () => true,
    spawnSync: () => ({ status: calls++ === 0 ? 0 : 7 }),
  }), /permissions.*status 7/i);
});
