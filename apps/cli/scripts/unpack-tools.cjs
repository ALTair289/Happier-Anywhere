#!/usr/bin/env node

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
    ensurePinnedSourceArchive,
    loadThirdPartyManifest,
} = require('./third-party-assets.cjs');
const {
    extractArchiveMembersSafely,
    preflightArchive,
} = require('./safe-extract.cjs');

const VERSION_MARKER_NAME = '.happier-tools-manifest.json';

function getPlatformDir() {
    const platform = os.platform();
    const arch = os.arch();
    if (platform === 'darwin' && (arch === 'arm64' || arch === 'x64')) return `${arch}-darwin`;
    if (platform === 'linux' && (arch === 'arm64' || arch === 'x64')) return `${arch}-linux`;
    if (platform === 'win32' && arch === 'x64') return 'x64-win32';
    if (platform === 'win32' && arch === 'arm64') {
        throw new Error('Unsupported platform: arm64-win32 (upstream binaries unavailable)');
    }
    throw new Error(`Unsupported platform: ${arch}-${platform}`);
}

function getToolsDir() {
    return path.resolve(__dirname, '..', 'tools');
}

function getToolArchiveManifest() {
    return loadThirdPartyManifest().assets.map((entry) => structuredClone(entry));
}

function getManifestForPlatform(platformDir, manifest = loadThirdPartyManifest()) {
    const entries = manifest.assets.filter((entry) => entry.platformDir === platformDir);
    if (entries.length === 0) {
        const blocked = manifest.platforms.unsupported.find((entry) => entry.platformDir === platformDir);
        const suffix = blocked ? ` (${blocked.reason})` : '';
        throw new Error(`Unsupported platform: ${platformDir}${suffix}`);
    }
    if (entries.length !== 3 || new Set(entries.map((entry) => entry.tool)).size !== 3) {
        throw new Error(`Third-party manifest does not provide exactly three tools for ${platformDir}`);
    }
    return entries;
}

function normalizedTextSha256(text) {
    return crypto.createHash('sha256').update(text.replace(/\r\n/g, '\n'), 'utf8').digest('hex');
}

function verifyLicenseFile(toolsDir, license) {
    const licensePath = path.join(toolsDir, 'licenses', license.file);
    const info = fs.lstatSync(licensePath);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error(`Third-party license must be a regular file: ${license.file}`);
    const actual = normalizedTextSha256(fs.readFileSync(licensePath, 'utf8'));
    if (actual !== license.normalizedSha256) {
        throw new Error(`Third-party license SHA-256 mismatch: ${license.file}`);
    }
    return licensePath;
}

function expectedFiles(entries, licensesById) {
    const files = new Set();
    for (const entry of entries) {
        for (const member of entry.members) files.add(member.destinationPath);
        const license = licensesById.get(entry.licenseId);
        if (!license) throw new Error(`Missing license metadata for ${entry.tool}: ${entry.licenseId}`);
        files.add(license.file);
    }
    return [...files].sort();
}

function readVersionMarker(unpackedPath) {
    const markerPath = path.join(unpackedPath, VERSION_MARKER_NAME);
    try {
        const info = fs.lstatSync(markerPath);
        if (info.isSymbolicLink() || !info.isFile()) return null;
        return JSON.parse(fs.readFileSync(markerPath, 'utf8'));
    } catch {
        return null;
    }
}

function isRegularNonLink(filePath) {
    try {
        const info = fs.lstatSync(filePath);
        return !info.isSymbolicLink() && info.isFile();
    } catch {
        return false;
    }
}

function areToolsUnpacked(toolsDir, platformDir = getPlatformDir(), manifest = loadThirdPartyManifest()) {
    const entries = getManifestForPlatform(platformDir, manifest);
    const licensesById = new Map(manifest.licenses.map((license) => [license.id, license]));
    const unpackedPath = path.join(toolsDir, 'unpacked');
    try {
        const info = fs.lstatSync(unpackedPath);
        if (info.isSymbolicLink() || !info.isDirectory()) return false;
    } catch {
        return false;
    }
    if (!expectedFiles(entries, licensesById).every((file) => isRegularNonLink(path.join(unpackedPath, file)))) return false;
    const marker = readVersionMarker(unpackedPath);
    if (!marker || marker.schemaVersion !== 'happier-unpacked-tools/v1' || marker.platformDir !== platformDir) return false;
    return entries.every((entry) => (
        marker.tools?.[entry.tool]?.version === entry.version
        && marker.tools?.[entry.tool]?.sourceSha256 === entry.source.sha256
    ));
}

function copyRegularFileExclusive(source, destination, executable = false) {
    const info = fs.lstatSync(source);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error(`Refusing to copy non-regular extracted member: ${source}`);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
    if (executable && process.platform !== 'win32') fs.chmodSync(destination, 0o755);
}

