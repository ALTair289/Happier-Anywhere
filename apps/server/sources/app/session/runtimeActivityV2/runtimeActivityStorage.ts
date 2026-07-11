import {
    SessionRuntimeActivityActiveLifecycleStateV2Schema,
    SessionRuntimeActivityExpectedOwnerManifestV2Schema,
    SessionRuntimeActivityMutationAckV2Schema,
    SessionRuntimeActivityMutationV2Schema,
    SessionRuntimeActivityProjectionV2Schema,
    SessionRuntimeActivityReceiptCompactionAckV2Schema,
    SessionRuntimeActivityReceiptCompactionV2Schema,
    SessionRuntimeActivityRequestDigestSchema,
    SessionRuntimeActivitySourceKindV2Schema,
    SessionRuntimeActivityTerminalLifecycleStateV2Schema,
    SessionRuntimeActivityWriterGenerationSchema,
    applySessionRuntimeActivityMutationV2 as applyRuntimeActivityReducerMutation,
    createSessionRuntimeActivityReducerStateV2,
    type SessionRuntimeActivityMutationAckV2,
    type SessionRuntimeActivityMutationV2,
    type SessionRuntimeActivityProjectionV2,
    type SessionRuntimeActivityReceiptCompactionAckV2,
    type SessionRuntimeActivityReceiptCompactionV2,
    type SessionRuntimeActivityReducerStateV2,
} from "@happier-dev/protocol";

import { inTx, type Tx } from "@/storage/inTx";
import { isPrismaErrorCode } from "@/storage/prisma";

import { readStoredSessionRuntimeActivityProjectionV2 } from "./readProjection";

const STORAGE_CONCURRENCY_RETRIES = 3;
const ACTIVE_STATES = new Set(["starting", "running", "waiting"]);

type ReducerOwner = SessionRuntimeActivityReducerStateV2["owners"][number];
type ReducerSource = ReducerOwner["sources"][number];
type ReducerReceipt = SessionRuntimeActivityReducerStateV2["receipts"][number];

class RuntimeActivityStorageConcurrentWriteError extends Error {
    constructor() {
        super("Concurrent runtime activity storage write");
    }
}

export function buildRuntimeActivityOwnerSequenceCas(input: Readonly<{
    ownerSequence: number;
    lowWatermark: number;
}>): Readonly<{ ownerSequence: bigint; lowWatermark: bigint }> {
    return {
        ownerSequence: BigInt(input.ownerSequence),
        lowWatermark: BigInt(input.lowWatermark),
    };
}

function toSafeNumber(value: bigint, field: string): number {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 0) {
        throw new Error(`Invalid persisted runtime activity ${field}`);
    }
    return parsed;
}

function projectionFromStoredReceipt(receipt: Readonly<{
    projectionState: string;
    projectionActiveCount: number;
    projectionSourceClass: string | null;
    projectionObservedAt: bigint | null;
    projectionRevision: bigint;
}>): SessionRuntimeActivityProjectionV2 {
    return SessionRuntimeActivityProjectionV2Schema.parse({
        v: 2,
        state: receipt.projectionState,
        activeCount: receipt.projectionActiveCount,
        sourceClass: receipt.projectionSourceClass,
        observedAtMs: receipt.projectionObservedAt === null
            ? null
            : toSafeNumber(receipt.projectionObservedAt, "receipt observedAt"),
        revision: toSafeNumber(receipt.projectionRevision, "receipt revision"),
    });
}

function ackFromStoredReceipt(receipt: Readonly<{
    mutationId: string;
    ackStatus: string;
    writerGeneration: string;
    ackOwnerSequence: bigint;
    projectionState: string;
    projectionActiveCount: number;
    projectionSourceClass: string | null;
    projectionObservedAt: bigint | null;
    projectionRevision: bigint;
}>): SessionRuntimeActivityMutationAckV2 {
    return SessionRuntimeActivityMutationAckV2Schema.parse({
        v: 2,
        mutationId: receipt.mutationId,
        status: receipt.ackStatus,
        writerGeneration: receipt.writerGeneration,
        ownerSequence: toSafeNumber(receipt.ackOwnerSequence, "receipt owner sequence"),
        projection: projectionFromStoredReceipt(receipt),
    });
}

