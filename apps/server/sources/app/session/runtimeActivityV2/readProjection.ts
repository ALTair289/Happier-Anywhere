import {
    readSessionRuntimeActivityProjectionCompatV2,
    type SessionRuntimeActivityProjectionV2,
} from "@happier-dev/protocol";

type RuntimeActivityStoredProjectionRow = Readonly<{
    runtimeActivityVersion?: unknown;
    runtimeActivityState?: unknown;
    runtimeActivityActiveCount?: unknown;
    runtimeActivityObservedAt?: unknown;
    runtimeActivityExpiresAt?: unknown;
    runtimeActivitySourceClass?: unknown;
    runtimeActivityRevision?: unknown;
}>;

export type StoredSessionRuntimeActivityProjectionV2 =
    | Readonly<{ source: "v2" | "v1"; projection: SessionRuntimeActivityProjectionV2 }>
    | Readonly<{ source: "none"; projection: null }>;

/**
 * Central staged-schema reader. Callers explicitly state which projection
 * columns their successful query contained, so a v2-column rollout failure can
 * retry v1 columns without collapsing all the way to a no-runtime row shape.
 */
export function readStoredSessionRuntimeActivityProjectionV2(params: Readonly<{
    availability: "v2" | "v1" | "none";
    row: RuntimeActivityStoredProjectionRow;
    nowMs: number;
}>): StoredSessionRuntimeActivityProjectionV2 {
    if (params.availability === "none") return { source: "none", projection: null };
    const row = params.availability === "v2"
        ? {
            ...params.row,
            runtimeActivityObservedAt: bigintToSafeNumber(params.row.runtimeActivityObservedAt),
            runtimeActivityRevision: bigintToSafeNumber(params.row.runtimeActivityRevision),
        }
        : params.row;
    return {
        source: params.availability,
        projection: readSessionRuntimeActivityProjectionCompatV2(row, params.nowMs),
    };
}

function bigintToSafeNumber(value: unknown): unknown {
    if (typeof value !== "bigint") return value;
    if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) return value;
    return Number(value);
}
