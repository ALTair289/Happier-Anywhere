#!/usr/bin/env node

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const tar = require('tar');

const WINDOWS_DEVICE_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const TAR_REGULAR_TYPES = new Set(['File', 'OldFile', 'ContiguousFile']);
const TAR_DIRECTORY_TYPES = new Set(['Directory', 'GNUDumpDir']);
const TAR_LINK_TYPES = new Set(['Link', 'SymbolicLink']);
const TAR_DEVICE_TYPES = new Set(['CharacterDevice', 'BlockDevice']);
const TAR_SPECIAL_TYPES = new Set(['FIFO', 'Socket']);
const UNIX_FILE_TYPE = 0o170000;
const UNIX_REGULAR_FILE = 0o100000;
const UNIX_DIRECTORY = 0o040000;
const UNIX_SYMBOLIC_LINK = 0o120000;
const UNIX_CHARACTER_DEVICE = 0o020000;
const UNIX_BLOCK_DEVICE = 0o060000;
const UNIX_FIFO = 0o010000;
const UNIX_SOCKET = 0o140000;
const WINDOWS_REPARSE_POINT = 0x400;

function sha256Bytes(bytes) {
    return crypto.createHash('sha256').update(bytes).digest('hex');
}

function sha256File(filePath) {
    return sha256Bytes(fs.readFileSync(filePath));
}

function normalizeArchivePath(value, label = 'archive entry') {
    if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
        throw new Error(`Unsafe ${label} path`);
    }
    const slashPath = value.replace(/\\/g, '/').replace(/\/+$/u, '');
    if (
        slashPath.length === 0
        || slashPath.startsWith('/')
        || slashPath.startsWith('//')
        || /^[A-Za-z]:\//u.test(slashPath)
        || path.posix.isAbsolute(slashPath)
        || path.win32.isAbsolute(value)
    ) {
        throw new Error(`Unsafe absolute ${label} path: ${value}`);
    }
    const segments = slashPath.split('/');
    if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
        throw new Error(`Unsafe parent traversal in ${label} path: ${value}`);
    }
    for (const segment of segments) {
        if (segment.includes(':') || WINDOWS_DEVICE_NAME.test(segment)) {
            throw new Error(`Unsafe ${label} path: ${value}`);
        }
    }
    return segments.join('/');
}

function normalizeMemberSpecs(members) {
    if (!Array.isArray(members) || members.length === 0) {
        throw new Error('At least one selected archive member is required');
    }
    const sourcePaths = new Map();
    const destinationPaths = new Map();
    return members.map((member) => {
        const sourcePath = normalizeArchivePath(member?.sourcePath, 'source member');
        const destinationPath = normalizeArchivePath(member?.destinationPath, 'destination member');
        if (!/^[a-f0-9]{64}$/u.test(member?.sha256 ?? '')) {
            throw new Error(`Invalid SHA-256 for selected member: ${sourcePath}`);
        }
        if (!Number.isSafeInteger(member?.size) || member.size < 0) {
            throw new Error(`Invalid size for selected member: ${sourcePath}`);
        }
        const sourceKey = sourcePath.toLowerCase();
        const destinationKey = destinationPath.toLowerCase();
        if (sourcePaths.has(sourceKey)) throw new Error(`Duplicate selected source member: ${sourcePath}`);
        if (destinationPaths.has(destinationKey)) throw new Error(`Destination member collision: ${destinationPath}`);
        sourcePaths.set(sourceKey, sourcePath);
        destinationPaths.set(destinationKey, destinationPath);
        return {
            sourcePath,
            destinationPath,
            sha256: member.sha256,
            size: member.size,
            executable: member.executable === true,
        };
    });
}

function expectedParentPaths(members) {
    const parents = new Set();
    for (const member of members) {
        const parts = member.sourcePath.split('/');
        for (let index = 1; index < parts.length; index += 1) {
            parents.add(parts.slice(0, index).join('/').toLowerCase());
        }
    }
    return parents;
}

