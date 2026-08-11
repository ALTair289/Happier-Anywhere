import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import test from 'node:test';

const repositoryRoot = resolve(import.meta.dirname, '../..');

function readRepositoryFile(path) {
    return readFileSync(join(repositoryRoot, path), 'utf8');
}

function collectFiles(directory) {
    const files = [];
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
            files.push(...collectFiles(path));
        } else if (entry.isFile()) {
            files.push(path);
        }
    }
    return files;
}

function workflowFiles() {
    return collectFiles(join(repositoryRoot, '.github/workflows'))
        .filter((path) => ['.yml', '.yaml'].includes(extname(path)))
        .sort();
}

function actionDefinitionFiles() {
    const root = join(repositoryRoot, '.github/actions');
    if (!existsSync(root)) {
        return [];
    }
    return collectFiles(root)
        .filter((path) => ['action.yml', 'action.yaml'].includes(path.split(/[\\/]/).at(-1)))
        .sort();
}

function externalActionFindings(path) {
    const findings = [];
    const lines = readFileSync(path, 'utf8').split(/\r?\n/);
    for (const [index, line] of lines.entries()) {
        const match = line.match(/^\s*(?:-\s*)?uses:\s*["']?([^\s"'#]+)["']?\s*(?:#.*)?$/);
        if (!match) {
            continue;
        }
        const reference = match[1];
        if (reference.startsWith('./')) {
            continue;
        }
        if (reference.startsWith('docker://')) {
            if (!/@sha256:[0-9a-f]{64}$/i.test(reference)) {
                findings.push(`${relative(repositoryRoot, path)}:${index + 1}: ${reference}`);
            }
            continue;
        }
        const separator = reference.lastIndexOf('@');
        const revision = separator === -1 ? '' : reference.slice(separator + 1);
        if (!/^[0-9a-f]{40}$/i.test(revision)) {
            findings.push(`${relative(repositoryRoot, path)}:${index + 1}: ${reference}`);
        }
    }
    return findings;
}

function topLevelPermissionsFinding(path) {
    const lines = readFileSync(path, 'utf8').split(/\r?\n/);
    const index = lines.findIndex((line) => /^permissions:\s*/.test(line));
    const name = relative(repositoryRoot, path);
    if (index === -1) {
        return `${name}: missing top-level permissions`;
    }

    const declaration = lines[index].replace(/^permissions:\s*/, '').trim();
    if (declaration === '{}' || declaration === 'read-all') {
        return null;
    }
    if (declaration !== '') {
        return `${name}:${index + 1}: top-level permissions must be read-only or empty`;
    }

    for (let offset = index + 1; offset < lines.length; offset += 1) {
        const line = lines[offset];
        if (line.trim() === '' || /^\s*#/.test(line)) {
            continue;
        }
        if (!/^\s/.test(line)) {
            break;
        }
        const permission = line.match(/^\s+[-\w]+:\s*([^#\s]+)\s*(?:#.*)?$/);
        if (!permission || !['read', 'none'].includes(permission[1])) {
            return `${name}:${offset + 1}: top-level permission is not read-only`;
        }
    }
    return null;
}

test('source provenance binds the full fork to the approved upstream base', () => {
    const manifest = JSON.parse(readRepositoryFile('SOURCE_PROVENANCE.json'));
    assert.equal(manifest.schemaVersion, 1);
    assert.equal(manifest.sourceRepository, 'https://github.com/ALTair289/Happier-Anywhere');
    assert.equal(manifest.upstream.repository, 'https://github.com/happier-dev/happier');
    assert.equal(manifest.upstream.defaultBranch, 'dev');
    assert.equal(manifest.upstream.baseCommit, '4b76fc8c60fffeb1c08a26ef05d0ffe22684168e');
    assert.equal(manifest.history, 'full');
    assert.deepEqual(manifest.license, { file: 'LICENCE', spdx: 'MIT' });
    assert.equal(manifest.distributionRepository, 'https://github.com/ALTair289/Happier-Anywhere-Deploy');

    execFileSync('git', ['cat-file', '-e', `${manifest.upstream.baseCommit}^{commit}`], {
        cwd: repositoryRoot,
        stdio: 'pipe',
    });
    execFileSync('git', ['merge-base', '--is-ancestor', manifest.upstream.baseCommit, 'HEAD'], {
        cwd: repositoryRoot,
        stdio: 'pipe',
    });
});

test('governance documents preserve upstream attribution and fork boundaries', () => {
    const requiredFiles = [
        'LICENCE',
        'NOTICE',
        'SECURITY.md',
        'CONTRIBUTING.md',
        'UPSTREAM.md',
        'SUPPLY_CHAIN.md',
    ];
    for (const path of requiredFiles) {
        assert.ok(existsSync(join(repositoryRoot, path)), `${path} must exist`);
    }

    const notice = readRepositoryFile('NOTICE');
    assert.match(notice, /https:\/\/github\.com\/happier-dev\/happier/);
    assert.match(notice, /MIT License/);
    assert.match(notice, /downstream modifications/i);

    const contributing = readRepositoryFile('CONTRIBUTING.md');
    assert.match(contributing, /Happier Anywhere downstream/i);
    assert.match(contributing, /UPSTREAM\.md/);

    const upstream = readRepositoryFile('UPSTREAM.md');
    assert.match(upstream, /upstream\/dev/);
    assert.match(upstream, /force-push/i);
    assert.match(upstream, /push --mirror/i);
});

test('CODEOWNERS protects policy, release, key, lock, and deployment-kit surfaces', () => {
    const codeowners = new Set(
        readRepositoryFile('.github/CODEOWNERS')
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter((line) => line !== '' && !line.startsWith('#')),
    );
    const requiredEntries = [
        '/.github/CODEOWNERS @ALTair289',
        '/.github/dependabot.yml @ALTair289',
        '/.github/workflows/** @ALTair289',
        '/.github/actions/** @ALTair289',
        '/LICENCE @ALTair289',
        '/NOTICE @ALTair289',
        '/SECURITY.md @ALTair289',
        '/CONTRIBUTING.md @ALTair289',
        '/UPSTREAM.md @ALTair289',
        '/SOURCE_PROVENANCE.json @ALTair289',
        '/SUPPLY_CHAIN.md @ALTair289',
        '/SECURITY_SCAN_POLICY.json @ALTair289',
        '/package.json @ALTair289',
        '/yarn.lock @ALTair289',
        '/scripts/release/** @ALTair289',
        '/scripts/pipeline/release/** @ALTair289',
        '/scripts/pipeline/deployment-kit/** @ALTair289',
        '/scripts/security/** @ALTair289',
        '/scripts/policy/** @ALTair289',
        '**/*.pub @ALTair289',
        '**/*.pem @ALTair289',
        '**/*.key @ALTair289',
    ];
    for (const entry of requiredEntries) {
        assert.ok(codeowners.has(entry), `missing CODEOWNERS entry: ${entry}`);
    }
});

test('Dependabot covers GitHub Actions and the Yarn workspace without direct pushes', () => {
    const dependabot = readRepositoryFile('.github/dependabot.yml');
    assert.match(dependabot, /package-ecosystem:\s*["']github-actions["']/);
    assert.match(dependabot, /package-ecosystem:\s*["']npm["']/);
    assert.match(dependabot, /target-branch:\s*["']dev["']/);
    assert.doesNotMatch(dependabot, /open-pull-requests-limit:\s*0/);
});

test('external Actions are immutable and workflow defaults never grant write', () => {
    const actionFindings = [...workflowFiles(), ...actionDefinitionFiles()]
        .flatMap((path) => externalActionFindings(path));
    assert.deepEqual(actionFindings, [], `unpinned external Actions:\n${actionFindings.join('\n')}`);

    const permissionFindings = workflowFiles()
        .map((path) => topLevelPermissionsFinding(path))
        .filter(Boolean);
    assert.deepEqual(permissionFindings, [], `unsafe workflow defaults:\n${permissionFindings.join('\n')}`);
});
