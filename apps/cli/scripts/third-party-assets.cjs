#!/usr/bin/env node

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const https = require('node:https');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');
const { Transform } = require('node:stream');

const MANIFEST_PATH = path.resolve(__dirname, '..', 'tools', 'third-party-assets.json');
const MAX_REDIRECTS = 5;
const CANONICAL_PLATFORMS = ['arm64-darwin', 'arm64-linux', 'x64-darwin', 'x64-linux', 'x64-win32'];
const CANONICAL_TOOLS = ['difftastic', 'ripgrep', 'zellij'];

function sha256File(filePath) {
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function assertPinnedSource(source) {
    if (!source || typeof source !== 'object') throw new Error('Pinned third-party source is required');
    let url;
    try {
        url = new URL(source.url);
    } catch (error) {
        throw new Error('Pinned third-party source URL is invalid', { cause: error });
    }
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
        throw new Error(`Pinned third-party source must use credential-free HTTPS: ${source.url}`);
    }
    if (typeof source.archiveName !== 'string' || source.archiveName !== path.basename(source.archiveName) || !source.archiveName) {
        throw new Error('Pinned third-party archiveName must be a basename');
    }
    if (source.archiveType !== 'tar.gz' && source.archiveType !== 'zip') {
        throw new Error(`Unsupported pinned third-party archive type: ${source.archiveType}`);
    }
    if (!/^[a-f0-9]{64}$/u.test(source.sha256 ?? '')) throw new Error('Pinned third-party SHA-256 is invalid');
    if (!Number.isSafeInteger(source.size) || source.size <= 0) throw new Error('Pinned third-party size is invalid');
    if (!/^[a-f0-9]{40}$/u.test(source.commit ?? '')) throw new Error('Pinned third-party commit is invalid');
    if (typeof source.ref !== 'string' || !source.ref) throw new Error('Pinned third-party version/tag ref is required');
    return url;
}

function validateManifest(manifest) {
    if (manifest?.schemaVersion !== 'happier-third-party-assets/v1') {
        throw new Error('Unsupported third-party asset manifest schema');
    }
    if (!Array.isArray(manifest.assets) || manifest.assets.length !== 15) {
        throw new Error('Third-party asset manifest must contain exactly fifteen target assets');
    }
    if (JSON.stringify(manifest.platforms?.supported) !== JSON.stringify(CANONICAL_PLATFORMS)
        || !Array.isArray(manifest.platforms?.unsupported)
        || manifest.platforms.unsupported.length !== 1
        || manifest.platforms.unsupported[0]?.platformDir !== 'arm64-win32'
        || !manifest.platforms.unsupported[0]?.reason) {
        throw new Error('Third-party platform matrix must be the canonical five targets with Windows arm64 unsupported');
    }
    const identities = new Set();
    for (const asset of manifest.assets) {
        const identity = `${asset?.tool}:${asset?.platformDir}`;
        if (identities.has(identity)) throw new Error(`Duplicate third-party asset identity: ${identity}`);
        identities.add(identity);
        assertPinnedSource(asset.source);
        if (asset.memberPolicy !== 'exact' && asset.memberPolicy !== 'pinned-container') {
            throw new Error(`Unsupported member policy for ${identity}`);
        }
        if (!Array.isArray(asset.members) || asset.members.length === 0) {
            throw new Error(`Selected members are required for ${identity}`);
        }
    }
    const expectedIdentities = CANONICAL_PLATFORMS.flatMap((platformDir) => (
        CANONICAL_TOOLS.map((tool) => `${tool}:${platformDir}`)
    ));
    if (JSON.stringify([...identities].sort()) !== JSON.stringify(expectedIdentities.sort())) {
        throw new Error('Third-party assets must provide exactly three tools for each canonical platform');
    }
    if (!Array.isArray(manifest.licenses) || manifest.licenses.length !== 3
        || new Set(manifest.licenses.map((license) => license.id)).size !== 3) {
        throw new Error('Third-party manifest must provide exactly three unique licenses');
    }
    return manifest;
}

function loadThirdPartyManifest(manifestPath = MANIFEST_PATH) {
    const info = fs.lstatSync(manifestPath);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error('Third-party asset manifest must be a regular file');
    return validateManifest(JSON.parse(fs.readFileSync(manifestPath, 'utf8')));
}

function verifyPinnedArchive(archivePath, source, label = 'archive') {
    const info = fs.lstatSync(archivePath);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error(`Pinned ${label} must be a regular file`);
    if (info.size !== source.size) {
        throw new Error(`Pinned ${label} size mismatch for ${source.archiveName}: expected ${source.size}, got ${info.size}`);
    }
    const actual = sha256File(archivePath);
    if (actual !== source.sha256) {
        throw new Error(`Pinned ${label} SHA-256 mismatch for ${source.archiveName}: expected ${source.sha256}, got ${actual}`);
    }
    return archivePath;
}

