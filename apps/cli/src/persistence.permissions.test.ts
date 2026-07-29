import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFile, stat } from 'node:fs/promises';
import { applyEnvValues, restoreEnvValues, snapshotEnvValues } from '@/testkit/env/envSnapshot';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';

describe('persistence file permissions (posix)', () => {
  const envBackup = snapshotEnvValues(['HAPPIER_HOME_DIR']);
  let homeDir: string | undefined;

  beforeEach(async () => {
    if (process.platform === 'win32') return;
    homeDir = await createTempDir('happier-cli-perms-');
    applyEnvValues({ HAPPIER_HOME_DIR: homeDir });
    vi.resetModules();
  });

  afterEach(async () => {
    restoreEnvValues(envBackup);
    vi.resetModules();
    vi.unstubAllGlobals();
    if (homeDir) {
      await removeTempDir(homeDir);
    }
  });

  it('creates home dir with no group/other permissions', async () => {
    if (process.platform === 'win32') return;
    const { configuration } = await import('@/configuration');
    const { readSettings, writeSettings } = await import('@/persistence');
    await writeSettings(await readSettings());
    const s = await stat(configuration.happyHomeDir);
    expect(s.isDirectory()).toBe(true);
    expect(s.mode & 0o077).toBe(0);
  });

  it('writes credentials with no group/other permissions', async () => {
    if (process.platform === 'win32') return;
    const { configuration } = await import('@/configuration');
    const { writeCredentialsLegacy } = await import('@/persistence');

    await writeCredentialsLegacy({ secret: new Uint8Array(32).fill(1), token: 't' });

    const s = await stat(configuration.privateKeyFile);
    expect(s.isFile()).toBe(true);
    expect(s.mode & 0o077).toBe(0);
  });

  it('writes daemon state with no group/other permissions', async () => {
    if (process.platform === 'win32') return;
    const { configuration } = await import('@/configuration');
    const { writeConnectedServiceBrokerState, writeDaemonState } = await import('@/persistence');

    writeDaemonState({
      pid: 1,
      httpPort: 2,
      startedAt: 3,
      startedWithCliVersion: '0.0.0',
      controlToken: 'secret',
    });
    writeConnectedServiceBrokerState({
      httpPort: 2,
      connectedServiceBrokerRefreshToken: 'scoped-secret',
    });

    const s = await stat(configuration.daemonStateFile);
    expect(s.isFile()).toBe(true);
    expect(s.mode & 0o077).toBe(0);

    const brokerState = await stat(configuration.connectedServiceBrokerStateFile);
    expect(brokerState.isFile()).toBe(true);
    expect(brokerState.mode & 0o077).toBe(0);
    expect(JSON.parse(await readFile(configuration.connectedServiceBrokerStateFile, 'utf8'))).toEqual({
      httpPort: 2,
      connectedServiceBrokerRefreshToken: 'scoped-secret',
    });
    expect(await readFile(configuration.connectedServiceBrokerStateFile, 'utf8')).not.toContain('controlToken');
  });
});
