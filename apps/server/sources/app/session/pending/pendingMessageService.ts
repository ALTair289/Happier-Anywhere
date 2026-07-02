import type { SessionParticipantCursor } from "@/app/session/changeTracking/markSessionParticipantsChanged";
import { applyPendingSessionStateChange } from "@/app/session/pending/applyPendingSessionStateChange";
import { mapPendingMessageRow } from "@/app/session/pending/mapPendingMessageRow";
import {
    resolveSessionPendingEditAccess,
    resolveSessionPendingOwnerAccess,
    resolveSessionPendingViewAccess,
} from "@/app/session/pending/resolveSessionPendingAccess";
import type { PendingMessageRow } from "@/app/session/pending/mapPendingMessageRow";
import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { isPrismaErrorCode } from "@/storage/prisma";
import { readEncryptionFeatureEnv } from "@/app/features/catalog/readFeatureEnv";
import {
    isStoredContentKindAllowedForSessionByStoragePolicy,
    normalizePendingDeliveryBlockedReason,
    type PendingDeliveryBlockedReason,
    type SessionStoredContentKind,
} from "@happier-dev/protocol";
import { resolveEncryptionWriteRejectionCode, type EncryptionPolicyRejectionCode } from "@/app/session/encryptionRejectionCodes";
import { reserveNextPendingQueuePosition } from "@/app/session/pending/reserveNextPendingQueuePosition";
import { resolveSessionMessageRole } from "@/app/session/messageRole/resolveSessionMessageRole";
import { isDeepStrictEqual } from "node:util";
import { markSessionParticipantsChanged } from "@/app/session/changeTracking/markSessionParticipantsChanged";
import {
    createSessionMessageFromPending,
    resolvePendingTranscriptCompatibility,
    type PendingTranscriptMessage,
} from "@/app/session/pending/pendingMessageTranscriptCommit";
import { blockStaleProviderDeliveryClaims } from "@/app/session/pending/providerDeliveryClaimStaleness";
import {
    resolveReadyProjectionEventType,
    updateSessionMessageActivityProjection,
    type SessionReadyProjectionUpdate,
} from "@/app/session/sessionWriteService";

type ParticipantCursor = SessionParticipantCursor;
type PendingServiceTx = Parameters<Parameters<typeof inTx>[0]>[0];

function isPendingDeliveryResolutionRaceError(error: unknown): boolean {
    return isPrismaErrorCode(error, "P2002") || isPrismaErrorCode(error, "P2025");
}

async function retryPendingDeliveryResolutionRace<T>(operation: () => Promise<T>): Promise<T> {
    try {
        return await operation();
    } catch (error) {
        if (!isPendingDeliveryResolutionRaceError(error)) {
            throw error;
        }
        return operation();
    }
}

export type { PendingMessageRow } from "@/app/session/pending/mapPendingMessageRow";

export type ListPendingMessagesResult =
    | { ok: true; pending: PendingMessageRow[] }
    | { ok: false; error: "session-not-found" | "forbidden" | "invalid-params" | "internal" };

export type ReadSessionPendingStateResult =
    | { ok: true; pendingCount: number; pendingBlockedCount: number; pendingVersion: number }
    | { ok: false; error: "session-not-found" | "forbidden" | "invalid-params" | "internal" };

export async function readSessionPendingState(params: {
    actorUserId: string;
    sessionId: string;
}): Promise<ReadSessionPendingStateResult> {
    const actorUserId = typeof params.actorUserId === "string" ? params.actorUserId : "";
    const sessionId = typeof params.sessionId === "string" ? params.sessionId : "";
    if (!actorUserId || !sessionId) return { ok: false, error: "invalid-params" };

    const access = await resolveSessionPendingOwnerAccess(actorUserId, sessionId);
    if (!access.ok) return { ok: false, error: access.error };

    try {
        const session = await db.session.findUnique({
            where: { id: sessionId },
            select: { pendingCount: true, pendingBlockedCount: true, pendingVersion: true },
        });
        if (!session) return { ok: false, error: "session-not-found" };
        return {
            ok: true,
            pendingCount: session.pendingCount ?? 0,
            pendingBlockedCount: session.pendingBlockedCount ?? 0,
            pendingVersion: session.pendingVersion ?? 0,
        };
    } catch {
        return { ok: false, error: "internal" };
    }
}

export async function listPendingMessages(params: {
    actorUserId: string;
    sessionId: string;
    includeDiscarded?: boolean;
}): Promise<ListPendingMessagesResult> {
    const actorUserId = typeof params.actorUserId === "string" ? params.actorUserId : "";
    const sessionId = typeof params.sessionId === "string" ? params.sessionId : "";
    const includeDiscarded = params.includeDiscarded === true;

    if (!actorUserId || !sessionId) return { ok: false, error: "invalid-params" };

    const access = await resolveSessionPendingViewAccess(actorUserId, sessionId);
    if (!access.ok) return { ok: false, error: access.error };

    const select = {
        localId: true,
        messageRole: true,
        content: true,
        status: true,
        deliveryState: true,
        deliveryBlockedReason: true,
        position: true,
        createdAt: true,
        updatedAt: true,
        discardedAt: true,
        discardedReason: true,
        authorAccountId: true,
    } as const;

    try {
        if (!includeDiscarded) {
            const rows = await db.sessionPendingMessage.findMany({
                where: { sessionId, status: "queued" },
                orderBy: [{ position: "asc" }, { createdAt: "asc" }, { localId: "asc" }],
                select,
            });
            return { ok: true, pending: rows.map(mapPendingMessageRow) };
        }

        const [queued, discarded] = await Promise.all([
            db.sessionPendingMessage.findMany({
                where: { sessionId, status: "queued" },
                orderBy: [{ position: "asc" }, { createdAt: "asc" }, { localId: "asc" }],
                select,
            }),
            db.sessionPendingMessage.findMany({
                where: { sessionId, status: "discarded" },
                orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
                select,
            }),
        ]);

        return { ok: true, pending: [...queued.map(mapPendingMessageRow), ...discarded.map(mapPendingMessageRow)] };
    } catch {
        return { ok: false, error: "internal" };
    }
}