function projectionFromSession(session: Readonly<{
    runtimeActivityVersion: number;
    runtimeActivityState: string | null;
    runtimeActivityActiveCount: number;
    runtimeActivityObservedAt: bigint | null;
    runtimeActivityExpiresAt: bigint | null;
    runtimeActivitySourceClass: string | null;
    runtimeActivityRevision: bigint;
}>): SessionRuntimeActivityProjectionV2 {
    const read = readStoredSessionRuntimeActivityProjectionV2({
        availability: "v2",
        nowMs: Date.now(),
        row: session,
    });
    if (!read.projection) throw new Error("Runtime activity v2 projection unavailable");
    return read.projection;
}

function groupSources(rows: readonly Readonly<{
    sourceKey: string;
    occurrenceId: string;
    sourceKind: string | null;
    lifecycleState: string;
    certainty: string;
    lastOwnerSequence: bigint;
}>[]): readonly ReducerSource[] {
    const grouped = new Map<string, ReducerSource>();
    for (const row of rows) {
        const existing = grouped.get(row.sourceKey) ?? {
            sourceKey: row.sourceKey,
            active: null,
            terminalOccurrences: [],
        };
        const lastOwnerSequence = toSafeNumber(row.lastOwnerSequence, "source owner sequence");
        if (ACTIVE_STATES.has(row.lifecycleState)) {
            if (existing.active) throw new Error("Multiple active occurrences persisted for one runtime activity source");
            const lifecycleState = SessionRuntimeActivityActiveLifecycleStateV2Schema.parse(row.lifecycleState);
            const sourceKind = SessionRuntimeActivitySourceKindV2Schema.parse(row.sourceKind);
            const certainty = row.certainty === "authoritative" || row.certainty === "last-known"
                ? row.certainty
                : (() => { throw new Error("Invalid persisted runtime activity certainty"); })();
            grouped.set(row.sourceKey, {
                ...existing,
                active: { occurrenceId: row.occurrenceId, sourceKind, lifecycleState, certainty, lastOwnerSequence },
            });
            continue;
        }
        const terminalState = SessionRuntimeActivityTerminalLifecycleStateV2Schema.parse(row.lifecycleState);
        grouped.set(row.sourceKey, {
            ...existing,
            terminalOccurrences: [
                ...existing.terminalOccurrences,
                { occurrenceId: row.occurrenceId, terminalState, lastOwnerSequence },
            ],
        });
    }
    return [...grouped.values()];
}

async function loadReducerState(params: Readonly<{
    tx: Tx;
    session: {
        id: string;
        runtimeActivityWriterGeneration: string | null;
        runtimeActivityVersion: number;
        runtimeActivityState: string | null;
        runtimeActivityActiveCount: number;
        runtimeActivityObservedAt: bigint | null;
        runtimeActivityExpiresAt: bigint | null;
        runtimeActivitySourceClass: string | null;
        runtimeActivityRevision: bigint;
    };
}>): Promise<SessionRuntimeActivityReducerStateV2> {
    const writerGeneration = SessionRuntimeActivityWriterGenerationSchema.parse(
        params.session.runtimeActivityWriterGeneration,
    );
    const owners = await params.tx.sessionRuntimeActivityOwner.findMany({
        where: { sessionId: params.session.id, writerGeneration },
        orderBy: { ownerScope: "asc" },
        include: {
            sources: { orderBy: [{ sourceKey: "asc" }, { occurrenceId: "asc" }] },
            receipts: { orderBy: [{ ownerSequence: "asc" }, { createdAt: "asc" }] },
        },
    });
    const expectedOwnerScopes = owners.map((owner) => owner.ownerScope);
    SessionRuntimeActivityExpectedOwnerManifestV2Schema.parse(expectedOwnerScopes);
    const projection = projectionFromSession(params.session);
    const reducerOwners: ReducerOwner[] = owners.map((owner) => ({
        ownerScope: owner.ownerScope,
        state: owner.state === "active" || owner.state === "idle" || owner.state === "unknown"
            ? owner.state
            : (() => { throw new Error("Invalid persisted runtime activity owner state"); })(),
        ownerSequence: toSafeNumber(owner.ownerSequence, "owner sequence"),
        lowWatermark: toSafeNumber(owner.lowWatermark, "owner low watermark"),
        sources: groupSources(owner.sources),
    }));
    const receipts: ReducerReceipt[] = owners.flatMap((owner) => owner.receipts.map((receipt) => ({
        mutationId: receipt.mutationId,
        requestDigest: SessionRuntimeActivityRequestDigestSchema.parse(receipt.requestDigest),
        ownerScope: receipt.ownerScope,
        ownerSequence: toSafeNumber(receipt.ownerSequence, "receipt sequence"),
        ack: ackFromStoredReceipt(receipt),
    })));
    return {
        v: 2,
        sessionId: params.session.id,
        writerGeneration,
        owners: reducerOwners,
        receipts,
        projection,
    };
}