async function downloadHttpsToFile({ url, destinationPath, expectedSize, redirects = 0 }) {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash) {
        throw new Error(`Third-party download must use credential-free HTTPS: ${url}`);
    }
    if (redirects > MAX_REDIRECTS) throw new Error(`Too many HTTPS redirects for ${url}`);
    await new Promise((resolve, reject) => {
        const request = https.get(parsed, {
            headers: {
                accept: 'application/octet-stream',
                'accept-encoding': 'identity',
                'user-agent': 'happier-third-party-fetch/1',
            },
        }, (response) => {
            const status = response.statusCode ?? 0;
            if ([301, 302, 303, 307, 308].includes(status)) {
                const location = response.headers.location;
                response.resume();
                if (!location) {
                    reject(new Error(`HTTPS redirect missing Location for ${url}`));
                    return;
                }
                const redirected = new URL(location, parsed);
                if (redirected.protocol !== 'https:') {
                    reject(new Error(`Third-party redirect must remain HTTPS: ${redirected.href}`));
                    return;
                }
                downloadHttpsToFile({
                    url: redirected.href,
                    destinationPath,
                    expectedSize,
                    redirects: redirects + 1,
                }).then(resolve, reject);
                return;
            }
            if (status !== 200) {
                response.resume();
                reject(new Error(`Third-party download failed with HTTP ${status}: ${url}`));
                return;
            }
            const encoding = response.headers['content-encoding'];
            if (encoding && encoding !== 'identity') {
                response.resume();
                reject(new Error(`Unexpected Content-Encoding for pinned download: ${encoding}`));
                return;
            }
            const contentLength = response.headers['content-length'];
            if (contentLength !== undefined && Number(contentLength) !== expectedSize) {
                response.resume();
                reject(new Error(`Pinned download Content-Length mismatch: expected ${expectedSize}, got ${contentLength}`));
                return;
            }
            let received = 0;
            const limiter = new Transform({
                transform(chunk, _encoding, callback) {
                    received += chunk.length;
                    if (received > expectedSize) callback(new Error(`Pinned download exceeded expected size ${expectedSize}`));
                    else callback(null, chunk);
                },
                flush(callback) {
                    if (received !== expectedSize) callback(new Error(`Pinned download size mismatch: expected ${expectedSize}, got ${received}`));
                    else callback();
                },
            });
            const output = fs.createWriteStream(destinationPath, { flags: 'wx', mode: 0o600 });
            pipeline(response, limiter, output).then(resolve, reject);
        });
        request.setTimeout(30_000, () => request.destroy(new Error(`Third-party download timed out: ${url}`)));
        request.on('error', reject);
    });
}

async function ensurePinnedSourceArchive({ source, cacheDir, download = downloadHttpsToFile }) {
    assertPinnedSource(source);
    if (typeof cacheDir !== 'string' || !cacheDir) throw new Error('Third-party cache directory is required');
    fs.mkdirSync(cacheDir, { recursive: true });
    const cacheInfo = fs.lstatSync(cacheDir);
    if (cacheInfo.isSymbolicLink() || !cacheInfo.isDirectory()) {
        throw new Error('Third-party cache must be a regular non-symlink directory');
    }
    const cacheName = `${source.sha256}-${source.archiveName}`;
    const cachePath = path.join(cacheDir, cacheName);
    if (fs.existsSync(cachePath)) return verifyPinnedArchive(cachePath, source, 'cache archive');

    const partialPath = path.join(cacheDir, `.${cacheName}.partial-${process.pid}-${crypto.randomBytes(6).toString('hex')}`);
    try {
        await download({ url: source.url, destinationPath: partialPath, expectedSize: source.size });
        verifyPinnedArchive(partialPath, source, 'download');
        try {
            fs.renameSync(partialPath, cachePath);
        } catch (error) {
            if (error?.code !== 'EEXIST') throw error;
            verifyPinnedArchive(cachePath, source, 'cache archive');
            fs.rmSync(partialPath, { force: true });
        }
        return verifyPinnedArchive(cachePath, source, 'cache archive');
    } catch (error) {
        fs.rmSync(partialPath, { force: true });
        throw error;
    }
}

module.exports = {
    MANIFEST_PATH,
    assertPinnedSource,
    downloadHttpsToFile,
    ensurePinnedSourceArchive,
    loadThirdPartyManifest,
    verifyPinnedArchive,
};