export type EnqueuePendingMessageResult =
    | {
        ok: true;
        didWrite: boolean;
        pending: PendingMessageRow;
        pendingCount: number;
        pendingBlockedCount: number;
        pendingVersion: number;
        meaningfulActivityAt?: Date;
        badgeAttentionChanged: boolean;
        participantCursors: ParticipantCursor[];
      }
    | { ok: false; error: "session-not-found" | "forbidden" | "invalid-params" | "internal"; code?: EncryptionPolicyRejectionCode };

export async function enqueuePendingMessage(params: {
    actorUserId: string;
    sessionId: string;
    localId: string;
    messageRole?: unknown;
} & (
    | Readonly<{ ciphertext: string; content?: never }>
    | Readonly<{ content: PrismaJson.SessionPendingMessageContent; ciphertext?: never }>
)): Promise<EnqueuePendingMessageResult> {
    const actorUserId = typeof params.actorUserId === "string" ? params.actorUserId : "";
    const sessionId = typeof params.sessionId === "string" ? params.sessionId : "";
    const localId = typeof params.localId === "string" ? params.localId : "";
    const ciphertext = "ciphertext" in params && typeof params.ciphertext === "string" ? params.ciphertext : "";
    const content =
        "content" in params ? params.content : ciphertext ? ({ t: "encrypted", c: ciphertext } satisfies PrismaJson.SessionPendingMessageContent) : null;

    if (!actorUserId || !sessionId || !localId || !content) return { ok: false, error: "invalid-params" };
    if (content.t === "encrypted" && (!content.c || typeof content.c !== "string")) return { ok: false, error: "invalid-params" };
    if (content.t === "plain" && !("v" in content)) return { ok: false, error: "invalid-params" };

    const access = await resolveSessionPendingEditAccess(actorUserId, sessionId);
    if (!access.ok) return { ok: false, error: access.error };

    try {
        return await inTx(async (tx) => {
            const session = await tx.session.findUnique({
                where: { id: sessionId },
                select: { encryptionMode: true, pendingCount: true, pendingBlockedCount: true, pendingVersion: true },
            });
            if (!session) return { ok: false, error: "session-not-found" } as const;

            const sessionEncryptionMode: "e2ee" | "plain" = session.encryptionMode === "plain" ? "plain" : "e2ee";
            const messageRole = resolveSessionMessageRole({
                content,
                suppliedRole: params.messageRole,
                telemetry: {
                    sessionId,
                    storageMode: sessionEncryptionMode,
                    source: "pending-message",
                },
            }).messageRole;
            const writeKind: SessionStoredContentKind = content.t === "plain" ? "plain" : "encrypted";
            const policy = readEncryptionFeatureEnv(process.env);
            if (!isStoredContentKindAllowedForSessionByStoragePolicy(policy.storagePolicy, sessionEncryptionMode, writeKind)) {
                return {
                    ok: false,
                    error: "invalid-params",
                    code: resolveEncryptionWriteRejectionCode({
                        storagePolicy: policy.storagePolicy,
                        sessionEncryptionMode,
                        writeKind,
                    }),
                } as const;
            }

            const existing = await tx.sessionPendingMessage.findUnique({
                where: { sessionId_localId: { sessionId, localId } },
                select: {
                    localId: true,
                    messageRole: true,
                    content: true,
                    status: true,
                    deliveryState: true,
                    deliveryBlockedReason: true,
                    position: true,
                    createdAt: true,
                    updatedAt: true,
                    discardedAt: true,
                    discardedReason: true,
                    authorAccountId: true,
                },
            });
            if (existing) {
                const pending = existing.messageRole === null && messageRole !== null && isDeepStrictEqual(existing.content, content)
                    ? await tx.sessionPendingMessage.update({
                        where: { sessionId_localId: { sessionId, localId } },
                        data: { messageRole },
                        select: {
                            localId: true,
                            messageRole: true,
                            content: true,
                            status: true,
                            deliveryState: true,
                            deliveryBlockedReason: true,
                            position: true,
                            createdAt: true,
                            updatedAt: true,
                            discardedAt: true,
                            discardedReason: true,
                            authorAccountId: true,
                        },
                    })
                    : existing;
                return {
                    ok: true,
                    didWrite: false,
                    pending: mapPendingMessageRow(pending),
                    pendingCount: session.pendingCount ?? 0,
                    pendingBlockedCount: session.pendingBlockedCount ?? 0,
                    pendingVersion: session.pendingVersion ?? 0,
                    badgeAttentionChanged: false,
                    participantCursors: [],
                };
            }

            const position = await reserveNextPendingQueuePosition(tx, sessionId);

            const created = await tx.sessionPendingMessage.create({
                data: {
                    sessionId,
                    localId,
                    messageRole,
                    content,
                    status: "queued",
                    position,
                    authorAccountId: actorUserId,
                },
                select: {
                    localId: true,
                    messageRole: true,
                    content: true,
                    status: true,
                    deliveryState: true,
                    deliveryBlockedReason: true,
                    position: true,
                    createdAt: true,
                    updatedAt: true,
                    discardedAt: true,
                    discardedReason: true,
                    authorAccountId: true,
                },
            });

            const { pendingCount, pendingBlockedCount, pendingVersion, participantCursors, badgeAttentionChanged } = await applyPendingSessionStateChange({
                tx,
                sessionId,
                pendingCountDelta: 1,
                meaningfulActivityAt: created.createdAt,
            });

            return {
                ok: true,
                didWrite: true,
                pending: mapPendingMessageRow(created),
                pendingCount,
                pendingBlockedCount,
                pendingVersion,
                meaningfulActivityAt: created.createdAt,
                badgeAttentionChanged,
                participantCursors,
            };
        });
    } catch {
        return { ok: false, error: "internal" };
    }
}

export type UpdatePendingMessageResult =
    | { ok: true; pendingVersion: number; pendingCount: number; pendingBlockedCount: number; participantCursors: ParticipantCursor[]; badgeAttentionChanged: boolean }
    | { ok: false; error: "session-not-found" | "forbidden" | "invalid-params" | "not-found" | "internal"; code?: EncryptionPolicyRejectionCode };

