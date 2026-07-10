import { z } from 'zod';

export const SESSION_RUNTIME_ACTIVITY_SOURCE_LIMIT = 32;

/**
 * Dead-owner display backstop for runtime-activity projections, not a liveness
 * proof or provider work deadline. Deliberately decoupled from
 * SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS: silent detached work such as
 * codex/Bash lanes can emit no renewal evidence for many minutes and must stay
 * displayed as working. Sizing matches the Helmor idle-backstop magnitude per
 * plan refinement 30 amendment.
 */
export const SESSION_RUNTIME_ACTIVITY_PROJECTION_LEASE_MS = 900_000;

export const SessionRuntimeActivitySourceKindV1Schema = z.enum([
  'provider_detached_task',
  'provider_autonomous_output',
]);
export type SessionRuntimeActivitySourceKindV1 = z.infer<typeof SessionRuntimeActivitySourceKindV1Schema>;

export const SessionRuntimeActivitySourceClassV1Schema = z.enum([
  'provider_detached_task',
  'provider_autonomous_output',
  'mixed',
]);
export type SessionRuntimeActivitySourceClassV1 = z.infer<typeof SessionRuntimeActivitySourceClassV1Schema>;

export const SessionRuntimeActivitySourceStatusV1Schema = z.enum([
  'active',
  'ending',
  'stale',
]);
export type SessionRuntimeActivitySourceStatusV1 = z.infer<typeof SessionRuntimeActivitySourceStatusV1Schema>;

export const SessionRuntimeActivitySourceV1Schema = z
  .object({
    id: z.string().trim().min(1),
    kind: SessionRuntimeActivitySourceKindV1Schema,
    status: SessionRuntimeActivitySourceStatusV1Schema,
    startedAtMs: z.number().int().nonnegative(),
    lastObservedAtMs: z.number().int().nonnegative(),
    expiresAtMs: z.number().int().nonnegative(),
  })
  .strip();
export type SessionRuntimeActivitySourceV1 = z.infer<typeof SessionRuntimeActivitySourceV1Schema>;

export const SessionRuntimeActivityV1Schema = z
  .object({
    v: z.literal(1),
    observedAtMs: z.number().int().nonnegative(),
    activeCount: z.number().int().nonnegative(),
    sources: z.array(SessionRuntimeActivitySourceV1Schema),
  })
  .strip();
export type SessionRuntimeActivityV1 = z.infer<typeof SessionRuntimeActivityV1Schema>;

export type BuildSessionRuntimeActivityV1Input = Readonly<{
  observedAtMs: unknown;
  nowMs: unknown;
  sources: readonly unknown[];
}>;

export type SessionRuntimeActivityProjectionForPendingDrain = Readonly<{
  runtimeActivityActiveCount?: unknown;
  runtimeActivityObservedAt?: unknown;
  runtimeActivityExpiresAt?: unknown;
  runtimeActivitySourceClass?: unknown;
}>;

function readNonNegativeInteger(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isInteger(value) && value >= 0 ? value : null;
  }
  if (typeof value === 'bigint') {
    if (value < BigInt(0) || value > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    return Number(value);
  }
  return null;
}

function isActiveSessionRuntimeActivitySource(source: SessionRuntimeActivitySourceV1, nowMs: number): boolean {
  return source.status !== 'stale' && source.expiresAtMs > nowMs;
}

function compareSourcesForRetention(a: SessionRuntimeActivitySourceV1, b: SessionRuntimeActivitySourceV1): number {
  if (a.lastObservedAtMs !== b.lastObservedAtMs) return b.lastObservedAtMs - a.lastObservedAtMs;
  if (a.startedAtMs !== b.startedAtMs) return b.startedAtMs - a.startedAtMs;
  return a.id.localeCompare(b.id);
}

export function readSessionRuntimeActivityV1(value: unknown): SessionRuntimeActivityV1 | null {
  const parsed = SessionRuntimeActivityV1Schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function buildSessionRuntimeActivityV1(input: BuildSessionRuntimeActivityV1Input): SessionRuntimeActivityV1 {
  const observedAtMs = readNonNegativeInteger(input.observedAtMs) ?? 0;
  const nowMs = readNonNegativeInteger(input.nowMs) ?? observedAtMs;
  const sources = input.sources.flatMap((source): SessionRuntimeActivitySourceV1[] => {
    const parsed = SessionRuntimeActivitySourceV1Schema.safeParse(source);
    return parsed.success ? [parsed.data] : [];
  });
  const activeCount = sources.filter((source) => isActiveSessionRuntimeActivitySource(source, nowMs)).length;
  return {
    v: 1,
    observedAtMs,
    activeCount,
    sources: [...sources].sort(compareSourcesForRetention).slice(0, SESSION_RUNTIME_ACTIVITY_SOURCE_LIMIT),
  };
}

export function listActiveSessionRuntimeActivitySources(
  snapshot: SessionRuntimeActivityV1 | null | undefined,
  nowMs: unknown,
): readonly SessionRuntimeActivitySourceV1[] {
  if (!snapshot) return [];
  const normalizedNowMs = readNonNegativeInteger(nowMs);
  if (normalizedNowMs === null) return [];
  return snapshot.sources.filter((source) => isActiveSessionRuntimeActivitySource(source, normalizedNowMs));
}

export function hasActiveSessionRuntimeActivity(
  snapshot: SessionRuntimeActivityV1 | null | undefined,
  nowMs: unknown,
): boolean {
  return listActiveSessionRuntimeActivitySources(snapshot, nowMs).length > 0;
}

export function isSessionRuntimeActivityProjectionIdleForPendingDrain(
  activity: SessionRuntimeActivityProjectionForPendingDrain | null | undefined,
  nowMs: unknown,
  _opts: Readonly<{ ownerLive?: boolean }> = {},
): boolean {
  const activeCount = readNonNegativeInteger(activity?.runtimeActivityActiveCount);
  if (activeCount === null || activeCount <= 0) {
    return true;
  }

  const expiresAt = readNonNegativeInteger(activity?.runtimeActivityExpiresAt);
  if (expiresAt === null) {
    return true;
  }

  const now = readNonNegativeInteger(nowMs);
  if (now === null) {
    return true;
  }

  return expiresAt <= now;
}
