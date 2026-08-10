import assert from 'node:assert/strict';
import test from 'node:test';

import {
    collectFilenameFindings,
    scanBufferForSecrets,
} from './repository-security-scan.mjs';

test('secret findings expose only rule, path, and a redacted fingerprint', () => {
    const syntheticSecret = `github_pat_${'a'.repeat(82)}`;
    const findings = scanBufferForSecrets(Buffer.from(`TOKEN=${syntheticSecret}\n`), 'fixture.env');

    assert.equal(findings.length, 1);
    assert.equal(findings[0].ruleId, 'GITHUB_FINE_GRAINED_TOKEN');
    assert.equal(findings[0].path, 'fixture.env');
    assert.match(findings[0].fingerprint, /^[0-9a-f]{16}$/);
    assert.doesNotMatch(JSON.stringify(findings), new RegExp(syntheticSecret));
    assert.deepEqual(Object.keys(findings[0]).sort(), ['fingerprint', 'path', 'ruleId']);
});

test('distinct secret-like values in one file produce distinct findings', () => {
    const first = `github_pat_${'a'.repeat(82)}`;
    const second = `github_pat_${'b'.repeat(82)}`;
    const findings = scanBufferForSecrets(Buffer.from(`${first}\n${second}\n`), 'fixture.env');

    assert.equal(findings.length, 2);
    assert.equal(new Set(findings.map((finding) => finding.fingerprint)).size, 2);
    assert.doesNotMatch(JSON.stringify(findings), new RegExp(`${first}|${second}`));
});

test('filename policy requires an explicit exact-path classification', () => {
    const paths = ['safe/source.ts', 'apps/cli/.env.dev', 'private/id_rsa'];
    const allowlist = new Map([
        ['apps/cli/.env.dev', 'tracked development template'],
    ]);

    assert.deepEqual(collectFilenameFindings(paths, allowlist), [
        { path: 'private/id_rsa', ruleId: 'PRIVATE_KEY_FILENAME' },
    ]);
});