function meaningChanged(left: SessionRuntimeActivityProjectionV2, right: SessionRuntimeActivityProjectionV2): boolean {
    return left.state !== right.state
        || left.activeCount !== right.activeCount
        || left.sourceClass !== right.sourceClass
        || left.observedAtMs !== right.observedAtMs
        || left.revision !== right.revision;
}

function activeNativeObservedAt(params: Readonly<{
    mutation: SessionRuntimeActivityMutationV2;
    sourceKey: string;
    occurrenceId: string;
}>): bigint | undefined {
    const operation = params.mutation.operation;
    if (operation.type === "source-upsert"
        && operation.sourceKey === params.sourceKey
        && operation.occurrenceId === params.occurrenceId
        && operation.nativeObservedAtMs !== undefined) {
        return BigInt(operation.nativeObservedAtMs);
    }
    if (operation.type === "owner-reconcile") {
        const source = operation.activeSources.find((candidate) => (
            candidate.sourceKey === params.sourceKey && candidate.occurrenceId === params.occurrenceId
        ));
        if (source?.nativeObservedAtMs !== undefined) return BigInt(source.nativeObservedAtMs);
    }
    return undefined;
}

function terminalReasonCode(params: Readonly<{
    mutation: SessionRuntimeActivityMutationV2;
    sourceKey: string;
    occurrenceId: string;
}>): string | undefined {
    const operation = params.mutation.operation;
    return operation.type === "source-terminal"
        && operation.sourceKey === params.sourceKey
        && operation.occurrenceId === params.occurrenceId
        ? operation.reasonCode
        : undefined;
}