function createEntryRegistry() {
    const entries = new Map();
    return {
        add(entryPath, kind) {
            const key = entryPath.toLowerCase();
            if (entries.has(key)) {
                const previous = entries.get(key);
                const reason = previous.path === entryPath ? 'duplicate' : 'case collision';
                throw new Error(`Archive ${reason}: ${previous.path} and ${entryPath}`);
            }
            const segments = entryPath.split('/');
            for (let index = 1; index < segments.length; index += 1) {
                const parent = segments.slice(0, index).join('/').toLowerCase();
                if (entries.get(parent)?.kind === 'file') {
                    throw new Error(`Archive path collision: file is parent of ${entryPath}`);
                }
            }
            if (kind === 'file') {
                for (const [existingKey, existing] of entries) {
                    if (existingKey.startsWith(`${key}/`)) {
                        throw new Error(`Archive path collision: ${entryPath} is parent of ${existing.path}`);
                    }
                }
            }
            entries.set(key, { path: entryPath, kind });
        },
    };
}

function validateExpectedEntry({ entryPath, kind, size, membersByPath, parents, memberPolicy }) {
    const selected = membersByPath.get(entryPath);
    if (selected) {
        if (kind !== 'file') throw new Error(`Selected archive member is not a regular file: ${entryPath}`);
        if (size !== selected.size) {
            throw new Error(`Selected archive member size mismatch for ${entryPath}: expected ${selected.size}, got ${size}`);
        }
        selected.seen += 1;
        return;
    }
    if (memberPolicy === 'exact' && !(kind === 'directory' && parents.has(entryPath.toLowerCase()))) {
        throw new Error(`Unexpected archive member: ${entryPath}`);
    }
}

function assertAllSelectedMembersSeen(membersByPath) {
    for (const selected of membersByPath.values()) {
        if (selected.seen !== 1) {
            throw new Error(`Expected exactly one selected archive member: ${selected.sourcePath}`);
        }
    }
}

function preparePreflight({ members, memberPolicy }) {
    if (memberPolicy !== 'exact' && memberPolicy !== 'pinned-container') {
        throw new Error(`Unsupported archive member policy: ${memberPolicy}`);
    }
    const normalizedMembers = normalizeMemberSpecs(members);
    const membersByPath = new Map(normalizedMembers.map((member) => [member.sourcePath, { ...member, seen: 0 }]));
    return {
        normalizedMembers,
        membersByPath,
        parents: expectedParentPaths(normalizedMembers),
        registry: createEntryRegistry(),
    };
}

async function preflightTarArchive({ archivePath, members, memberPolicy }) {
    const state = preparePreflight({ members, memberPolicy });
    let validationError = null;
    await tar.list({
        file: archivePath,
        strict: true,
        onentry(entry) {
            try {
                if (validationError) return;
                const entryPath = normalizeArchivePath(entry.path);
                let kind;
                if (TAR_REGULAR_TYPES.has(entry.type)) kind = 'file';
                else if (TAR_DIRECTORY_TYPES.has(entry.type)) kind = 'directory';
                else if (TAR_LINK_TYPES.has(entry.type)) {
                    const linkKind = entry.type === 'Link' ? 'hard link' : 'symbolic link';
                    throw new Error(`Unsafe ${linkKind} archive member: ${entryPath}`);
                } else if (TAR_DEVICE_TYPES.has(entry.type)) {
                    throw new Error(`Unsafe device archive member: ${entryPath}`);
                } else if (TAR_SPECIAL_TYPES.has(entry.type)) {
                    throw new Error(`Unsafe special ${entry.type.toLowerCase()} archive member: ${entryPath}`);
                } else {
                    throw new Error(`Unsupported special tar member type ${entry.type}: ${entryPath}`);
                }
                state.registry.add(entryPath, kind);
                validateExpectedEntry({
                    entryPath,
                    kind,
                    size: Number(entry.size ?? 0),
                    membersByPath: state.membersByPath,
                    parents: state.parents,
                    memberPolicy,
                });
            } catch (error) {
                validationError = error;
            } finally {
                entry.resume();
            }
        },
    });
    if (validationError) throw validationError;
    assertAllSelectedMembersSeen(state.membersByPath);
    return { archiveType: 'tar.gz', members: state.normalizedMembers };
}

