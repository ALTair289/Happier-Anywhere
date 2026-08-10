import test from 'node:test';
import assert from 'node:assert/strict';

import { parseGitHubProjectCliArgs } from '../pipeline/deployment-kit/assemble-github-project.mjs';

test('GitHub project CLI requires explicit spec, output, repository, and release public key values', () => {
  assert.deepEqual(
    parseGitHubProjectCliArgs([
      '--spec',
      'kit-spec.json',
      '--out=dist/github-project',
      '--repository',
      'soul667/Happier',
      '--release-public-key',
      'keys/happier-anywhere.pub',
      '--repository-availability',
      'verified',
    ]),
    {
      help: false,
      specPath: 'kit-spec.json',
      kitRoot: null,
      outDir: 'dist/github-project',
      repository: 'soul667/Happier',
      repositoryAvailability: 'verified',
      releasePublicKeyPath: 'keys/happier-anywhere.pub',
    },
  );
  assert.deepEqual(parseGitHubProjectCliArgs(['--help']), {
    help: true,
    specPath: null,
    kitRoot: null,
    outDir: null,
    repository: null,
    repositoryAvailability: null,
    releasePublicKeyPath: null,
  });

  assert.deepEqual(
    parseGitHubProjectCliArgs([
      '--kit',
      'dist/deployment-kits/verified-kit',
      '--out',
      'dist/github-project',
      '--repository',
      'soul667/Happier',
      '--release-public-key',
      'keys/happier-anywhere.pub',
    ]),
    {
      help: false,
      specPath: null,
      kitRoot: 'dist/deployment-kits/verified-kit',
      outDir: 'dist/github-project',
      repository: 'soul667/Happier',
      repositoryAvailability: null,
      releasePublicKeyPath: 'keys/happier-anywhere.pub',
    },
  );
});

test('GitHub project CLI rejects missing, duplicate, or ambient publishing arguments', () => {
  assert.throws(
    () => parseGitHubProjectCliArgs([
      '--spec', 'kit.json', '--out', 'dist/project', '--repository', 'one/repo',
    ]),
    /--release-public-key.*required/i,
  );
  assert.throws(
    () => parseGitHubProjectCliArgs(['--spec', 'kit.json', '--out', 'dist/project']),
    /--repository/,
  );
  assert.throws(
    () => parseGitHubProjectCliArgs([
      '--spec', 'kit.json', '--out', 'dist/project', '--repository', 'one/repo', '--repository', 'two/repo',
    ]),
    /duplicate.*--repository/i,
  );
  assert.throws(
    () => parseGitHubProjectCliArgs([
      '--spec', 'kit.json', '--out', 'dist/project', '--repository', 'one/repo',
      '--release-public-key', 'one.pub', '--release-public-key', 'two.pub',
    ]),
    /duplicate.*--release-public-key/i,
  );
  assert.throws(
    () => parseGitHubProjectCliArgs([
      '--spec', 'kit.json', '--out', 'dist/project', '--repository', 'one/repo',
      '--repository-availability', 'assumed',
      '--release-public-key', 'project.pub',
    ]),
    /repository-availability.*not-verified.*verified/i,
  );
  assert.throws(
    () => parseGitHubProjectCliArgs([
      '--spec', 'kit.json', '--out', 'dist/project', '--repository', 'one/repo', '--publish', 'true',
    ]),
    /unknown argument/i,
  );
  assert.throws(
    () => parseGitHubProjectCliArgs([
      '--spec', 'kit.json', '--kit', 'kit-dir', '--out', 'dist/project', '--repository', 'one/repo',
      '--release-public-key', 'project.pub',
    ]),
    /exactly one.*--spec.*--kit/i,
  );
});
