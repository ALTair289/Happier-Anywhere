import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { inspectLocalRelaySnapshotReadiness } from './relayHostSnapshotPreflight.js';

const cleanupRoots: string[] = [];

async function createCompleteFixture(): Promise<Readonly<{
  root: string;
  configDir: string;
  defaultDataDir: string;
  installRoot: string;
  serviceDefinitionPath: string;
  databasePath: string;
  sensitiveSecret: string;
}>> {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'relay-snapshot-preflight-'));
  cleanupRoots.push(root);
  const configDir = join(root, 'config');
  const defaultDataDir = join(root, 'default-data-unused');
  const actualDataDir = join(root, 'actual-data');
  const filesDir = join(root, 'external-files');
  const privateFilesDir = join(root, 'external-private-files');
  const databasePath = join(root, 'external-database', 'relay.sqlite');
  const installRoot = join(root, 'install');
  const serviceDefinitionPath = join(root, 'service', 'happier-server.service');
  const sensitiveSecret = 'snapshot-secret-must-not-leak';

  await mkdir(configDir, { recursive: true });
  await mkdir(actualDataDir, { recursive: true });
  await mkdir(filesDir, { recursive: true });
  await mkdir(privateFilesDir, { recursive: true });
  await mkdir(join(databasePath, '..'), { recursive: true });
  await mkdir(installRoot, { recursive: true });
  await mkdir(join(serviceDefinitionPath, '..'), { recursive: true });
  await writeFile(join(filesDir, 'upload.bin'), 'uploaded-data', 'utf8');
  await writeFile(join(privateFilesDir, 'account-pet.bin'), 'private-data', 'utf8');
  await writeFile(databasePath, 'sqlite-db', 'utf8');
  await writeFile(`${databasePath}-wal`, 'sqlite-wal', 'utf8');
  await writeFile(`${databasePath}-shm`, 'sqlite-shm', 'utf8');
  await writeFile(join(actualDataDir, 'handy-master-secret.txt'), sensitiveSecret, 'utf8');
  await writeFile(join(installRoot, 'self-host-state.json'), JSON.stringify({ version: '0.2.10' }), 'utf8');
  await writeFile(serviceDefinitionPath, '[Service]\nWorkingDirectory=/relay\n', 'utf8');
  await writeFile(join(configDir, 'server.env'), [
    'HAPPIER_DB_PROVIDER=sqlite',
    `DATABASE_URL=${pathToFileURL(databasePath).href}`,
    'HAPPIER_FILES_BACKEND=local',
    `HAPPY_SERVER_LIGHT_DATA_DIR=${actualDataDir}`,
    `HAPPIER_SERVER_LIGHT_DATA_DIR=${defaultDataDir}`,
    `HAPPY_SERVER_LIGHT_FILES_DIR=${filesDir}`,
    `HAPPIER_SERVER_LIGHT_FILES_DIR=${join(root, 'decoy-files')}`,
    `HAPPY_SERVER_LIGHT_PRIVATE_FILES_DIR=${privateFilesDir}`,
    `HAPPIER_SERVER_LIGHT_PRIVATE_FILES_DIR=${join(root, 'decoy-private-files')}`,
    '',
  ].join('\n'), 'utf8');

  return {
    root,
    configDir,
    defaultDataDir,
    installRoot,
    serviceDefinitionPath,
    databasePath,
    sensitiveSecret,
  };
}

