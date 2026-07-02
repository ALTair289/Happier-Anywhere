import {
  ProviderAccountUsageRecordIdSchema,
  ProviderAccountUsageSnapshotV1Schema,
  openProviderAccountUsageSnapshotCiphertext,
  readProviderAccountUsageRecordIdsFromMetadata,
  type ConnectedServiceUsageSourceV1,
  type ProviderAccountUsageRecordId,
  type ProviderAccountUsageSnapshotV1,
  type SealedProviderAccountUsageSnapshotV1,
} from '@happier-dev/protocol';

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
  sources?: readonly ConnectedServiceUsageSourceV1[];
}>;

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
    ...(response.sources !== undefined ? { sources: response.sources } : {}),
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
    ...(response.sources !== undefined ? { sources: response.sources } : {}),
  } : null;
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
        input.store.recordSnapshot(hydrated.snapshot, hydrated.sources?.length ? { sources: hydrated.sources } : undefined);
        hydratedRecordIds.push(parsedRecordId.data);
      }
    }
  }

  return { hydratedRecordIds };
}
