import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  rm,
} from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';

export type ProtectedLocalStateKind = 'directory' | 'file';

export type WindowsProtectedLocalStateCommandResult = Readonly<{
  exitCode: number;
  stdout: string;
  stderr: string;
}>;

export type WindowsProtectedLocalStateCommandRunner = (
  command: string,
  args: readonly string[],
) => Promise<WindowsProtectedLocalStateCommandResult>;

export type WindowsProtectedLocalStateAclBoundary = Readonly<{
  applyAndVerify(input: Readonly<{
    path: string;
    kind: ProtectedLocalStateKind;
  }>): Promise<void>;
  verify(input: Readonly<{
    path: string;
    kind: ProtectedLocalStateKind;
  }>): Promise<void>;
}>;

export type ProtectedLocalStateOptions = Readonly<{
  platform?: NodeJS.Platform;
  expectedUid?: number;
  windowsAclBoundary?: WindowsProtectedLocalStateAclBoundary;
}>;

type WindowsAclSnapshot = Readonly<{
  ownerSid: string;
  protected: boolean;
  reparsePoint: boolean;
  rules: readonly Readonly<{
    sid: string;
    type: string;
    inherited: boolean;
    rights: string;
  }>[];
}>;

const LOCAL_SYSTEM_SID = 'S-1-5-18';
const WINDOWS_SID_PATTERN = /^S-\d(?:-\d+)+$/u;
const WINDOWS_ACL_INSPECTION_SCRIPT = [
  '& {',
  'param([string]$Path)',
  '$acl = Get-Acl -LiteralPath $Path -ErrorAction Stop',
  '$attributes = [System.IO.File]::GetAttributes($Path)',
  '$rules = @($acl.Access | ForEach-Object {',
  '  [pscustomobject]@{',
  '    sid = $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value',
  '    type = $_.AccessControlType.ToString()',
  '    inherited = $_.IsInherited',
  '    rights = $_.FileSystemRights.ToString()',
  '  }',
  '})',
  '[pscustomobject]@{',
  '  ownerSid = ([System.Security.Principal.NTAccount]::new($acl.Owner)).Translate([System.Security.Principal.SecurityIdentifier]).Value',
  '  protected = $acl.AreAccessRulesProtected',
  '  reparsePoint = (($attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0)',
  '  rules = $rules',
  '} | ConvertTo-Json -Depth 5 -Compress',
  '} ',
].join('\n');

let defaultWindowsAclBoundary: WindowsProtectedLocalStateAclBoundary | null = null;

function isErrno(error: unknown, code: string): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as NodeJS.ErrnoException).code === code;
}

function defaultWindowsCommandRunner(
  command: string,
  args: readonly string[],
): Promise<WindowsProtectedLocalStateCommandResult> {
  return new Promise((resolve, reject) => {
    execFile(command, [...args], {
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (error && typeof error.code !== 'number') {
        reject(new Error(`Protected local state command could not start: ${command}`));
        return;
      }
      resolve({
        exitCode: typeof error?.code === 'number' ? error.code : 0,
        stdout: String(stdout),
        stderr: String(stderr),
      });
    });
  });
}

function parseCurrentUserSid(stdout: string): string {
  const match = stdout.match(/S-\d(?:-\d+)+/u);
  if (!match || !WINDOWS_SID_PATTERN.test(match[0])) {
    throw new Error('Unable to resolve the current Windows user SID');
  }
  return match[0];
}

function parseWindowsAclSnapshot(stdout: string): WindowsAclSnapshot {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    throw new Error('Windows protected local state ACL verification returned invalid JSON');
  }
  if (typeof value !== 'object' || value === null) {
    throw new Error('Windows protected local state ACL verification returned an invalid snapshot');
  }
  const candidate = value as Partial<WindowsAclSnapshot>;
  if (
    typeof candidate.ownerSid !== 'string'
    || typeof candidate.protected !== 'boolean'
    || typeof candidate.reparsePoint !== 'boolean'
    || !Array.isArray(candidate.rules)
  ) {
    throw new Error('Windows protected local state ACL verification returned an invalid snapshot');
  }
  for (const rule of candidate.rules) {
    if (
      typeof rule !== 'object'
      || rule === null
      || typeof rule.sid !== 'string'
      || typeof rule.type !== 'string'
      || typeof rule.inherited !== 'boolean'
      || typeof rule.rights !== 'string'
    ) {
      throw new Error('Windows protected local state ACL verification returned an invalid rule');
    }
  }
  return candidate as WindowsAclSnapshot;
}

