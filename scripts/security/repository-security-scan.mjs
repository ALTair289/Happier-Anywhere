import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, readlinkSync } from 'node:fs';
import { basename, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const repositoryRoot = resolve(import.meta.dirname, '../..');

const filenameRules = [
    {
        ruleId: 'PRIVATE_KEY_FILENAME',
        matches: (path) => /(^|\/)(?:id_(?:rsa|dsa|ecdsa|ed25519)|[^/]*private[^/]*\.(?:key|pem))$/i.test(path),
    },
    {
        ruleId: 'ENV_FILENAME',
        matches: (path) => /^\.env(?:\.|$)/i.test(basename(path)),
    },
    {
        ruleId: 'BACKUP_FILENAME',
        matches: (path) => /\.(?:bak|backup|orig)$/i.test(path),
    },
    {
        ruleId: 'SIGNING_CONTAINER_FILENAME',
        matches: (path) => /\.(?:p12|pfx|jks|keystore)$/i.test(path),
    },
];

const secretRules = [
    {
        ruleId: 'PRIVATE_KEY_BLOCK',
        pattern: /-----BEGIN ((?:RSA |DSA |EC |OPENSSH |PGP )?PRIVATE KEY)-----[\s\S]{1,65536}?-----END \1-----/g,
        gitPattern: '-----BEGIN (RSA |DSA |EC |OPENSSH |PGP )?PRIVATE KEY-----',
    },
    {
        ruleId: 'GITHUB_CLASSIC_TOKEN',
        pattern: /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/g,
        gitPattern: 'gh[pousr]_[A-Za-z0-9]{36,}',
    },
    {
        ruleId: 'GITHUB_FINE_GRAINED_TOKEN',
        pattern: /\bgithub_pat_[A-Za-z0-9_]{82,255}\b/g,
        gitPattern: 'github_pat_[A-Za-z0-9_]{82,}',
    },
    {
        ruleId: 'AWS_ACCESS_KEY_ID',
        pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
        gitPattern: '(AKIA|ASIA)[A-Z0-9]{16}',
    },
    {
        ruleId: 'SLACK_TOKEN',
        pattern: /\bxox[baprs]-[A-Za-z0-9-]{20,255}\b/g,
        gitPattern: 'xox[baprs]-[A-Za-z0-9-]{20,}',
    },
    {
        ruleId: 'GOOGLE_API_KEY',
        pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g,
        gitPattern: 'AIza[0-9A-Za-z_-]{35}',
    },
    {
        ruleId: 'MINISIGN_SECRET_KEY',
        pattern: /untrusted comment: minisign secret key[^\r\n]*\r?\n[A-Za-z0-9+/=]{32,}/gi,
        gitPattern: 'untrusted comment: minisign secret key',
    },
];

function fingerprint(ruleId, value) {
    return createHash('sha256')
        .update(ruleId)
        .update('\0')
        .update(value)
        .digest('hex')
        .slice(0, 16);
}

function normalizePath(path) {
    return path.replaceAll('\\', '/').replace(/^\.\//, '');
}

export function collectFilenameFindings(paths, allowlist = new Map()) {
    const findings = [];
    for (const rawPath of paths) {
        const path = normalizePath(rawPath);
        for (const rule of filenameRules) {
            if (rule.matches(path) && !allowlist.has(path)) {
                findings.push({ path, ruleId: rule.ruleId });
                break;
            }
        }
    }
    return findings;
}

export function scanBufferForSecrets(buffer, rawPath) {
    const path = normalizePath(rawPath);
    const text = buffer.toString('latin1');
    const findings = [];
    for (const rule of secretRules) {
        rule.pattern.lastIndex = 0;
        const seenFingerprints = new Set();
        for (const match of text.matchAll(rule.pattern)) {
            const matchFingerprint = fingerprint(rule.ruleId, match[0]);
            if (seenFingerprints.has(matchFingerprint)) {
                continue;
            }
            seenFingerprints.add(matchFingerprint);
            findings.push({
                path,
                ruleId: rule.ruleId,
                fingerprint: matchFingerprint,
            });
        }
    }
    return findings;
}

function gitPathList(args) {
    const output = execFileSync('git', args, {
        cwd: repositoryRoot,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
    });
    return output.split('\0').filter(Boolean).map(normalizePath);
}

function repositoryPaths() {
    return gitPathList(['ls-files', '--cached', '--others', '--exclude-standard', '-z']);
}

function untrackedPaths() {
    return gitPathList(['ls-files', '--others', '--exclude-standard', '-z']);
}

function trackedPathsMatching(pattern) {
    try {
        return gitPathList(['grep', '-l', '-z', '-E', '-e', pattern, '--']);
    } catch (error) {
        if (error && typeof error === 'object' && error.status === 1) {
            return [];
        }
        throw error;
    }
}

function readRepositoryPath(path) {
    const absolutePath = resolve(repositoryRoot, path);
    if (!absolutePath.startsWith(`${repositoryRoot}${sep}`)) {
        throw new Error(`Repository path escapes the root: ${path}`);
    }
    if (lstatSync(absolutePath).isSymbolicLink()) {
        return Buffer.from(readlinkSync(absolutePath), 'utf8');
    }
    return readFileSync(absolutePath);
}

function contentCandidatePaths() {
    const candidates = new Set(untrackedPaths());
    for (const rule of secretRules) {
        for (const path of trackedPathsMatching(rule.gitPattern)) {
            candidates.add(path);
        }
    }
    return [...candidates].sort();
}

function readPolicy() {
    const policy = JSON.parse(readFileSync(resolve(repositoryRoot, 'SECURITY_SCAN_POLICY.json'), 'utf8'));
    if (policy.schemaVersion !== 1) {
        throw new Error(`Unsupported SECURITY_SCAN_POLICY.json schemaVersion: ${policy.schemaVersion}`);
    }
    return policy;
}

function validateFilenameAllowlist(paths, entries) {
    const tracked = new Set(paths);
    const classified = new Map();
    for (const entry of entries) {
        const path = normalizePath(entry.path);
        if (!tracked.has(path)) {
            throw new Error(`Filename allowlist path is not tracked: ${path}`);
        }
        const rule = filenameRules.find((candidate) => candidate.matches(path));
        if (!rule || rule.ruleId !== entry.ruleId) {
            throw new Error(`Filename allowlist rule does not match path: ${path}`);
        }
        if (typeof entry.reason !== 'string' || entry.reason.trim() === '') {
            throw new Error(`Filename allowlist reason is missing: ${path}`);
        }
        if (classified.has(path)) {
            throw new Error(`Duplicate filename allowlist path: ${path}`);
        }
        classified.set(path, entry.reason);
    }
    return classified;
}

function contentAllowlistKey(finding) {
    return `${finding.path}\0${finding.ruleId}\0${finding.fingerprint}`;
}

function validateContentAllowlist(paths, entries) {
    const tracked = new Set(paths);
    const allowlist = new Set();
    for (const entry of entries) {
        const path = normalizePath(entry.path);
        if (!tracked.has(path)) {
            throw new Error(`Content allowlist path is not tracked: ${path}`);
        }
        if (!secretRules.some((rule) => rule.ruleId === entry.ruleId)) {
            throw new Error(`Unknown content allowlist rule: ${entry.ruleId}`);
        }
        if (!/^[0-9a-f]{16}$/.test(entry.fingerprint ?? '')) {
            throw new Error(`Invalid content allowlist fingerprint: ${path}`);
        }
        if (typeof entry.reason !== 'string' || entry.reason.trim() === '') {
            throw new Error(`Content allowlist reason is missing: ${path}`);
        }
        allowlist.add(contentAllowlistKey({ ...entry, path }));
    }
    return allowlist;
}

function printFinding(finding) {
    process.stdout.write(`${JSON.stringify(finding)}\n`);
}

export function main(args = process.argv.slice(2)) {
    const filenamesOnly = args.includes('--filenames-only');
    const unknown = args.filter((arg) => arg !== '--filenames-only');
    if (unknown.length > 0) {
        throw new Error(`Unknown argument(s): ${unknown.join(', ')}`);
    }

    const paths = repositoryPaths();
    const policy = readPolicy();
    const filenameAllowlist = validateFilenameAllowlist(paths, policy.filenameAllowlist ?? []);
    const contentAllowlist = validateContentAllowlist(paths, policy.contentAllowlist ?? []);
    const usedContentAllowlist = new Set();
    const findings = collectFilenameFindings(paths, filenameAllowlist);

    if (!filenamesOnly) {
        for (const path of contentCandidatePaths()) {
            const buffer = readRepositoryPath(path);
            for (const finding of scanBufferForSecrets(buffer, path)) {
                const key = contentAllowlistKey(finding);
                if (contentAllowlist.has(key)) {
                    usedContentAllowlist.add(key);
                } else {
                    findings.push(finding);
                }
            }
        }
        for (const key of contentAllowlist) {
            if (!usedContentAllowlist.has(key)) {
                const [path, ruleId, fingerprint] = key.split('\0');
                findings.push({
                    path,
                    ruleId: `STALE_ALLOWLIST_${ruleId}`,
                    fingerprint,
                });
            }
        }
    }

    findings.sort((left, right) => (
        left.path.localeCompare(right.path)
        || left.ruleId.localeCompare(right.ruleId)
    ));
    for (const finding of findings) {
        printFinding(finding);
    }

    if (findings.length > 0) {
        process.stderr.write(`repository security scan failed: ${findings.length} redacted finding(s).\n`);
        process.exitCode = 1;
        return;
    }
    process.stdout.write(
        filenamesOnly
            ? `repository filename scan passed: ${paths.length} repository paths classified.\n`
            : `repository redacted secret scan passed: ${paths.length} repository paths scanned.\n`,
    );
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
    main();
}
