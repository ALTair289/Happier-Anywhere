import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { extractArchiveMembersSafely } = require('./safe-extract.cjs');

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function writeTarString(buffer, offset, length, value) {
  Buffer.from(value).copy(buffer, offset, 0, length);
}

function writeTarOctal(buffer, offset, length, value) {
  writeTarString(buffer, offset, length, value.toString(8).padStart(length - 1, '0') + '\0');
}

function tarHeader({ name, type = '0', bytes = Buffer.alloc(0), linkName = '' }) {
  const header = Buffer.alloc(512);
  writeTarString(header, 0, 100, name);
  writeTarOctal(header, 100, 8, 0o755);
  writeTarOctal(header, 108, 8, 0);
  writeTarOctal(header, 116, 8, 0);
  writeTarOctal(header, 124, 12, type === '0' ? bytes.length : 0);
  writeTarOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  writeTarString(header, 156, 1, type);
  writeTarString(header, 157, 100, linkName);
  writeTarString(header, 257, 6, 'ustar\0');
  writeTarString(header, 263, 2, '00');
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  writeTarString(header, 148, 8, checksum.toString(8).padStart(6, '0') + '\0 ');
  return header;
}

function makeTarGz(entries) {
  const parts = [];
  for (const entry of entries) {
    const bytes = Buffer.from(entry.bytes ?? '');
    parts.push(tarHeader({ ...entry, bytes }));
    if ((entry.type ?? '0') === '0') {
      parts.push(bytes);
      const padding = (512 - (bytes.length % 512)) % 512;
      if (padding) parts.push(Buffer.alloc(padding));
    }
  }
  parts.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(parts));
}

function makeZip(entries) {
  const localParts = [];
  const centralParts = [];
  let localOffset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const data = Buffer.from(entry.bytes ?? '');
    assert.equal(data.length, 0, 'test ZIP builder uses empty entries so CRC-32 is zero');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(0, 14);
    local.writeUInt32LE(0, 18);
    local.writeUInt32LE(0, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, name);

    const central = Buffer.alloc(46);
    const host = entry.host ?? 3;
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((host << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(0, 16);
    central.writeUInt32LE(0, 20);
    central.writeUInt32LE(0, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE((entry.externalAttributes ?? (0o100644 << 16)) >>> 0, 38);
    central.writeUInt32LE(localOffset, 42);
    centralParts.push(central, name);
    localOffset += local.length + name.length;
  }
  const centralOffset = localOffset;
  const centralBytes = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBytes.length, 12);
  eocd.writeUInt32LE(centralOffset, 16);
  return Buffer.concat([...localParts, centralBytes, eocd]);
}

async function expectRejectedBeforeWrites({ archiveType, bytes, members, message }) {
  const root = await mkdtemp(join(tmpdir(), 'happier-safe-extract-'));
  const archivePath = join(root, archiveType === 'zip' ? 'fixture.zip' : 'fixture.tar.gz');
  const destinationDir = join(root, 'out');
  await writeFile(archivePath, bytes);
  await assert.rejects(
    () => extractArchiveMembersSafely({ archivePath, archiveType, destinationDir, memberPolicy: 'exact', members }),
    message,
  );
  await assert.rejects(() => stat(destinationDir), { code: 'ENOENT' });
}

const TOOL_BYTES = Buffer.from('tool');
const TOOL_MEMBER = {
  sourcePath: 'tool',
  destinationPath: 'tool',
  sha256: sha256(TOOL_BYTES),
  size: TOOL_BYTES.length,
  executable: true,
};

test('safe tar extraction writes only the declared regular member after full preflight', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-safe-extract-'));
  const archivePath = join(root, 'fixture.tar.gz');
  const destinationDir = join(root, 'out');
  await writeFile(archivePath, makeTarGz([{ name: 'tool', bytes: TOOL_BYTES }]));
  await extractArchiveMembersSafely({
    archivePath,
    archiveType: 'tar.gz',
    destinationDir,
    memberPolicy: 'exact',
    members: [TOOL_MEMBER],
  });
  assert.deepEqual(await readFile(join(destinationDir, 'tool')), TOOL_BYTES);
});