async function persistAffectedOwner(params: Readonly<{
    tx: Tx;
    mutation: SessionRuntimeActivityMutationV2;
    before: ReducerOwner;
    after: ReducerOwner;
}>): Promise<string> {
    // Reducer owners intentionally contain no storage identity. Resolve it by
    // the immutable generation/scope key before applying the sequence CAS.
    const owner = await params.tx.sessionRuntimeActivityOwner.findUniqueOrThrow({
        where: {
            sessionId_writerGeneration_ownerScope: {
                sessionId: params.mutation.sessionId,
                writerGeneration: params.mutation.writerGeneration,
                ownerScope: params.mutation.ownerScope,
            },
        },
        select: { id: true },
    });
    const updated = await params.tx.sessionRuntimeActivityOwner.updateMany({
        where: {
            id: owner.id,
            ...buildRuntimeActivityOwnerSequenceCas({
                ownerSequence: params.before.ownerSequence,
                lowWatermark: params.before.lowWatermark,
            }),
        },
        data: {
            state: params.after.state,
            ownerSequence: BigInt(params.after.ownerSequence),
            lowWatermark: BigInt(params.after.lowWatermark),
        },
    });
    if (updated.count !== 1) throw new RuntimeActivityStorageConcurrentWriteError();
    for (const source of params.after.sources) {
        if (source.active) {
            const nativeObservedAt = activeNativeObservedAt({
                mutation: params.mutation,
                sourceKey: source.sourceKey,
                occurrenceId: source.active.occurrenceId,
            });
            await params.tx.sessionRuntimeActivitySource.upsert({
                where: {
                    ownerId_sourceKey_occurrenceId: {
                        ownerId: owner.id,
                        sourceKey: source.sourceKey,
                        occurrenceId: source.active.occurrenceId,
                    },
                },
                create: {
                    ownerId: owner.id,
                    sourceKey: source.sourceKey,
                    occurrenceId: source.active.occurrenceId,
                    sourceKind: source.active.sourceKind,
                    lifecycleState: source.active.lifecycleState,
                    certainty: source.active.certainty,
                    lastOwnerSequence: BigInt(source.active.lastOwnerSequence),
                    ...(nativeObservedAt === undefined ? {} : { nativeObservedAt }),
                },
                update: {
                    sourceKind: source.active.sourceKind,
                    lifecycleState: source.active.lifecycleState,
                    certainty: source.active.certainty,
                    lastOwnerSequence: BigInt(source.active.lastOwnerSequence),
                    ...(nativeObservedAt === undefined ? {} : { nativeObservedAt }),
                    terminalReasonCode: null,
                },
            });
        }
        for (const occurrence of source.terminalOccurrences) {
            const reasonCode = terminalReasonCode({
                mutation: params.mutation,
                sourceKey: source.sourceKey,
                occurrenceId: occurrence.occurrenceId,
            });
            const existingActive = params.before.sources.find((candidate) => candidate.sourceKey === source.sourceKey)?.active;
            await params.tx.sessionRuntimeActivitySource.upsert({
                where: {
                    ownerId_sourceKey_occurrenceId: {
                        ownerId: owner.id,
                        sourceKey: source.sourceKey,
                        occurrenceId: occurrence.occurrenceId,
                    },
                },
                create: {
                    ownerId: owner.id,
                    sourceKey: source.sourceKey,
                    occurrenceId: occurrence.occurrenceId,
                    sourceKind: existingActive?.occurrenceId === occurrence.occurrenceId
                        ? existingActive.sourceKind
                        : null,
                    lifecycleState: occurrence.terminalState,
                    certainty: "authoritative",
                    lastOwnerSequence: BigInt(occurrence.lastOwnerSequence),
                    ...(reasonCode === undefined ? {} : { terminalReasonCode: reasonCode }),
                },
                update: {
                    lifecycleState: occurrence.terminalState,
                    certainty: "authoritative",
                    lastOwnerSequence: BigInt(occurrence.lastOwnerSequence),
                    ...(reasonCode === undefined ? {} : { terminalReasonCode: reasonCode }),
                },
            });
        }
    }
    return owner.id;
}

