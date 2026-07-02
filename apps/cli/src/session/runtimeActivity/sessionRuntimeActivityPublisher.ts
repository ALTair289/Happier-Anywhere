import type {
  SessionRuntimeActivitySourceClassV1,
  SessionRuntimeActivitySourceKindV1,
  SessionRuntimeActivitySourceStatusV1,
  SessionRuntimeActivityV1,
} from '@happier-dev/protocol';

const RUNTIME_ACTIVITY_SOURCE_LIMIT = 32;
const DEFAULT_RUNTIME_ACTIVITY_PROJECTION_RETRY_DELAY_MS = 5_000;

export type RuntimeActivityPublicSourceClass = Exclude<SessionRuntimeActivitySourceClassV1, 'mixed'>;

export type RuntimeActivityProjection = Readonly<{
  runtimeActivityActiveCount: number;
  runtimeActivityObservedAt: number | null;
  runtimeActivityExpiresAt: number | null;
  runtimeActivitySourceClass: SessionRuntimeActivitySourceClassV1 | null;
}>;

export type RuntimeActivityProjectionWriter = (projection: RuntimeActivityProjection) => Promise<void> | void;

export type RuntimeActivitySourceUpdate = Readonly<{
  id: string;
  sourceClass: RuntimeActivityPublicSourceClass;
  providerId?: string | null;
  observedAtMs?: number | null;
  expiresAtMs?: number | null;
}>;

export type RuntimeActivitySourceObservation = Readonly<{
  id: string;
  reason: string;
  observedAtMs?: number | null;
  expiresAtMs?: number | null;
}>;

export type RuntimeActivitySourceReconciliation = Readonly<{
  id: string;
  sourceClass: RuntimeActivityPublicSourceClass;
  providerId?: string | null;
  observedAtMs: number;
  expiresAtMs: number;
}>;

export type SessionRuntimeActivityPublisher = Readonly<{
  setSourceActive(input: RuntimeActivitySourceUpdate): Promise<void>;
  observeSource(input: RuntimeActivitySourceObservation): Promise<void>;
  observeAmbientLiveness(reason: string): Promise<void>;
  clearSource(id: string, reason: string): Promise<void>;
  clearProviderSources(providerId: string, reason: string): Promise<void>;
  clearAll(reason: string): Promise<void>;
  reconcileSources(input: Readonly<{
    reason: string;
    sources: readonly RuntimeActivitySourceReconciliation[];
  }>): Promise<void>;
  getProjection(): RuntimeActivityProjection;
  getSnapshot(): SessionRuntimeActivityV1;
}>;

export type SessionRuntimeActivityPublisherParams = Readonly<{
  nowMs: () => number;
  leaseDurationMs: number;
  updateRuntimeActivityProjection: RuntimeActivityProjectionWriter;
  projectionRetryDelayMs?: number;
  logError?: (event: string, details: Readonly<Record<string, unknown>>) => void;
  lifecycle?: Readonly<Record<string, unknown>>;
}>;

type RuntimeActivitySourceRecord = Readonly<{
  id: string;
  sourceClass: RuntimeActivityPublicSourceClass;
  providerId: string | null;
  startedAtMs: number;
  lastObservedAtMs: number;
  expiresAtMs: number;
  status: SessionRuntimeActivitySourceStatusV1;
}>;

function readSourceId(id: string): string | null {
  const normalized = id.trim();
  return normalized.length > 0 ? normalized : null;
}

