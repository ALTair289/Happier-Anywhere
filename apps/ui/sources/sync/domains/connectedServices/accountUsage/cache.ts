import {
  ProviderAccountUsageRecordIdSchema,
  type ProviderAccountUsageRecordId,
  type ProviderAccountUsageSnapshotV1,
} from '@happier-dev/protocol';

type ScopeCache = Map<ProviderAccountUsageRecordId, ProviderAccountUsageSnapshotV1>;

const snapshotsByCredentialScope = new Map<string, ScopeCache>();
const versionsByCredentialScope = new Map<string, number>();
const listenersByCredentialScope = new Map<string, Set<() => void>>();

function normalizeCredentialScope(credentialScope: string): string {
  return String(credentialScope ?? '').trim();
}

function getScopeCache(credentialScope: string, create: true): ScopeCache;
function getScopeCache(credentialScope: string, create?: false): ScopeCache | null;
function getScopeCache(credentialScope: string, create = false): ScopeCache | null {
  const scope = normalizeCredentialScope(credentialScope);
  if (!scope) return null;
  const existing = snapshotsByCredentialScope.get(scope);
  if (existing || !create) return existing ?? null;
  const created: ScopeCache = new Map();
  snapshotsByCredentialScope.set(scope, created);
  return created;
}

function notifyScopeCacheChanged(credentialScope: string): void {
  const scope = normalizeCredentialScope(credentialScope);
  if (!scope) return;
  versionsByCredentialScope.set(scope, (versionsByCredentialScope.get(scope) ?? 0) + 1);
  const listeners = listenersByCredentialScope.get(scope);
  if (!listeners) return;
  for (const listener of listeners) listener();
}

export function writeProviderAccountUsageSnapshotToCache(params: Readonly<{
  credentialScope: string;
  snapshot: ProviderAccountUsageSnapshotV1;
}>): void {
  const parsedRecordId = ProviderAccountUsageRecordIdSchema.safeParse(params.snapshot.recordId);
  if (!parsedRecordId.success) return;
  const cache = getScopeCache(params.credentialScope, true);
  const existing = cache.get(parsedRecordId.data);
  if (existing && params.snapshot.fetchedAtMs < existing.fetchedAtMs) return;
  if (existing === params.snapshot) return;
  cache.set(parsedRecordId.data, params.snapshot);
  notifyScopeCacheChanged(params.credentialScope);
}

export function readProviderAccountUsageSnapshotFromCache(params: Readonly<{
  credentialScope: string;
  recordId: ProviderAccountUsageRecordId | string;
}>): ProviderAccountUsageSnapshotV1 | null {
  const parsedRecordId = ProviderAccountUsageRecordIdSchema.safeParse(params.recordId);
  if (!parsedRecordId.success) return null;
  return getScopeCache(params.credentialScope)?.get(parsedRecordId.data) ?? null;
}

export function readProviderAccountUsageSnapshotsFromCache(params: Readonly<{
  credentialScope: string;
}>): Record<string, ProviderAccountUsageSnapshotV1> {
  const cache = getScopeCache(params.credentialScope);
  if (!cache) return {};
  return Object.fromEntries(cache.entries());
}

export function readProviderAccountUsageSnapshotCacheVersion(params: Readonly<{
  credentialScope: string;
}>): number {
  const scope = normalizeCredentialScope(params.credentialScope);
  if (!scope) return 0;
  return versionsByCredentialScope.get(scope) ?? 0;
}

export function subscribeProviderAccountUsageSnapshotCache(params: Readonly<{
  credentialScope: string;
}>, listener: () => void): () => void {
  const scope = normalizeCredentialScope(params.credentialScope);
  if (!scope) return () => {};
  let listeners = listenersByCredentialScope.get(scope);
  if (!listeners) {
    listeners = new Set();
    listenersByCredentialScope.set(scope, listeners);
  }
  listeners.add(listener);
  return () => {
    listeners?.delete(listener);
    if (listeners && listeners.size === 0) {
      listenersByCredentialScope.delete(scope);
    }
  };
}

export function __resetProviderAccountUsageSnapshotCache(): void {
  snapshotsByCredentialScope.clear();
  versionsByCredentialScope.clear();
  listenersByCredentialScope.clear();
}
