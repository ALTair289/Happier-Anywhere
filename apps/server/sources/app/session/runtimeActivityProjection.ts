import {
    SessionRuntimeActivitySourceClassV1Schema,
    type SessionRuntimeActivitySourceClassV1,
} from "@happier-dev/protocol";

export type SessionRuntimeActivityProjectionUpdate = Readonly<{
    runtimeActivityActiveCount: number;
    runtimeActivityObservedAt: number | null;
    runtimeActivityExpiresAt: number | null;
    runtimeActivitySourceClass: SessionRuntimeActivitySourceClassV1 | null;
}>;

export const IDLE_SESSION_RUNTIME_ACTIVITY_PROJECTION = {
    runtimeActivityActiveCount: 0,
    runtimeActivityObservedAt: null,
    runtimeActivityExpiresAt: null,
    runtimeActivitySourceClass: null,
} as const satisfies SessionRuntimeActivityProjectionUpdate;

function readNonNegativeSafeInteger(value: unknown): number | null {
    if (typeof value === "number") {
        return Number.isInteger(value) && value >= 0 && Number.isSafeInteger(value) ? value : null;
    }
    if (typeof value === "bigint") {
        if (value < BigInt(0) || value > BigInt(Number.MAX_SAFE_INTEGER)) return null;
        return Number(value);
    }
    return null;
}

export function normalizeSessionRuntimeActivityProjection(value: Readonly<{
    activeCount?: unknown;
    observedAt?: unknown;
    expiresAt?: unknown;
    sourceClass?: unknown;
}>): SessionRuntimeActivityProjectionUpdate {
    const activeCount = readNonNegativeSafeInteger(value.activeCount) ?? 0;
    const observedAt = readNonNegativeSafeInteger(value.observedAt);
    const expiresAt = readNonNegativeSafeInteger(value.expiresAt);
    const sourceClass = SessionRuntimeActivitySourceClassV1Schema.safeParse(value.sourceClass);
    if (activeCount <= 0 || observedAt === null || expiresAt === null || !sourceClass.success) {
        return IDLE_SESSION_RUNTIME_ACTIVITY_PROJECTION;
    }
    return {
        runtimeActivityActiveCount: activeCount,
        runtimeActivityObservedAt: observedAt,
        runtimeActivityExpiresAt: expiresAt,
        runtimeActivitySourceClass: sourceClass.data,
    };
}

export function normalizeStoredSessionRuntimeActivityProjection(value: Readonly<{
    runtimeActivityActiveCount?: unknown;
    runtimeActivityObservedAt?: unknown;
    runtimeActivityExpiresAt?: unknown;
    runtimeActivitySourceClass?: unknown;
}>): SessionRuntimeActivityProjectionUpdate {
    return normalizeSessionRuntimeActivityProjection({
        activeCount: value.runtimeActivityActiveCount,
        observedAt: value.runtimeActivityObservedAt,
        expiresAt: value.runtimeActivityExpiresAt,
        sourceClass: value.runtimeActivitySourceClass,
    });
}

export function hasNonIdleSessionRuntimeActivityProjection(session: {
    runtimeActivityActiveCount?: unknown;
    runtimeActivityObservedAt?: unknown;
    runtimeActivityExpiresAt?: unknown;
    runtimeActivitySourceClass?: unknown;
}): boolean {
    return (
        (typeof session.runtimeActivityActiveCount === "number" && session.runtimeActivityActiveCount > 0)
        || session.runtimeActivityObservedAt !== null && session.runtimeActivityObservedAt !== undefined
        || session.runtimeActivityExpiresAt !== null && session.runtimeActivityExpiresAt !== undefined
        || session.runtimeActivitySourceClass !== null && session.runtimeActivitySourceClass !== undefined
    );
}
