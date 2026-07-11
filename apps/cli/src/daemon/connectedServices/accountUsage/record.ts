import {
  ProviderAccountUsageSnapshotV1Schema,
  writeProviderAccountUsageRecordIdToMetadata,
  type ConnectedServiceUsageSourceV1,
  type ProviderAccountUsageSnapshotV1,
} from '@happier-dev/protocol';

import type { ProviderAccountUsagePersistenceScheduler } from './persistence';
import {
  type ProviderAccountUsageObservation,
  type ProviderAccountUsageStore,
  type ProviderAccountUsageStoreMutationStatus,
} from './store';

type TrackedSessionLike = Readonly<{
  happySessionId?: unknown;
}>;

type ProviderAccountUsagePersistenceResult =
  | Readonly<{ status: 'persisted' }>
  | Awaited<ReturnType<ProviderAccountUsagePersistenceScheduler['recordInBandSnapshot']>>;

export type ProviderAccountUsageRecordIdPublisher = (input: Readonly<{
  sessionId: string;
  recordId: string;
}>) => Promise<void>;

function normalizeSessionId(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function findTrackedSession(
  children: ReadonlyArray<TrackedSessionLike | unknown>,
  sessionId: string,
): TrackedSessionLike | null {
  const normalized = normalizeSessionId(sessionId);
  if (!normalized) return null;
  return (children as ReadonlyArray<TrackedSessionLike>)
    .find((child) => normalizeSessionId(child.happySessionId) === normalized) ?? null;
}

function normalizeProviderAccountId(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function canRecordProviderAccountUsageSourceLinks(input: Readonly<{
  snapshot: ProviderAccountUsageSnapshotV1;
  sourceProviderAccountId?: string | null;
}>): boolean {
  const sourceProviderAccountId = normalizeProviderAccountId(input.sourceProviderAccountId);
  if (!sourceProviderAccountId) return false;
  const parsed = ProviderAccountUsageSnapshotV1Schema.parse(input.snapshot);
  if (parsed.recordKey.subjectKind !== 'account' || !parsed.recordKey.accountSubjectId) return false;
  return parsed.recordKey.accountSubjectId === sourceProviderAccountId;
}

export function authorizeProviderAccountUsageObservation(input: Readonly<{
  snapshot: ProviderAccountUsageSnapshotV1;
  observation?: ProviderAccountUsageObservation;
  sourceProviderAccountId?: string | null;
}>): ProviderAccountUsageObservation | undefined {
  if (!input.observation?.sources?.length) return undefined;
  if (!canRecordProviderAccountUsageSourceLinks({
    snapshot: input.snapshot,
    sourceProviderAccountId: input.sourceProviderAccountId,
  })) {
    return undefined;
  }
  return { sources: input.observation.sources };
}

export function createProviderAccountUsageRecordIdMetadataPublisher(params: Readonly<{
  now: () => number;
  updateMetadata: (
    sessionId: string,
    updater: (metadata: Record<string, unknown>) => Record<string, unknown>,
  ) => Promise<void>;
}>): ProviderAccountUsageRecordIdPublisher {
  return async ({ sessionId, recordId }) => {
    await params.updateMetadata(sessionId, (metadata) => writeProviderAccountUsageRecordIdToMetadata(metadata, {
      recordId,
      updatedAtMs: params.now(),
    }));
  };
}

export async function recordProviderAccountUsageSnapshotForSession(input: Readonly<{
  getChildren: () => ReadonlyArray<TrackedSessionLike | unknown>;
  store: Pick<ProviderAccountUsageStore, 'recordSnapshot' | 'resolveRecordId'>;
  persistence: Pick<ProviderAccountUsagePersistenceScheduler, 'recordInBandSnapshot'> | null;
  publishRecordId?: ProviderAccountUsageRecordIdPublisher;
  sourceProviderAccountId?: string | null;
  observation?: Readonly<{
    sources?: readonly ConnectedServiceUsageSourceV1[];
  }>;
  sessionId: string;
  snapshot: ProviderAccountUsageSnapshotV1;
}>): Promise<
  | Readonly<{
      status: ProviderAccountUsageStoreMutationStatus;
      recordId: string;
      persisted: boolean;
    }>
  | Readonly<{ status: 'session_not_found' }>
> {
  const tracked = findTrackedSession(input.getChildren(), input.sessionId);
  if (!tracked) return { status: 'session_not_found' };

  const snapshot = ProviderAccountUsageSnapshotV1Schema.parse(input.snapshot);
  const observation: ProviderAccountUsageObservation = {
    ...(input.observation?.sources ? { sources: input.observation.sources } : {}),
  };
  const authorizedObservation = authorizeProviderAccountUsageObservation({
    snapshot,
    observation,
    sourceProviderAccountId: input.sourceProviderAccountId,
  });
  const recorded = input.store.recordSnapshot(snapshot, authorizedObservation);
  const changed = recorded.status === 'snapshot_advanced' || recorded.status === 'source_linked';

  let persisted = false;
  if (input.persistence && changed) {
    try {
      const result = await input.persistence.recordInBandSnapshot(
        input.store.resolveRecordId(recorded.recordId) ?? snapshot,
        authorizedObservation?.sources?.length ? { sources: authorizedObservation.sources } : undefined,
      ) as ProviderAccountUsagePersistenceResult;
      persisted = result.status === 'persisted';
    } catch {
      persisted = false;
    }
  }

  if (persisted) {
    try {
      await input.publishRecordId?.({
        sessionId: input.sessionId,
        recordId: recorded.recordId,
      });
    } catch {
      // Session metadata refs are a best-effort projection over the canonical persisted record.
    }
  }

  return {
    status: recorded.status,
    recordId: recorded.recordId,
    persisted,
  };
}