export async function updatePendingMessage(params: {
    actorUserId: string;
    sessionId: string;
    localId: string;
    messageRole?: unknown;
} & (
    | Readonly<{ ciphertext: string; content?: never }>
    | Readonly<{ content: PrismaJson.SessionPendingMessageContent; ciphertext?: never }>
)): Promise<UpdatePendingMessageResult> {
    const actorUserId = typeof params.actorUserId === "string" ? params.actorUserId : "";
    const sessionId = typeof params.sessionId === "string" ? params.sessionId : "";
    const localId = typeof params.localId === "string" ? params.localId : "";
    const ciphertext = "ciphertext" in params && typeof params.ciphertext === "string" ? params.ciphertext : "";
    const content =
        "content" in params ? params.content : ciphertext ? ({ t: "encrypted", c: ciphertext } satisfies PrismaJson.SessionPendingMessageContent) : null;

    if (!actorUserId || !sessionId || !localId || !content) return { ok: false, error: "invalid-params" };
    if (content.t === "encrypted" && (!content.c || typeof content.c !== "string")) return { ok: false, error: "invalid-params" };
    if (content.t === "plain" && !("v" in content)) return { ok: false, error: "invalid-params" };

    const access = await resolveSessionPendingEditAccess(actorUserId, sessionId);
    if (!access.ok) return { ok: false, error: access.error };

    try {
        return await inTx(async (tx) => {
            const session = await tx.session.findUnique({
                where: { id: sessionId },
                select: { encryptionMode: true },
            });
            if (!session) return { ok: false, error: "session-not-found" } as const;

            const sessionEncryptionMode: "e2ee" | "plain" = session.encryptionMode === "plain" ? "plain" : "e2ee";
            const messageRole = resolveSessionMessageRole({
                content,
                suppliedRole: params.messageRole,
                telemetry: {
                    sessionId,
                    storageMode: sessionEncryptionMode,
                    source: "pending-message",
                },
            }).messageRole;
            const writeKind: SessionStoredContentKind = content.t === "plain" ? "plain" : "encrypted";
            const policy = readEncryptionFeatureEnv(process.env);
            if (!isStoredContentKindAllowedForSessionByStoragePolicy(policy.storagePolicy, sessionEncryptionMode, writeKind)) {
                return {
                    ok: false,
                    error: "invalid-params",
                    code: resolveEncryptionWriteRejectionCode({
                        storagePolicy: policy.storagePolicy,
                        sessionEncryptionMode,
                        writeKind,
                    }),
                } as const;
            }

            const existing = await tx.sessionPendingMessage.findUnique({
                where: { sessionId_localId: { sessionId, localId } },
                select: { id: true, status: true, deliveryState: true },
            });
            if (!existing) return { ok: false, error: "not-found" } as const;
            if (existing.deliveryState === "delivering") return { ok: false, error: "not-found" } as const;

            await tx.sessionPendingMessage.update({
                where: { sessionId_localId: { sessionId, localId } },
                data: { content, messageRole },
            });

            const { pendingVersion, pendingCount, pendingBlockedCount, participantCursors, badgeAttentionChanged } = await applyPendingSessionStateChange({
                tx,
                sessionId,
            });
            return { ok: true, pendingVersion, pendingCount, pendingBlockedCount, participantCursors, badgeAttentionChanged };
        });
    } catch {
        return { ok: false, error: "internal" };
    }
}

export type DeletePendingMessageResult =
    | { ok: true; pendingVersion: number; pendingCount: number; pendingBlockedCount: number; participantCursors: ParticipantCursor[]; badgeAttentionChanged: boolean }
    | { ok: false; error: "session-not-found" | "forbidden" | "invalid-params" | "internal" };

export async function deletePendingMessage(params: {
    actorUserId: string;
    sessionId: string;
    localId: string;
}): Promise<DeletePendingMessageResult> {
    const actorUserId = typeof params.actorUserId === "string" ? params.actorUserId : "";
    const sessionId = typeof params.sessionId === "string" ? params.sessionId : "";
    const localId = typeof params.localId === "string" ? params.localId : "";

    if (!actorUserId || !sessionId || !localId) return { ok: false, error: "invalid-params" };

    const access = await resolveSessionPendingEditAccess(actorUserId, sessionId);
    if (!access.ok) return { ok: false, error: access.error };

    try {
        return await inTx(async (tx) => {
            const existing = await tx.sessionPendingMessage.findUnique({
                where: { sessionId_localId: { sessionId, localId } },
                select: { status: true, deliveryState: true },
            });

            if (!existing) {
                const session = await tx.session.findUnique({
                    where: { id: sessionId },
                    select: { pendingCount: true, pendingBlockedCount: true, pendingVersion: true },
                });
                return {
                    ok: true,
                    pendingVersion: session?.pendingVersion ?? 0,
                    pendingCount: session?.pendingCount ?? 0,
                    pendingBlockedCount: session?.pendingBlockedCount ?? 0,
                    participantCursors: [],
                    badgeAttentionChanged: false,
                };
            }
            await tx.sessionPendingMessage.delete({
                where: { sessionId_localId: { sessionId, localId } },
            });

            const { pendingVersion, pendingCount, pendingBlockedCount, participantCursors, badgeAttentionChanged } = await applyPendingSessionStateChange({
                tx,
                sessionId,
                pendingCountDelta: existing.status === "queued" ? -1 : 0,
                pendingBlockedCountDelta: existing.status === "queued" && existing.deliveryState === "blocked" ? -1 : 0,
            });
            return { ok: true, pendingVersion, pendingCount, pendingBlockedCount, participantCursors, badgeAttentionChanged };
        });
    } catch {
        return { ok: false, error: "internal" };
    }
}

export type ResolveAcceptedPendingDeliveryResult =
    | {
        ok: true;
        pendingVersion: number;
        pendingCount: number;
        pendingBlockedCount: number;
        participantCursors: ParticipantCursor[];
        participantCursorsPending?: ParticipantCursor[];
        participantCursorsMessage?: ParticipantCursor[];
        badgeAttentionChanged: boolean;
        didResolve: boolean;
        didWrite?: boolean;
        didUpdate?: boolean;
        message?: PendingTranscriptMessage;
        readyProjection?: SessionReadyProjectionUpdate;
      }
    | {
        ok: false;
        error: "session-not-found" | "forbidden" | "invalid-params" | "not-found" | "not-materialized" | "blocked-by-earlier-pending" | "transcript-conflict" | "internal";
        pendingStateChanged?: boolean;
        pendingVersion?: number;
        pendingCount?: number;
        pendingBlockedCount?: number;
        participantCursors?: ParticipantCursor[];
        badgeAttentionChanged?: boolean;
      };

type PendingDeliveryResolutionInput = Readonly<{
    status: string;
    deliveryState: string | null;
    messageRole: string | null;
    content: unknown;
    position: number;
}>;