function verifyWindowsAclSnapshot(snapshot: WindowsAclSnapshot, currentUserSid: string): void {
  if (snapshot.ownerSid !== currentUserSid) {
    throw new Error('Windows protected local state has an unexpected owner SID');
  }
  if (!snapshot.protected) {
    throw new Error('Windows protected local state still inherits ACL entries');
  }
  if (snapshot.reparsePoint) {
    throw new Error('Windows protected local state must not be a reparse point');
  }
  if (snapshot.rules.length !== 2) {
    throw new Error('Windows protected local state has unexpected ACL entries');
  }

  const expectedSids = new Set([currentUserSid, LOCAL_SYSTEM_SID]);
  for (const rule of snapshot.rules) {
    if (
      !expectedSids.delete(rule.sid)
      || rule.type !== 'Allow'
      || rule.inherited
      || rule.rights !== 'FullControl'
    ) {
      throw new Error('Windows protected local state has an unsafe ACL entry');
    }
  }
  if (expectedSids.size !== 0) {
    throw new Error('Windows protected local state is missing a required ACL entry');
  }
}

export function createWindowsProtectedLocalStateAclBoundary(params: Readonly<{
  runCommand?: WindowsProtectedLocalStateCommandRunner;
}> = {}): WindowsProtectedLocalStateAclBoundary {
  const runCommand = params.runCommand ?? defaultWindowsCommandRunner;
  let currentUserSidPromise: Promise<string> | null = null;

  const runChecked = async (command: string, args: readonly string[]) => {
    const result = await runCommand(command, args);
    if (result.exitCode !== 0) {
      throw new Error(`Windows protected local state command failed: ${command}`);
    }
    return result;
  };

  const resolveCurrentUserSid = async (): Promise<string> => {
    currentUserSidPromise ??= runChecked('whoami.exe', ['/user', '/fo', 'csv', '/nh'])
      .then((result) => parseCurrentUserSid(result.stdout));
    return currentUserSidPromise;
  };

  const verify = async (input: Readonly<{
    path: string;
    kind: ProtectedLocalStateKind;
  }>): Promise<void> => {
    const currentUserSid = await resolveCurrentUserSid();
    const inspection = await runChecked('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      WINDOWS_ACL_INSPECTION_SCRIPT,
      input.path,
    ]);
    verifyWindowsAclSnapshot(parseWindowsAclSnapshot(inspection.stdout), currentUserSid);
  };

  return Object.freeze({
    async applyAndVerify(input) {
      const currentUserSid = await resolveCurrentUserSid();
      const inheritance = input.kind === 'directory' ? '(OI)(CI)' : '';
      await runChecked('icacls.exe', [
        input.path,
        '/inheritancelevel:r',
        '/grant:r',
        `*${currentUserSid}:${inheritance}F`,
        `*${LOCAL_SYSTEM_SID}:${inheritance}F`,
      ]);
      await verify(input);
    },
    verify,
  });
}

function resolvePlatform(options: ProtectedLocalStateOptions): NodeJS.Platform {
  return options.platform ?? process.platform;
}

function resolveWindowsAclBoundary(
  options: ProtectedLocalStateOptions,
): WindowsProtectedLocalStateAclBoundary {
  if (options.windowsAclBoundary) return options.windowsAclBoundary;
  defaultWindowsAclBoundary ??= createWindowsProtectedLocalStateAclBoundary();
  return defaultWindowsAclBoundary;
}

function resolveExpectedUid(options: ProtectedLocalStateOptions): number {
  if (options.expectedUid !== undefined) return options.expectedUid;
  const uid = process.getuid?.();
  if (uid === undefined) {
    throw new Error('POSIX protected local state requires a current process UID');
  }
  return uid;
}

function validateStats(params: Readonly<{
  stats: Awaited<ReturnType<typeof lstat>>;
  kind: ProtectedLocalStateKind;
  platform: NodeJS.Platform;
  expectedUid?: number;
}>): void {
  if (params.stats.isSymbolicLink()) {
    throw new Error('Protected local state must not be a symbolic link');
  }
  if (params.kind === 'directory' ? !params.stats.isDirectory() : !params.stats.isFile()) {
    throw new Error(`Protected local state must be a regular ${params.kind}`);
  }
  if (params.platform !== 'win32') {
    if (Number(params.stats.uid) !== params.expectedUid) {
      throw new Error('Protected local state has an unexpected owner UID');
    }
    const forbiddenBits = params.kind === 'directory' ? 0o077 : 0o077;
    if ((Number(params.stats.mode) & forbiddenBits) !== 0) {
      throw new Error('Protected local state has unsafe group/world permissions');
    }
  }
}

