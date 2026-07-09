import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const destinationLocks = new Map<string, Promise<void>>();

export class ConnectedServiceStateSharingLockError extends Error {
  readonly code = 'state_sharing_lock_unavailable';
  readonly providerId: string | null;
  readonly destinationHome: string;
  readonly owner: ConnectedServiceStateSharingLockOwnerDiagnostic | null;

  constructor(params: Readonly<{
    providerId?: string | null;
    destinationHome: string;
    owner?: ConnectedServiceStateSharingLockOwnerDiagnostic | null;
  }>) {
    super(`Connected-service state sharing lock is unavailable for ${params.destinationHome}`);
    this.name = 'ConnectedServiceStateSharingLockError';
    this.providerId = params.providerId ?? null;
    this.destinationHome = params.destinationHome;
    this.owner = params.owner ?? null;
  }
}

export type ConnectedServiceStateSharingLockOwnerDiagnostic = Readonly<{
  pid: number | null;
  providerId: string | null;
  acquiredAt: string | null;
  acquiredAtMs: number | null;
  ageMs: number | null;
  alive: boolean | null;
}>;

type LockOptions = Readonly<{
  providerId?: string | null;
  acquireTimeoutMs?: number;
  retryDelayMs?: number;
  staleLockTimeoutMs?: number;
}>;

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    return err?.code === 'EPERM';
  }
}

async function readLockOwner(lockDir: string): Promise<Readonly<{ pid?: number; providerId?: string | null; acquiredAt?: string }> | null> {
  try {
    return JSON.parse(await readFile(join(lockDir, 'owner.json'), 'utf8')) as Readonly<{ pid?: number; providerId?: string | null; acquiredAt?: string }>;
  } catch {
    return null;
  }
}

async function readLockOwnerDiagnostic(lockDir: string): Promise<ConnectedServiceStateSharingLockOwnerDiagnostic | null> {
  const owner = await readLockOwner(lockDir);
  if (!owner) return null;
  const pid = typeof owner.pid === 'number' && Number.isSafeInteger(owner.pid) && owner.pid > 0
    ? owner.pid
    : null;
  const acquiredAt = typeof owner.acquiredAt === 'string' ? owner.acquiredAt : null;
  const acquiredAtMs = acquiredAt ? Date.parse(acquiredAt) : NaN;
  return {
    pid,
    providerId: typeof owner.providerId === 'string' && owner.providerId.trim().length > 0
      ? owner.providerId
      : null,
    acquiredAt,
    acquiredAtMs: Number.isFinite(acquiredAtMs) ? acquiredAtMs : null,
    ageMs: Number.isFinite(acquiredAtMs) ? Math.max(0, Date.now() - acquiredAtMs) : null,
    alive: pid === null ? null : isProcessAlive(pid),
  };
}

async function removeStaleFileLock(lockDir: string, staleLockTimeoutMs: number): Promise<boolean> {
  const lockStat = await stat(lockDir).catch(() => null);
  if (!lockStat) return false;
  const owner = await readLockOwner(lockDir);
  const acquiredAtMs = typeof owner?.acquiredAt === 'string' ? Date.parse(owner.acquiredAt) : NaN;
  const lockAgeMs = Date.now() - (Number.isFinite(acquiredAtMs) ? acquiredAtMs : lockStat.mtimeMs);
  if (lockAgeMs < staleLockTimeoutMs) return false;
  if (typeof owner?.pid === 'number' && isProcessAlive(owner.pid)) return false;
  await rm(lockDir, { recursive: true, force: true });
  return true;
}

async function acquireFileLock(destinationHome: string, options: LockOptions): Promise<string> {
  await mkdir(destinationHome, { recursive: true });
  const lockDir = join(destinationHome, '.happier-state-sharing.lock');
  const startedAt = Date.now();
  const acquireTimeoutMs = options.acquireTimeoutMs ?? 10_000;
  const retryDelayMs = options.retryDelayMs ?? 25;
  const staleLockTimeoutMs = options.staleLockTimeoutMs ?? 5 * 60_000;
  for (;;) {
    try {
      await mkdir(lockDir);
      await writeFile(join(lockDir, 'owner.json'), JSON.stringify({
        pid: process.pid,
        providerId: options.providerId ?? null,
        acquiredAt: new Date().toISOString(),
      }));
      return lockDir;
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err?.code !== 'EEXIST') throw error;
      if (await removeStaleFileLock(lockDir, staleLockTimeoutMs)) {
        continue;
      }
      if (Date.now() - startedAt >= acquireTimeoutMs) {
        throw new ConnectedServiceStateSharingLockError({
          providerId: options.providerId ?? null,
          destinationHome,
          owner: await readLockOwnerDiagnostic(lockDir),
        });
      }
      await sleep(retryDelayMs);
    }
  }
}

async function withInProcessDestinationLock<T>(destinationHome: string, fn: () => Promise<T>): Promise<T> {
  const key = resolve(destinationHome);
  const previous = destinationLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolvePromise) => {
    release = resolvePromise;
  });
  const queued = previous.catch(() => undefined).then(() => current);
  destinationLocks.set(key, queued);
  await previous.catch(() => undefined);
  try {
    return await fn();
  } finally {
    release();
    if (destinationLocks.get(key) === queued) {
      destinationLocks.delete(key);
    }
  }
}

export async function withConnectedServiceStateSharingDestinationLock<T>(
  destinationHome: string,
  fn: () => Promise<T>,
  options: LockOptions = {},
): Promise<T> {
  return await withInProcessDestinationLock(destinationHome, async () => {
    const lockDir = await acquireFileLock(destinationHome, options);
    try {
      return await fn();
    } finally {
      await rm(lockDir, { recursive: true, force: true });
    }
  });
}
