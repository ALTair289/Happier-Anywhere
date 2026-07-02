import type {
  ConnectedServiceId,
  ConnectedServiceQuotaSnapshotV1,
} from '@happier-dev/protocol';

export type ConnectedServiceQuotaSnapshotDeliveryBody = Readonly<{
  sessionId: string;
  serviceId: ConnectedServiceId;
  snapshot: ConnectedServiceQuotaSnapshotV1;
}>;

export type ConnectedServiceQuotaSnapshotDeliveryInput = ConnectedServiceQuotaSnapshotDeliveryBody & Readonly<{
  groupId?: string | null;
  groupGeneration?: number | null;
}>;

export type ConnectedServiceQuotaSnapshotDeliveryFlushReason =
  | 'initial'
  | 'periodic_retry'
  | 'daemon_reconnect'
  | 'session_report'
  | 'manual_flush';

export type ConnectedServiceQuotaSnapshotDeliveryDiagnostic = Readonly<{
  event: 'quota_snapshot_delivery_retrying' | 'quota_snapshot_delivery_dropped';
  phase: 'quota_snapshot_delivery';
  reason:
    | 'daemon_quota_snapshot_delivery_failed'
    | 'quota_snapshot_outbox_overflow';
  sessionId: string;
  serviceId: ConnectedServiceId;
  profileId: string;
  groupId: string | null;
  activeAccountId: string | null;
  groupGeneration: number | null;
  attemptCount: number;
  maxAttempts: number;
  lastError: string | null;
  flushReason: ConnectedServiceQuotaSnapshotDeliveryFlushReason;
}>;

export type ConnectedServiceQuotaSnapshotDeliveryOutbox = Readonly<{
  enqueue(input: ConnectedServiceQuotaSnapshotDeliveryInput): void;
  enqueueAndFlush(
    input: ConnectedServiceQuotaSnapshotDeliveryInput,
  ): Promise<ConnectedServiceQuotaSnapshotDeliveryFlushResult>;
  flushPending(options?: Readonly<{
    reason?: ConnectedServiceQuotaSnapshotDeliveryFlushReason;
    sessionId?: string;
  }>): Promise<ConnectedServiceQuotaSnapshotDeliveryFlushResult>;
  clearSession(sessionId: string): number;
  pendingCount(): number;
}>;

export type ConnectedServiceQuotaSnapshotDeliveryFlushResult = Readonly<{
  attempted: number;
  delivered: number;
  pending: number;
  dropped: number;
}>;

type DeliverConnectedServiceQuotaSnapshot = (
  body: ConnectedServiceQuotaSnapshotDeliveryInput,
) => Promise<unknown> | unknown;

type PendingDelivery = Readonly<{
  input: ConnectedServiceQuotaSnapshotDeliveryInput;
  attempts: number;
  lastError: string | null;
}>;

const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_MAX_PENDING_ENTRIES = 256;

function readDeliveryError(result: unknown): string | null {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return null;
  const record = result as Readonly<Record<string, unknown>>;
  const error = record.error;
  if (typeof error === 'string' && error.trim().length > 0) return error.trim();
  if (record.ok === false || record.success === false) {
    const errorCode = record.errorCode;
    if (typeof errorCode === 'string' && errorCode.trim().length > 0) return errorCode.trim();
    const message = record.message;
    if (typeof message === 'string' && message.trim().length > 0) return message.trim();
    return 'daemon_quota_snapshot_delivery_failed';
  }
  return null;
}

function formatDeliveryError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error ?? 'unknown_error');
}

function normalizePositiveInt(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.trunc(value));
}

function normalizeNonNegativeInt(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  return Math.trunc(value);
}