function findEndOfCentralDirectory(buffer) {
    const minimum = Math.max(0, buffer.length - 22 - 0xffff);
    for (let index = buffer.length - 22; index >= minimum; index -= 1) {
        if (buffer.readUInt32LE(index) === 0x06054b50) return index;
    }
    return -1;
}

function checkedRange(buffer, offset, length, label) {
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > buffer.length) {
        throw new Error(`Invalid ZIP ${label}`);
    }
}

function zipEntryKind({ versionMadeBy, externalAttributes, entryPath, directoryName }) {
    if ((externalAttributes & WINDOWS_REPARSE_POINT) !== 0) {
        throw new Error(`Unsafe Windows reparse point ZIP member: ${entryPath}`);
    }
    const host = versionMadeBy >>> 8;
    if (host !== 3) return directoryName ? 'directory' : 'file';
    const mode = externalAttributes >>> 16;
    const type = mode & UNIX_FILE_TYPE;
    if (type === 0 || type === UNIX_REGULAR_FILE) return directoryName ? 'directory' : 'file';
    if (type === UNIX_DIRECTORY) return 'directory';
    if (type === UNIX_SYMBOLIC_LINK) throw new Error(`Unsafe symbolic link ZIP member: ${entryPath}`);
    if (type === UNIX_CHARACTER_DEVICE || type === UNIX_BLOCK_DEVICE) {
        throw new Error(`Unsafe device ZIP member: ${entryPath}`);
    }
    if (type === UNIX_FIFO) throw new Error(`Unsafe special FIFO ZIP member: ${entryPath}`);
    if (type === UNIX_SOCKET) throw new Error(`Unsafe special socket ZIP member: ${entryPath}`);
    throw new Error(`Unsupported special ZIP member type ${type.toString(8)}: ${entryPath}`);
}

