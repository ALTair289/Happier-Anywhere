import { lstat, readFile, readdir } from 'node:fs/promises';
import { posix as posixPath, win32 as win32Path } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseEnvText } from '../firstPartyRuntime/selfHostServerEnv.js';

export type RelayHostSnapshotCoverage = Readonly<{
  sqliteDatabase: boolean;
  sqliteWal: 'present' | 'absent' | 'unsafe';
  sqliteShm: 'present' | 'absent' | 'unsafe';
  files: boolean;
  privateFiles: boolean;
  masterSecret: boolean;
  effectiveConfig: boolean;
  serviceMetadata: boolean;
  installMetadata: boolean;
}>;

export type RelayHostSnapshotPreflightResult = Readonly<{
  target: 'local' | 'ssh';
  platform: NodeJS.Platform | 'remote-unknown';
  channel: 'stable' | 'preview' | 'dev';
  mode: 'user' | 'system';
  managedServiceInactive: boolean;
  currentBinaryProcessCountZero: boolean;
  writerStopped: boolean;
  sourceStateReady: boolean;
  snapshotCreationSupported: false;
  canCreateSnapshot: false;
  coverage: RelayHostSnapshotCoverage;
  blockers: readonly string[];
}>;

export type InspectLocalRelaySnapshotReadinessParams = Readonly<{
  platform: NodeJS.Platform;
  channel: 'stable' | 'preview' | 'dev';
  mode: 'user' | 'system';
  relayInstalled: boolean;
  serviceActive: boolean | null;
  matchingWriterProcessCount: number | null;
  configDir: string;
  homeDir?: string;
  defaultDataDir: string;
  installRoot: string;
  serviceDefinitionPath: string;
}>;

const EMPTY_COVERAGE: RelayHostSnapshotCoverage = Object.freeze({
  sqliteDatabase: false,
  sqliteWal: 'absent',
  sqliteShm: 'absent',
  files: false,
  privateFiles: false,
  masterSecret: false,
  effectiveConfig: false,
  serviceMetadata: false,
  installMetadata: false,
});

function appendUnique(items: string[], value: string): void {
  if (!items.includes(value)) items.push(value);
}
function pathApiForPlatform(platform: NodeJS.Platform): typeof posixPath | typeof win32Path {
  return platform === 'win32' ? win32Path : posixPath;
}
function normalizeAbsoluteLocalPath(raw: unknown, platform: NodeJS.Platform): string | null {
  const value = String(raw ?? '').trim();
  if (!value || value.includes('\0')) return null;
  const pathApi = pathApiForPlatform(platform);
  if (!pathApi.isAbsolute(value)) return null;
  if (platform === 'win32' && (value.startsWith('\\\\') || value.startsWith('//'))) {
    return null;
  }
  return pathApi.normalize(value);
}

function normalizeRuntimeStoragePath(
  raw: unknown,
  platform: NodeJS.Platform,
  homeDir: string | undefined,
): string | null {
  const value = String(raw ?? '').trim();
  const expanded = value === '~'
    ? String(homeDir ?? '').trim()
    : value.startsWith('~/') || value.startsWith('~\\')
      ? pathApiForPlatform(platform).join(String(homeDir ?? '').trim(), value.slice(2))
      : value;
  return normalizeAbsoluteLocalPath(expanded, platform);
}

function readLegacyFirstEnvValue(
  config: Readonly<Record<string, string>>,
  legacyKey: string,
  currentKey: string,
): string {
  return String(config[legacyKey] ?? config[currentKey] ?? '').trim();
}

function resolveSqliteDatabasePath(raw: unknown, platform: NodeJS.Platform): string | null {
  const value = String(raw ?? '').trim();
  if (!value) return null;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'file:' || parsed.hostname) return null;
    return normalizeAbsoluteLocalPath(
      fileURLToPath(parsed, { windows: platform === 'win32' }),
      platform,
    );
  } catch {
    return null;
  }
}

async function lstatOrNull(path: string): Promise<Awaited<ReturnType<typeof lstat>> | null> {
  return await lstat(path).catch(() => null);
}

async function pathDoesNotTraverseLinks(path: string, platform: NodeJS.Platform): Promise<boolean> {
  const pathApi = pathApiForPlatform(platform);
  const normalized = normalizeAbsoluteLocalPath(path, platform);
  if (!normalized) return false;
  const parsed = pathApi.parse(normalized);
  if (!parsed.root) return false;
  const components = normalized
    .slice(parsed.root.length)
    .split(pathApi.sep)
    .filter((component) => component.length > 0);
  const paths = [
    parsed.root,
    ...components.map((_, index) => pathApi.join(parsed.root, ...components.slice(0, index + 1))),
  ];
  for (const [index, componentPath] of paths.entries()) {
    const info = await lstatOrNull(componentPath);
    if (!info || info.isSymbolicLink()) return false;
    if (index < paths.length - 1 && !info.isDirectory()) return false;
  }
  return true;
}

