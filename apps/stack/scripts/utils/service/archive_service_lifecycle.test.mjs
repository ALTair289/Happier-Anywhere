import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { createTempFixture } from '../../testkit/core/temp_fixture.mjs';
import {
  disableInstalledStackServicesBeforeArchive,
  resolveStackServiceDefinitionCandidates,
} from './archive_service_lifecycle.mjs';

test('archive service lifecycle resolves platform service definitions for the stack label', () => {
  assert.deepEqual(
    resolveStackServiceDefinitionCandidates({ platform: 'darwin', homeDir: '/home/alice', label: 'dev.happier.stack.exp' }),
    [{ mode: 'user', path: '/home/alice/Library/LaunchAgents/dev.happier.stack.exp.plist' }],
  );
  assert.deepEqual(
    resolveStackServiceDefinitionCandidates({ platform: 'linux', homeDir: '/home/alice', label: 'dev.happier.stack.exp' }),
    [
      { mode: 'user', path: '/home/alice/.config/systemd/user/dev.happier.stack.exp.service' },
      { mode: 'system', path: '/etc/systemd/system/dev.happier.stack.exp.service' },
    ],
  );
  assert.deepEqual(
    resolveStackServiceDefinitionCandidates({ platform: 'win32', homeDir: 'C:\\Users\\alice', label: 'dev.happier.stack.exp' }),
    [
      { mode: 'user', path: 'C:\\Users\\alice\\.happier\\services\\dev.happier.stack.exp.ps1' },
      { mode: 'system', path: 'C:\\ProgramData\\happier\\services\\dev.happier.stack.exp.ps1' },
    ],
  );
});

test('archive service lifecycle uninstalls evidenced user service without mutating an absent privileged mode', async (t) => {
  const fixture = await createTempFixture(t, { prefix: 'stack-archive-service-lifecycle-' });
  const userDefinition = join(fixture.root, '.config', 'systemd', 'user', 'dev.happier.stack.exp.service');
  await mkdir(join(fixture.root, '.config', 'systemd', 'user'), { recursive: true });
  await writeFile(userDefinition, 'service', 'utf8');
  const calls = [];

  const result = await disableInstalledStackServicesBeforeArchive({
    rootDir: '/repo/apps/stack',
    stackName: 'exp',
    platform: 'linux',
    homeDir: fixture.root,
    definitionCandidates: [
      { mode: 'user', path: userDefinition },
      { mode: 'system', path: join(fixture.root, 'missing-system.service') },
    ],
    inspectRegistration: async ({ mode }) => mode === 'system' ? 'absent' : 'registered',
    uninstallStackService: async (params) => calls.push(params),
  });

  assert.deepEqual(calls, [{ rootDir: '/repo/apps/stack', stackName: 'exp', svcCmd: 'uninstall', args: ['--mode=user'] }]);
  assert.deepEqual(result, { removedModes: ['user'] });
});

test('archive service lifecycle removes a registered orphan even when its definition is already missing', async () => {
  const calls = [];
  const result = await disableInstalledStackServicesBeforeArchive({
    rootDir: '/repo/apps/stack',
    stackName: 'exp',
    platform: 'darwin',
    homeDir: '/home/alice',
    definitionCandidates: [{ mode: 'user', path: '/missing/dev.happier.stack.exp.plist' }],
    definitionExists: () => false,
    inspectRegistration: async () => 'registered',
    uninstallStackService: async (params) => calls.push(params),
  });

  assert.deepEqual(calls, [{ rootDir: '/repo/apps/stack', stackName: 'exp', svcCmd: 'uninstall', args: ['--mode=user'] }]);
  assert.deepEqual(result, { removedModes: ['user'] });
});

test('archive service lifecycle delegates stale definition removal when registration is proven absent', async () => {
  const calls = [];
  await disableInstalledStackServicesBeforeArchive({
    rootDir: '/repo/apps/stack',
    stackName: 'exp',
    platform: 'darwin',
    homeDir: '/home/alice',
    definitionCandidates: [{ mode: 'user', path: '/existing/dev.happier.stack.exp.plist' }],
    definitionExists: () => true,
    inspectRegistration: async () => 'absent',
    uninstallStackService: async (params) => calls.push(params),
  });

  assert.deepEqual(calls, [{ rootDir: '/repo/apps/stack', stackName: 'exp', svcCmd: 'uninstall', args: ['--mode=user'] }]);
});