function parseZipArchive({ archivePath, members, memberPolicy }) {
    const state = preparePreflight({ members, memberPolicy });
    const buffer = fs.readFileSync(archivePath);
    const eocd = findEndOfCentralDirectory(buffer);
    if (eocd < 0) throw new Error(`Invalid ZIP archive: ${archivePath}`);
    checkedRange(buffer, eocd, 22, 'end of central directory');
    const diskNumber = buffer.readUInt16LE(eocd + 4);
    const centralDisk = buffer.readUInt16LE(eocd + 6);
    const diskEntries = buffer.readUInt16LE(eocd + 8);
    const entryCount = buffer.readUInt16LE(eocd + 10);
    const centralSize = buffer.readUInt32LE(eocd + 12);
    let centralOffset = buffer.readUInt32LE(eocd + 16);
    if (diskNumber !== 0 || centralDisk !== 0 || diskEntries !== entryCount) throw new Error('Multi-disk ZIP archives are unsupported');
    if (entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
        throw new Error('ZIP64 archives are unsupported');
    }
    checkedRange(buffer, centralOffset, centralSize, 'central directory');
    const entries = [];
    for (let entryIndex = 0; entryIndex < entryCount; entryIndex += 1) {
        checkedRange(buffer, centralOffset, 46, 'central directory entry');
        if (buffer.readUInt32LE(centralOffset) !== 0x02014b50) throw new Error('Invalid ZIP central directory');
        const versionMadeBy = buffer.readUInt16LE(centralOffset + 4);
        const flags = buffer.readUInt16LE(centralOffset + 8);
        const method = buffer.readUInt16LE(centralOffset + 10);
        const crc32 = buffer.readUInt32LE(centralOffset + 16);
        const compressedSize = buffer.readUInt32LE(centralOffset + 20);
        const uncompressedSize = buffer.readUInt32LE(centralOffset + 24);
        const fileNameLength = buffer.readUInt16LE(centralOffset + 28);
        const extraLength = buffer.readUInt16LE(centralOffset + 30);
        const commentLength = buffer.readUInt16LE(centralOffset + 32);
        const externalAttributes = buffer.readUInt32LE(centralOffset + 38);
        const localHeaderOffset = buffer.readUInt32LE(centralOffset + 42);
        const entryLength = 46 + fileNameLength + extraLength + commentLength;
        checkedRange(buffer, centralOffset, entryLength, 'central directory entry');
        const nameBytes = buffer.subarray(centralOffset + 46, centralOffset + 46 + fileNameLength);
        const rawName = nameBytes.toString('utf8');
        if (rawName.includes('\ufffd')) throw new Error('Invalid UTF-8 ZIP member path');
        const entryPath = normalizeArchivePath(rawName);
        centralOffset += entryLength;
        if ((flags & 0x1) !== 0) throw new Error(`Encrypted ZIP member is unsupported: ${entryPath}`);
        if (method !== 0 && method !== 8) throw new Error(`Unsupported ZIP compression method ${method}: ${entryPath}`);
        if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localHeaderOffset === 0xffffffff) {
            throw new Error('ZIP64 members are unsupported');
        }
        const kind = zipEntryKind({
            versionMadeBy,
            externalAttributes,
            entryPath,
            directoryName: rawName.endsWith('/'),
        });
        state.registry.add(entryPath, kind);
        validateExpectedEntry({
            entryPath,
            kind,
            size: uncompressedSize,
            membersByPath: state.membersByPath,
            parents: state.parents,
            memberPolicy,
        });

        checkedRange(buffer, localHeaderOffset, 30, 'local header');
        if (buffer.readUInt32LE(localHeaderOffset) !== 0x04034b50) throw new Error('Invalid ZIP local header');
        const localFlags = buffer.readUInt16LE(localHeaderOffset + 6);
        const localMethod = buffer.readUInt16LE(localHeaderOffset + 8);
        const localNameLength = buffer.readUInt16LE(localHeaderOffset + 26);
        const localExtraLength = buffer.readUInt16LE(localHeaderOffset + 28);
        const dataOffset = localHeaderOffset + 30 + localNameLength + localExtraLength;
        checkedRange(buffer, localHeaderOffset + 30, localNameLength + localExtraLength, 'local header name');
        checkedRange(buffer, dataOffset, compressedSize, 'member data');
        const localName = buffer.subarray(localHeaderOffset + 30, localHeaderOffset + 30 + localNameLength);
        if (!localName.equals(nameBytes) || localFlags !== flags || localMethod !== method) {
            throw new Error(`ZIP central/local header mismatch: ${entryPath}`);
        }
        entries.push({ entryPath, kind, method, crc32, compressedSize, uncompressedSize, dataOffset });
    }
    assertAllSelectedMembersSeen(state.membersByPath);
    return { archiveType: 'zip', buffer, entries, members: state.normalizedMembers };
}

async function preflightArchive({ archivePath, archiveType, members, memberPolicy = 'exact' }) {
    const info = fs.lstatSync(archivePath);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error(`Archive must be a regular file: ${archivePath}`);
    if (archiveType === 'tar.gz') return await preflightTarArchive({ archivePath, members, memberPolicy });
    if (archiveType === 'zip') return parseZipArchive({ archivePath, members, memberPolicy });
    throw new Error(`Unsupported archive type: ${archiveType}`);
}

let crcTable = null;
function crc32(bytes) {
    if (crcTable === null) {
        crcTable = Array.from({ length: 256 }, (_, index) => {
            let value = index;
            for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
            return value >>> 0;
        });
    }
    let crc = 0xffffffff;
    for (const byte of bytes) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff];
    return (crc ^ 0xffffffff) >>> 0;
}