function writeVersionMarker(unpackedPath, platformDir, entries) {
    const tools = {};
    for (const entry of entries) {
        tools[entry.tool] = {
            version: entry.version,
            sourceUrl: entry.source.url,
            sourceSha256: entry.source.sha256,
            sourceCommit: entry.source.commit,
        };
    }
    const marker = { schemaVersion: 'happier-unpacked-tools/v1', platformDir, tools };
    fs.writeFileSync(path.join(unpackedPath, VERSION_MARKER_NAME), `${JSON.stringify(marker, null, 2)}\n`, { flag: 'wx', mode: 0o644 });
}

async function unpackTools(options = {}) {
    const platformDir = options.platformDir || getPlatformDir();
    const toolsDir = options.toolsDir || getToolsDir();
    const cacheDir = options.cacheDir || path.join(toolsDir, 'downloads');
    const manifest = options.manifest ?? loadThirdPartyManifest(options.manifestPath);
    const entries = getManifestForPlatform(platformDir, manifest);
    const licensesById = new Map(manifest.licenses.map((license) => [license.id, license]));

    if (areToolsUnpacked(toolsDir, platformDir, manifest)) {
        console.log(`Tools already unpacked for ${platformDir}`);
        return { success: true, alreadyUnpacked: true };
    }

    const verifiedLicenses = new Map();
    for (const entry of entries) {
        const license = licensesById.get(entry.licenseId);
        if (!license) throw new Error(`Missing license metadata for ${entry.tool}: ${entry.licenseId}`);
        if (!verifiedLicenses.has(license.id)) verifiedLicenses.set(license.id, verifyLicenseFile(toolsDir, license));
    }

    console.log(`Downloading and verifying fixed tools for ${platformDir}...`);
    const archiveBySha256 = new Map();
    for (const entry of entries) {
        if (!archiveBySha256.has(entry.source.sha256)) {
            archiveBySha256.set(entry.source.sha256, await ensurePinnedSourceArchive({
                source: entry.source,
                cacheDir,
                download: options.download,
            }));
        }
    }

    // Complete every archive preflight before creating an extraction destination.
    for (const entry of entries) {
        await preflightArchive({
            archivePath: archiveBySha256.get(entry.source.sha256),
            archiveType: entry.source.archiveType,
            memberPolicy: entry.memberPolicy,
            members: entry.members,
        });
    }

    const unpackedPath = path.join(toolsDir, 'unpacked');
    const stagingPath = path.join(toolsDir, `.unpacked-staging-${process.pid}-${crypto.randomBytes(6).toString('hex')}`);
    const extractionRoot = path.join(toolsDir, `.archive-staging-${process.pid}-${crypto.randomBytes(6).toString('hex')}`);
    fs.mkdirSync(stagingPath, { recursive: false });
    fs.mkdirSync(extractionRoot, { recursive: false });
    try {
        const written = new Set();
        for (const entry of entries) {
            const entryDir = path.join(extractionRoot, entry.tool);
            await extractArchiveMembersSafely({
                archivePath: archiveBySha256.get(entry.source.sha256),
                archiveType: entry.source.archiveType,
                destinationDir: entryDir,
                memberPolicy: entry.memberPolicy,
                members: entry.members,
            });
            for (const member of entry.members) {
                const key = member.destinationPath.toLowerCase();
                if (written.has(key)) throw new Error(`Tool output collision: ${member.destinationPath}`);
                written.add(key);
                copyRegularFileExclusive(
                    path.join(entryDir, ...member.destinationPath.split('/')),
                    path.join(stagingPath, ...member.destinationPath.split('/')),
                    member.executable,
                );
            }
        }
        for (const [licenseId, source] of verifiedLicenses) {
            const license = licensesById.get(licenseId);
            copyRegularFileExclusive(source, path.join(stagingPath, license.file));
        }
        writeVersionMarker(stagingPath, platformDir, entries);

        if (fs.existsSync(unpackedPath)) {
            const existing = fs.lstatSync(unpackedPath);
            if (existing.isSymbolicLink() || !existing.isDirectory()) {
                throw new Error(`Refusing to replace non-directory or reparse-point tools output: ${unpackedPath}`);
            }
            fs.rmSync(unpackedPath, { recursive: true, force: true });
        }
        fs.renameSync(stagingPath, unpackedPath);
        console.log(`Tools verified and unpacked successfully to ${unpackedPath}`);
        return { success: true, alreadyUnpacked: false };
    } catch (error) {
        fs.rmSync(stagingPath, { recursive: true, force: true });
        throw error;
    } finally {
        fs.rmSync(extractionRoot, { recursive: true, force: true });
    }
}

module.exports = {
    areToolsUnpacked,
    getPlatformDir,
    getToolArchiveManifest,
    getToolsDir,
    unpackTools,
};

if (require.main === module) {
    unpackTools().catch((error) => {
        console.error(`Failed to install fixed third-party tools: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
    });
}