function normalizeString(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readActiveAccountId(snapshot: ConnectedServiceQuotaSnapshotV1): string | null {
  const value = snapshot.activeAccountId;
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function slotKey(input: Pick<ConnectedServiceQuotaSnapshotDeliveryInput, 'sessionId' | 'serviceId' | 'groupId' | 'groupGeneration' | 'snapshot'>): string {
  return JSON.stringify([
    input.sessionId,
    input.serviceId,
    input.snapshot.profileId,
    normalizeString(input.groupId),
    readActiveAccountId(input.snapshot),
    normalizeNonNegativeInt(input.groupGeneration),
  ]);
}

function buildDiagnostic(input: Readonly<{
  entry: PendingDelivery;
  event: ConnectedServiceQuotaSnapshotDeliveryDiagnostic['event'];
  reason: ConnectedServiceQuotaSnapshotDeliveryDiagnostic['reason'];
  attemptCount: number;
  maxAttempts: number;
  lastError: string | null;
  flushReason: ConnectedServiceQuotaSnapshotDeliveryFlushReason;
}>): ConnectedServiceQuotaSnapshotDeliveryDiagnostic {
  const snapshot = input.entry.input.snapshot;
  return {
    event: input.event,
    phase: 'quota_snapshot_delivery',
    reason: input.reason,
    sessionId: input.entry.input.sessionId,
    serviceId: input.entry.input.serviceId,
    profileId: snapshot.profileId,
    groupId: normalizeString(input.entry.input.groupId),
    activeAccountId: readActiveAccountId(snapshot),
    groupGeneration: normalizeNonNegativeInt(input.entry.input.groupGeneration),
    attemptCount: input.attemptCount,
    maxAttempts: input.maxAttempts,
    lastError: input.lastError,
    flushReason: input.flushReason,
  };
}

export function createConnectedServiceQuotaSnapshotDeliveryOutbox(params: Readonly<{
  deliver: DeliverConnectedServiceQuotaSnapshot;
  maxAttempts?: number;
  maxPendingEntries?: number;
  retryDelayMs?: number | null;
  onDiagnostic?: (diagnostic: ConnectedServiceQuotaSnapshotDeliveryDiagnostic) => void;
}>): ConnectedServiceQuotaSnapshotDeliveryOutbox {
  const pending = new Map<string, PendingDelivery>();
  const maxAttempts = normalizePositiveInt(params.maxAttempts, DEFAULT_MAX_ATTEMPTS);
  const maxPendingEntries = normalizePositiveInt(params.maxPendingEntries, DEFAULT_MAX_PENDING_ENTRIES);
  const retryDelayMs =
    params.retryDelayMs === null || params.retryDelayMs === undefined
      ? null
      : normalizePositiveInt(params.retryDelayMs, 1_000);
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let droppedSinceLastFlush = 0;

  const clearRetryTimer = (): void => {
    if (!retryTimer) return;
    clearTimeout(retryTimer);
    retryTimer = null;
  };

  const emitDiagnostic = (diagnostic: ConnectedServiceQuotaSnapshotDeliveryDiagnostic): void => {
    params.onDiagnostic?.(diagnostic);
  };

  const dropEntry = (
    key: string,
    entry: PendingDelivery,
    reason: ConnectedServiceQuotaSnapshotDeliveryDiagnostic['reason'],
    flushReason: ConnectedServiceQuotaSnapshotDeliveryFlushReason,
  ): void => {
    pending.delete(key);
    droppedSinceLastFlush += 1;
    emitDiagnostic(buildDiagnostic({
      entry,
      event: 'quota_snapshot_delivery_dropped',
      reason,
      attemptCount: entry.attempts,
      maxAttempts,
      lastError: entry.lastError,
      flushReason,
    }));
  };

  const enforceMaxPendingEntries = (): void => {
    while (pending.size > maxPendingEntries) {
      const oldest = pending.entries().next().value as [string, PendingDelivery] | undefined;
      if (!oldest) return;
      dropEntry(oldest[0], oldest[1], 'quota_snapshot_outbox_overflow', 'initial');
    }
  };

  const scheduleRetry = (): void => {
    if (retryDelayMs === null || pending.size === 0 || retryTimer) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void flushPending({ reason: 'periodic_retry' });
    }, retryDelayMs);
    (retryTimer as { unref?: () => void }).unref?.();
  };

  const enqueue = (input: ConnectedServiceQuotaSnapshotDeliveryInput): void => {
    const key = slotKey(input);
    const existing = pending.get(key);
    pending.set(key, {
      input,
      attempts: existing?.attempts ?? 0,
      lastError: null,
    });
    enforceMaxPendingEntries();
  };

  const flushPending = async (options: Readonly<{
    reason?: ConnectedServiceQuotaSnapshotDeliveryFlushReason;
    sessionId?: string;
  }> = {}): Promise<ConnectedServiceQuotaSnapshotDeliveryFlushResult> => {
    const flushReason = options.reason ?? 'manual_flush';
    clearRetryTimer();
    let dropped = droppedSinceLastFlush;
    droppedSinceLastFlush = 0;
    let attempted = 0;
    let delivered = 0;
    for (const [key, entry] of Array.from(pending.entries())) {
      if (options.sessionId && entry.input.sessionId !== options.sessionId) continue;
      const attemptCount = entry.attempts + 1;
      attempted += 1;
      try {
        const result = await params.deliver(entry.input);
        const deliveryError = readDeliveryError(result);
        if (!deliveryError) {
          if (pending.get(key) === entry) {
            pending.delete(key);
          }
          delivered += 1;
          continue;
        }
        const currentEntry = pending.get(key);
        if (currentEntry !== entry) continue;
        const boundedAttemptCount = Math.min(attemptCount, maxAttempts);
        const nextEntry: PendingDelivery = {
          ...currentEntry,
          attempts: boundedAttemptCount,
          lastError: deliveryError,
        };
        pending.set(key, nextEntry);
        emitDiagnostic(buildDiagnostic({
          entry: nextEntry,
          event: 'quota_snapshot_delivery_retrying',
          reason: 'daemon_quota_snapshot_delivery_failed',
          attemptCount: boundedAttemptCount,
          maxAttempts,
          lastError: deliveryError,
          flushReason,
        }));
      } catch (error) {
        const lastError = formatDeliveryError(error);
        const currentEntry = pending.get(key);
        if (currentEntry !== entry) continue;
        const boundedAttemptCount = Math.min(attemptCount, maxAttempts);
        const nextEntry: PendingDelivery = {
          ...currentEntry,
          attempts: boundedAttemptCount,
          lastError,
        };
        pending.set(key, nextEntry);
        emitDiagnostic(buildDiagnostic({
          entry: nextEntry,
          event: 'quota_snapshot_delivery_retrying',
          reason: 'daemon_quota_snapshot_delivery_failed',
          attemptCount: boundedAttemptCount,
          maxAttempts,
          lastError,
          flushReason,
        }));
      }
    }
    if (pending.size > 0) {
      scheduleRetry();
    } else {
      clearRetryTimer();
    }
    return {
      attempted,
      delivered,
      pending: pending.size,
      dropped,
    };
  };

  return {
    enqueue,
    enqueueAndFlush: async (input) => {
      enqueue(input);
      return await flushPending({ reason: 'initial', sessionId: input.sessionId });
    },
    flushPending,
    clearSession: (sessionId) => {
      let cleared = 0;
      for (const [key, entry] of Array.from(pending.entries())) {
        if (entry.input.sessionId !== sessionId) continue;
        pending.delete(key);
        cleared += 1;
      }
      if (pending.size === 0) clearRetryTimer();
      return cleared;
    },
    pendingCount: () => pending.size,
  };
}