async function fsyncDirectory(path: string): Promise<void> {
  const handle = await open(path, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function assertProtectedPath(
  path: string,
  kind: ProtectedLocalStateKind,
  options: ProtectedLocalStateOptions,
): Promise<Awaited<ReturnType<typeof lstat>>> {
  const platform = resolvePlatform(options);
  const stats = await lstat(path);
  validateStats({
    stats,
    kind,
    platform,
    expectedUid: platform === 'win32' ? undefined : resolveExpectedUid(options),
  });
  if (platform === 'win32') {
    await resolveWindowsAclBoundary(options).verify({ path, kind });
  }
  return stats;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return false;
    throw error;
  }
}

export async function ensureProtectedLocalStateDirectory(
  path: string,
  options: ProtectedLocalStateOptions = {},
): Promise<void> {
  const existed = await pathExists(path);
  if (!existed) {
    await mkdir(path, { recursive: true, mode: 0o700 });
    if (resolvePlatform(options) === 'win32') {
      await resolveWindowsAclBoundary(options).applyAndVerify({ path, kind: 'directory' });
    } else {
      await chmod(path, 0o700);
    }
  }
  await assertProtectedPath(path, 'directory', options);
  if (!existed) {
    await fsyncDirectory(dirname(path));
  }
}

export async function createProtectedLocalStateFileExclusive(
  path: string,
  contents: string | Uint8Array,
  options: ProtectedLocalStateOptions = {},
): Promise<void> {
  await ensureProtectedLocalStateDirectory(dirname(path), options);
  const platform = resolvePlatform(options);
  const flags = platform === 'win32'
    ? 'wx'
    : constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
  const handle = await open(path, flags, 0o600);
  try {
    const stats = await handle.stat();
    validateStats({
      stats,
      kind: 'file',
      platform,
      expectedUid: platform === 'win32' ? undefined : resolveExpectedUid(options),
    });
    if (platform === 'win32') {
      // The file is still empty here. Apply and verify its restrictive DACL
      // before any protected bytes become observable through the path.
      await resolveWindowsAclBoundary(options).applyAndVerify({ path, kind: 'file' });
    }
    await handle.writeFile(contents);
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => {});
    await rm(path, { force: true }).catch(() => {});
    throw error;
  }
  await handle.close();

  try {
    await assertProtectedPath(path, 'file', options);
    await fsyncDirectory(dirname(path));
  } catch (error) {
    await rm(path, { force: true }).catch(() => {});
    throw error;
  }
}

export async function readProtectedLocalStateFile(
  path: string,
  options: ProtectedLocalStateOptions = {},
): Promise<string> {
  const platform = resolvePlatform(options);
  const before = await assertProtectedPath(path, 'file', options);
  const flags = platform === 'win32' ? 'r' : constants.O_RDONLY | constants.O_NOFOLLOW;
  const handle = await open(path, flags);
  try {
    const opened = await handle.stat();
    validateStats({
      stats: opened,
      kind: 'file',
      platform,
      expectedUid: platform === 'win32' ? undefined : resolveExpectedUid(options),
    });
    if (opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new Error('Protected local state changed during no-follow open');
    }
    return await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
}

/**
 * Reads a one-time protected payload and removes its directory entry before
 * returning it. Callers still need an idempotent durable receipt for
 * crash-before-removal recovery; local file deletion is not a transaction.
 */
export async function consumeProtectedLocalStateFile(
  path: string,
  options: ProtectedLocalStateOptions = {},
): Promise<string> {
  const contents = await readProtectedLocalStateFile(path, options);
  await removeProtectedLocalStateFile(path, options);
  return contents;
}

export async function writeProtectedLocalStateFileAtomic(
  path: string,
  contents: string | Uint8Array,
  options: ProtectedLocalStateOptions = {},
): Promise<void> {
  await ensureProtectedLocalStateDirectory(dirname(path), options);
  if (await pathExists(path)) {
    await assertProtectedPath(path, 'file', options);
  }
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let published = false;
  try {
    await createProtectedLocalStateFileExclusive(temporaryPath, contents, options);
    await rename(temporaryPath, path);
    published = true;
    await assertProtectedPath(path, 'file', options);
    await fsyncDirectory(dirname(path));
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => {});
    if (published) {
      await rm(path, { force: true }).catch(() => {});
    }
    throw error;
  }
}

export async function removeProtectedLocalStateFile(
  path: string,
  options: ProtectedLocalStateOptions = {},
): Promise<void> {
  await assertProtectedPath(path, 'file', options);
  await rm(path);
  await fsyncDirectory(dirname(path));
}

export async function listProtectedLocalStateDirectory(
  path: string,
  options: ProtectedLocalStateOptions = {},
): Promise<readonly string[]> {
  await assertProtectedPath(path, 'directory', options);
  return readdir(path);
}
