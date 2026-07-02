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
} from './store';

type TrackedSessionLike = Readonly<{
  happySessionId?: unknown;
}>;

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
  observation?: Readonly<{
    sources?: readonly ConnectedServiceUsageSourceV1[];
  }>;
  sessionId: string;
  snapshot: ProviderAccountUsageSnapshotV1;
}>): Promise<
  | Readonly<{ status: 'recorded'; recordId: string; persisted: boolean }>
  | Readonly<{ status: 'session_not_found' }>
> {
  const tracked = findTrackedSession(input.getChildren(), input.sessionId);
  if (!tracked) return { status: 'session_not_found' };

  const snapshot = ProviderAccountUsageSnapshotV1Schema.parse(input.snapshot);
  const observation: ProviderAccountUsageObservation = {
    ...(input.observation?.sources ? { sources: input.observation.sources } : {}),
  };
  const recorded = input.store.recordSnapshot(snapshot, observation);

  let persisted = false;
  if (input.persistence) {
    try {
      await input.persistence.recordInBandSnapshot(
        input.store.resolveRecordId(recorded.recordId) ?? snapshot,
        input.observation?.sources?.length ? { sources: input.observation.sources } : undefined,
      );
      persisted = true;
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

  return { status: 'recorded', recordId: recorded.recordId, persisted };
}
