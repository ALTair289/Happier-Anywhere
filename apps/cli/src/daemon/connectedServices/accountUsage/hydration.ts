import {
  ConnectedServiceUsageSourceV1Schema,
  ProviderAccountUsageRecordIdSchema,
  ProviderAccountUsageSnapshotV1Schema,
  openProviderAccountUsageSnapshotCiphertext,
  readProviderAccountUsageRecordIdsFromMetadata,
  type ConnectedServiceUsageSourceV1,
  type ProviderAccountUsageRecordId,
  type ProviderAccountUsageSnapshotV1,
  type SealedProviderAccountUsageSnapshotV1,
} from '@happier-dev/protocol';
import { AGENTS_CORE } from '@happier-dev/agents';

import type { Credentials } from '@/persistence';

import type { ProviderAccountUsageStore } from './store';

type ProviderAccountUsageHydrationApi = Readonly<{
  getAccountEncryptionMode?: () => Promise<'plain' | 'e2ee' | 'unknown'>;
  getProviderAccountUsageSnapshotPlain?: (args: Readonly<{ recordId: ProviderAccountUsageRecordId }>) => Promise<
    | null
    | Readonly<{
        content: Readonly<{ t: 'plain'; v: ProviderAccountUsageSnapshotV1 }>;
        sources?: readonly ConnectedServiceUsageSourceV1[];
      }>
  >;
  getProviderAccountUsageSnapshotSealed?: (args: Readonly<{ recordId: ProviderAccountUsageRecordId }>) => Promise<
    | null
    | Readonly<{
        sealed: SealedProviderAccountUsageSnapshotV1;
        sources?: readonly ConnectedServiceUsageSourceV1[];
      }>
  >;
}>;

type HydratedProviderAccountUsageSnapshot = Readonly<{
  snapshot: ProviderAccountUsageSnapshotV1;
  sources: readonly ConnectedServiceUsageSourceV1[];
}>;

export type ProviderAccountUsageCurrentSourceHydrationDisposition = Readonly<{
  source: ConnectedServiceUsageSourceV1;
  status: 'hydrated_fresh' | 'hydrated_stale' | 'missing' | 'ownership_unproven';
  recordId?: ProviderAccountUsageRecordId;
}>;

function parseConnectedServiceUsageSources(value: unknown): readonly ConnectedServiceUsageSourceV1[] {
  const parsed = ConnectedServiceUsageSourceV1Schema.array().safeParse(value ?? []);
  return parsed.success ? parsed.data : [];
}

function connectedServiceUsageSourceKey(source: ConnectedServiceUsageSourceV1): string {
  const parsed = ConnectedServiceUsageSourceV1Schema.parse(source);
  return JSON.stringify([
    parsed.serviceId,
    parsed.profileId,
    parsed.bindingKind,
    parsed.groupId ?? '',
    parsed.groupGeneration ?? null,
  ]);
}

function isProviderCompatibleWithConnectedServiceSource(input: Readonly<{
  providerId: string;
  source: ConnectedServiceUsageSourceV1;
}>): boolean {
  const providerId = input.providerId.trim();
  if (!providerId) return false;
  if (providerId === input.source.serviceId) return true;
  const provider = (AGENTS_CORE as Readonly<Record<string, Readonly<{
    connectedServices?: Readonly<{ supportedServiceIds: readonly string[] }> | null;
  }>>>)[providerId];
  return provider?.connectedServices?.supportedServiceIds.includes(input.source.serviceId) === true;
}

type HydrationTrackedSession = Readonly<{
  happySessionId?: unknown;
  happySessionMetadataFromLocalWebhook?: unknown;
}>;

