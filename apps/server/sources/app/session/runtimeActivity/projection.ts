import {
    SessionRuntimeActivityProjectionSchema,
    SessionRuntimeActivitySnapshotSchema,
    type SessionRuntimeActivityProjection,
    type SessionRuntimeActivitySnapshot,
} from "@happier-dev/protocol";

export interface StoredSessionRuntimeActivityProjectionFields {
    runtimeActivityState: unknown;
    runtimeActivityActiveCount: unknown;
    runtimeActivityObservedAt: unknown;
    runtimeActivityRevision: unknown;
}

export interface PublicSessionRuntimeActivityProjectionFields {
    runtimeActivityState: SessionRuntimeActivityProjection["state"];
    runtimeActivityActiveCount: number;
    runtimeActivityObservedAt: number | null;
    runtimeActivityRevision: number;
}

export type StoredSessionRuntimeActivityProjectionResult =
    | Readonly<{ status: "valid"; projection: SessionRuntimeActivityProjection }>
    | Readonly<{ status: "invalid"; revision: number | null }>;

export function parseSessionRuntimeActivitySnapshot(value: unknown): SessionRuntimeActivitySnapshot {
    return SessionRuntimeActivitySnapshotSchema.parse(value);
}

function readNonNegativeSafeInteger(value: unknown): number | null {
    if (typeof value === "number") {
        return Number.isSafeInteger(value) && value >= 0 ? value : null;
    }
    if (typeof value === "bigint") {
        return value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : null;
    }
    return null;
}

export function readStoredSessionRuntimeActivityProjectionResult(
    value: StoredSessionRuntimeActivityProjectionFields,
): StoredSessionRuntimeActivityProjectionResult {
    const revision = readNonNegativeSafeInteger(value.runtimeActivityRevision);
    const observedAt = value.runtimeActivityObservedAt === null
        ? null
        : readNonNegativeSafeInteger(value.runtimeActivityObservedAt);
    if (
        revision === null
        || (value.runtimeActivityObservedAt !== null && observedAt === null)
    ) {
        return { status: "invalid", revision };
    }
    const parsed = SessionRuntimeActivityProjectionSchema.safeParse({
        state: value.runtimeActivityState,
        activeCount: value.runtimeActivityActiveCount,
        observedAt,
        revision,
    });
    if (parsed.success) {
        return { status: "valid", projection: parsed.data };
    }
    return { status: "invalid", revision };
}

/** Reads one exact final stored projection. Malformed final storage is never truth. */
export function readStoredSessionRuntimeActivityProjection(
    value: StoredSessionRuntimeActivityProjectionFields,
): SessionRuntimeActivityProjection {
    const result = readStoredSessionRuntimeActivityProjectionResult(value);
    if (result.status === "valid") return result.projection;
    throw new Error("Invalid stored Session Runtime Activity projection");
}

export function normalizeStoredSessionRuntimeActivityProjection(
    value: Readonly<Partial<StoredSessionRuntimeActivityProjectionFields>>,
): PublicSessionRuntimeActivityProjectionFields {
    const projection = readStoredSessionRuntimeActivityProjection({
        runtimeActivityState: value.runtimeActivityState,
        runtimeActivityActiveCount: value.runtimeActivityActiveCount,
        runtimeActivityObservedAt: value.runtimeActivityObservedAt,
        runtimeActivityRevision: value.runtimeActivityRevision,
    });
    return {
        runtimeActivityState: projection.state,
        runtimeActivityActiveCount: projection.activeCount,
        runtimeActivityObservedAt: projection.observedAt,
        runtimeActivityRevision: projection.revision,
    };
}
