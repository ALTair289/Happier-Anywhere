import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

async function loadWorkflow(name) {
  return readFile(join(repoRoot, '.github', 'workflows', name), 'utf8');
}

test('publish-docker supports workflow_call and is wired from release workflow', async () => {
  const publishDocker = await loadWorkflow('publish-docker.yml');
  assert.match(publishDocker, /\n\s*workflow_call:\n/);
  assert.match(
    publishDocker,
    /permissions:\n\s+contents:\s+read\n\s+packages:\s+write/m,
    'publish-docker should request packages:write for GHCR pushes',
  );
  assert.match(publishDocker, /\n\s*source_ref:\n/);
  assert.match(
    publishDocker,
    /\n\s*registries:\n/,
    'publish-docker should support configuring which registries receive image pushes',
  );
  assert.match(publishDocker, /\n\s*build_relay:\n/);
  assert.match(publishDocker, /\n\s*build_dev_box:\n/);
  assert.match(
    publishDocker,
    /node scripts\/pipeline\/run\.mjs docker-publish/,
    'publish-docker should delegate docker build+push to the pipeline docker-publish command',
  );
  assert.match(publishDocker, /--registries "\${{\s*inputs\.registries\s*}}"/);
  assert.match(
    publishDocker,
    /DOCKERHUB_USERNAME:\s*\${{\s*secrets\.DOCKERHUB_USERNAME\s*}}/,
    'publish-docker should pass Docker Hub username to the pipeline script',
  );
  assert.match(
    publishDocker,
    /DOCKERHUB_TOKEN:\s*\${{\s*secrets\.DOCKERHUB_TOKEN\s*}}/,
    'publish-docker should pass Docker Hub token to the pipeline script',
  );
  assert.match(
    publishDocker,
    /Login to GHCR/,
    'publish-docker should login to GHCR (ghcr.io)',
  );
  assert.match(
    publishDocker,
    /registry:\s*ghcr\.io/,
    'publish-docker should use docker/login-action registry ghcr.io',
  );
  assert.match(
    publishDocker,
    /peter-evans\/dockerhub-description@/,
    'publish-docker should publish Docker Hub README/description',
  );
  assert.match(
    publishDocker,
    /repository:\s*happierdev\/relay-server/,
    'publish-docker should publish relay-server Docker Hub README',
  );
  assert.match(
    publishDocker,
    /readme-filepath:\s*docker\/dockerhub\/relay-server\.md/,
    'publish-docker should use repo README file for relay-server',
  );
  assert.match(
    publishDocker,
    /repository:\s*happierdev\/dev-box/,
    'publish-docker should publish dev-box Docker Hub README',
  );
  assert.match(
    publishDocker,
    /readme-filepath:\s*docker\/dockerhub\/dev-box\.md/,
    'publish-docker should use repo README file for dev-box',
  );

  const release = await loadWorkflow('release.yml');
  assert.match(release, /publish_docker:/);
  assert.match(release, /publish_cli_binaries:/);
  assert.match(
    release,
    /publish_server_runtime:[\s\S]*?\(needs\.plan\.outputs\.publish_server == 'true' \|\| inputs\.force_deploy == true \|\| needs\.plan\.outputs\.changed_server == 'true' \|\| needs\.plan\.outputs\.changed_shared == 'true'\)/,
    'server runtime artifacts should publish when relay Docker needs fresh server bits',
  );
  assert.match(
    release,
    /publish_ui_web:[\s\S]*?\(contains\(format\(',\{0\},', inputs\.deploy_targets\), ',ui,'\) \|\| inputs\.force_deploy == true \|\| needs\.plan\.outputs\.changed_ui == 'true' \|\| needs\.plan\.outputs\.changed_shared == 'true'\)/,
    'UI web artifacts should publish when relay Docker needs a fresh embedded UI bundle',
  );
  assert.match(release, /uses:\s+\.\/\.github\/workflows\/publish-docker\.yml/);
  assert.match(release, /publish_docker:[\s\S]*?needs:\s*\[plan, bump_versions_dev, promote_preview, promote_main, publish_cli_binaries, publish_server_runtime, publish_ui_web\]/);
  assert.match(release, /publish_docker:[\s\S]*?needs\.publish_cli_binaries\.result == 'success' \|\| needs\.publish_cli_binaries\.result == 'skipped'/);
  assert.match(release, /publish_docker:[\s\S]*?needs\.publish_server_runtime\.result == 'success' \|\| needs\.publish_server_runtime\.result == 'skipped'/);
  assert.match(release, /publish_docker:[\s\S]*?needs\.publish_ui_web\.result == 'success' \|\| needs\.publish_ui_web\.result == 'skipped'/);
  assert.match(release, /build_relay:/);
  assert.match(release, /build_dev_box:/);
  assert.doesNotMatch(release, /build_dev_box:\s*\$\{\{[^\n]*changed_stack/);
});

test('nightly dev docker waits for the release artifacts it consumes', async () => {
  const nightly = await loadWorkflow('nightly-dev.yml');
  assert.match(
    nightly,
    /docker:[\s\S]*?needs:\s*\[cli, server_runtime, ui_web\][\s\S]*?uses:\s+\.\/\.github\/workflows\/publish-docker\.yml/,
  );
});

test('Docker publishing installs and builds its release-runtime dependency', async () => {
  const publishDocker = await loadWorkflow('publish-docker.yml');
  assert.match(
    publishDocker,
    /Enable Corepack \(Yarn\)[\s\S]*?corepack prepare yarn@1\.22\.22 --activate/,
    'publish-docker should pin the repository Yarn runtime before installing dependencies',
  );
  assert.match(
    publishDocker,
    /Install dependencies[\s\S]*?HAPPIER_INSTALL_SCOPE:\s*["']release-runtime["'][\s\S]*?uses:\s*\.\/\.github\/actions\/install-yarn-dependencies/,
    'publish-docker should install and postinstall-build the release-runtime workspace it imports',
  );
  assert.match(
    publishDocker,
    /Install dependencies[\s\S]*?Build & push images \(pipeline\)/,
    'the release-runtime dependency must be available before Docker artifact resolution starts',
  );
});
