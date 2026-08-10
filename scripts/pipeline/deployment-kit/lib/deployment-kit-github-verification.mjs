// @ts-check

export const DEPLOYMENT_PROJECT_VERIFY_SCRIPT = String.raw`#!/usr/bin/env node
import { createHash, createPublicKey, verify } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { dirname, join, posix, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RECEIPT = 'PROJECT-SHA256SUMS';
const SIGNATURE = RECEIPT + '.minisig';
const SKIPPED_ROOTS = new Set(['.git', 'downloads']);
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function fail(message) { throw new Error('[verify-project] ' + message); }
function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function isObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }

function schemaRef(root, ref) {
  if (!ref.startsWith('#/')) fail('unsupported JSON Schema reference: ' + ref);
  return ref.slice(2).split('/').reduce((value, segment) => {
    const key = segment.replace(/~1/g, '/').replace(/~0/g, '~');
    if (!isObject(value) || !(key in value)) fail('unresolved JSON Schema reference: ' + ref);
    return value[key];
  }, root);
}

function validateSchema(schema, value, instancePath, root) {
  if (!isObject(schema)) fail('invalid JSON Schema node at ' + instancePath);
  if (schema.$ref) return validateSchema(schemaRef(root, schema.$ref), value, instancePath, root);
  if (schema.oneOf) {
    const matches = schema.oneOf.filter((candidate) => {
      try { validateSchema(candidate, value, instancePath, root); return true; } catch { return false; }
    });
    if (matches.length !== 1) fail('catalog does not match exactly one schema at ' + instancePath);
  }
  if ('const' in schema && !Object.is(value, schema.const)) fail('catalog const mismatch at ' + instancePath);
  if (schema.enum && !schema.enum.some((entry) => Object.is(entry, value))) fail('catalog enum mismatch at ' + instancePath);
  if (schema.type === 'object') {
    if (!isObject(value)) fail('catalog expected object at ' + instancePath);
    const properties = isObject(schema.properties) ? schema.properties : {};
    for (const key of schema.required ?? []) {
      if (!(key in value)) fail('catalog missing required property ' + instancePath + '/' + key);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in properties)) fail('catalog has additional property ' + instancePath + '/' + key);
      }
    }
    for (const [key, childSchema] of Object.entries(properties)) {
      if (key in value) validateSchema(childSchema, value[key], instancePath + '/' + key, root);
    }
  } else if (schema.type === 'array') {
    if (!Array.isArray(value)) fail('catalog expected array at ' + instancePath);
    if (schema.minItems != null && value.length < schema.minItems) fail('catalog array is too short at ' + instancePath);
    if (schema.uniqueItems === true && new Set(value.map((entry) => JSON.stringify(entry))).size !== value.length) {
      fail('catalog array entries are not unique at ' + instancePath);
    }
    if (schema.items) value.forEach((entry, index) => validateSchema(schema.items, entry, instancePath + '/' + index, root));
  } else if (schema.type === 'string') {
    if (typeof value !== 'string') fail('catalog expected string at ' + instancePath);
    if (schema.minLength != null && value.length < schema.minLength) fail('catalog string is too short at ' + instancePath);
    if (schema.pattern && !(new RegExp(schema.pattern).test(value))) fail('catalog string pattern mismatch at ' + instancePath);
  } else if (schema.type === 'integer') {
    if (!Number.isSafeInteger(value)) fail('catalog expected safe integer at ' + instancePath);
    if (schema.minimum != null && value < schema.minimum) fail('catalog integer is too small at ' + instancePath);
  } else if (schema.type != null) {
    fail('unsupported JSON Schema type: ' + schema.type);
  }
  return value;
}

function safeReceiptPath(value) {
  const raw = String(value ?? '');
  const normalized = posix.normalize(raw);
  if (!raw || raw.includes('\\') || raw.startsWith('/') || /^[A-Za-z]:/.test(raw)
      || normalized !== raw || normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
    fail('unsafe checksum path: ' + raw);
  }
  return raw;
}

async function listProjectFiles(root, relativePath = '') {
  const files = [];
  for (const entry of await readdir(join(root, relativePath), { withFileTypes: true })) {
    const child = relativePath ? relativePath + '/' + entry.name : entry.name;
    if (!relativePath && SKIPPED_ROOTS.has(entry.name)) continue;
    const metadata = await lstat(join(root, ...child.split('/')));
    if (metadata.isSymbolicLink()) fail('symbolic link or reparse entry is forbidden: ' + child);
    if (metadata.isDirectory()) files.push(...await listProjectFiles(root, child));
    else if (metadata.isFile()) files.push(child);
    else fail('special filesystem entry is forbidden: ' + child);
  }
  return files.sort((left, right) => left.localeCompare(right, 'en'));
}

function parseReceipt(text) {
  if (!text.endsWith('\n')) fail('checksum receipt must end with a newline');
  const entries = new Map();
  let previous = '';
  for (const line of text.slice(0, -1).split('\n')) {
    const match = /^([a-f0-9]{64})  (.+)$/.exec(line);
    if (!match) fail('invalid checksum line');
    const file = safeReceiptPath(match[2]);
    if (entries.has(file) || [...entries.keys()].some((entry) => entry.toLowerCase() === file.toLowerCase())) {
      fail('duplicate or case-colliding checksum path: ' + file);
    }
    if (previous && previous.localeCompare(file, 'en') >= 0) fail('checksum receipt is not strictly sorted: ' + previous + ' then ' + file);
    previous = file;
    entries.set(file, match[1]);
  }
  return entries;
}

async function verifyProjectChecksums() {
  const receiptBytes = await readFile(join(PROJECT_ROOT, RECEIPT));
  const entries = parseReceipt(receiptBytes.toString('utf8'));
  const actualFiles = (await listProjectFiles(PROJECT_ROOT)).filter((file) => file !== RECEIPT && file !== SIGNATURE);
  if (JSON.stringify([...entries.keys()]) !== JSON.stringify(actualFiles)) fail('checksum receipt coverage is not exact');
  for (const [file, expected] of entries) {
    const actual = sha256(await readFile(join(PROJECT_ROOT, ...file.split('/'))));
    if (actual !== expected) fail('checksum mismatch: ' + file);
  }
  return receiptBytes;
}

function decodeBase64(line, expectedBytes) {
  const normalized = String(line ?? '').trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) fail('invalid Minisign base64');
  const bytes = Buffer.from(normalized, 'base64');
  if (bytes.length !== expectedBytes || bytes.toString('base64') !== normalized) fail('invalid Minisign payload length');
  return bytes;
}

export function verifyMinisign({ message, pubkeyFile, sigFile }) {
  try {
    const publicLines = String(pubkeyFile ?? '').trimEnd().split('\n');
    if (publicLines.length !== 2 || !publicLines[0].startsWith('untrusted comment: minisign public key')) return false;
    const publicPacket = decodeBase64(publicLines[1], 42);
    const signatureLines = String(sigFile ?? '').trimEnd().split('\n');
    if (signatureLines.length !== 4 || !signatureLines[0].startsWith('untrusted comment:')
        || !signatureLines[2].startsWith('trusted comment: ')) return false;
    const signaturePacket = decodeBase64(signatureLines[1], 74);
    const globalSignature = decodeBase64(signatureLines[3], 64);
    if (!publicPacket.subarray(0, 2).equals(Buffer.from('Ed'))
        || !publicPacket.subarray(2, 10).equals(signaturePacket.subarray(2, 10))) return false;
    const algorithm = signaturePacket.subarray(0, 2).toString('ascii');
    if (algorithm !== 'Ed' && algorithm !== 'ED') return false;
    const spki = Buffer.concat([ED25519_SPKI_PREFIX, publicPacket.subarray(10)]);
    const key = createPublicKey({ key: spki, format: 'der', type: 'spki' });
    const payload = algorithm === 'ED' ? createHash('blake2b512').update(message).digest() : message;
    if (!verify(null, payload, key, signaturePacket.subarray(10))) return false;
    const trustedSuffix = Buffer.from(signatureLines[2].slice('trusted comment: '.length), 'utf8');
    return verify(null, Buffer.concat([signaturePacket.subarray(10), trustedSuffix]), key, globalSignature);
  } catch { return false; }
}

async function fetchBytes(url, limit) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'github.com' || parsed.username || parsed.password) {
    fail('refusing non-GitHub HTTPS URL: ' + url);
  }
  const response = await fetch(parsed, { redirect: 'follow', headers: { 'user-agent': 'happier-anywhere-verifier/1' } });
  if (!response.ok) fail('download failed (' + response.status + '): ' + url);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length < 1 || bytes.length > limit) fail('download size is outside verifier bounds: ' + url);
  return bytes;
}

async function verifyPublishedReleases(catalog, publicKey) {
  if (catalog.repository.availability !== 'verified') {
    process.stdout.write('Release audit skipped: catalog availability is not-verified.\n');
    return;
  }
  const sourceSha = String(catalog.source?.commitSha ?? '');
  if (!/^[a-f0-9]{40}$/.test(sourceSha) || catalog.source?.workspaceDirty !== false) {
    fail('verified catalog requires one clean lowercase source commit SHA');
  }
  const byTag = new Map();
  for (const artifact of catalog.artifacts) {
    const tag = artifact.release.tag;
    if (!byTag.has(tag)) byTag.set(tag, []);
    byTag.get(tag).push(artifact);
  }
  for (const [tag, artifacts] of byTag) {
    const apiUrl = 'https://api.github.com/repos/' + catalog.repository.slug + '/releases/tags/' + encodeURIComponent(tag);
    const response = await fetch(apiUrl, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'happier-anywhere-verifier/1' } });
    if (!response.ok) fail('release metadata lookup failed (' + response.status + '): ' + tag);
    const release = await response.json();
    if (release.draft !== false || release.prerelease !== true || release.tag_name !== tag || release.target_commitish !== sourceSha) {
      fail('release metadata/target_commitish mismatch: ' + tag);
    }
    const releaseAssets = new Map((release.assets ?? []).map((asset) => [asset.name, asset]));
    const receiptNames = new Set();
    for (const artifact of artifacts) {
      const descriptor = releaseAssets.get(artifact.release.assetName);
      if (!descriptor || descriptor.state !== 'uploaded' || descriptor.size !== artifact.size
          || descriptor.browser_download_url !== artifact.release.url) fail('release archive metadata mismatch: ' + artifact.id);
      receiptNames.add(artifact.release.checksumsAssetName);
      const signatureDescriptor = releaseAssets.get(artifact.release.signatureAssetName);
      if (!signatureDescriptor || signatureDescriptor.state !== 'uploaded'
          || signatureDescriptor.browser_download_url !== artifact.release.signatureUrl) fail('release signature metadata mismatch: ' + artifact.id);
    }
    for (const receiptName of receiptNames) {
      const members = artifacts.filter((artifact) => artifact.release.checksumsAssetName === receiptName);
      const receiptUrl = members[0].release.checksumsUrl;
      const signatureUrl = members[0].release.signatureUrl;
      const receipt = await fetchBytes(receiptUrl, 4 * 1024 * 1024);
      const signature = await fetchBytes(signatureUrl, 64 * 1024);
      if (!verifyMinisign({ message: receipt, pubkeyFile: publicKey, sigFile: signature.toString('utf8') })) {
        fail('Minisign verification failed: ' + receiptName);
      }
      const signedEntries = parseReceipt(receipt.toString('utf8'));
      for (const artifact of members) {
        if (signedEntries.get(artifact.release.assetName) !== artifact.sha256) {
          fail('signed release checksum mismatch: ' + artifact.id);
        }
      }
    }
  }
}

export async function verifyProject({ verifyReleases = false, requireProjectSignature = false } = {}) {
  const schema = JSON.parse(await readFile(join(PROJECT_ROOT, 'deployment-catalog.schema.json'), 'utf8'));
  const catalog = JSON.parse(await readFile(join(PROJECT_ROOT, 'catalog.json'), 'utf8'));
  validateSchema(schema, catalog, '', schema);
  const receipt = await verifyProjectChecksums();
  const publicKey = await readFile(join(PROJECT_ROOT, 'happier-release.pub'), 'utf8');
  const signaturePath = join(PROJECT_ROOT, SIGNATURE);
  let signature = null;
  try { signature = await readFile(signaturePath, 'utf8'); } catch (error) {
    if (!error || error.code !== 'ENOENT') throw error;
  }
  if (signature && !verifyMinisign({ message: receipt, pubkeyFile: publicKey, sigFile: signature })) {
    fail('PROJECT-SHA256SUMS Minisign signature is invalid');
  }
  if (requireProjectSignature && !signature) fail('PROJECT-SHA256SUMS.minisig is required');
  if (verifyReleases) await verifyPublishedReleases(catalog, publicKey);
  process.stdout.write('Project verification passed.\n');
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const args = new Set(process.argv.slice(2));
  const allowed = new Set(['--verify-releases', '--require-project-signature']);
  for (const arg of args) if (!allowed.has(arg)) fail('unknown argument: ' + arg);
  verifyProject({
    verifyReleases: args.has('--verify-releases'),
    requireProjectSignature: args.has('--require-project-signature'),
  }).catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exit(1); });
}
`;