async function applyInTx(params: Readonly<{
    tx: Tx;
    mutation: SessionRuntimeActivityMutationV2;
    requestDigest: string;
    observedAtMs?: number;
}>): Promise<Readonly<{ ack: SessionRuntimeActivityMutationAckV2 }>> {
    const duplicate = await params.tx.sessionRuntimeActivityMutationReceipt.findUnique({
        where: {
            sessionId_writerGeneration_mutationId: {
                sessionId: params.mutation.sessionId,
                writerGeneration: params.mutation.writerGeneration,
                mutationId: params.mutation.mutationId,
            },
        },
    });
    if (duplicate && duplicate.requestDigest === params.requestDigest) {
        return { ack: ackFromStoredReceipt(duplicate) };
    }
    const session = await params.tx.session.findUnique({
        where: { id: params.mutation.sessionId },
        select: {
            id: true,
            runtimeActivityVersion: true,
            runtimeActivityState: true,
            runtimeActivityWriterGeneration: true,
            runtimeActivityActiveCount: true,
            runtimeActivityObservedAt: true,
            runtimeActivityExpiresAt: true,
            runtimeActivitySourceClass: true,
            runtimeActivityRevision: true,
        },
    });
    if (!session) throw new Error("Session not found");
    const currentProjection = projectionFromSession(session);
    if (duplicate) {
        return {
            ack: SessionRuntimeActivityMutationAckV2Schema.parse({
                v: 2,
                mutationId: params.mutation.mutationId,
                status: "mutation-id-conflict",
                writerGeneration: params.mutation.writerGeneration,
                ownerSequence: toSafeNumber(duplicate.ownerSequence, "conflicting receipt owner sequence"),
                projection: currentProjection,
            }),
        };
    }
    if (session.runtimeActivityVersion !== 2
        || session.runtimeActivityWriterGeneration !== params.mutation.writerGeneration) {
        return {
            ack: SessionRuntimeActivityMutationAckV2Schema.parse({
                v: 2,
                mutationId: params.mutation.mutationId,
                status: "stale-generation",
                writerGeneration: params.mutation.writerGeneration,
                ownerSequence: 0,
                projection: currentProjection,
            }),
        };
    }
    const before = await loadReducerState({ tx: params.tx, session });
    const reduced = applyRuntimeActivityReducerMutation(before, params.mutation, {
        requestDigest: params.requestDigest,
        ...(params.observedAtMs === undefined ? {} : { observedAtMs: params.observedAtMs }),
    });
    const createdReceipt = reduced.state.receipts.find((receipt) => (
        !before.receipts.some((candidate) => candidate.mutationId === receipt.mutationId)
    ));
    if (!createdReceipt) return { ack: reduced.ack };
    const beforeOwner = before.owners.find((owner) => owner.ownerScope === params.mutation.ownerScope);
    const afterOwner = reduced.state.owners.find((owner) => owner.ownerScope === params.mutation.ownerScope);
    if (!beforeOwner || !afterOwner) throw new Error("Expected runtime activity owner missing");

    const sessionCas = await params.tx.session.updateMany({
        where: {
            id: params.mutation.sessionId,
            runtimeActivityVersion: 2,
            runtimeActivityWriterGeneration: params.mutation.writerGeneration,
            runtimeActivityRevision: session.runtimeActivityRevision,
        },
        data: meaningChanged(before.projection, reduced.state.projection)
            ? {
                runtimeActivityState: reduced.state.projection.state,
                runtimeActivityActiveCount: reduced.state.projection.activeCount,
                runtimeActivityObservedAt: reduced.state.projection.observedAtMs === null
                    ? null
                    : BigInt(reduced.state.projection.observedAtMs),
                runtimeActivitySourceClass: reduced.state.projection.sourceClass,
                runtimeActivityRevision: BigInt(reduced.state.projection.revision),
            }
            : { runtimeActivityRevision: session.runtimeActivityRevision },
    });
    if (sessionCas.count !== 1) throw new RuntimeActivityStorageConcurrentWriteError();
    const ownerId = await persistAffectedOwner({
        tx: params.tx,
        mutation: params.mutation,
        before: beforeOwner,
        after: afterOwner,
    });
    await params.tx.sessionRuntimeActivityMutationReceipt.create({
        data: {
            sessionId: params.mutation.sessionId,
            ownerId,
            writerGeneration: params.mutation.writerGeneration,
            ownerScope: params.mutation.ownerScope,
            mutationId: params.mutation.mutationId,
            requestDigest: params.requestDigest,
            ownerSequence: BigInt(params.mutation.ownerSequence),
            ackStatus: reduced.ack.status,
            ackOwnerSequence: BigInt(reduced.ack.ownerSequence),
            projectionState: reduced.ack.projection.state,
            projectionActiveCount: reduced.ack.projection.activeCount,
            projectionSourceClass: reduced.ack.projection.sourceClass,
            projectionObservedAt: reduced.ack.projection.observedAtMs === null
                ? null
                : BigInt(reduced.ack.projection.observedAtMs),
            projectionRevision: BigInt(reduced.ack.projection.revision),
        },
    });
    return { ack: reduced.ack };
}

async function withStorageConcurrencyRetry<T>(operation: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
        try {
            return await operation();
        } catch (error) {
            const concurrent = error instanceof RuntimeActivityStorageConcurrentWriteError
                || isPrismaErrorCode(error, "P2002");
            if (!concurrent || attempt >= STORAGE_CONCURRENCY_RETRIES) throw error;
        }
    }
}

