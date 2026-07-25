import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildMutagenProjectArgs,
  renderMutagenProject,
} from './mutagen_project.mjs';

const targets = [
  {
    name: 'linux',
    platform: 'posix',
    ssh: 'happier-stack-linux',
    repoDir: '/home/dev/happier',
    cliHomeDir: '/home/dev/.happier-stack/dev-targets/linux',
    remoteServerPort: null,
  },
  {
    name: 'windows',
    platform: 'windows',
    ssh: 'happier-stack-windows',
    repoDir: 'C:/Users/test_qa/happier',
    cliHomeDir: 'C:/Users/test_qa/.happier-stack/dev-targets/windows',
    remoteServerPort: null,
  },
];

test('renderMutagenProject creates one-way source replicas while retaining target-local build state', () => {
  const rendered = renderMutagenProject({
    sourceDir: '/Users/dev/happier',
    targets,
  });

  assert.match(rendered, /mode: "one-way-replica"/);
  assert.match(rendered, /flushOnCreate: true/);
  assert.ok(rendered.includes('alpha: "/Users/dev/happier"'));
  assert.ok(rendered.includes('beta: "happier-stack-linux:/home/dev/happier"'));
  assert.ok(rendered.includes('beta: "happier-stack-windows:C:/Users/test_qa/happier"'));
  assert.match(rendered, /vcs: true/);
  for (const ignored of [
    'node_modules',
    'dist',
    '.project',
    '.happier',
    'coverage',
    '/output',
    '.reviews',
    '.agent-contexts',
    '.dev',
    '.clawpatch',
    '.playwright-mcp',
    '.antigravitycli',
    'evidence',
    'graphify-out',
    '/workspace',
    '.expo',
    'target',
    'Pods',
    '.next',
    '.runner-snapshots',
    'package-dist',
    '.restore.*',
    '.dist.hstack-*',
    'apps/ui/ios/build',
    'apps/ui/android/app/build',
    'apps/ui/android/build',
    'apps/ui/android/.gradle',
    'apps/cli/tools/unpacked',
    'apps/cli/*:*',
    'subagents/dev-plugin-projection-runtime-closure',
    '*.trace',
  ]) {
    assert.ok(rendered.includes(`- "${ignored}"`));
  }
  assert.doesNotMatch(rendered, /beforeCreate|afterCreate|beforeTerminate|afterTerminate/);
});

test('buildMutagenProjectArgs isolates global configuration and addresses the generated project explicitly', () => {
  assert.deepEqual(buildMutagenProjectArgs('start', '/tmp/stack/mutagen.yml'), [
    'project',
    'start',
    '--no-global-configuration',
    '--project-file',
    '/tmp/stack/mutagen.yml',
  ]);
  assert.deepEqual(buildMutagenProjectArgs('list', '/tmp/stack/mutagen.yml'), [
    'project',
    'list',
    '--project-file',
    '/tmp/stack/mutagen.yml',
  ]);
});