afterEach(async () => {
  await Promise.all(cleanupRoots.splice(0).map(async (root) => {
    await rm(root, { recursive: true, force: true });
  }));
});
describe('inspectLocalRelaySnapshotReadiness', () => {
  it('resolves effective external SQLite/files paths and inventories all stopped-writer snapshot material without exposing paths or secrets', async () => {
    const fixture = await createCompleteFixture();

    const result = await inspectLocalRelaySnapshotReadiness({
      platform: process.platform,
      channel: 'stable',
      mode: 'user',
      relayInstalled: true,
      serviceActive: false,
      matchingWriterProcessCount: 0,
      configDir: fixture.configDir,
      defaultDataDir: fixture.defaultDataDir,
      installRoot: fixture.installRoot,
      serviceDefinitionPath: fixture.serviceDefinitionPath,
    });

    expect(result).toEqual({
      target: 'local',
      platform: process.platform,
      channel: 'stable',
      mode: 'user',
      managedServiceInactive: true,
      currentBinaryProcessCountZero: true,
      writerStopped: false,
      sourceStateReady: true,
      snapshotCreationSupported: false,
      canCreateSnapshot: false,
      coverage: {
        sqliteDatabase: true,
        sqliteWal: 'present',
        sqliteShm: 'present',
        files: true,
        privateFiles: true,
        masterSecret: true,
        effectiveConfig: true,
        serviceMetadata: true,
        installMetadata: true,
      },
      blockers: [
        'global_writer_exclusion_unverified',
        'acl_snapshot_backend_unverified',
      ],
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(fixture.root);
    expect(serialized).not.toContain(fixture.sensitiveSecret);
  });

  it('stops before reading snapshot material when the Relay writer is active', async () => {
    const root = await mkdtemp(join(await realpath(tmpdir()), 'relay-snapshot-active-'));
    cleanupRoots.push(root);

    const result = await inspectLocalRelaySnapshotReadiness({
      platform: process.platform,
      channel: 'stable',
      mode: 'user',
      relayInstalled: true,
      serviceActive: true,
      matchingWriterProcessCount: 1,
      configDir: join(root, 'missing-config'),
      defaultDataDir: join(root, 'missing-data'),
      installRoot: join(root, 'missing-install'),
      serviceDefinitionPath: join(root, 'missing-service'),
    });

    expect(result.writerStopped).toBe(false);
    expect(result.sourceStateReady).toBe(false);
    expect(result.blockers).toEqual([
      'relay_writer_active',
      'relay_writer_process_detected',
      'global_writer_exclusion_unverified',
      'acl_snapshot_backend_unverified',
    ]);
    expect(result.blockers).not.toContain('effective_config_missing_or_unsafe');
  });

  it('records definitively absent SQLite sidecars without treating a clean stopped database as incomplete', async () => {
    const fixture = await createCompleteFixture();
    await rm(`${fixture.databasePath}-wal`);
    await rm(`${fixture.databasePath}-shm`);

    const result = await inspectLocalRelaySnapshotReadiness({
      platform: process.platform,
      channel: 'stable',
      mode: 'user',
      relayInstalled: true,
      serviceActive: false,
      matchingWriterProcessCount: 0,
      configDir: fixture.configDir,
      defaultDataDir: fixture.defaultDataDir,
      installRoot: fixture.installRoot,
      serviceDefinitionPath: fixture.serviceDefinitionPath,
    });

    expect(result.coverage.sqliteWal).toBe('absent');
    expect(result.coverage.sqliteShm).toBe('absent');
    expect(result.sourceStateReady).toBe(true);
    expect(result.blockers).toEqual([
      'global_writer_exclusion_unverified',
      'acl_snapshot_backend_unverified',
    ]);
  });

  it('fails closed when an effective files tree contains a symbolic link', async () => {
    const fixture = await createCompleteFixture();
    const targetDir = join(fixture.root, 'link-target');
    await mkdir(targetDir);
    await writeFile(join(targetDir, 'outside.txt'), 'outside', 'utf8');
    await symlink(targetDir, join(fixture.root, 'external-files', 'linked'), 'junction');

    const result = await inspectLocalRelaySnapshotReadiness({
      platform: process.platform,
      channel: 'stable',
      mode: 'user',
      relayInstalled: true,
      serviceActive: false,
      matchingWriterProcessCount: 0,
      configDir: fixture.configDir,
      defaultDataDir: fixture.defaultDataDir,
      installRoot: fixture.installRoot,
      serviceDefinitionPath: fixture.serviceDefinitionPath,
    });

    expect(result.sourceStateReady).toBe(false);
    expect(result.coverage.files).toBe(false);
    expect(result.blockers).toContain('files_missing_or_unsafe');
    expect(result.blockers).toContain('acl_snapshot_backend_unverified');
  });
});