type PendingDeliveryBlockRowInput = Readonly<{
    localId: string;
    status: string;
    deliveryState: string | null;
}>;

async function markPendingDeliveryRowsBlocked(
    tx: PendingServiceTx,
    params: Readonly<{
        sessionId: string;
        rows: readonly PendingDeliveryBlockRowInput[];
        reason: PendingDeliveryBlockedReason;
    }>,
): Promise<Readonly<{ updatedCount: number; pendingBlockedCountDelta: number }>> {
    const localIds = [...new Set(params.rows.map((row) => row.localId).filter((localId) => localId.length > 0))];
    if (localIds.length === 0) return { updatedCount: 0, pendingBlockedCountDelta: 0 };

    const pendingBlockedCountDelta = params.rows.filter((row) =>
        row.status === "queued" && row.deliveryState !== "blocked",
    ).length;
    const updated = await tx.sessionPendingMessage.updateMany({
        where: {
            sessionId: params.sessionId,
            localId: { in: localIds },
            status: "queued",
        },
        data: { deliveryState: "blocked", deliveryBlockedReason: params.reason },
    });

    return {
        updatedCount: updated.count,
        pendingBlockedCountDelta,
    };
}

async function commitResolvedPendingDelivery(
    tx: PendingServiceTx,
    params: Readonly<{
        actorUserId: string;
        sessionId: string;
        localId: string;
        existing: PendingDeliveryResolutionInput;
    }>,
): Promise<
    | {
        ok: true;
        pendingVersion: number;
        pendingCount: number;
        pendingBlockedCount: number;
        participantCursors: ParticipantCursor[];
        participantCursorsPending: ParticipantCursor[];
        participantCursorsMessage: ParticipantCursor[];
        badgeAttentionChanged: boolean;
        didWrite: boolean;
        didUpdate: boolean;
        message: PendingTranscriptMessage;
        readyProjection?: SessionReadyProjectionUpdate;
      }
    | { ok: false; error: "session-not-found" | "invalid-params" }
    | {
        ok: false;
        error: "transcript-conflict";
        pendingStateChanged: true;
        pendingVersion: number;
        pendingCount: number;
        pendingBlockedCount: number;
        participantCursors: ParticipantCursor[];
        badgeAttentionChanged: boolean;
      }
> {
    const session = await tx.session.findUnique({
        where: { id: params.sessionId },
        select: { accountId: true, encryptionMode: true },
    });
    if (!session) return { ok: false, error: "session-not-found" };

    const sessionEncryptionMode: "e2ee" | "plain" = session.encryptionMode === "plain" ? "plain" : "e2ee";
    const content = params.existing.content as PrismaJson.SessionPendingMessageContent;
    const messageRole = resolveSessionMessageRole({
        content,
        suppliedRole: params.existing.messageRole,
        telemetry: {
            sessionId: params.sessionId,
            storageMode: sessionEncryptionMode,
            source: "pending-materialization",
        },
    }).messageRole;
    const writeKind: SessionStoredContentKind = content.t === "plain" ? "plain" : "encrypted";
    const policy = readEncryptionFeatureEnv(process.env);
    if (!isStoredContentKindAllowedForSessionByStoragePolicy(policy.storagePolicy, sessionEncryptionMode, writeKind)) {
        return { ok: false, error: "invalid-params" };
    }

    const committed = await createSessionMessageFromPending(tx, {
        sessionId: params.sessionId,
        localId: params.localId,
        content,
        messageRole,
    });
    if (!committed.ok) {
        const blocked = await markPendingDeliveryRowsBlocked(tx, {
            sessionId: params.sessionId,
            rows: [{
                localId: params.localId,
                status: params.existing.status,
                deliveryState: params.existing.deliveryState,
            }],
            reason: "unknown",
        });
        const { pendingVersion, pendingCount, pendingBlockedCount, participantCursors, badgeAttentionChanged } = await applyPendingSessionStateChange({
            tx,
            sessionId: params.sessionId,
            pendingBlockedCountDelta: blocked.pendingBlockedCountDelta,
        });
        return {
            ok: false,
            error: committed.error,
            pendingStateChanged: true,
            pendingVersion,
            pendingCount,
            pendingBlockedCount,
            participantCursors,
            badgeAttentionChanged,
        };
    }
    const readyProjection = committed.didWrite
        ? await updateSessionMessageActivityProjection(tx, {
            sessionId: params.sessionId,
            created: committed.message,
            trustedSessionEventType: resolveReadyProjectionEventType({
                actorUserId: params.actorUserId,
                sessionOwnerId: session.accountId,
                content,
            }),
        })
        : undefined;

    await tx.sessionPendingMessage.delete({
        where: { sessionId_localId: { sessionId: params.sessionId, localId: params.localId } },
    });

    const { pendingVersion, pendingCount, pendingBlockedCount, participantCursors, badgeAttentionChanged } = await applyPendingSessionStateChange({
        tx,
        sessionId: params.sessionId,
        pendingCountDelta: params.existing.status === "queued" ? -1 : 0,
        pendingBlockedCountDelta: params.existing.status === "queued" && params.existing.deliveryState === "blocked" ? -1 : 0,
    });
    const participantCursorsMessage = committed.didWrite || committed.didUpdate
        ? await markSessionParticipantsChanged({
            tx,
            sessionId: params.sessionId,
            hint: { lastMessageSeq: committed.message.seq, lastMessageId: committed.message.id },
        })
        : [];
    return {
        ok: true,
        pendingVersion,
        pendingCount,
        pendingBlockedCount,
        participantCursors,
        participantCursorsPending: participantCursors,
        participantCursorsMessage,
        badgeAttentionChanged,
        didWrite: committed.didWrite,
        didUpdate: committed.didUpdate,
        message: committed.message,
        ...(readyProjection ? { readyProjection } : {}),
    };
}

