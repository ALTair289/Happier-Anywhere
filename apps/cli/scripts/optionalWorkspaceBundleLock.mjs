import {
  closeSync,
  existsSync,
  fstatSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

function sleepSync(ms) {
  if (!ms || ms <= 0) return;
  const buffer = new SharedArrayBuffer(4);
  const view = new Int32Array(buffer);
  Atomics.wait(view, 0, 0, ms);
}

function createLockOwner() {
  const createdAtMs = Date.now();
  return {
    pid: process.pid,
    createdAtMs,
    token: `${process.pid}:${createdAtMs}:${Math.random().toString(16).slice(2)}`,
  };
}

function parseLockOwner(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return { pid: null, createdAtMs: null, token: null };

  try {
    const parsed = JSON.parse(text);
    return {
      pid: typeof parsed.pid === 'number' && Number.isFinite(parsed.pid) && parsed.pid > 0 ? parsed.pid : null,
      createdAtMs:
        typeof parsed.createdAtMs === 'number' && Number.isFinite(parsed.createdAtMs) && parsed.createdAtMs > 0
          ? parsed.createdAtMs
          : null,
      token: typeof parsed.token === 'string' && parsed.token.trim() ? parsed.token : null,
    };
  } catch {
    return { pid: null, createdAtMs: null, token: null };
  }
}

function isRunningPid(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ESRCH') return false;
    return true;
  }
}

function sameFileIdentity(a, b) {
  return Boolean(a && b && a.dev === b.dev && a.ino === b.ino);
}

function readLockSnapshot(lockPath) {
  const stats = statSync(lockPath);
  return {
    stats,
    owner: parseLockOwner(readFileSync(lockPath, 'utf8')),
    fallbackCreatedAtMs: Math.round(stats.mtimeMs),
  };
}

function isReclaimableLockSnapshot(snapshot, staleAfterMs, nowMs) {
  const owner = snapshot?.owner ?? {};
  const fallbackCreatedAtMs = snapshot?.fallbackCreatedAtMs ?? 0;
  if (owner.pid == null && owner.createdAtMs == null) {
    return nowMs - fallbackCreatedAtMs > staleAfterMs;
  }
  if (owner.pid != null) return !isRunningPid(owner.pid);
  if (owner.createdAtMs != null && nowMs - owner.createdAtMs > staleAfterMs) return true;
  return false;
}

function sameLockSnapshot(a, b) {
  if (!sameFileIdentity(a?.stats, b?.stats)) return false;
  const aOwner = a?.owner ?? {};
  const bOwner = b?.owner ?? {};
  return (
    aOwner.pid === bOwner.pid &&
    aOwner.createdAtMs === bOwner.createdAtMs &&
    aOwner.token === bOwner.token
  );
}

export function reclaimWorkspaceBundleLockIfStale(lockPath, options = {}) {
  const staleAfterMs = options.staleAfterMs;
  const nowMs = options.nowMs ?? Date.now();

  let observed;
  try {
    observed = readLockSnapshot(lockPath);
  } catch {
    try {
      unlinkSync(lockPath);
    } catch {
      // ignore
    }
    return true;
  }

  if (!isReclaimableLockSnapshot(observed, staleAfterMs, nowMs)) {
    return false;
  }

  let current;
  try {
    current = readLockSnapshot(lockPath);
  } catch {
    return true;
  }

  if (!sameLockSnapshot(observed, current)) {
    return false;
  }

  try {
    unlinkSync(lockPath);
    return true;
  } catch {
    return false;
  }
}

function writeLockOwnerToFd(fd, owner) {
  const serializedOwner = JSON.stringify(owner);
  writeSync(fd, serializedOwner, 0, 'utf8');
  ftruncateSync(fd, Buffer.byteLength(serializedOwner));
}

function refreshLockOwnerHeartbeat(lockPath, fd, owner) {
  if (fd == null || !owner?.token) return owner;

  let fdStats;
  let pathStats;
  let currentOwner;
  try {
    fdStats = fstatSync(fd);
    pathStats = statSync(lockPath);
    currentOwner = parseLockOwner(readFileSync(lockPath, 'utf8'));
  } catch {
    return owner;
  }

  if (!sameFileIdentity(fdStats, pathStats)) return owner;
  if (currentOwner.pid !== owner.pid || currentOwner.token !== owner.token) return owner;

  const refreshedOwner = { ...owner, createdAtMs: Date.now() };
  try {
    writeLockOwnerToFd(fd, refreshedOwner);
    return refreshedOwner;
  } catch {
    return owner;
  }
}

function isLockOwnedByFd(lockPath, fd, owner) {
  if (fd == null || !owner?.token) return false;

  let fdStats;
  let pathStats;
  let currentOwner;
  try {
    fdStats = fstatSync(fd);
    pathStats = statSync(lockPath);
    currentOwner = parseLockOwner(readFileSync(lockPath, 'utf8'));
  } catch {
    return false;
  }

  if (!sameFileIdentity(fdStats, pathStats)) return false;
  if (currentOwner.pid !== owner.pid || currentOwner.token !== owner.token) return false;

  return true;
}

export function releaseWorkspaceBundleLock(lockPath, fd, owner) {
  if (fd == null) return;

  const shouldRemove = isLockOwnedByFd(lockPath, fd, owner);
  try {
    closeSync(fd);
  } catch {
    // ignore
  }

  if (!shouldRemove) return;

  try {
    unlinkSync(lockPath);
  } catch {
    // ignore
  }
}