export async function initializeSessionRuntimeActivityGenerationV2(params: Readonly<{
    sessionId: string;
    expectedCurrentGeneration: string | null;
    writerGeneration: string;
    writerCredentialHash: Uint8Array;
    expectedOwnerScopes: readonly string[];
}>): Promise<Readonly<{
    status: "initialized" | "stale-generation";
    projection: SessionRuntimeActivityProjectionV2;
}>> {
    const writerGeneration = SessionRuntimeActivityWriterGenerationSchema.parse(params.writerGeneration);
    const expectedOwnerScopes = SessionRuntimeActivityExpectedOwnerManifestV2Schema.parse(params.expectedOwnerScopes);
    if (params.writerCredentialHash.byteLength !== 32) throw new Error("Writer credential hash must be 32 bytes");
    const writerCredentialHash = Uint8Array.from(params.writerCredentialHash);
    return await withStorageConcurrencyRetry(() => inTx(async (tx) => {
        const session = await tx.session.findUniqueOrThrow({
            where: { id: params.sessionId },
            select: {
                id: true,
                runtimeActivityVersion: true,
                runtimeActivityState: true,
                runtimeActivityWriterGeneration: true,
                runtimeActivityActiveCount: true,
                runtimeActivityObservedAt: true,
                runtimeActivityExpiresAt: true,
                runtimeActivitySourceClass: true,
                runtimeActivityRevision: true,
            },
        });
        const current = projectionFromSession(session);
        if (session.runtimeActivityWriterGeneration !== params.expectedCurrentGeneration) {
            return { status: "stale-generation" as const, projection: current };
        }
        const initialState = createSessionRuntimeActivityReducerStateV2({
            sessionId: params.sessionId,
            writerGeneration,
            expectedOwnerScopes,
            revision: toSafeNumber(session.runtimeActivityRevision, "session revision"),
        });
        const targetMeaning = initialState.projection;
        const publicChanged = session.runtimeActivityVersion !== 2
            || current.state !== targetMeaning.state
            || current.activeCount !== targetMeaning.activeCount
            || current.sourceClass !== targetMeaning.sourceClass;
        const revision = publicChanged ? targetMeaning.revision + 1 : targetMeaning.revision;
        if (!Number.isSafeInteger(revision)) throw new Error("Session runtime activity revision exhausted");
        const targetProjection = { ...targetMeaning, revision };
        const updated = await tx.session.updateMany({
            where: {
                id: params.sessionId,
                runtimeActivityWriterGeneration: params.expectedCurrentGeneration,
                runtimeActivityRevision: session.runtimeActivityRevision,
            },
            data: {
                runtimeActivityVersion: 2,
                runtimeActivityState: targetProjection.state,
                runtimeActivityWriterGeneration: writerGeneration,
                runtimeActivityWriterCredentialHash: writerCredentialHash,
                runtimeActivityRevision: BigInt(targetProjection.revision),
                runtimeActivityActiveCount: targetProjection.activeCount,
                runtimeActivityObservedAt: null,
                runtimeActivityExpiresAt: null,
                runtimeActivitySourceClass: targetProjection.sourceClass,
            },
        });
        if (updated.count !== 1) throw new RuntimeActivityStorageConcurrentWriteError();
        if (expectedOwnerScopes.length > 0) {
            await tx.sessionRuntimeActivityOwner.createMany({
                data: expectedOwnerScopes.map((ownerScope) => ({
                    sessionId: params.sessionId,
                    writerGeneration,
                    ownerScope,
                    state: "unknown",
                    ownerSequence: 0n,
                    lowWatermark: 0n,
                })),
            });
        }
        return { status: "initialized" as const, projection: targetProjection };
    }));
}

export async function applySessionRuntimeActivityMutationV2(params: Readonly<{
    mutation: SessionRuntimeActivityMutationV2;
    requestDigest: string;
    observedAtMs?: number;
}>): Promise<Readonly<{ ack: SessionRuntimeActivityMutationAckV2 }>> {
    const mutation = SessionRuntimeActivityMutationV2Schema.parse(params.mutation);
    const requestDigest = SessionRuntimeActivityRequestDigestSchema.parse(params.requestDigest);
    return await withStorageConcurrencyRetry(() => inTx(async (tx) => await applyInTx({
        tx,
        mutation,
        requestDigest,
        ...(params.observedAtMs === undefined ? {} : { observedAtMs: params.observedAtMs }),
    })));
}

function buildReceiptCompactionAck(params: Readonly<{
    acknowledgement: SessionRuntimeActivityReceiptCompactionV2;
    status: SessionRuntimeActivityReceiptCompactionAckV2["status"];
    ownerSequence: number;
    lowWatermark: number;
}>): SessionRuntimeActivityReceiptCompactionAckV2 {
    return SessionRuntimeActivityReceiptCompactionAckV2Schema.parse({
        v: 2,
        status: params.status,
        writerGeneration: params.acknowledgement.writerGeneration,
        ownerScope: params.acknowledgement.ownerScope,
        ownerSequence: params.ownerSequence,
        lowWatermark: params.lowWatermark,
    });
}