export async function resolveAcceptedPendingDelivery(params: {
    actorUserId: string;
    sessionId: string;
    localId: string;
}): Promise<ResolveAcceptedPendingDeliveryResult> {
    const actorUserId = typeof params.actorUserId === "string" ? params.actorUserId : "";
    const sessionId = typeof params.sessionId === "string" ? params.sessionId : "";
    const localId = typeof params.localId === "string" ? params.localId : "";

    if (!actorUserId || !sessionId || !localId) return { ok: false, error: "invalid-params" };

    const access = await resolveSessionPendingOwnerAccess(actorUserId, sessionId);
    if (!access.ok) return { ok: false, error: access.error };

    try {
        return await retryPendingDeliveryResolutionRace(() => inTx(async (tx) => {
            const existing = await tx.sessionPendingMessage.findUnique({
                where: { sessionId_localId: { sessionId, localId } },
                select: { status: true, deliveryState: true, messageRole: true, content: true, position: true },
            });

            if (!existing) {
                const committed = await tx.sessionMessage.findFirst({
                    where: {
                        sessionId,
                        localId,
                        OR: [
                            { messageRole: "user" },
                            { messageRole: null },
                        ],
                    },
                    select: { id: true },
                });
                if (!committed) {
                    return { ok: false, error: "not-found" } as const;
                }

                const session = await tx.session.findUnique({
                    where: { id: sessionId },
                    select: { pendingCount: true, pendingBlockedCount: true, pendingVersion: true },
                });
                return {
                    ok: true,
                    pendingVersion: session?.pendingVersion ?? 0,
                    pendingCount: session?.pendingCount ?? 0,
                    pendingBlockedCount: session?.pendingBlockedCount ?? 0,
                    participantCursors: [],
                    badgeAttentionChanged: false,
                    didResolve: false,
                } as const;
            }

            if (existing.status !== "queued") {
                const session = await tx.session.findUnique({
                    where: { id: sessionId },
                    select: { pendingCount: true, pendingBlockedCount: true, pendingVersion: true },
                });
                return {
                    ok: true,
                    pendingVersion: session?.pendingVersion ?? 0,
                    pendingCount: session?.pendingCount ?? 0,
                    pendingBlockedCount: session?.pendingBlockedCount ?? 0,
                    participantCursors: [],
                    badgeAttentionChanged: false,
                    didResolve: false,
                } as const;
            }

            const earlierUnresolved = await tx.sessionPendingMessage.findFirst({
                where: {
                    sessionId,
                    status: "queued",
                    position: { lt: existing.position },
                },
                select: { localId: true },
                orderBy: [{ position: "asc" }, { createdAt: "asc" }, { localId: "asc" }],
            });
            if (earlierUnresolved) {
                return { ok: false, error: "blocked-by-earlier-pending" } as const;
            }

            const resolved = await commitResolvedPendingDelivery(tx, {
                actorUserId,
                sessionId,
                localId,
                existing,
            });
            if (!resolved.ok) return resolved;
            return {
                ...resolved,
                didResolve: true,
            };
        }));
    } catch {
        return { ok: false, error: "internal" };
    }
}

export type ReconcileAcceptedPendingDeliveriesThroughSeqResult =
    | { ok: true; pendingVersion: number; pendingCount: number; pendingBlockedCount: number; participantCursors: ParticipantCursor[]; badgeAttentionChanged: boolean; didResolve: boolean; resolvedCount: number; resolvedLocalIds: string[] }
    | { ok: false; error: "session-not-found" | "forbidden" | "invalid-params" | "internal" };

export async function reconcileAcceptedPendingDeliveriesThroughSeq(params: {
    actorUserId: string;
    sessionId: string;
    maxAcceptedSeq: number;
}): Promise<ReconcileAcceptedPendingDeliveriesThroughSeqResult> {
    const actorUserId = typeof params.actorUserId === "string" ? params.actorUserId : "";
    const sessionId = typeof params.sessionId === "string" ? params.sessionId : "";
    const maxAcceptedSeq = Number.isSafeInteger(params.maxAcceptedSeq) && params.maxAcceptedSeq >= 0
        ? params.maxAcceptedSeq
        : null;

    if (!actorUserId || !sessionId || maxAcceptedSeq === null) return { ok: false, error: "invalid-params" };

    const access = await resolveSessionPendingOwnerAccess(actorUserId, sessionId);
    if (!access.ok) return { ok: false, error: access.error };

    try {
        return await inTx(async (tx) => {
            const session = await tx.session.findUnique({
                where: { id: sessionId },
                select: { encryptionMode: true },
            });
            if (!session) return { ok: false, error: "session-not-found" } as const;
            const sessionEncryptionMode: "e2ee" | "plain" = session.encryptionMode === "plain" ? "plain" : "e2ee";
            const unresolvedRows = await tx.sessionPendingMessage.findMany({
                where: {
                    sessionId,
                    status: "queued",
                    deliveryState: { in: ["delivering", "blocked"] },
                },
                select: { localId: true, deliveryState: true, messageRole: true, content: true },
            });
            if (unresolvedRows.length === 0) {
                return { ok: true, ...(await readCurrentPendingMutationState(tx, sessionId)), didResolve: false, resolvedCount: 0, resolvedLocalIds: [] };
            }

            const localIds = unresolvedRows.map((row) => row.localId);
            const acceptedMessages = await tx.sessionMessage.findMany({
                where: {
                    sessionId,
                    localId: { in: localIds },
                    seq: { lte: maxAcceptedSeq },
                },
                select: { localId: true, messageRole: true, content: true },
            });
            const acceptedMessageByLocalId = new Map<string, typeof acceptedMessages[number]>();
            for (const message of acceptedMessages) {
                if (typeof message.localId === "string" && message.localId.length > 0) {
                    acceptedMessageByLocalId.set(message.localId, message);
                }
            }
            const acceptedLocalIds: string[] = [];
            const conflictingRows: PendingDeliveryBlockRowInput[] = [];
            for (const row of unresolvedRows) {
                const message = acceptedMessageByLocalId.get(row.localId);
                if (!message) continue;
                const compatibility = resolvePendingTranscriptCompatibility({
                    existing: message,
                    pending: {
                        content: row.content as PrismaJson.SessionMessageContent,
                        messageRole: resolveSessionMessageRole({
                            content: row.content as PrismaJson.SessionPendingMessageContent,
                            suppliedRole: row.messageRole,
                            telemetry: {
                                sessionId,
                                storageMode: sessionEncryptionMode,
                                source: "pending-materialization",
                            },
                        }).messageRole,
                    },
                });
                if (compatibility.ok) {
                    acceptedLocalIds.push(row.localId);
                } else {
                    conflictingRows.push({
                        localId: row.localId,
                        status: "queued",
                        deliveryState: row.deliveryState,
                    });
                }
            }

            if (acceptedLocalIds.length === 0 && conflictingRows.length === 0) {
                return { ok: true, ...(await readCurrentPendingMutationState(tx, sessionId)), didResolve: false, resolvedCount: 0, resolvedLocalIds: [] };
            }

            const blockedConflicts = await markPendingDeliveryRowsBlocked(tx, {
                sessionId,
                rows: conflictingRows,
                reason: "unknown",
            });
            const acceptedLocalIdSet = new Set(acceptedLocalIds);
            const resolvedBlockedCount = unresolvedRows.filter((row) => acceptedLocalIdSet.has(row.localId) && row.deliveryState === "blocked").length;
            const deleted = await tx.sessionPendingMessage.deleteMany({
                where: {
                    sessionId,
                    localId: { in: acceptedLocalIds },
                    status: "queued",
                    deliveryState: { in: ["delivering", "blocked"] },
                },
            });

            const { pendingVersion, pendingCount, pendingBlockedCount, participantCursors, badgeAttentionChanged } = await applyPendingSessionStateChange({
                tx,
                sessionId,
                pendingCountDelta: deleted.count > 0 ? -deleted.count : 0,
                pendingBlockedCountDelta: blockedConflicts.pendingBlockedCountDelta
                    + (deleted.count > 0 ? -Math.min(resolvedBlockedCount, deleted.count) : 0),
            });
            return {
                ok: true,
                pendingVersion,
                pendingCount,
                pendingBlockedCount,
                participantCursors,
                badgeAttentionChanged,
                didResolve: deleted.count > 0,
                resolvedCount: deleted.count,
                resolvedLocalIds: acceptedLocalIds,
            };
        });
    } catch {
        return { ok: false, error: "internal" };
    }
}