export const DEPLOYMENT_PROJECT_SAFE_EXTRACT_SCRIPT = String.raw`#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, posix, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { gunzipSync } from 'node:zlib';

const WINDOWS_DEVICE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
function fail(message) { throw new Error('[safe-extract] ' + message); }
function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }

function tarString(block, start, length) {
  return block.subarray(start, start + length).toString('utf8').replace(/\0.*$/s, '').trim();
}
function tarNumber(block, start, length) {
  const raw = block.subarray(start, start + length);
  if ((raw[0] & 0x80) !== 0) fail('base-256 tar numbers are unsupported');
  const text = raw.toString('ascii').replace(/\0.*$/s, '').trim();
  if (!/^[0-7]*$/.test(text)) fail('invalid tar number');
  const value = text ? Number.parseInt(text, 8) : 0;
  if (!Number.isSafeInteger(value) || value < 0) fail('unsafe tar number');
  return value;
}
function safeArchivePath(value) {
  const raw = String(value ?? '').replace(/\/$/, '');
  if (!raw || raw.includes('\\') || raw.includes(':') || raw.startsWith('/') || /^[A-Za-z]:/.test(raw)) fail('absolute or unsafe archive path');
  const normalized = posix.normalize(raw);
  if (normalized !== raw || normalized === '.' || normalized === '..' || normalized.startsWith('../')) fail('archive path traverses destination');
  for (const segment of raw.split('/')) {
    if (!segment || segment === '.' || segment === '..' || WINDOWS_DEVICE.test(segment)) fail('unsafe archive path segment');
  }
  return raw;
}
function parsePax(bytes) {
  const result = {};
  let offset = 0;
  while (offset < bytes.length) {
    const space = bytes.indexOf(0x20, offset);
    if (space < 0) fail('invalid PAX record');
    const length = Number.parseInt(bytes.subarray(offset, space).toString('ascii'), 10);
    if (!Number.isSafeInteger(length) || length < 4 || offset + length > bytes.length || bytes[offset + length - 1] !== 0x0a) fail('invalid PAX record length');
    const record = bytes.subarray(space + 1, offset + length - 1).toString('utf8');
    const equals = record.indexOf('=');
    if (equals < 1) fail('invalid PAX record field');
    result[record.slice(0, equals)] = record.slice(equals + 1);
    offset += length;
  }
  return result;
}

export function preflightTarBuffer(tarBytes) {
  const entries = [];
  const identities = new Map();
  let offset = 0;
  let nextPath = null;
  let globalPath = null;
  let zeroBlocks = 0;
  while (offset + 512 <= tarBytes.length) {
    const header = tarBytes.subarray(offset, offset + 512);
    offset += 512;
    if (header.every((byte) => byte === 0)) { zeroBlocks += 1; if (zeroBlocks >= 2) break; continue; }
    zeroBlocks = 0;
    const storedChecksum = tarNumber(header, 148, 8);
    const checksumBlock = Buffer.from(header);
    checksumBlock.fill(0x20, 148, 156);
    const actualChecksum = checksumBlock.reduce((sum, byte) => sum + byte, 0);
    if (storedChecksum !== actualChecksum) fail('tar header checksum mismatch');
    const size = tarNumber(header, 124, 12);
    const type = String.fromCharCode(header[156] || 0x30);
    const prefix = tarString(header, 345, 155);
    const baseName = tarString(header, 0, 100);
    const headerPath = prefix ? prefix + '/' + baseName : baseName;
    if (offset + size > tarBytes.length) fail('truncated tar entry');
    const body = tarBytes.subarray(offset, offset + size);
    offset += Math.ceil(size / 512) * 512;
    if (type === 'x' || type === 'g') {
      const pax = parsePax(body);
      if (pax.linkpath) fail('PAX linkpath is forbidden');
      if (pax.path) {
        if (type === 'g') globalPath = safeArchivePath(pax.path); else nextPath = safeArchivePath(pax.path);
      }
      continue;
    }
    if (type === 'L') { nextPath = safeArchivePath(body.toString('utf8').replace(/\0.*$/s, '')); continue; }
    const entryPath = safeArchivePath(nextPath ?? globalPath ?? headerPath);
    nextPath = null;
    if (type === '1') fail('hard link is forbidden: ' + entryPath);
    if (type === '2') fail('symbolic link is forbidden: ' + entryPath);
    if (type === '3' || type === '4') fail('device entry is forbidden: ' + entryPath);
    if (type === '6') fail('FIFO entry is forbidden: ' + entryPath);
    if (type !== '0' && type !== '\0' && type !== '5') fail('special tar entry is forbidden: ' + entryPath);
    const identity = entryPath.toLowerCase();
    if (identities.has(identity)) fail('duplicate or case-colliding archive path: ' + entryPath);
    for (const prior of entries) {
      if (prior.path.startsWith(entryPath + '/') && type !== '5') fail('file/directory archive path collision');
      if (entryPath.startsWith(prior.path + '/') && prior.type !== 'directory') fail('file/directory archive path collision');
    }
    const entry = { path: entryPath, type: type === '5' ? 'directory' : 'file', size };
    entries.push(entry);
    identities.set(identity, entry);
  }
  if (zeroBlocks < 2 || offset > tarBytes.length) fail('tar archive lacks a valid end marker');
  return entries;
}

async function assertExtractedTree(root, expectedEntries, relativePath = '') {
  const actual = [];
  for (const entry of await readdir(join(root, relativePath), { withFileTypes: true })) {
    const child = relativePath ? relativePath + '/' + entry.name : entry.name;
    const metadata = await lstat(join(root, ...child.split('/')));
    if (metadata.isSymbolicLink()) fail('extracted symbolic link or reparse point is forbidden: ' + child);
    if (metadata.isDirectory()) { actual.push({ path: child, type: 'directory', size: 0 }); actual.push(...await assertExtractedTree(root, expectedEntries, child)); }
    else if (metadata.isFile()) actual.push({ path: child, type: 'file', size: metadata.size });
    else fail('extracted device or special file is forbidden: ' + child);
  }
  if (!relativePath) {
    const normalizedExpected = expectedEntries.map((entry) => ({ ...entry, size: entry.type === 'directory' ? 0 : entry.size })).sort((a, b) => a.path.localeCompare(b.path, 'en'));
    actual.sort((a, b) => a.path.localeCompare(b.path, 'en'));
    if (JSON.stringify(actual) !== JSON.stringify(normalizedExpected)) fail('extracted tree differs from preflight inventory');
  }
  return actual;
}

export async function safelyExtractTarGz({ archivePath, outDir, expectedSha256 = '' }) {
  const source = resolve(archivePath);
  const destination = resolve(outDir);
  if (source === destination || destination.startsWith(source + sep)) fail('invalid extraction destination');
  try { await lstat(destination); fail('output already exists: ' + destination); } catch (error) { if (!error || error.code !== 'ENOENT') throw error; }
  const archiveMetadata = await lstat(source);
  if (!archiveMetadata.isFile() || archiveMetadata.isSymbolicLink()) fail('archive must be a regular non-symlink file');
  const compressed = await readFile(source);
  const sourceSha = sha256(compressed);
  if (expectedSha256 && sourceSha !== expectedSha256) fail('archive SHA256 mismatch');
  const entries = preflightTarBuffer(gunzipSync(compressed));
  const parent = dirname(destination);
  await mkdir(parent, { recursive: true });
  const stage = await mkdtemp(join(parent, '.safe-extract-'));
  try {
    execFileSync('tar', ['-xzf', source, '-C', stage], { stdio: 'pipe', timeout: 30 * 60_000 });
    if (sha256(await readFile(source)) !== sourceSha) fail('archive changed during extraction');
    await assertExtractedTree(stage, entries);
    await rename(stage, destination);
  } catch (error) { await rm(stage, { recursive: true, force: true }); throw error; }
  return { outDir: destination, sha256: sourceSha, entries };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const values = parseArgs({ args: process.argv.slice(2), options: { archive: { type: 'string' }, out: { type: 'string' }, sha256: { type: 'string', default: '' } } }).values;
  if (!values.archive || !values.out) fail('--archive and --out are required');
  safelyExtractTarGz({ archivePath: values.archive, outDir: values.out, expectedSha256: values.sha256 }).then(
    (result) => process.stdout.write(result.outDir + '\n'),
    (error) => { console.error(error instanceof Error ? error.message : String(error)); process.exit(1); },
  );
}
`;

