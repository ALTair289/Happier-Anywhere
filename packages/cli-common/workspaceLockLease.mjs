import { statSync } from 'node:fs';
import { resolve } from 'node:path';

const WORKSPACE_LOCK_LEASE_VERSION = 1;

function normalizeWorkspaceLockPath(lockPath) {
  const normalized = resolve(String(lockPath ?? '').trim());
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function pathsIdentifySameFile(a, b) {
  try {
    const aStats = statSync(a);
    const bStats = statSync(b);
    return aStats.dev === bStats.dev && aStats.ino === bStats.ino;
  } catch {
    return false;
  }
}

export function createWorkspaceLockLeaseValue({ lockPath, ownerToken }) {
  const normalizedPath = String(lockPath ?? '').trim();
  const normalizedToken = String(ownerToken ?? '').trim();
  if (!normalizedPath) throw new Error('Cannot create a workspace lock lease without a lock path');
  if (!normalizedToken) throw new Error('Cannot create a workspace lock lease without an owner token');

  return JSON.stringify({
    v: WORKSPACE_LOCK_LEASE_VERSION,
    path: resolve(normalizedPath),
    token: normalizedToken,
  });
}

export function parseWorkspaceLockLeaseValue(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;

  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || parsed.v !== WORKSPACE_LOCK_LEASE_VERSION) return null;
    const path = String(parsed.path ?? '').trim();
    const token = String(parsed.token ?? '').trim();
    if (!path || !token) return null;
    return { path: resolve(path), token };
  } catch {
    // Path-only values are deliberately rejected: a successor may own the same path.
    return null;
  }
}

export function workspaceLockLeaseMatchesOwner({ lockPath, leaseValue, owner }) {
  const lease = parseWorkspaceLockLeaseValue(leaseValue);
  const ownerToken = typeof owner?.token === 'string' ? owner.token.trim() : '';
  if (!lease || !ownerToken) return false;
  const samePath = normalizeWorkspaceLockPath(lease.path) === normalizeWorkspaceLockPath(lockPath);
  return (samePath || pathsIdentifySameFile(lease.path, lockPath)) && lease.token === ownerToken;
}