function normalizeSessionId(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function accountScopedMaterial(credentials: Credentials): Parameters<typeof openProviderAccountUsageSnapshotCiphertext>[0]['material'] {
  return credentials.encryption.type === 'legacy'
    ? { type: 'legacy', secret: credentials.encryption.secret }
    : { type: 'dataKey', machineKey: credentials.encryption.machineKey };
}

function parseProviderAccountUsageSnapshot(value: unknown): ProviderAccountUsageSnapshotV1 | null {
  const parsed = ProviderAccountUsageSnapshotV1Schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function parseProviderAccountUsageSnapshotForRecordId(input: Readonly<{
  value: unknown;
  recordId: ProviderAccountUsageRecordId;
}>): ProviderAccountUsageSnapshotV1 | null {
  const snapshot = parseProviderAccountUsageSnapshot(input.value);
  return snapshot?.recordId === input.recordId ? snapshot : null;
}

async function openPlainProviderAccountUsageSnapshot(input: Readonly<{
  api: ProviderAccountUsageHydrationApi;
  recordId: ProviderAccountUsageRecordId;
}>): Promise<HydratedProviderAccountUsageSnapshot | null> {
  if (!input.api.getProviderAccountUsageSnapshotPlain) return null;
  const response = await input.api.getProviderAccountUsageSnapshotPlain({ recordId: input.recordId }).catch(() => null);
  if (response?.content?.t !== 'plain') return null;
  const snapshot = parseProviderAccountUsageSnapshotForRecordId({
    value: response.content.v,
    recordId: input.recordId,
  });
  return snapshot ? {
    snapshot,
    sources: parseConnectedServiceUsageSources(response.sources),
  } : null;
}

async function openSealedProviderAccountUsageSnapshot(input: Readonly<{
  api: ProviderAccountUsageHydrationApi;
  credentials: Credentials;
  recordId: ProviderAccountUsageRecordId;
}>): Promise<HydratedProviderAccountUsageSnapshot | null> {
  if (!input.api.getProviderAccountUsageSnapshotSealed) return null;
  const response = await input.api.getProviderAccountUsageSnapshotSealed({ recordId: input.recordId }).catch(() => null);
  const ciphertext = response?.sealed?.ciphertext;
  if (!ciphertext) return null;
  const opened = openProviderAccountUsageSnapshotCiphertext({
    material: accountScopedMaterial(input.credentials),
    ciphertext,
  });
  const snapshot = parseProviderAccountUsageSnapshotForRecordId({
    value: opened?.value,
    recordId: input.recordId,
  });
  return snapshot ? {
    snapshot,
    sources: parseConnectedServiceUsageSources(response.sources),
  } : null;
}

/**
 * Passively reconstructs canonical PAU state for the exact current connected-service sources.
 *
 * The source-to-record resolver is the authoritative server-relation boundary. Hydration still
 * requires the fetched record to return that exact active source, including group generation,
 * before installing either the snapshot or its source alias. This owner intentionally exposes
 * stale/missing sources as refresh work instead of polling, notifying policy, clearing recovery,
 * or switching accounts itself.
 */
export async function hydrateProviderAccountUsageStoreFromCurrentSources(input: Readonly<{
  sources: Iterable<ConnectedServiceUsageSourceV1>;
  resolveRecordIdForSource: (
    source: ConnectedServiceUsageSourceV1,
  ) => Promise<Readonly<{ recordId: ProviderAccountUsageRecordId }> | null>;
  api: ProviderAccountUsageHydrationApi;
  credentials: Credentials;
  store: Pick<ProviderAccountUsageStore, 'recordSnapshot'>;
  nowMs: number;
}>): Promise<Readonly<{
  hydratedRecordIds: ProviderAccountUsageRecordId[];
  dispositions: ProviderAccountUsageCurrentSourceHydrationDisposition[];
  refreshSources: ConnectedServiceUsageSourceV1[];
}>> {
  const sourcesByKey = new Map<string, ConnectedServiceUsageSourceV1>();
  for (const rawSource of input.sources) {
    const parsed = ConnectedServiceUsageSourceV1Schema.safeParse(rawSource);
    if (!parsed.success) continue;
    sourcesByKey.set(connectedServiceUsageSourceKey(parsed.data), parsed.data);
  }

  const hydratedRecordIds = new Set<ProviderAccountUsageRecordId>();
  const dispositions: ProviderAccountUsageCurrentSourceHydrationDisposition[] = [];
  const refreshSources: ConnectedServiceUsageSourceV1[] = [];
  const snapshotsByRecordId = new Map<ProviderAccountUsageRecordId, HydratedProviderAccountUsageSnapshot | null>();
  const nowMs = Number.isFinite(input.nowMs) ? Math.max(0, Math.trunc(input.nowMs)) : 0;

  for (const source of sourcesByKey.values()) {
    const resolved = await input.resolveRecordIdForSource(source).catch(() => null);
    const parsedRecordId = ProviderAccountUsageRecordIdSchema.safeParse(resolved?.recordId);
    if (!parsedRecordId.success) {
      dispositions.push({ source, status: 'missing' });
      refreshSources.push(source);
      continue;
    }

    let hydrated = snapshotsByRecordId.get(parsedRecordId.data);
    if (hydrated === undefined) {
      hydrated = await openProviderAccountUsageSnapshotForHydration({
        api: input.api,
        credentials: input.credentials,
        recordId: parsedRecordId.data,
      });
      snapshotsByRecordId.set(parsedRecordId.data, hydrated);
    }
    if (!hydrated) {
      dispositions.push({ source, status: 'missing' });
      refreshSources.push(source);
      continue;
    }

    const exactSourceKey = connectedServiceUsageSourceKey(source);
    const sourceProven = hydrated.sources.some(
      (candidate) => connectedServiceUsageSourceKey(candidate) === exactSourceKey,
    );
    if (!sourceProven || !isProviderCompatibleWithConnectedServiceSource({
      providerId: hydrated.snapshot.providerId,
      source,
    })) {
      dispositions.push({ source, status: 'ownership_unproven' });
      refreshSources.push(source);
      continue;
    }

    input.store.recordSnapshot(hydrated.snapshot, { sources: [source] });
    hydratedRecordIds.add(parsedRecordId.data);
    const staleAtMs = hydrated.snapshot.fetchedAtMs + hydrated.snapshot.staleAfterMs;
    const isFresh = nowMs < staleAtMs;
    dispositions.push({
      source,
      status: isFresh ? 'hydrated_fresh' : 'hydrated_stale',
      recordId: parsedRecordId.data,
    });
    if (!isFresh) refreshSources.push(source);
  }

  return {
    hydratedRecordIds: [...hydratedRecordIds],
    dispositions,
    refreshSources,
  };
}

async function openProviderAccountUsageSnapshotForHydration(input: Readonly<{
  api: ProviderAccountUsageHydrationApi;
  credentials: Credentials;
  recordId: ProviderAccountUsageRecordId;
}>): Promise<HydratedProviderAccountUsageSnapshot | null> {
  const mode = input.api.getAccountEncryptionMode
    ? await input.api.getAccountEncryptionMode().catch(() => 'unknown' as const)
    : 'unknown';
  if (mode === 'plain') {
    return await openPlainProviderAccountUsageSnapshot(input);
  }
  if (mode === 'e2ee') {
    return await openSealedProviderAccountUsageSnapshot(input);
  }
  return await openPlainProviderAccountUsageSnapshot(input)
    ?? await openSealedProviderAccountUsageSnapshot(input);
}

export async function hydrateProviderAccountUsageStoreFromSessionMetadata<TTracked extends HydrationTrackedSession>(input: Readonly<{
  trackedSessions: Iterable<TTracked>;
  resolvePersistedSessionMetadata?: (input: Readonly<{
    sessionId: string;
    tracked: TTracked;
  }>) => Promise<unknown> | unknown;
  api: ProviderAccountUsageHydrationApi;
  credentials: Credentials;
  store: Pick<ProviderAccountUsageStore, 'recordSnapshot'>;
}>): Promise<Readonly<{ hydratedRecordIds: ProviderAccountUsageRecordId[] }>> {
  const seenRecordIds = new Set<string>();
  const hydratedRecordIds: ProviderAccountUsageRecordId[] = [];

  for (const tracked of input.trackedSessions) {
    const sessionId = normalizeSessionId(tracked.happySessionId);
    const metadataCandidates: unknown[] = [];
    if (sessionId && input.resolvePersistedSessionMetadata) {
      try {
        metadataCandidates.push(await input.resolvePersistedSessionMetadata({ sessionId, tracked }));
      } catch {
        metadataCandidates.push(null);
      }
    }
    metadataCandidates.push(tracked.happySessionMetadataFromLocalWebhook);

    for (const metadata of metadataCandidates) {
      const recordIds = readProviderAccountUsageRecordIdsFromMetadata(metadata);
      for (const rawRecordId of recordIds) {
        const parsedRecordId = ProviderAccountUsageRecordIdSchema.safeParse(rawRecordId);
        if (!parsedRecordId.success || seenRecordIds.has(parsedRecordId.data)) continue;
        seenRecordIds.add(parsedRecordId.data);
        const hydrated = await openProviderAccountUsageSnapshotForHydration({
          api: input.api,
          credentials: input.credentials,
          recordId: parsedRecordId.data,
        });
        if (!hydrated) continue;
        input.store.recordSnapshot(hydrated.snapshot, hydrated.sources.length ? { sources: hydrated.sources } : undefined);
        hydratedRecordIds.push(parsedRecordId.data);
      }
    }
  }

  return { hydratedRecordIds };
}
