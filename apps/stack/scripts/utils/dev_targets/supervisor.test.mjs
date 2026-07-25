import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { startStackDevTargets } from './supervisor.mjs';

test('dev target supervisor owns Mutagen publication, remote bootstrap, auth seed, worker, and teardown order', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-dev-targets-'));
  const calls = [];
  const worker = { pid: 1234, exitCode: null };
  const target = {
    name: 'linux',
    platform: 'posix',
    ssh: 'linux-ssh',
    repoDir: '/home/dev/happier',
    cliHomeDir: '/home/dev/.happier/linux',
    remoteServerPort: 43005,
  };
  try {
    const credentialPath = join(root, 'access.key');
    target.sshConfigFile = join(root, 'lima.ssh.config');
    await writeFile(credentialPath, '{"token":"secret"}\n', { mode: 0o600 });
    await writeFile(target.sshConfigFile, 'Host linux-ssh\n  Hostname 127.0.0.1\n');
    await mkdir(join(root, 'stack'), { recursive: true });

    const controller = await startStackDevTargets(
      {
        stackName: 'repo-test',
        stackBaseDir: join(root, 'stack'),
        sourceDir: '/source/happier',
        localServerPort: 3005,
        activeServerId: 'stack_repo-test__id_default',
        credentialPath,
        targets: [target],
        env: {},
      },
      {
        runProcess: async ({ label, command, args, env }) => {
          calls.push({ kind: 'run', label, command, args, env });
          if (command === 'mutagen' && args.includes('terminate')) {
            return { code: 1 };
          }
          return { code: 0 };
        },
        spawnProcess: ({ label, command, args, env }) => {
          calls.push({ kind: 'spawn', label, command, args, env });
          return worker;
        },
        stopProcess: async (child) => {
          calls.push({ kind: 'stop', child });
          child.exitCode = 0;
        },
      },
    );

    const project = await readFile(join(root, 'stack', 'mutagen', 'mutagen.yml'), 'utf8');
    assert.match(project, /linux-ssh:\/home\/dev\/happier/);
    assert.deepEqual(
      calls.map((call) => `${call.kind}:${call.label}`),
      [
        'run:mutagen',
        'run:remote:linux',
        'run:mutagen',
        'run:mutagen',
        'run:mutagen',
        'run:mutagen',
        'run:remote:linux',
        'run:remote:linux',
        'run:remote:linux',
        'spawn:remote:linux',
      ],
    );
    assert.match(calls.at(-1).args.join(' '), /-R 127\.0\.0\.1:43005:127\.0\.0\.1:3005/);
    assert.ok(
      calls.filter((call) => call.command === 'ssh' || call.command === 'scp')
        .every((call) => call.args.includes('-F') && call.args.includes('ControlMaster=no')),
    );
    assert.match(
      calls.find((call) => call.command === 'mutagen' && call.args.includes('start')).env.MUTAGEN_SSH_PATH,
      /mutagen\/openssh$/,
    );

    await controller.close();
    assert.deepEqual(
      calls.slice(-2).map((call) => `${call.kind}:${call.label ?? 'worker'}`),
      ['stop:worker', 'run:mutagen'],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('dev target supervisor terminates a started Mutagen project when the initial flush fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-dev-target-cleanup-'));
  const calls = [];
  const target = {
    name: 'linux',
    platform: 'posix',
    ssh: 'linux-ssh',
    repoDir: '/home/dev/happier',
    cliHomeDir: '/home/dev/.happier/linux',
    remoteServerPort: null,
  };
  try {
    const credentialPath = join(root, 'access.key');
    await writeFile(credentialPath, '{"token":"secret"}\n', { mode: 0o600 });
    await assert.rejects(
      startStackDevTargets(
        {
          stackName: 'repo-test',
          stackBaseDir: join(root, 'stack'),
          sourceDir: '/source/happier',
          localServerPort: 3005,
          activeServerId: 'stack_repo-test__id_default',
          credentialPath,
          targets: [target],
          env: {},
        },
        {
          runProcess: async ({ command, args }) => {
            calls.push({ command, args });
            if (command === 'mutagen' && args.includes('flush')) return { code: 1 };
            return { code: 0 };
          },
        },
      ),
      /Mutagen initial flush failed/,
    );

    const mutagenCommands = calls
      .filter((call) => call.command === 'mutagen')
      .map((call) => call.args.find((arg) => ['version', 'terminate', 'start', 'flush'].includes(arg)));
    assert.deepEqual(mutagenCommands, ['version', 'terminate', 'start', 'flush', 'terminate']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
