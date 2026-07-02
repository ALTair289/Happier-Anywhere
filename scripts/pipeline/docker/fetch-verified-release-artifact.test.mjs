import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

test('fetch-verified-release-artifact verifies signed checksums and extracts one top-level payload', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'happier-docker-artifact-fetch-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const product = 'happier';
  const version = '1.2.3-test.4';
  const releaseTag = 'cli-test';
  const archiveName = `${product}-v${version}-linux-x64.tar.gz`;
  const checksumsName = `checksums-${product}-v${version}.txt`;
  const releaseDir = join(root, 'releases', releaseTag);
  const stageDir = join(root, 'stage', `${product}-v${version}-linux-x64`);
  const destDir = join(root, 'dest');
  const fakeBin = join(root, 'bin');
  const minisignLog = join(root, 'minisign.log');

  mkdirSync(stageDir, { recursive: true });
  mkdirSync(releaseDir, { recursive: true });
  mkdirSync(fakeBin, { recursive: true });
  writeFileSync(join(stageDir, 'happier'), '#!/bin/sh\necho happier\n', { encoding: 'utf8', mode: 0o755 });
  writeFileSync(join(stageDir, '._happier'), 'appledouble metadata\n', 'utf8');
  mkdirSync(join(stageDir, 'nested'), { recursive: true });
  writeFileSync(join(stageDir, 'nested', '._payload'), 'nested appledouble metadata\n', 'utf8');
  execFileSync('tar', ['-czf', join(releaseDir, archiveName), '-C', join(root, 'stage'), `${product}-v${version}-linux-x64`], {
    env: { ...process.env, COPYFILE_DISABLE: '1' },
  });
  writeFileSync(join(releaseDir, checksumsName), `${sha256(join(releaseDir, archiveName))}  ${archiveName}\n`, 'utf8');
  writeFileSync(join(releaseDir, `${checksumsName}.minisig`), 'fake signature\n', 'utf8');
  writeFileSync(join(root, 'happier-release.pub'), 'fake public key\n', 'utf8');
  writeFileSync(
    join(fakeBin, 'minisign'),
    `#!/bin/sh
set -eu
echo "$@" >> "${minisignLog}"
exit 0
`,
    { encoding: 'utf8', mode: 0o755 },
  );
  chmodSync(join(fakeBin, 'minisign'), 0o755);

  const result = spawnSync(
    'sh',
    [
      join(process.cwd(), 'scripts', 'pipeline', 'docker', 'fetch-verified-release-artifact.sh'),
      '--base-url',
      `file://${join(root, 'releases')}`,
      '--release-tag',
      releaseTag,
      '--product',
      product,
      '--version',
      version,
      '--os',
      'linux',
      '--arch',
      'x64',
      '--dest',
      destDir,
      '--pubkey',
      join(root, 'happier-release.pub'),
    ],
    {
      env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ''}` },
      encoding: 'utf8',
    },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(readFileSync(join(destDir, 'happier'), 'utf8'), /echo happier/);
  assert.equal(existsSync(join(destDir, '._happier')), false);
  assert.equal(existsSync(join(destDir, 'nested', '._payload')), false);
  assert.doesNotThrow(() => readFileSync(minisignLog, 'utf8'));
  assert.match(readFileSync(minisignLog, 'utf8'), /-Vm/);
  assert.match(readFileSync(minisignLog, 'utf8'), /happier-release\.pub/);
});
