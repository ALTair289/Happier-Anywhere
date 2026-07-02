import test from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveDockerReleaseArtifactInputs,
  dockerReleaseArtifactInputsToBuildArgs,
} from './resolve-release-artifact-build-args.mjs';

function makeRelease(product, version, targets) {
  return {
    assets: [
      { name: `checksums-${product}-v${version}.txt`, browser_download_url: 'https://example.test/checksums.txt' },
      { name: `checksums-${product}-v${version}.txt.minisig`, browser_download_url: 'https://example.test/checksums.txt.minisig' },
      ...targets.map(({ os, arch }) => ({
        name: `${product}-v${version}-${os}-${arch}.tar.gz`,
        browser_download_url: `https://example.test/${product}-${os}-${arch}.tar.gz`,
      })),
    ],
  };
}

test('resolves Docker release artifact inputs from GitHub rolling releases', async () => {
  const calls = [];
  const releases = new Map([
    ['server-preview', makeRelease('happier-server', '0.2.10-preview.41', [{ os: 'linux', arch: 'x64' }, { os: 'linux', arch: 'arm64' }])],
    ['ui-web-preview', makeRelease('happier-ui-web', '0.2.10-preview.99', [{ os: 'web', arch: 'any' }])],
    ['cli-preview', makeRelease('happier', '0.2.10-preview.77', [{ os: 'linux', arch: 'x64' }, { os: 'linux', arch: 'arm64' }])],
  ]);

  const inputs = await resolveDockerReleaseArtifactInputs({
    channel: 'preview',
    repoRoot: process.cwd(),
    dryRun: false,
    env: {},
    fetchGitHubReleaseByTag: async ({ tag }) => {
      calls.push(tag);
      return releases.get(tag);
    },
  });

  assert.deepEqual(calls, ['server-preview', 'ui-web-preview', 'cli-preview']);
  assert.deepEqual(inputs.relay.server, { releaseTag: 'server-v0.2.10-preview.41', version: '0.2.10-preview.41' });
  assert.deepEqual(inputs.relay.uiWeb, { releaseTag: 'ui-web-v0.2.10-preview.99', version: '0.2.10-preview.99' });
  assert.deepEqual(inputs.devBox.cli, { releaseTag: 'cli-v0.2.10-preview.77', version: '0.2.10-preview.77' });

  const args = dockerReleaseArtifactInputsToBuildArgs(inputs, 'relay');
  assert.deepEqual(args, [
    '--build-arg',
    'HAPPIER_RELEASE_BASE_URL=https://github.com/happier-dev/happier/releases/download',
    '--build-arg',
    'HAPPIER_RELAY_SERVER_RELEASE_TAG=server-v0.2.10-preview.41',
    '--build-arg',
    'HAPPIER_RELAY_SERVER_VERSION=0.2.10-preview.41',
    '--build-arg',
    'HAPPIER_RELAY_UI_WEB_RELEASE_TAG=ui-web-v0.2.10-preview.99',
    '--build-arg',
    'HAPPIER_RELAY_UI_WEB_VERSION=0.2.10-preview.99',
  ]);
});

test('uses explicit Docker artifact version overrides without GitHub lookups', async () => {
  let fetched = false;
  const inputs = await resolveDockerReleaseArtifactInputs({
    channel: 'dev',
    repoRoot: process.cwd(),
    dryRun: false,
    env: {
      HAPPIER_DOCKER_SERVER_VERSION: '1.0.0-dev.1',
      HAPPIER_DOCKER_UI_WEB_VERSION: '1.0.0-dev.2',
      HAPPIER_DOCKER_CLI_VERSION: '1.0.0-dev.3',
      HAPPIER_DOCKER_RELEASE_BASE_URL: 'https://releases.example.test/download',
    },
    fetchGitHubReleaseByTag: async () => {
      fetched = true;
      throw new Error('unexpected fetch');
    },
  });

  assert.equal(fetched, false);
  assert.equal(inputs.releaseBaseUrl, 'https://releases.example.test/download');
  assert.deepEqual(inputs.relay.server, { releaseTag: 'server-v1.0.0-dev.1', version: '1.0.0-dev.1' });
  assert.deepEqual(inputs.relay.uiWeb, { releaseTag: 'ui-web-v1.0.0-dev.2', version: '1.0.0-dev.2' });
  assert.deepEqual(inputs.devBox.cli, { releaseTag: 'cli-v1.0.0-dev.3', version: '1.0.0-dev.3' });
});