async function readCurrentPendingMutationState(tx: PendingServiceTx, sessionId: string) {
    const session = await tx.session.findUnique({
        where: { id: sessionId },
        select: { pendingCount: true, pendingBlockedCount: true, pendingVersion: true },
    });
    return {
        pendingVersion: session?.pendingVersion ?? 0,
        pendingCount: session?.pendingCount ?? 0,
        pendingBlockedCount: session?.pendingBlockedCount ?? 0,
        participantCursors: [] as ParticipantCursor[],
        badgeAttentionChanged: false,
    };
}

export type BlockPendingDeliveryResult =
    | { ok: true; pendingVersion: number; pendingCount: number; pendingBlockedCount: number; participantCursors: ParticipantCursor[]; badgeAttentionChanged: boolean; didUpdate: boolean }
    | { ok: false; error: "session-not-found" | "forbidden" | "invalid-params" | "not-found" | "internal" };

export type BlockPendingDeliveriesOnProviderAttachResult =
    | { ok: true; pendingVersion: number; pendingCount: number; pendingBlockedCount: number; participantCursors: ParticipantCursor[]; badgeAttentionChanged: boolean; didUpdate: boolean; blockedCount: number }
    | { ok: false; error: "session-not-found" | "forbidden" | "invalid-params" | "internal" };

export async function blockPendingDeliveriesOnProviderAttach(params: {
    actorUserId: string;
    sessionId: string;
}): Promise<BlockPendingDeliveriesOnProviderAttachResult> {
    const actorUserId = typeof params.actorUserId === "string" ? params.actorUserId : "";
    const sessionId = typeof params.sessionId === "string" ? params.sessionId : "";

    if (!actorUserId || !sessionId) return { ok: false, error: "invalid-params" };

    const access = await resolveSessionPendingOwnerAccess(actorUserId, sessionId);
    if (!access.ok) return { ok: false, error: access.error };

    try {
        return await inTx(async (tx) => {
            const blocked = await blockStaleProviderDeliveryClaims({ tx, sessionId });

            if (!blocked) {
                return { ok: true, ...(await readCurrentPendingMutationState(tx, sessionId)), didUpdate: false, blockedCount: 0 };
            }

            return {
                ok: true,
                pendingVersion: blocked.pendingVersion,
                pendingCount: blocked.pendingCount,
                pendingBlockedCount: blocked.pendingBlockedCount,
                participantCursors: blocked.participantCursors,
                badgeAttentionChanged: blocked.badgeAttentionChanged,
                didUpdate: true,
                blockedCount: blocked.blockedCount,
            };
        });
    } catch {
        return { ok: false, error: "internal" };
    }
}

export async function blockPendingDelivery(params: {
    actorUserId: string;
    sessionId: string;
    localId: string;
    reason: PendingDeliveryBlockedReason;
}): Promise<BlockPendingDeliveryResult> {
    const actorUserId = typeof params.actorUserId === "string" ? params.actorUserId : "";
    const sessionId = typeof params.sessionId === "string" ? params.sessionId : "";
    const localId = typeof params.localId === "string" ? params.localId : "";
    const reason = normalizePendingDeliveryBlockedReason(params.reason);

    if (!actorUserId || !sessionId || !localId || !reason) return { ok: false, error: "invalid-params" };

    const access = await resolveSessionPendingOwnerAccess(actorUserId, sessionId);
    if (!access.ok) return { ok: false, error: access.error };

    try {
        return await inTx(async (tx) => {
            const existing = await tx.sessionPendingMessage.findUnique({
                where: { sessionId_localId: { sessionId, localId } },
                select: { status: true, deliveryState: true, deliveryBlockedReason: true },
            });
            if (!existing) return { ok: false, error: "not-found" } as const;
            if (existing.status !== "queued") {
                return { ok: true, ...(await readCurrentPendingMutationState(tx, sessionId)), didUpdate: false };
            }
            if (existing.deliveryState === "blocked" && existing.deliveryBlockedReason === reason) {
                return { ok: true, ...(await readCurrentPendingMutationState(tx, sessionId)), didUpdate: false };
            }

            const blocked = await markPendingDeliveryRowsBlocked(tx, {
                sessionId,
                rows: [{ localId, status: existing.status, deliveryState: existing.deliveryState }],
                reason,
            });

            const { pendingVersion, pendingCount, pendingBlockedCount, participantCursors, badgeAttentionChanged } = await applyPendingSessionStateChange({
                tx,
                sessionId,
                pendingBlockedCountDelta: blocked.pendingBlockedCountDelta,
            });
            return { ok: true, pendingVersion, pendingCount, pendingBlockedCount, participantCursors, badgeAttentionChanged, didUpdate: true };
        });
    } catch {
        return { ok: false, error: "internal" };
    }
}

