import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { readAuthorizedServerBaseVersion } from './authorized-server-version.mjs';

async function fixture(serverVersion = '1.2.3', relayVersion = serverVersion) {
  const root = await mkdtemp(join(tmpdir(), 'authorized-server-version-'));
  await mkdir(join(root, 'apps/server'), { recursive: true });
  await mkdir(join(root, 'packages/relay-server'), { recursive: true });
  await writeFile(join(root, 'apps/server/package.json'), JSON.stringify({ version: serverVersion }));
  await writeFile(join(root, 'packages/relay-server/package.json'), JSON.stringify({ version: relayVersion }));
  return root;
}

test('reads the synchronized server version from authorized source data', async () => {
  assert.equal(await readAuthorizedServerBaseVersion(await fixture()), '1.2.3');
});

test('rejects divergent or malformed authorized source versions', async () => {
  await assert.rejects(readAuthorizedServerBaseVersion(await fixture('1.2.3', '1.2.4')), /must match/i);
  await assert.rejects(readAuthorizedServerBaseVersion(await fixture('$(touch nope)')), /invalid/i);
});

test('rejects symlinked and oversized authorized package metadata', async () => {
  const symlinkRoot = await fixture();
  await rm(join(symlinkRoot, 'apps/server/package.json'));
  await symlink('/etc/passwd', join(symlinkRoot, 'apps/server/package.json'));
  await assert.rejects(readAuthorizedServerBaseVersion(symlinkRoot), /regular file|symbolic link/i);

  const oversizedRoot = await fixture();
  await writeFile(join(oversizedRoot, 'apps/server/package.json'), JSON.stringify({ version: '1.2.3', padding: 'x'.repeat(70_000) }));
  await assert.rejects(readAuthorizedServerBaseVersion(oversizedRoot), /size/i);
});