function readNonnegativeInteger(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

function readPositiveInteger(value: number): number | null {
  return Number.isInteger(value) && value > 0 ? value : null;
}

function isSourceActive(source: RuntimeActivitySourceRecord): boolean {
  return source.status !== 'stale';
}

function toSourceStatus(expiresAtMs: number, nowMs: number): SessionRuntimeActivitySourceStatusV1 {
  return expiresAtMs > nowMs ? 'active' : 'stale';
}

function readSnapshotStatus(source: RuntimeActivitySourceRecord): SessionRuntimeActivitySourceStatusV1 {
  return source.status;
}

function compareSources(a: RuntimeActivitySourceRecord, b: RuntimeActivitySourceRecord): number {
  const aActive = a.status !== 'stale';
  const bActive = b.status !== 'stale';
  if (aActive !== bActive) return aActive ? -1 : 1;
  if (a.lastObservedAtMs !== b.lastObservedAtMs) return b.lastObservedAtMs - a.lastObservedAtMs;
  if (a.startedAtMs !== b.startedAtMs) return b.startedAtMs - a.startedAtMs;
  return a.id.localeCompare(b.id);
}

function collapseSourceClass(sources: readonly RuntimeActivitySourceRecord[]): SessionRuntimeActivitySourceClassV1 | null {
  let current: RuntimeActivityPublicSourceClass | null = null;
  for (const source of sources) {
    if (current === null) {
      current = source.sourceClass;
      continue;
    }
    if (current !== source.sourceClass) return 'mixed';
  }
  return current;
}

function buildIdleProjection(): RuntimeActivityProjection {
  return {
    runtimeActivityActiveCount: 0,
    runtimeActivityObservedAt: null,
    runtimeActivityExpiresAt: null,
    runtimeActivitySourceClass: null,
  };
}

export function createSessionRuntimeActivityPublisher(
  params: SessionRuntimeActivityPublisherParams,
): SessionRuntimeActivityPublisher {
  const sources = new Map<string, RuntimeActivitySourceRecord>();
  const leaseDurationMs = readPositiveInteger(params.leaseDurationMs) ?? 60_000;
  const projectionRetryDelayMs =
    readPositiveInteger(params.projectionRetryDelayMs ?? DEFAULT_RUNTIME_ACTIVITY_PROJECTION_RETRY_DELAY_MS)
    ?? DEFAULT_RUNTIME_ACTIVITY_PROJECTION_RETRY_DELAY_MS;
  const renewalWindowMs = Math.max(1, Math.floor(leaseDurationMs / 2));
  let lastPublishedProjection: RuntimeActivityProjection | null = null;
  let projectionRetryTimer: ReturnType<typeof setTimeout> | null = null;
  let projectionRetryForce = false;
  let publishQueue: Promise<void> = Promise.resolve();

  function now(): number {
    return readNonnegativeInteger(params.nowMs()) ?? 0;
  }

  function buildProjection(): RuntimeActivityProjection {
    const activeSources = [...sources.values()].filter((source) => isSourceActive(source));
    if (activeSources.length === 0) return buildIdleProjection();

    return {
      runtimeActivityActiveCount: activeSources.length,
      runtimeActivityObservedAt: Math.max(...activeSources.map((source) => source.lastObservedAtMs)),
      runtimeActivityExpiresAt: Math.max(...activeSources.map((source) => source.expiresAtMs)),
      runtimeActivitySourceClass: collapseSourceClass(activeSources),
    };
  }

  function projectionsEqual(a: RuntimeActivityProjection, b: RuntimeActivityProjection): boolean {
    return a.runtimeActivityActiveCount === b.runtimeActivityActiveCount
      && a.runtimeActivityObservedAt === b.runtimeActivityObservedAt
      && a.runtimeActivityExpiresAt === b.runtimeActivityExpiresAt
      && a.runtimeActivitySourceClass === b.runtimeActivitySourceClass;
  }

  function clearProjectionRetryTimer(): void {
    if (!projectionRetryTimer) return;
    clearTimeout(projectionRetryTimer);
    projectionRetryTimer = null;
  }

  function scheduleProjectionRetry(reason: string, opts?: Readonly<{ force?: boolean }>): void {
    projectionRetryForce = projectionRetryForce || opts?.force === true;
    if (projectionRetryTimer) return;
    projectionRetryTimer = setTimeout(() => {
      projectionRetryTimer = null;
      const force = projectionRetryForce;
      projectionRetryForce = false;
      void publish(`retry:${reason}`, { force });
    }, projectionRetryDelayMs);
    projectionRetryTimer.unref?.();
  }

  async function publishNow(reason: string, opts?: Readonly<{ force?: boolean }>): Promise<void> {
    const projection = buildProjection();
    if (opts?.force !== true && lastPublishedProjection && projectionsEqual(lastPublishedProjection, projection)) {
      return;
    }
    try {
      await params.updateRuntimeActivityProjection(projection);
      lastPublishedProjection = projection;
      clearProjectionRetryTimer();
      projectionRetryForce = false;
    } catch (error) {
      params.logError?.('runtime_activity_projection_write_failed', {
        reason,
        error,
      });
      scheduleProjectionRetry(reason, opts);
    }
  }

  async function publish(reason: string, opts?: Readonly<{ force?: boolean }>): Promise<void> {
    const queuedPublish = publishQueue.then(() => publishNow(reason, opts));
    publishQueue = queuedPublish.catch(() => undefined);
    await queuedPublish;
  }

  function shouldCoalesceImplicitRenewal(input: RuntimeActivitySourceUpdate, existing: RuntimeActivitySourceRecord, observedAtMs: number): boolean {
    if (input.observedAtMs !== undefined && input.observedAtMs !== null) return false;
    if (input.expiresAtMs !== undefined && input.expiresAtMs !== null) return false;
    if (existing.sourceClass !== input.sourceClass) return false;
    if (existing.providerId !== (input.providerId?.trim() || null)) return false;
    return existing.expiresAtMs - observedAtMs > renewalWindowMs;
  }

  function upsertSource(input: RuntimeActivitySourceUpdate, defaultNowMs: number): boolean {
    const id = readSourceId(input.id);
    if (!id) return false;

    const observedAtMs = readNonnegativeInteger(input.observedAtMs) ?? defaultNowMs;
    const expiresAtMs = readNonnegativeInteger(input.expiresAtMs) ?? observedAtMs + leaseDurationMs;
    const existing = sources.get(id);
    if (existing && shouldCoalesceImplicitRenewal(input, existing, observedAtMs)) return false;
    sources.set(id, {
      id,
      sourceClass: input.sourceClass,
      providerId: input.providerId?.trim() || null,
      startedAtMs: existing?.startedAtMs ?? observedAtMs,
      lastObservedAtMs: observedAtMs,
      expiresAtMs,
      status: toSourceStatus(expiresAtMs, defaultNowMs),
    });
    return true;
  }

  function shouldCoalesceSourceObservation(input: RuntimeActivitySourceObservation, existing: RuntimeActivitySourceRecord, observedAtMs: number): boolean {
    if (input.observedAtMs !== undefined && input.observedAtMs !== null) return false;
    if (input.expiresAtMs !== undefined && input.expiresAtMs !== null) return false;
    return existing.expiresAtMs - observedAtMs > renewalWindowMs;
  }

  return {
    async setSourceActive(input: RuntimeActivitySourceUpdate): Promise<void> {
      const didUpdate = upsertSource(input, now());
      if (!didUpdate) return;
      await publish('source_active');
    },

    async observeSource(input: RuntimeActivitySourceObservation): Promise<void> {
      const id = readSourceId(input.id);
      if (!id) return;
      const existing = sources.get(id);
      if (!existing) return;

      const observedNowMs = now();
      const observedAtMs = readNonnegativeInteger(input.observedAtMs) ?? observedNowMs;
      const expiresAtMs = readNonnegativeInteger(input.expiresAtMs) ?? observedAtMs + leaseDurationMs;
      if (shouldCoalesceSourceObservation(input, existing, observedAtMs)) return;
      sources.set(id, {
        ...existing,
        lastObservedAtMs: observedAtMs,
        expiresAtMs,
        status: toSourceStatus(expiresAtMs, observedNowMs),
      });
      await publish(input.reason);
    },

    async observeAmbientLiveness(_reason: string): Promise<void> {
    },

    async clearSource(id: string, reason: string): Promise<void> {
      const normalized = readSourceId(id);
      if (!normalized || !sources.has(normalized)) return;
      sources.delete(normalized);
      await publish(reason, { force: true });
    },

    async clearProviderSources(providerId: string, reason: string): Promise<void> {
      const normalizedProviderId = providerId.trim();
      let deleted = false;
      if (normalizedProviderId.length > 0) {
        for (const [id, source] of sources) {
          if (source.providerId === normalizedProviderId) {
            sources.delete(id);
            deleted = true;
          }
        }
      }
      if (!deleted) return;
      await publish(reason, { force: true });
    },

    async clearAll(reason: string): Promise<void> {
      sources.clear();
      await publish(reason, { force: true });
    },

    async reconcileSources(input: Readonly<{
      reason: string;
      sources: readonly RuntimeActivitySourceReconciliation[];
    }>): Promise<void> {
      const observedNowMs = now();
      sources.clear();
      for (const source of input.sources) {
        const id = readSourceId(source.id);
        if (!id) continue;
        const observedAtMs = readNonnegativeInteger(source.observedAtMs);
        const expiresAtMs = readNonnegativeInteger(source.expiresAtMs);
        if (observedAtMs === null || expiresAtMs === null) continue;
        sources.set(id, {
          id,
          sourceClass: source.sourceClass,
          providerId: source.providerId?.trim() || null,
          startedAtMs: observedAtMs,
          lastObservedAtMs: observedAtMs,
          expiresAtMs,
          status: toSourceStatus(expiresAtMs, observedNowMs),
        });
      }
      await publish(input.reason);
    },

    getProjection(): RuntimeActivityProjection {
      return buildProjection();
    },

    getSnapshot(): SessionRuntimeActivityV1 {
      const observedAtMs = now();
      const retainedSources = [...sources.values()].sort(compareSources).slice(0, RUNTIME_ACTIVITY_SOURCE_LIMIT);
      return {
        v: 1,
        observedAtMs,
        activeCount: retainedSources.filter((source) => isSourceActive(source)).length,
        sources: retainedSources.map((source) => ({
          id: source.id,
          kind: source.sourceClass as SessionRuntimeActivitySourceKindV1,
          status: readSnapshotStatus(source),
          startedAtMs: source.startedAtMs,
          lastObservedAtMs: source.lastObservedAtMs,
          expiresAtMs: source.expiresAtMs,
        })),
      };
    },
  };
}