export type RetryPendingDeliveryResult =
    | { ok: true; pendingVersion: number; pendingCount: number; pendingBlockedCount: number; participantCursors: ParticipantCursor[]; badgeAttentionChanged: boolean; didUpdate: boolean }
    | { ok: false; error: "session-not-found" | "forbidden" | "invalid-params" | "not-found" | "internal" };

export async function retryPendingDelivery(params: {
    actorUserId: string;
    sessionId: string;
    localId: string;
}): Promise<RetryPendingDeliveryResult> {
    const actorUserId = typeof params.actorUserId === "string" ? params.actorUserId : "";
    const sessionId = typeof params.sessionId === "string" ? params.sessionId : "";
    const localId = typeof params.localId === "string" ? params.localId : "";

    if (!actorUserId || !sessionId || !localId) return { ok: false, error: "invalid-params" };

    const access = await resolveSessionPendingEditAccess(actorUserId, sessionId);
    if (!access.ok) return { ok: false, error: access.error };

    try {
        return await inTx(async (tx) => {
            const existing = await tx.sessionPendingMessage.findUnique({
                where: { sessionId_localId: { sessionId, localId } },
                select: { status: true, deliveryState: true, deliveryBlockedReason: true },
            });
            if (!existing) return { ok: false, error: "not-found" } as const;
            if (existing.status !== "queued" || existing.deliveryState !== "blocked") {
                return { ok: true, ...(await readCurrentPendingMutationState(tx, sessionId)), didUpdate: false };
            }

            await tx.sessionPendingMessage.update({
                where: { sessionId_localId: { sessionId, localId } },
                data: { deliveryState: null, deliveryBlockedReason: null },
            });

            const { pendingVersion, pendingCount, pendingBlockedCount, participantCursors, badgeAttentionChanged } = await applyPendingSessionStateChange({
                tx,
                sessionId,
                pendingBlockedCountDelta: -1,
            });
            return { ok: true, pendingVersion, pendingCount, pendingBlockedCount, participantCursors, badgeAttentionChanged, didUpdate: true };
        });
    } catch {
        return { ok: false, error: "internal" };
    }
}

export type MarkPendingDeliveryHandledResult =
    | {
        ok: true;
        pendingVersion: number;
        pendingCount: number;
        pendingBlockedCount: number;
        participantCursors: ParticipantCursor[];
        participantCursorsPending?: ParticipantCursor[];
        participantCursorsMessage?: ParticipantCursor[];
        badgeAttentionChanged: boolean;
        didResolve: boolean;
        didWrite?: boolean;
        didUpdate?: boolean;
        message?: PendingTranscriptMessage;
        readyProjection?: SessionReadyProjectionUpdate;
      }
    | {
        ok: false;
        error: "session-not-found" | "forbidden" | "invalid-params" | "transcript-conflict" | "internal";
        pendingStateChanged?: boolean;
        pendingVersion?: number;
        pendingCount?: number;
        pendingBlockedCount?: number;
        participantCursors?: ParticipantCursor[];
        badgeAttentionChanged?: boolean;
      };

export async function markPendingDeliveryHandled(params: {
    actorUserId: string;
    sessionId: string;
    localId: string;
}): Promise<MarkPendingDeliveryHandledResult> {
    const actorUserId = typeof params.actorUserId === "string" ? params.actorUserId : "";
    const sessionId = typeof params.sessionId === "string" ? params.sessionId : "";
    const localId = typeof params.localId === "string" ? params.localId : "";

    if (!actorUserId || !sessionId || !localId) return { ok: false, error: "invalid-params" };

    const access = await resolveSessionPendingEditAccess(actorUserId, sessionId);
    if (!access.ok) return { ok: false, error: access.error };

    try {
        return await retryPendingDeliveryResolutionRace(() => inTx(async (tx) => {
            const existing = await tx.sessionPendingMessage.findUnique({
                where: { sessionId_localId: { sessionId, localId } },
                select: { status: true, deliveryState: true, messageRole: true, content: true, position: true },
            });
            const isResolvableDeliveryState = existing?.deliveryState === "blocked" || existing?.deliveryState === "delivering";
            if (!existing || existing.status !== "queued" || !isResolvableDeliveryState) {
                return { ok: true, ...(await readCurrentPendingMutationState(tx, sessionId)), didResolve: false };
            }

            const resolved = await commitResolvedPendingDelivery(tx, {
                actorUserId,
                sessionId,
                localId,
                existing,
            });
            if (!resolved.ok) return resolved;
            return {
                ...resolved,
                ok: true,
                didResolve: true,
            };
        }));
    } catch {
        return { ok: false, error: "internal" };
    }
}

export type DiscardPendingMessageResult =
    | { ok: true; pendingVersion: number; pendingCount: number; pendingBlockedCount: number; participantCursors: ParticipantCursor[]; badgeAttentionChanged: boolean }
    | { ok: false; error: "session-not-found" | "forbidden" | "invalid-params" | "not-found" | "internal" };

export async function discardPendingMessage(params: {
    actorUserId: string;
    sessionId: string;
    localId: string;
    reason?: string;
    now?: Date;
}): Promise<DiscardPendingMessageResult> {
    const actorUserId = typeof params.actorUserId === "string" ? params.actorUserId : "";
    const sessionId = typeof params.sessionId === "string" ? params.sessionId : "";
    const localId = typeof params.localId === "string" ? params.localId : "";
    const reason = typeof params.reason === "string" ? params.reason : null;
    const now = params.now instanceof Date ? params.now : new Date();

    if (!actorUserId || !sessionId || !localId) return { ok: false, error: "invalid-params" };

    const access = await resolveSessionPendingEditAccess(actorUserId, sessionId);
    if (!access.ok) return { ok: false, error: access.error };

    try {
        return await inTx(async (tx) => {
            const existing = await tx.sessionPendingMessage.findUnique({
                where: { sessionId_localId: { sessionId, localId } },
                select: { status: true, deliveryState: true },
            });
            if (!existing) return { ok: false, error: "not-found" } as const;

            if (existing.status !== "queued") {
                const session = await tx.session.findUnique({
                    where: { id: sessionId },
                    select: { pendingCount: true, pendingBlockedCount: true, pendingVersion: true },
                });
                return {
                    ok: true,
                    pendingVersion: session?.pendingVersion ?? 0,
                    pendingCount: session?.pendingCount ?? 0,
                    pendingBlockedCount: session?.pendingBlockedCount ?? 0,
                    participantCursors: [],
                    badgeAttentionChanged: false,
                } as const;
            }

            await tx.sessionPendingMessage.update({
                where: { sessionId_localId: { sessionId, localId } },
                data: { status: "discarded", deliveryState: null, deliveryBlockedReason: null, discardedAt: now, discardedReason: reason },
            });

            const { pendingVersion, pendingCount, pendingBlockedCount, participantCursors, badgeAttentionChanged } = await applyPendingSessionStateChange({
                tx,
                sessionId,
                pendingCountDelta: -1,
                pendingBlockedCountDelta: existing.deliveryState === "blocked" ? -1 : 0,
            });
            return { ok: true, pendingVersion, pendingCount, pendingBlockedCount, participantCursors, badgeAttentionChanged };
        });
    } catch {
        return { ok: false, error: "internal" };
    }
}