/**
 * Advances the persisted safe receipt-compaction watermark only after the
 * current writer explicitly acknowledges that it durably observed all server
 * mutation acknowledgements through the supplied owner sequence.
 *
 * This compacts exact-replay receipts only. Source occurrence tombstones are
 * deliberately retained, while the monotonic owner low-watermark continues to
 * fence every delayed lifecycle mutation at or below the acknowledged point.
 */
export async function acknowledgeSessionRuntimeActivityReceiptsV2(params: Readonly<{
    acknowledgement: SessionRuntimeActivityReceiptCompactionV2;
}>): Promise<Readonly<{ ack: SessionRuntimeActivityReceiptCompactionAckV2 }>> {
    const acknowledgement = SessionRuntimeActivityReceiptCompactionV2Schema.parse(params.acknowledgement);
    return await withStorageConcurrencyRetry(() => inTx(async (tx) => {
        const session = await tx.session.findUnique({
            where: { id: acknowledgement.sessionId },
            select: { runtimeActivityVersion: true, runtimeActivityWriterGeneration: true },
        });
        if (!session) throw new Error("Session not found");
        if (session.runtimeActivityVersion !== 2
            || session.runtimeActivityWriterGeneration !== acknowledgement.writerGeneration) {
            return {
                ack: buildReceiptCompactionAck({
                    acknowledgement,
                    status: "stale-generation",
                    ownerSequence: 0,
                    lowWatermark: 0,
                }),
            };
        }

        const owner = await tx.sessionRuntimeActivityOwner.findUnique({
            where: {
                sessionId_writerGeneration_ownerScope: {
                    sessionId: acknowledgement.sessionId,
                    writerGeneration: acknowledgement.writerGeneration,
                    ownerScope: acknowledgement.ownerScope,
                },
            },
            select: { id: true, ownerSequence: true, lowWatermark: true },
        });
        if (!owner) {
            return {
                ack: buildReceiptCompactionAck({
                    acknowledgement,
                    status: "owner-not-expected",
                    ownerSequence: 0,
                    lowWatermark: 0,
                }),
            };
        }

        const ownerSequence = toSafeNumber(owner.ownerSequence, "owner sequence");
        const lowWatermark = toSafeNumber(owner.lowWatermark, "owner low watermark");
        const throughSequence = acknowledgement.acknowledgedThroughSequence;
        if (throughSequence <= lowWatermark) {
            return {
                ack: buildReceiptCompactionAck({
                    acknowledgement,
                    status: "already-compacted",
                    ownerSequence,
                    lowWatermark,
                }),
            };
        }
        if (throughSequence > ownerSequence) {
            return {
                ack: buildReceiptCompactionAck({
                    acknowledgement,
                    status: "acknowledgement-ahead",
                    ownerSequence,
                    lowWatermark,
                }),
            };
        }

        const retainedReceiptCount = await tx.sessionRuntimeActivityMutationReceipt.count({
            where: {
                ownerId: owner.id,
                ownerSequence: { gt: owner.lowWatermark, lte: BigInt(throughSequence) },
            },
        });
        if (retainedReceiptCount !== throughSequence - lowWatermark) {
            return {
                ack: buildReceiptCompactionAck({
                    acknowledgement,
                    status: "receipt-gap",
                    ownerSequence,
                    lowWatermark,
                }),
            };
        }

        const advanced = await tx.sessionRuntimeActivityOwner.updateMany({
            where: {
                id: owner.id,
                ...buildRuntimeActivityOwnerSequenceCas({ ownerSequence, lowWatermark }),
            },
            data: { lowWatermark: BigInt(throughSequence) },
        });
        if (advanced.count !== 1) throw new RuntimeActivityStorageConcurrentWriteError();
        await tx.sessionRuntimeActivityMutationReceipt.deleteMany({
            where: { ownerId: owner.id, ownerSequence: { lte: BigInt(throughSequence) } },
        });
        return {
            ack: buildReceiptCompactionAck({
                acknowledgement,
                status: "compacted",
                ownerSequence,
                lowWatermark: throughSequence,
            }),
        };
    }));
}