export const DEPLOYMENT_PROJECT_SAFE_EXTRACT_TEST = String.raw`import test from 'node:test';
import assert from 'node:assert/strict';

import { preflightTarBuffer } from '../scripts/safe-extract.mjs';

function octal(value, length) { return Buffer.from(value.toString(8).padStart(length - 1, '0') + '\0', 'ascii'); }
function tar(entries) {
  const blocks = [];
  for (const entry of entries) {
    const body = Buffer.from(entry.body ?? '');
    const header = Buffer.alloc(512);
    header.write(entry.path, 0, 100, 'utf8');
    octal(entry.mode ?? 0o644, 8).copy(header, 100);
    octal(0, 8).copy(header, 108); octal(0, 8).copy(header, 116);
    octal(body.length, 12).copy(header, 124); octal(0, 12).copy(header, 136);
    header.fill(0x20, 148, 156); header[156] = String(entry.type ?? '0').charCodeAt(0);
    Buffer.from('ustar\0', 'ascii').copy(header, 257);
    octal(header.reduce((sum, byte) => sum + byte, 0), 8).copy(header, 148);
    blocks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

test('safe extraction preflight admits only regular files and directories', () => {
  assert.deepEqual(preflightTarBuffer(tar([{ path: 'bin/', type: '5' }, { path: 'bin/happier', body: 'ok' }])), [
    { path: 'bin', type: 'directory', size: 0 },
    { path: 'bin/happier', type: 'file', size: 2 },
  ]);
});

for (const [name, entry, pattern] of [
  ['absolute path', { path: '/escape', body: 'x' }, /absolute|unsafe/i],
  ['parent traversal', { path: '../escape', body: 'x' }, /traverses/i],
  ['symbolic link', { path: 'escape', type: '2' }, /symbolic link/i],
  ['hard link', { path: 'escape', type: '1' }, /hard link/i],
  ['character device', { path: 'escape', type: '3' }, /device/i],
]) {
  test('safe extraction preflight rejects ' + name + ' before writes', () => {
    assert.throws(() => preflightTarBuffer(tar([entry])), pattern);
  });
}
`;

export const DEPLOYMENT_PROJECT_VERIFY_WORKFLOW = String.raw`name: Verify modular deployment project

on:
  push:
  pull_request:

permissions:
  contents: read

jobs:
  verify:
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-latest, windows-latest]
    runs-on: ${'${{ matrix.os }}'}
    steps:
      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262
        with:
          persist-credentials: false
      - name: Validate JSON Schema, exact project checksums, and project signature when present
        run: node scripts/verify-project.mjs
      - name: Exercise safe archive preflight
        run: node --test tests/safe-extract.test.mjs
      - name: Parse PowerShell helper
        if: runner.os == 'Windows'
        shell: pwsh
        run: "[void][ScriptBlock]::Create((Get-Content -LiteralPath scripts/fetch.ps1 -Raw))"
      - name: Parse Bash helper
        if: runner.os != 'Windows'
        shell: bash
        run: bash -n scripts/fetch.sh
      - name: Audit published prerelease metadata, target SHA, checksums, and Minisign
        run: node scripts/verify-project.mjs --verify-releases
`;