test('safe tar extraction rejects paths, links, devices, collisions, and unexpected members before writes', async (t) => {
  const cases = [
    ['absolute path', [{ name: '/tool', bytes: TOOL_BYTES }], /absolute|unsafe path/i],
    ['Windows absolute path', [{ name: 'C:/tool', bytes: TOOL_BYTES }], /absolute|unsafe path/i],
    ['parent traversal', [{ name: '../tool', bytes: TOOL_BYTES }], /parent|traversal|unsafe path/i],
    ['symbolic link', [{ name: 'tool', type: '2', linkName: 'target' }], /symbolic|link/i],
    ['hard link', [{ name: 'tool', type: '1', linkName: 'target' }], /hard.?link|link/i],
    ['character device', [{ name: 'tool', type: '3' }], /device|special/i],
    ['block device', [{ name: 'tool', type: '4' }], /device|special/i],
    ['fifo', [{ name: 'tool', type: '6' }], /fifo|special/i],
    ['duplicate', [{ name: 'tool', bytes: TOOL_BYTES }, { name: 'tool', bytes: TOOL_BYTES }], /duplicate|collision/i],
    ['case collision', [{ name: 'tool', bytes: TOOL_BYTES }, { name: 'TOOL', bytes: TOOL_BYTES }], /collision/i],
    ['unexpected member', [{ name: 'tool', bytes: TOOL_BYTES }, { name: 'extra', bytes: 'x' }], /unexpected/i],
  ];
  for (const [name, entries, message] of cases) {
    await t.test(name, () => expectRejectedBeforeWrites({
      archiveType: 'tar.gz',
      bytes: makeTarGz(entries),
      members: [TOOL_MEMBER],
      message,
    }));
  }
});

test('pinned container mode scans ignored members but extracts only selected members', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-safe-extract-'));
  const archivePath = join(root, 'fixture.tar.gz');
  const destinationDir = join(root, 'out');
  await writeFile(archivePath, makeTarGz([
    { name: 'package/vendor/tool', bytes: TOOL_BYTES },
    { name: 'package/README.md', bytes: 'metadata' },
  ]));
  await extractArchiveMembersSafely({
    archivePath,
    archiveType: 'tar.gz',
    destinationDir,
    memberPolicy: 'pinned-container',
    members: [{ ...TOOL_MEMBER, sourcePath: 'package/vendor/tool' }],
  });
  assert.deepEqual(await readFile(join(destinationDir, 'tool')), TOOL_BYTES);

  await expectRejectedBeforeWrites({
    archiveType: 'tar.gz',
    bytes: makeTarGz([
      { name: 'package/vendor/tool', bytes: TOOL_BYTES },
      { name: 'package/escape', type: '2', linkName: '../../escape' },
    ]),
    members: [{ ...TOOL_MEMBER, sourcePath: 'package/vendor/tool' }],
    message: /symbolic|link/i,
  });
});

test('safe ZIP extraction rejects unsafe paths, symlinks, devices, reparse points, collisions, and unexpected members before writes', async (t) => {
  const emptyMember = { ...TOOL_MEMBER, sha256: sha256(Buffer.alloc(0)), size: 0 };
  const unixType = (mode) => (mode << 16) >>> 0;
  const cases = [
    ['absolute path', [{ name: '/tool' }], /absolute|unsafe path/i],
    ['Windows absolute path', [{ name: 'C:/tool' }], /absolute|unsafe path/i],
    ['parent traversal', [{ name: '../tool' }], /parent|traversal|unsafe path/i],
    ['symbolic link', [{ name: 'tool', externalAttributes: unixType(0o120777) }], /symbolic|link/i],
    ['character device', [{ name: 'tool', externalAttributes: unixType(0o020666) }], /device|special/i],
    ['block device', [{ name: 'tool', externalAttributes: unixType(0o060666) }], /device|special/i],
    ['fifo', [{ name: 'tool', externalAttributes: unixType(0o010666) }], /fifo|special/i],
    ['Windows reparse point', [{ name: 'tool', host: 0, externalAttributes: 0x400 }], /reparse/i],
    ['duplicate', [{ name: 'tool' }, { name: 'tool' }], /duplicate|collision/i],
    ['case collision', [{ name: 'tool' }, { name: 'TOOL' }], /collision/i],
    ['unexpected member', [{ name: 'tool' }, { name: 'extra' }], /unexpected/i],
  ];
  for (const [name, entries, message] of cases) {
    await t.test(name, () => expectRejectedBeforeWrites({
      archiveType: 'zip',
      bytes: makeZip(entries),
      members: [emptyMember],
      message,
    }));
  }
});