function buildLockTimeoutError(lockPath) {
  const owner = parseLockOwner(readFileSync(lockPath, 'utf8'));
  const ownerLabel =
    owner.pid != null
      ? `pid=${owner.pid}, createdAtMs=${owner.createdAtMs ?? 'unknown'}`
      : owner.createdAtMs != null
        ? `createdAtMs=${owner.createdAtMs}`
        : 'unknown owner';
  return new Error(`Timed out waiting for workspace bundle lock: ${lockPath} (${ownerLabel})`);
}

export async function withWorkspaceBundleLock(fn, options = {}) {
  const lockPath = String(options.lockPath ?? '').trim();
  if (!lockPath) {
    throw new Error('Missing workspace bundle lock path');
  }

  mkdirSync(dirname(lockPath), { recursive: true });

  const startedAt = Date.now();
  const timeoutMs = options.timeoutMs ?? 240_000;
  const pollIntervalMs = options.pollIntervalMs ?? 250;
  const staleAfterMs = options.staleAfterMs ?? timeoutMs;

  let fd = null;
  let heartbeatTimer = null;
  let owner = null;
  while (true) {
    try {
      fd = openSync(lockPath, 'wx');
      owner = createLockOwner();
      writeLockOwnerToFd(fd, owner);
      break;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      if (reclaimWorkspaceBundleLockIfStale(lockPath, { staleAfterMs, nowMs: Date.now() })) {
        continue;
      }
      if (Date.now() - startedAt > timeoutMs) {
        throw buildLockTimeoutError(lockPath);
      }
      await sleep(pollIntervalMs);
    }
  }

  try {
    if (staleAfterMs > 0) {
      const heartbeatIntervalMs = Math.max(250, Math.min(5_000, Math.floor(staleAfterMs / 4) || 250));
      heartbeatTimer = setInterval(() => {
        owner = refreshLockOwnerHeartbeat(lockPath, fd, owner);
      }, heartbeatIntervalMs);
      heartbeatTimer.unref();
    }

    return await fn();
  } finally {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    releaseWorkspaceBundleLock(lockPath, fd, owner);
  }
}

export function withWorkspaceBundleLockSync(fn, options = {}) {
  const lockPath = String(options.lockPath ?? '').trim();
  if (!lockPath) {
    throw new Error('Missing workspace bundle lock path');
  }

  mkdirSync(dirname(lockPath), { recursive: true });

  const startedAt = Date.now();
  const timeoutMs = options.timeoutMs ?? 240_000;
  const pollIntervalMs = options.pollIntervalMs ?? 250;
  const staleAfterMs = options.staleAfterMs ?? timeoutMs;

  let fd = null;
  let owner = null;
  while (true) {
    try {
      fd = openSync(lockPath, 'wx');
      owner = createLockOwner();
      writeLockOwnerToFd(fd, owner);
      break;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      if (reclaimWorkspaceBundleLockIfStale(lockPath, { staleAfterMs, nowMs: Date.now() })) {
        continue;
      }
      if (Date.now() - startedAt > timeoutMs) {
        throw buildLockTimeoutError(lockPath);
      }
      sleepSync(pollIntervalMs);
    }
  }

  try {
    return fn();
  } finally {
    releaseWorkspaceBundleLock(lockPath, fd, owner);
  }
}

function isRepoRoot(dir) {
  if (!dir) return false;
  return existsSync(resolve(dir, 'package.json')) && existsSync(resolve(dir, 'yarn.lock'));
}

export function findRepoRoot(startDir) {
  let dir = resolve(String(startDir ?? process.cwd()));
  for (let i = 0; i < 10; i++) {
    if (isRepoRoot(dir)) {
      return dir;
    }
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export function resolveCliSharedDepsBuildLockPath(repoRoot) {
  return resolve(repoRoot, '.project', 'tmp', 'cli-dist-build.lock');
}

export function resolveCliSharedDepsBuildLockOptions(options = {}) {
  if (options.skipLock === true) {
    return null;
  }
  const explicitLockPath = String(options.lockPath ?? '').trim();
  const explicitRepoRoot = String(options.repoRoot ?? '').trim();
  const repoRoot = explicitRepoRoot ? resolve(explicitRepoRoot) : findRepoRoot(options.startDir);
  if (!explicitLockPath && !repoRoot) {
    return null;
  }
  if (!explicitLockPath && repoRoot && !isRepoRoot(repoRoot)) {
    return null;
  }

  const timeoutMs = options.lockTimeoutMs ?? options.timeoutMs ?? 240_000;
  return {
    lockPath: explicitLockPath || resolveCliSharedDepsBuildLockPath(repoRoot),
    timeoutMs,
    pollIntervalMs: options.lockPollIntervalMs ?? options.pollIntervalMs ?? 250,
    staleAfterMs: options.lockStaleAfterMs ?? options.staleAfterMs ?? timeoutMs,
  };
}

export async function withOptionalCliSharedDepsBuildLock(fn, options = {}) {
  const lockOptions = resolveCliSharedDepsBuildLockOptions(options);
  if (!lockOptions) {
    return await fn();
  }
  return await withWorkspaceBundleLock(fn, lockOptions);
}

export function withOptionalCliSharedDepsBuildLockSync(fn, options = {}) {
  const lockOptions = resolveCliSharedDepsBuildLockOptions(options);
  if (!lockOptions) {
    return fn();
  }
  return withWorkspaceBundleLockSync(fn, lockOptions);
}