export type RestorePendingMessageResult =
    | { ok: true; pendingVersion: number; pendingCount: number; pendingBlockedCount: number; participantCursors: ParticipantCursor[]; badgeAttentionChanged: boolean }
    | { ok: false; error: "session-not-found" | "forbidden" | "invalid-params" | "not-found" | "internal" };

export async function restorePendingMessage(params: {
    actorUserId: string;
    sessionId: string;
    localId: string;
}): Promise<RestorePendingMessageResult> {
    const actorUserId = typeof params.actorUserId === "string" ? params.actorUserId : "";
    const sessionId = typeof params.sessionId === "string" ? params.sessionId : "";
    const localId = typeof params.localId === "string" ? params.localId : "";

    if (!actorUserId || !sessionId || !localId) return { ok: false, error: "invalid-params" };

    const access = await resolveSessionPendingEditAccess(actorUserId, sessionId);
    if (!access.ok) return { ok: false, error: access.error };

    try {
        return await inTx(async (tx) => {
            const existing = await tx.sessionPendingMessage.findUnique({
                where: { sessionId_localId: { sessionId, localId } },
                select: { status: true },
            });
            if (!existing) return { ok: false, error: "not-found" } as const;

            if (existing.status === "discarded") {
                const position = await reserveNextPendingQueuePosition(tx, sessionId);

                await tx.sessionPendingMessage.update({
                    where: { sessionId_localId: { sessionId, localId } },
                    data: {
                        status: "queued",
                        deliveryState: null,
                        deliveryBlockedReason: null,
                        discardedAt: null,
                        discardedReason: null,
                        position,
                    },
                });
            }

            const { pendingVersion, pendingCount, pendingBlockedCount, participantCursors, badgeAttentionChanged } = await applyPendingSessionStateChange({
                tx,
                sessionId,
                pendingCountDelta: existing.status === "discarded" ? 1 : 0,
            });
            return { ok: true, pendingVersion, pendingCount, pendingBlockedCount, participantCursors, badgeAttentionChanged };
        });
    } catch {
        return { ok: false, error: "internal" };
    }
}

export type ReorderPendingMessagesResult =
    | { ok: true; pendingVersion: number; pendingCount: number; pendingBlockedCount: number; participantCursors: ParticipantCursor[]; badgeAttentionChanged: boolean }
    | { ok: false; error: "session-not-found" | "forbidden" | "invalid-params" | "internal" };

export async function reorderPendingMessages(params: {
    actorUserId: string;
    sessionId: string;
    orderedLocalIds: string[];
}): Promise<ReorderPendingMessagesResult> {
    const actorUserId = typeof params.actorUserId === "string" ? params.actorUserId : "";
    const sessionId = typeof params.sessionId === "string" ? params.sessionId : "";
    const orderedLocalIds = Array.isArray(params.orderedLocalIds) ? params.orderedLocalIds.filter((v) => typeof v === "string" && v.length > 0) : [];

    if (!actorUserId || !sessionId || orderedLocalIds.length === 0) return { ok: false, error: "invalid-params" };
    if (new Set(orderedLocalIds).size !== orderedLocalIds.length) return { ok: false, error: "invalid-params" };

    const access = await resolveSessionPendingEditAccess(actorUserId, sessionId);
    if (!access.ok) return { ok: false, error: access.error };

    try {
        return await inTx(async (tx) => {
            const queued = await tx.sessionPendingMessage.findMany({
                where: { sessionId, status: "queued" },
                select: { localId: true, deliveryState: true, position: true },
                orderBy: { position: "asc" },
            });
            const queuedIds = queued.map((v) => v.localId);
            if (queuedIds.length !== orderedLocalIds.length) return { ok: false, error: "invalid-params" } as const;

            const a = new Set(queuedIds);
            for (const id of orderedLocalIds) {
                if (!a.has(id)) return { ok: false, error: "invalid-params" } as const;
            }
            const queuedByLocalId = new Map(queued.map((row) => [row.localId, row]));
            const orderedIndexByLocalId = new Map(orderedLocalIds.map((localId, index) => [localId, index]));
            for (let existingIndex = 0; existingIndex < queued.length; existingIndex++) {
                const row = queued[existingIndex];
                if (row.deliveryState === "delivering" && orderedIndexByLocalId.get(row.localId) !== existingIndex) {
                    return { ok: false, error: "invalid-params" } as const;
                }
            }

            let position = 1;
            for (const localId of orderedLocalIds) {
                const row = queuedByLocalId.get(localId);
                if (row?.deliveryState === "delivering" || row?.position === position) {
                    position++;
                    continue;
                }
                await tx.sessionPendingMessage.update({
                    where: { sessionId_localId: { sessionId, localId } },
                    data: { position },
                });
                position++;
            }

            const { pendingVersion, pendingCount, pendingBlockedCount, participantCursors, badgeAttentionChanged } = await applyPendingSessionStateChange({
                tx,
                sessionId,
            });
            return { ok: true, pendingVersion, pendingCount, pendingBlockedCount, participantCursors, badgeAttentionChanged };
        });
    } catch {
        return { ok: false, error: "internal" };
    }
}

export type { MaterializeNextPendingMessageResult } from "@/app/session/pending/materializeNextPendingMessage";
export { materializeNextPendingMessage } from "@/app/session/pending/materializeNextPendingMessage";
