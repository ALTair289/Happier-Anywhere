import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { resolveRelayRuntimeDefaults } from '../firstPartyRuntime/relayRuntime.js';

describe('RelayHostEngine snapshot preflight', () => {
  const cleanupRoots: string[] = [];
  const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');

  afterEach(async () => {
    if (originalPlatformDescriptor) {
      Object.defineProperty(process, 'platform', originalPlatformDescriptor);
    }
    vi.resetModules();
    vi.restoreAllMocks();
    await Promise.all(cleanupRoots.splice(0).map(async (root) => {
      await rm(root, { recursive: true, force: true });
    }));
  });

  it('uses the canonical managed service identity and local runtime paths without changing service state', async () => {
    const homeDir = await mkdtemp(join(await realpath(tmpdir()), 'relay-engine-snapshot-'));
    cleanupRoots.push(homeDir);
    const defaults = resolveRelayRuntimeDefaults({
      platform: process.platform,
      mode: 'user',
      channel: 'stable',
      homeDir,
    });
    const serverBinaryName = process.platform === 'win32' ? 'happier-server.exe' : 'happier-server';
    const serverBinaryPath = join(defaults.installRoot, 'bin', serverBinaryName);
    const databasePath = join(defaults.dataDir, 'happier-server-light.sqlite');
    const serviceDefinitionPath = process.platform === 'win32'
      ? join(homeDir, '.happier', 'services', `${defaults.serviceName}.ps1`)
      : process.platform === 'darwin'
        ? join(homeDir, 'Library', 'LaunchAgents', `${defaults.serviceName}.plist`)
        : join(homeDir, '.config', 'systemd', 'user', `${defaults.serviceName}.service`);

    await mkdir(defaults.configDir, { recursive: true });
    await mkdir(join(defaults.dataDir, 'files'), { recursive: true });
    await mkdir(join(defaults.dataDir, 'private-files'), { recursive: true });
    await mkdir(dirname(serverBinaryPath), { recursive: true });
    await mkdir(dirname(serviceDefinitionPath), { recursive: true });
    await writeFile(join(defaults.configDir, 'server.env'), [
      'HAPPIER_DB_PROVIDER=sqlite',
      `DATABASE_URL=${pathToFileURL(databasePath).href}`,
      'HAPPIER_FILES_BACKEND=local',
      `HAPPIER_SERVER_LIGHT_DATA_DIR=${defaults.dataDir}`,
      `HAPPIER_SERVER_LIGHT_FILES_DIR=${join(defaults.dataDir, 'files')}`,
      '',
    ].join('\n'), 'utf8');
    await writeFile(databasePath, 'sqlite-db', 'utf8');
    await writeFile(join(defaults.dataDir, 'handy-master-secret.txt'), 'private-secret', 'utf8');
    await writeFile(join(defaults.dataDir, 'files', 'upload.bin'), 'upload', 'utf8');
    await writeFile(join(defaults.dataDir, 'private-files', 'account-pet.bin'), 'private', 'utf8');
    await writeFile(join(defaults.installRoot, 'self-host-state.json'), JSON.stringify({ version: '0.2.10' }), 'utf8');
    await writeFile(serverBinaryPath, 'binary', 'utf8');
    await writeFile(serviceDefinitionPath, 'managed service definition', 'utf8');

    vi.doMock('node:os', async () => {
      const actual = await vi.importActual<typeof import('node:os')>('node:os');
      return { ...actual, homedir: () => homeDir };
    });
    const spawnedCommands: Array<Readonly<{ command: string; args: readonly string[] }>> = [];
    vi.doMock('node:child_process', async () => {
      const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
      return {
        ...actual,
        spawnSync: (command: string, args?: readonly string[]) => {
          spawnedCommands.push({ command, args: [...(args ?? [])] });
          if (command === 'powershell.exe') {
            const script = String((args ?? []).find((arg) => String(arg).includes('Win32_Process')) ?? '');
            return script
              ? { status: 0, stdout: '0', stderr: '' }
              : { status: 0, stdout: '{"exists":true,"enabled":true,"active":false,"stateLabel":"Ready","stateValue":3}', stderr: '' };
          }
          if (command === 'schtasks') {
            return { status: 0, stdout: 'Status: Ready\nScheduled Task State: Enabled\n', stderr: '' };
          }
          if (command === 'systemctl') {
            return { status: 0, stdout: 'LoadState=loaded\nActiveState=inactive\nUnitFileState=enabled\n', stderr: '' };
          }
          if (command === 'launchctl' || command === 'pgrep') {
            return { status: 1, stdout: '', stderr: '' };
          }
          return { status: 1, stdout: '', stderr: 'unexpected command' };
        },
      };
    });

    const { createRelayHostEngine } = await import('./relayHostEngine.js');
    const engine = createRelayHostEngine({
      resolveRemoteReleaseTarget: async () => ({ os: 'linux', arch: 'x64' }),
      runRemoteText: async () => ({ status: 0, stdout: '', stderr: '' }),
      copyLocalDirectoryToRemote: async () => undefined,
      installRemoteComponent: async () => ({ binaryPath: '/unused', versionId: 'unused' }),
    });

    const result = await engine.preflightSnapshot({
      target: { kind: 'local' },
      channel: 'stable',
      mode: 'user',
    });

    expect(result.managedServiceInactive).toBe(true);
    expect(result.currentBinaryProcessCountZero).toBe(true);
    expect(result.writerStopped).toBe(false);
    expect(result.sourceStateReady).toBe(true);
    expect(result.blockers).toEqual([
      'global_writer_exclusion_unverified',
      'acl_snapshot_backend_unverified',
    ]);
    expect(spawnedCommands.some(({ command, args }) => {
      if (command === 'schtasks') return args.some((arg) => ['/Run', '/End', '/Create', '/Delete'].includes(arg));
      if (command === 'systemctl') return args.some((arg) => ['stop', 'start', 'restart', 'enable', 'disable'].includes(arg));
      if (command === 'launchctl') return args.some((arg) => ['bootout', 'bootstrap', 'enable', 'kickstart'].includes(arg));
      return false;
    })).toBe(false);
    expect(JSON.stringify(result)).not.toContain(homeDir);
    expect(JSON.stringify(result)).not.toContain('private-secret');
  });

  it('fails closed when launchctl cannot be started instead of treating the installed plist as a stopped writer', async () => {
    if (!originalPlatformDescriptor) throw new Error('process.platform descriptor is unavailable');
    Object.defineProperty(process, 'platform', { ...originalPlatformDescriptor, value: 'darwin' });
    const homeDir = await mkdtemp(join(await realpath(tmpdir()), 'relay-engine-launchd-failed-'));
    cleanupRoots.push(homeDir);
    const defaults = resolveRelayRuntimeDefaults({
      platform: 'darwin',
      mode: 'user',
      channel: 'stable',
      homeDir,
    });
    const serviceDefinitionPath = join(homeDir, 'Library', 'LaunchAgents', `${defaults.serviceName}.plist`);
    await mkdir(defaults.installRoot, { recursive: true });
    await mkdir(dirname(serviceDefinitionPath), { recursive: true });
    await writeFile(join(defaults.installRoot, 'self-host-state.json'), JSON.stringify({ version: '0.2.10' }), 'utf8');
    await writeFile(serviceDefinitionPath, '<plist/>', 'utf8');

    vi.doMock('node:os', async () => {
      const actual = await vi.importActual<typeof import('node:os')>('node:os');
      return { ...actual, homedir: () => homeDir };
    });
    vi.doMock('node:child_process', async () => {
      const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
      return {
        ...actual,
        spawnSync: (command: string) => command === 'launchctl'
          ? { status: null, stdout: '', stderr: '', error: new Error('launchctl spawn failed') }
          : command === 'pgrep'
            ? { status: 1, stdout: '', stderr: '' }
            : { status: 1, stdout: '', stderr: 'unexpected command' },
      };
    });

    const { createRelayHostEngine } = await import('./relayHostEngine.js');
    const engine = createRelayHostEngine({
      resolveRemoteReleaseTarget: async () => ({ os: 'linux', arch: 'x64' }),
      runRemoteText: async () => ({ status: 0, stdout: '', stderr: '' }),
      copyLocalDirectoryToRemote: async () => undefined,
      installRemoteComponent: async () => ({ binaryPath: '/unused', versionId: 'unused' }),
    });

    const result = await engine.preflightSnapshot({
      target: { kind: 'local' },
      channel: 'stable',
      mode: 'user',
    });

    expect(result.writerStopped).toBe(false);
    expect(result.sourceStateReady).toBe(false);
    expect(result.coverage).toMatchObject({
      sqliteDatabase: false,
      files: false,
      masterSecret: false,
      effectiveConfig: false,
    });
    expect(result.blockers).toEqual([
      'relay_writer_state_unknown',
      'global_writer_exclusion_unverified',
      'acl_snapshot_backend_unverified',
    ]);
  });

  it('blocks SSH snapshot preflight locally without invoking any remote dependency', async () => {
    const resolveRemoteReleaseTarget = vi.fn(async () => ({ os: 'linux' as const, arch: 'x64' as const }));
    const runRemoteText = vi.fn(async () => ({ status: 0, stdout: '', stderr: '' }));
    const copyLocalDirectoryToRemote = vi.fn(async () => undefined);
    const installRemoteComponent = vi.fn(async () => ({ binaryPath: '/unused', versionId: 'unused' }));
    const { createRelayHostEngine } = await import('./relayHostEngine.js');
    const engine = createRelayHostEngine({
      resolveRemoteReleaseTarget,
      runRemoteText,
      copyLocalDirectoryToRemote,
      installRemoteComponent,
    });

    const result = await engine.preflightSnapshot({
      target: { kind: 'ssh', ssh: { target: 'relay@example.test', auth: 'agent' } },
      channel: 'stable',
      mode: 'user',
    });

    expect(result).toMatchObject({
      target: 'ssh',
      writerStopped: false,
      sourceStateReady: false,
      canCreateSnapshot: false,
      blockers: [
        'remote_snapshot_requires_local_execution',
        'acl_snapshot_backend_unverified',
      ],
    });
    expect(resolveRemoteReleaseTarget).not.toHaveBeenCalled();
    expect(runRemoteText).not.toHaveBeenCalled();
    expect(copyLocalDirectoryToRemote).not.toHaveBeenCalled();
    expect(installRemoteComponent).not.toHaveBeenCalled();
  });
});