async function inspectRegularFile(params: Readonly<{
  path: string;
  platform: NodeJS.Platform;
  nonEmpty?: boolean;
}>): Promise<boolean> {
  if (!await pathDoesNotTraverseLinks(params.path, params.platform)) return false;
  const info = await lstatOrNull(params.path);
  return Boolean(info?.isFile() && (params.nonEmpty !== true || info.size > 0));
}

async function inspectOptionalRegularFile(params: Readonly<{
  path: string;
  platform: NodeJS.Platform;
}>): Promise<'present' | 'absent' | 'unsafe'> {
  const info = await lstat(params.path).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return null;
    return false;
  });
  if (info === null) return 'absent';
  if (info === false) return 'unsafe';
  if (!await pathDoesNotTraverseLinks(params.path, params.platform)) return 'unsafe';
  return info.isFile() ? 'present' : 'unsafe';
}

async function inspectRegularTree(params: Readonly<{
  root: string;
  platform: NodeJS.Platform;
}>): Promise<boolean> {
  if (!await pathDoesNotTraverseLinks(params.root, params.platform)) return false;
  const rootInfo = await lstatOrNull(params.root);
  if (!rootInfo?.isDirectory()) return false;

  const pending = [params.root];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    const entries = await readdir(directory).catch(() => null);
    if (!entries) return false;
    for (const entry of entries) {
      const entryPath = pathApiForPlatform(params.platform).join(directory, entry);
      const info = await lstatOrNull(entryPath);
      if (!info || info.isSymbolicLink()) return false;
      if (info.isDirectory()) {
        pending.push(entryPath);
      } else if (!info.isFile()) {
        return false;
      }
    }
  }
  return true;
}

function finalize(params: Readonly<{
  input: InspectLocalRelaySnapshotReadinessParams;
  blockers: string[];
  coverage: RelayHostSnapshotCoverage;
}>): RelayHostSnapshotPreflightResult {
  const blockers = [...params.blockers];
  const sourceStateReady = blockers.length === 0;
  appendUnique(blockers, 'global_writer_exclusion_unverified');
  appendUnique(blockers, 'acl_snapshot_backend_unverified');
  const managedServiceInactive = params.input.relayInstalled && params.input.serviceActive === false;
  const currentBinaryProcessCountZero =
    params.input.relayInstalled && params.input.matchingWriterProcessCount === 0;
  return {
    target: 'local',
    platform: params.input.platform,
    channel: params.input.channel,
    mode: params.input.mode,
    managedServiceInactive,
    currentBinaryProcessCountZero,
    writerStopped: false,
    sourceStateReady,
    snapshotCreationSupported: false,
    canCreateSnapshot: false,
    coverage: params.coverage,
    blockers,
  };
}

