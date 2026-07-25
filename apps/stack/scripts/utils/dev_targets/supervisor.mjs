import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { killProcessTree, spawnProc } from '../proc/proc.mjs';
import { buildMutagenProjectArgs, renderMutagenProject } from './mutagen_project.mjs';
import {
  buildRemoteBootstrapCommand,
  buildRemoteDaemonCommand,
  buildRemoteEnsureDirectoriesCommand,
  buildRemoteInstallCredentialCommand,
  buildSshWorkerArgs,
} from './remote_commands.mjs';

function defaultRemoteServerPort(localServerPort, index) {
  return 40_000 + (Number(localServerPort) % 10_000) + index;
}

async function defaultRunProcess({ label, command, args, env }) {
  const child = spawnProc(label, command, args, env);
  const result = await child.completion;
  return result;
}

function defaultSpawnProcess({ label, command, args, env }) {
  return spawnProc(label, command, args, env);
}

async function defaultStopProcess(child) {
  if (!child || child.exitCode != null) return;
  await killProcessTree(child, 'SIGINT', { graceMs: 2_000 });
}

function requireSuccessful(result, description) {
  if (result?.code === 0) return;
  if (result?.error?.code === 'ENOENT') {
    throw new Error(
      `[dev-targets] ${description} failed because Mutagen was not found.\n` +
        'Install Mutagen locally and ensure `mutagen` is available on PATH, or remove this stack’s dev-targets.json.',
    );
  }
  throw new Error(`[dev-targets] ${description} failed (code=${String(result?.code ?? 'unknown')})`);
}

function remoteCredentialPaths(target, activeServerId, stackName) {
  const base = String(target.cliHomeDir).replace(/[\\/]+$/, '');
  const stagedPath = `${base}/.access-key-${stackName}.tmp`;
  const finalPath = `${base}/servers/${activeServerId}/access.key`;
  return { stagedPath, finalPath };
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}

async function prepareOpenSsh({ targets, mutagenDir, env }) {
  const customConfigs = [
    ...new Set(targets.map((target) => target.sshConfigFile).filter(Boolean)),
  ];
  if (customConfigs.length === 0) {
    return { sshArgs: [], mutagenEnv: env };
  }
  if (process.platform === 'win32') {
    throw new Error('[dev-targets] sshConfigFile is not yet supported on Windows Stack hosts');
  }

  const opensshDir = join(mutagenDir, 'openssh');
  const configPath = join(opensshDir, 'config');
  await mkdir(opensshDir, { recursive: true });
  await writeFile(
    configPath,
    [
      `Include ${JSON.stringify(join(homedir(), '.ssh', 'config'))}`,
      ...customConfigs.map((path) => `Include ${JSON.stringify(path)}`),
      '',
    ].join('\n'),
    { mode: 0o600 },
  );
  for (const executable of ['ssh', 'scp']) {
    await writeFile(
      join(opensshDir, executable),
      `#!/bin/sh\nexec /usr/bin/${executable} -F ${shellQuote(configPath)} -o ControlMaster=no "$@"\n`,
      { mode: 0o700 },
    );
  }
  return {
    sshArgs: ['-F', configPath, '-o', 'ControlMaster=no'],
    mutagenEnv: { ...env, MUTAGEN_SSH_PATH: opensshDir },
  };
}