function destinationPathInside(root, relativePath) {
    const resolvedRoot = path.resolve(root);
    const resolved = path.resolve(root, ...relativePath.split('/'));
    if (resolved === resolvedRoot || !resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
        throw new Error(`Unsafe destination member path: ${relativePath}`);
    }
    return resolved;
}

function verifyAndCopySelectedFile(sourcePath, destinationPath, member) {
    const info = fs.lstatSync(sourcePath);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error(`Extracted member is not a regular file: ${member.sourcePath}`);
    if (info.size !== member.size) throw new Error(`Extracted member size mismatch: ${member.sourcePath}`);
    const actualSha256 = sha256File(sourcePath);
    if (actualSha256 !== member.sha256) throw new Error(`Extracted member SHA-256 mismatch: ${member.sourcePath}`);
    fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
    fs.copyFileSync(sourcePath, destinationPath, fs.constants.COPYFILE_EXCL);
    if (member.executable && process.platform !== 'win32') fs.chmodSync(destinationPath, 0o755);
}

async function extractTarPlan({ plan, archivePath, stagingDir }) {
    const sourceDir = path.join(stagingDir, '.archive-source');
    fs.mkdirSync(sourceDir, { recursive: true });
    const selected = new Set(plan.members.map((member) => member.sourcePath));
    await tar.extract({
        file: archivePath,
        cwd: sourceDir,
        strict: true,
        preserveOwner: false,
        noChmod: true,
        filter(entryPath) {
            return selected.has(normalizeArchivePath(entryPath));
        },
    });
    for (const member of plan.members) {
        verifyAndCopySelectedFile(
            destinationPathInside(sourceDir, member.sourcePath),
            destinationPathInside(stagingDir, member.destinationPath),
            member,
        );
    }
    fs.rmSync(sourceDir, { recursive: true, force: true });
}

function extractZipPlan({ plan, stagingDir }) {
    const selected = new Map(plan.members.map((member) => [member.sourcePath, member]));
    for (const entry of plan.entries) {
        const member = selected.get(entry.entryPath);
        if (!member) continue;
        const compressed = plan.buffer.subarray(entry.dataOffset, entry.dataOffset + entry.compressedSize);
        const bytes = entry.method === 0 ? compressed : zlib.inflateRawSync(compressed);
        if (bytes.length !== entry.uncompressedSize || crc32(bytes) !== entry.crc32) {
            throw new Error(`Invalid ZIP member integrity: ${entry.entryPath}`);
        }
        if (sha256Bytes(bytes) !== member.sha256) throw new Error(`Extracted member SHA-256 mismatch: ${entry.entryPath}`);
        const destination = destinationPathInside(stagingDir, member.destinationPath);
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.writeFileSync(destination, bytes, { flag: 'wx', mode: member.executable ? 0o755 : 0o644 });
    }
}

async function extractArchiveMembersSafely({
    archivePath,
    archiveType,
    destinationDir,
    members,
    memberPolicy = 'exact',
}) {
    if (fs.existsSync(destinationDir)) throw new Error(`Safe extraction destination already exists: ${destinationDir}`);
    const plan = await preflightArchive({ archivePath, archiveType, members, memberPolicy });
    const resolvedDestination = path.resolve(destinationDir);
    const stagingDir = `${resolvedDestination}.staging-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
    fs.mkdirSync(path.dirname(resolvedDestination), { recursive: true });
    fs.mkdirSync(stagingDir, { recursive: false });
    try {
        if (archiveType === 'tar.gz') await extractTarPlan({ plan, archivePath, stagingDir });
        else extractZipPlan({ plan, stagingDir });
        fs.renameSync(stagingDir, resolvedDestination);
        return { destinationDir, extractedMembers: plan.members.map((member) => member.destinationPath) };
    } catch (error) {
        fs.rmSync(stagingDir, { recursive: true, force: true });
        throw error;
    }
}

module.exports = {
    extractArchiveMembersSafely,
    normalizeArchivePath,
    preflightArchive,
};