export async function inspectLocalRelaySnapshotReadiness(
  params: InspectLocalRelaySnapshotReadinessParams,
): Promise<RelayHostSnapshotPreflightResult> {
  const blockers: string[] = [];
  if (!params.relayInstalled) appendUnique(blockers, 'relay_not_installed');
  if (params.serviceActive === true) appendUnique(blockers, 'relay_writer_active');
  if (params.serviceActive === null) appendUnique(blockers, 'relay_writer_state_unknown');
  if (params.matchingWriterProcessCount === null) {
    appendUnique(blockers, 'relay_writer_process_check_failed');
  } else if (params.matchingWriterProcessCount > 0) {
    appendUnique(blockers, 'relay_writer_process_detected');
  }
  if (blockers.length > 0) {
    return finalize({ input: params, blockers, coverage: EMPTY_COVERAGE });
  }

  const pathApi = pathApiForPlatform(params.platform);
  const configPath = pathApi.join(params.configDir, 'server.env');
  const configTreeSafe = await inspectRegularTree({ root: params.configDir, platform: params.platform });
  const configFileSafe = configTreeSafe && await inspectRegularFile({
    path: configPath,
    platform: params.platform,
    nonEmpty: true,
  });
  const configText = configFileSafe ? await readFile(configPath, 'utf8').catch(() => '') : '';
  const config = configText ? parseEnvText(configText) : {};
  const effectiveConfig = Boolean(configFileSafe && configText);
  if (!effectiveConfig) appendUnique(blockers, 'effective_config_missing_or_unsafe');

  const sqliteConfigured = String(config.HAPPIER_DB_PROVIDER ?? '').trim().toLowerCase() === 'sqlite';
  if (!sqliteConfigured) appendUnique(blockers, 'database_provider_not_sqlite');
  const localFilesConfigured = String(config.HAPPIER_FILES_BACKEND ?? '').trim().toLowerCase() === 'local';
  if (!localFilesConfigured) appendUnique(blockers, 'files_backend_not_local');

  const dataDir = normalizeRuntimeStoragePath(
    readLegacyFirstEnvValue(config, 'HAPPY_SERVER_LIGHT_DATA_DIR', 'HAPPIER_SERVER_LIGHT_DATA_DIR')
      || params.defaultDataDir,
    params.platform,
    params.homeDir,
  );
  const filesDir = normalizeRuntimeStoragePath(
    readLegacyFirstEnvValue(config, 'HAPPY_SERVER_LIGHT_FILES_DIR', 'HAPPIER_SERVER_LIGHT_FILES_DIR')
      || (dataDir ? pathApi.join(dataDir, 'files') : ''),
    params.platform,
    params.homeDir,
  );
  const privateFilesDir = normalizeRuntimeStoragePath(
    readLegacyFirstEnvValue(
      config,
      'HAPPY_SERVER_LIGHT_PRIVATE_FILES_DIR',
      'HAPPIER_SERVER_LIGHT_PRIVATE_FILES_DIR',
    ) || (dataDir ? pathApi.join(dataDir, 'private-files') : ''),
    params.platform,
    params.homeDir,
  );
  const databasePath = config.DATABASE_URL
    ? resolveSqliteDatabasePath(config.DATABASE_URL, params.platform)
    : dataDir
      ? pathApi.join(dataDir, 'happier-server-light.sqlite')
      : null;

  const dataTreeSafe = dataDir
    ? await inspectRegularTree({ root: dataDir, platform: params.platform })
    : false;
  if (!dataTreeSafe) appendUnique(blockers, 'data_directory_missing_or_unsafe');

  const files = Boolean(
    localFilesConfigured
    && filesDir
    && await inspectRegularTree({ root: filesDir, platform: params.platform }),
  );
  if (!files) appendUnique(blockers, 'files_missing_or_unsafe');
  const privateFiles = Boolean(
    privateFilesDir
    && await inspectRegularTree({ root: privateFilesDir, platform: params.platform }),
  );
  if (!privateFiles) appendUnique(blockers, 'private_files_missing_or_unsafe');

  const sqliteDatabase = Boolean(
    sqliteConfigured
    && databasePath
    && await inspectRegularFile({ path: databasePath, platform: params.platform, nonEmpty: true }),
  );
  if (!sqliteDatabase) appendUnique(blockers, 'sqlite_database_missing_or_unsafe');
  const sqliteWal = databasePath
    ? await inspectOptionalRegularFile({ path: `${databasePath}-wal`, platform: params.platform })
    : 'unsafe';
  const sqliteShm = databasePath
    ? await inspectOptionalRegularFile({ path: `${databasePath}-shm`, platform: params.platform })
    : 'unsafe';
  if (sqliteWal === 'unsafe' || sqliteShm === 'unsafe') {
    appendUnique(blockers, 'sqlite_sidecar_missing_or_unsafe');
  }

  const configuredSecret = String(config.HANDY_MASTER_SECRET ?? '').trim();
  const masterSecret = configuredSecret.length > 0 || Boolean(
    dataDir
    && await inspectRegularFile({
      path: pathApi.join(dataDir, 'handy-master-secret.txt'),
      platform: params.platform,
      nonEmpty: true,
    }),
  );
  if (!masterSecret) appendUnique(blockers, 'master_secret_missing_or_unsafe');

  const serviceMetadata = await inspectRegularFile({
    path: params.serviceDefinitionPath,
    platform: params.platform,
    nonEmpty: true,
  });
  if (!serviceMetadata) appendUnique(blockers, 'service_metadata_missing_or_unsafe');

  const installMetadata = await inspectRegularFile({
    path: pathApi.join(params.installRoot, 'self-host-state.json'),
    platform: params.platform,
    nonEmpty: true,
  });
  if (!installMetadata) appendUnique(blockers, 'install_metadata_missing_or_unsafe');

  return finalize({
    input: params,
    blockers,
    coverage: {
      sqliteDatabase,
      sqliteWal,
      sqliteShm,
      files,
      privateFiles,
      masterSecret,
      effectiveConfig,
      serviceMetadata,
      installMetadata,
    },
  });
}

export function createRemoteRelaySnapshotBlockedPreflight(params: Readonly<{
  channel: 'stable' | 'preview' | 'dev';
  mode: 'user' | 'system';
}>): RelayHostSnapshotPreflightResult {
  return {
    target: 'ssh',
    platform: 'remote-unknown',
    channel: params.channel,
    mode: params.mode,
    managedServiceInactive: false,
    currentBinaryProcessCountZero: false,
    writerStopped: false,
    sourceStateReady: false,
    snapshotCreationSupported: false,
    canCreateSnapshot: false,
    coverage: EMPTY_COVERAGE,
    blockers: [
      'remote_snapshot_requires_local_execution',
      'acl_snapshot_backend_unverified',
    ],
  };
}