export async function startStackDevTargets(
  {
    stackName,
    stackBaseDir,
    sourceDir,
    localServerPort,
    activeServerId,
    credentialPath,
    targets,
    env = process.env,
  },
  {
    runProcess = defaultRunProcess,
    spawnProcess = defaultSpawnProcess,
    stopProcess = defaultStopProcess,
  } = {},
) {
  if (!Array.isArray(targets) || targets.length === 0) {
    return { workers: [], close: async () => {} };
  }
  if (!credentialPath) {
    throw new Error(
      '[dev-targets] the local stack has no daemon credential to seed remotely; authenticate the local daemon first',
    );
  }

  const mutagenDir = join(stackBaseDir, 'mutagen');
  const mutagenDataDir = join(mutagenDir, 'data');
  const projectFile = join(mutagenDir, 'mutagen.yml');
  const openSsh = await prepareOpenSsh({ targets, mutagenDir, env });
  const mutagenEnv = {
    ...openSsh.mutagenEnv,
    MUTAGEN_DATA_DIRECTORY: mutagenDataDir,
    MUTAGEN_SSH_CONNECT_TIMEOUT: String(env.MUTAGEN_SSH_CONNECT_TIMEOUT ?? '10'),
  };
  await mkdir(mutagenDataDir, { recursive: true });
  await writeFile(projectFile, renderMutagenProject({ sourceDir, targets }), 'utf8');

  const workers = [];
  let projectStarted = false;
  try {
    requireSuccessful(
      await runProcess({ label: 'mutagen', command: 'mutagen', args: ['version'], env: mutagenEnv }),
      'Mutagen preflight',
    );

    for (const target of targets) {
      requireSuccessful(
        await runProcess({
          label: `remote:${target.name}`,
          command: 'ssh',
          args: [
            ...openSsh.sshArgs,
            '-o',
            'BatchMode=yes',
            target.ssh,
            buildRemoteEnsureDirectoriesCommand(target),
          ],
          env,
        }),
        `${target.name} directory bootstrap`,
      );
    }

    await runProcess({
      label: 'mutagen',
      command: 'mutagen',
      args: buildMutagenProjectArgs('terminate', projectFile),
      env: mutagenEnv,
    });
    requireSuccessful(
      await runProcess({
        label: 'mutagen',
        command: 'mutagen',
        args: buildMutagenProjectArgs('start', projectFile),
        env: mutagenEnv,
      }),
      'Mutagen project start',
    );
    projectStarted = true;
    requireSuccessful(
      await runProcess({
        label: 'mutagen',
        command: 'mutagen',
        args: buildMutagenProjectArgs('flush', projectFile),
        env: mutagenEnv,
      }),
      'Mutagen initial flush',
    );
    requireSuccessful(
      await runProcess({
        label: 'mutagen',
        command: 'mutagen',
        args: buildMutagenProjectArgs('list', projectFile),
        env: mutagenEnv,
      }),
      'Mutagen project status',
    );

    for (const [index, target] of targets.entries()) {
      requireSuccessful(
        await runProcess({
          label: `remote:${target.name}`,
          command: 'ssh',
          args: [
            ...openSsh.sshArgs,
            '-o',
            'BatchMode=yes',
            target.ssh,
            buildRemoteBootstrapCommand(target),
          ],
          env,
        }),
        `${target.name} dependency bootstrap`,
      );

      const { stagedPath, finalPath } = remoteCredentialPaths(target, activeServerId, stackName);
      requireSuccessful(
        await runProcess({
          label: `remote:${target.name}`,
          command: 'scp',
          args: [
            '-q',
            ...openSsh.sshArgs,
            '-o',
            'BatchMode=yes',
            credentialPath,
            `${target.ssh}:${stagedPath}`,
          ],
          env,
        }),
        `${target.name} credential transfer`,
      );
      requireSuccessful(
        await runProcess({
          label: `remote:${target.name}`,
          command: 'ssh',
          args: [
            '-o',
            'BatchMode=yes',
            ...openSsh.sshArgs,
            target.ssh,
            buildRemoteInstallCredentialCommand(target, { stagedPath, finalPath }),
          ],
          env,
        }),
        `${target.name} credential installation`,
      );

      const remoteServerPort =
        target.remoteServerPort ?? defaultRemoteServerPort(localServerPort, index);
      const remoteCommand = buildRemoteDaemonCommand(target, {
        serverUrl: `http://127.0.0.1:${remoteServerPort}`,
        activeServerId,
        stackName,
      });
      workers.push(
        spawnProcess({
          label: `remote:${target.name}`,
          command: 'ssh',
          args: buildSshWorkerArgs(target, {
            localServerPort,
            remoteServerPort,
            remoteCommand,
            sshArgs: openSsh.sshArgs,
          }),
          env,
        }),
      );
    }

    let closed = false;
    return {
      workers,
      projectFile,
      async close() {
        if (closed) return;
        closed = true;
        for (const worker of workers) {
          await stopProcess(worker);
        }
        await runProcess({
          label: 'mutagen',
          command: 'mutagen',
          args: buildMutagenProjectArgs('terminate', projectFile),
          env: mutagenEnv,
        });
      },
    };
  } catch (error) {
    for (const worker of workers) {
      await stopProcess(worker).catch(() => {});
    }
    if (projectStarted) {
      await runProcess({
        label: 'mutagen',
        command: 'mutagen',
        args: buildMutagenProjectArgs('terminate', projectFile),
        env: mutagenEnv,
      }).catch(() => {});
    }
    throw error;
  }
}
