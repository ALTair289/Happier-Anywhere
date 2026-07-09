import { markSessionParticipantsChanged, type SessionParticipantCursor } from "@/app/session/changeTracking/markSessionParticipantsChanged";
import { markPendingStateChangedParticipants } from "@/app/session/pending/markPendingStateChangedParticipants";
import { resolveSessionPendingOwnerAccess } from "@/app/session/pending/resolveSessionPendingAccess";
import { inTx } from "@/storage/inTx";
import { db } from "@/storage/db";
import { isPrismaErrorCode } from "@/storage/prisma";
import { readEncryptionFeatureEnv } from "@/app/features/catalog/readFeatureEnv";
import {
    accountSettingsParse,
    isSessionRuntimeActivityProjectionIdleForPendingDrain,
    isStoredContentKindAllowedForSessionByStoragePolicy,
    pendingDeliveryStatusV1ToPersistedFields,
    type SessionMessageRole,
    type SessionPendingQueueDeliveryTiming,
    type SessionStoredContentKind,
} from "@happier-dev/protocol";
import { didSessionActivityBadgeContributionChange } from "@/app/activity/accountActivityBadge";
import { resolveSessionMessageRole } from "@/app/session/messageRole/resolveSessionMessageRole";
import { createSessionMessageFromPending, resolvePendingTranscriptCompatibility } from "@/app/session/pending/pendingMessageTranscriptCommit";
import { blockStaleProviderDeliveryClaims } from "@/app/session/pending/providerDeliveryClaimStaleness";
import {
    resolveReadyProjectionEventType,
    updateSessionMessageActivityProjection,
    type SessionReadyProjectionUpdate,
} from "@/app/session/sessionWriteService";
import { logger } from "@/utils/logging/log";
import { openPlainAccountSettingsDbValue } from "@/app/encryption/accountSettingsStorage";

type ParticipantCursor = SessionParticipantCursor;

export type PendingMaterializationDeliveryState = Readonly<{
    mode: "provider";
    unresolved: boolean;
}>;

export type PendingMaterializationDeliveryStateMode = PendingMaterializationDeliveryState["mode"];

const pendingMessageEligibleForMaterializationWhere = {
    status: "queued" as const,
    deliveryState: null,
};

export type MaterializeNextPendingMessageResult =
    | {
        ok: true;
        didMaterialize: false;
        pendingCount: number;
        pendingBlockedCount: number;
        pendingVersion: number;
        pendingStateChanged?: boolean;
        participantCursorsPending?: ParticipantCursor[];
        badgeAttentionChanged?: boolean;
        deliveryState?: PendingMaterializationDeliveryState;
        deferredReason?: "runtime_activity_active";
      }
    | {
        ok: true;
        didMaterialize: true;
        didWriteMessage: boolean;
        message: { id: string | null; seq: number | null; localId: string; messageRole: SessionMessageRole | null; content: PrismaJson.SessionMessageContent; createdAt: Date; updatedAt: Date };
        participantCursorsMessage: ParticipantCursor[];
        participantCursorsPending: ParticipantCursor[];
        pendingCount: number;
        pendingBlockedCount: number;
        pendingVersion: number;
        meaningfulActivityAt?: Date;
        badgeAttentionChanged: boolean;
        readyProjection?: SessionReadyProjectionUpdate;
        deliveryState?: PendingMaterializationDeliveryState;
      }
    | { ok: false; error: "session-not-found" | "forbidden" | "invalid-params" | "transcript-conflict" | "internal" };

function toSessionMessageContentFromPending(content: PrismaJson.SessionPendingMessageContent): PrismaJson.SessionMessageContent {
    return content;
}

async function resolveEffectiveDeliveryTiming(params: {
    actorUserId: string;
    requestedDeliveryTiming?: SessionPendingQueueDeliveryTiming;
}): Promise<SessionPendingQueueDeliveryTiming> {
    if (params.requestedDeliveryTiming === "after_runtime_idle") {
        return "after_runtime_idle";
    }

    const account = await db.account.findUnique({
        where: { id: params.actorUserId },
        select: { settings: true },
    });
    const settings = openPlainAccountSettingsDbValue({
        accountId: params.actorUserId,
        dbValue: account?.settings ?? null,
    });
    const accountDeliveryTiming = accountSettingsParse(
        settings?.t === "plain" ? settings.v : {},
    ).sessionPendingQueueDeliveryTiming;
    if (accountDeliveryTiming === "after_runtime_idle") {
        return "after_runtime_idle";
    }
    return params.requestedDeliveryTiming ?? accountDeliveryTiming;
}

export async function materializeNextPendingMessage(params: {
    actorUserId: string;
    sessionId: string;
    deliveryState?: PendingMaterializationDeliveryStateMode;
    deliveryTiming?: SessionPendingQueueDeliveryTiming;
}): Promise<MaterializeNextPendingMessageResult> {
    return await materializeNextPendingMessageWithRaceRetry(params, true);
}

async function materializeNextPendingMessageWithRaceRetry(params: {
    actorUserId: string;
    sessionId: string;
    deliveryState?: PendingMaterializationDeliveryStateMode;
    deliveryTiming?: SessionPendingQueueDeliveryTiming;
}, retryRace: boolean): Promise<MaterializeNextPendingMessageResult> {
    const actorUserId = typeof params.actorUserId === "string" ? params.actorUserId : "";
    const sessionId = typeof params.sessionId === "string" ? params.sessionId : "";
    const useProviderDeliveryState = params.deliveryState === "provider";
    const materializedDeliveryState = useProviderDeliveryState
        ? ({ mode: "provider", unresolved: true } satisfies PendingMaterializationDeliveryState)
        : undefined;
    const noopDeliveryState = useProviderDeliveryState
        ? ({ mode: "provider", unresolved: false } satisfies PendingMaterializationDeliveryState)
        : undefined;
    const pendingMessageMaterializationWhere = pendingMessageEligibleForMaterializationWhere;

    if (!actorUserId || !sessionId) return { ok: false, error: "invalid-params" };

    const access = await resolveSessionPendingOwnerAccess(actorUserId, sessionId);
    if (!access.ok) return { ok: false, error: access.error };

    const sessionRow = await db.session.findUnique({
        where: { id: sessionId },
        select: {
            encryptionMode: true,
            seq: true,
            pendingCount: true,
            pendingBlockedCount: true,
            pendingVersion: true,
            lastViewedSessionSeq: true,
            pendingPermissionRequestCount: true,
            pendingUserActionRequestCount: true,
            active: true,
            archivedAt: true,
            runtimeActivityActiveCount: true,
            runtimeActivityObservedAt: true,
            runtimeActivityExpiresAt: true,
            runtimeActivitySourceClass: true,
        },
    });
    if (!sessionRow) return { ok: false, error: "session-not-found" };
    if ((sessionRow.pendingCount ?? 0) <= 0) {
        // pendingCount is a denormalized counter; treat it as a fast-path hint, not a source of truth.
        // If the counter is inconsistent (e.g. race/data corruption), fall back to checking the queue.
        const hasEligibleQueued = await db.sessionPendingMessage.findFirst({
            where: { sessionId, ...pendingMessageMaterializationWhere },
            orderBy: [{ position: "asc" }, { createdAt: "asc" }, { localId: "asc" }],
            select: { localId: true },
        });
        if (!hasEligibleQueued) {
            const queuedCount = await db.sessionPendingMessage.count({
                where: { sessionId, status: "queued" },
            });
            if (queuedCount > 0) {
                // There are unresolved provider-owned rows but no row currently eligible for a
                // materialization handoff. Let the transactional path reconcile pendingCount.
            } else {
                return {
                    ok: true,
                    didMaterialize: false,
                    pendingCount: sessionRow.pendingCount ?? 0,
                    pendingBlockedCount: sessionRow.pendingBlockedCount ?? 0,
                    pendingVersion: sessionRow.pendingVersion ?? 0,
                    ...(noopDeliveryState ? { deliveryState: noopDeliveryState } : {}),
                };
            }
        }
    }

    const deliveryTiming = await resolveEffectiveDeliveryTiming({
        actorUserId,
        requestedDeliveryTiming: params.deliveryTiming,
    });
    if (deliveryTiming === "after_runtime_idle" && !isSessionRuntimeActivityProjectionIdleForPendingDrain(sessionRow, Date.now())) {
        const hasEligibleQueued = await db.sessionPendingMessage.findFirst({
            where: { sessionId, ...pendingMessageMaterializationWhere },
            orderBy: [{ position: "asc" }, { createdAt: "asc" }, { localId: "asc" }],
            select: { localId: true },
        });
        if (hasEligibleQueued) {
            return {
                ok: true,
                didMaterialize: false,
                pendingCount: sessionRow.pendingCount ?? 0,
                pendingBlockedCount: sessionRow.pendingBlockedCount ?? 0,
                pendingVersion: sessionRow.pendingVersion ?? 0,
                deferredReason: "runtime_activity_active",
                ...(noopDeliveryState ? { deliveryState: noopDeliveryState } : {}),
            };
        }
    }

    const sessionEncryptionMode: "e2ee" | "plain" = sessionRow.encryptionMode === "plain" ? "plain" : "e2ee";
    const policy = readEncryptionFeatureEnv(process.env);

    try {
        const result = await inTx(async (tx) => {
            const sessionBefore = await tx.session.findUniqueOrThrow({
                where: { id: sessionId },
                select: {
                    seq: true,
                    pendingCount: true,
                    pendingBlockedCount: true,
                    pendingVersion: true,
                    lastViewedSessionSeq: true,
                    pendingPermissionRequestCount: true,
                    pendingUserActionRequestCount: true,
                    active: true,
                    archivedAt: true,
                    runtimeActivityActiveCount: true,
                    runtimeActivityObservedAt: true,
                    runtimeActivityExpiresAt: true,
                    runtimeActivitySourceClass: true,
                },
            });

            const staleDeliveryBlock = await blockStaleProviderDeliveryClaims({ tx, sessionId });
            if (staleDeliveryBlock) {
                return {
                    ok: true,
                    didMaterialize: false,
                    pendingCount: staleDeliveryBlock.pendingCount,
                    pendingBlockedCount: staleDeliveryBlock.pendingBlockedCount,
                    pendingVersion: staleDeliveryBlock.pendingVersion,
                    pendingStateChanged: true,
                    participantCursorsPending: staleDeliveryBlock.participantCursors,
                    badgeAttentionChanged: staleDeliveryBlock.badgeAttentionChanged,
                    ...(noopDeliveryState ? { deliveryState: noopDeliveryState } : {}),
                } as const;
            }

            if (deliveryTiming === "after_runtime_idle" && !isSessionRuntimeActivityProjectionIdleForPendingDrain(sessionBefore, Date.now())) {
                const hasEligibleQueued = await tx.sessionPendingMessage.findFirst({
                    where: { sessionId, ...pendingMessageMaterializationWhere },
                    orderBy: [{ position: "asc" }, { createdAt: "asc" }, { localId: "asc" }],
                    select: { localId: true },
                });
                if (hasEligibleQueued) {
                    return {
                        ok: true,
                        didMaterialize: false,
                        pendingCount: sessionBefore.pendingCount ?? 0,
                        pendingBlockedCount: sessionBefore.pendingBlockedCount ?? 0,
                        pendingVersion: sessionBefore.pendingVersion ?? 0,
                        deferredReason: "runtime_activity_active",
                        ...(noopDeliveryState ? { deliveryState: noopDeliveryState } : {}),
                    } as const;
                }
            }

            const nextPending = await tx.sessionPendingMessage.findFirst({
                where: { sessionId, ...pendingMessageMaterializationWhere },
                orderBy: [{ position: "asc" }, { createdAt: "asc" }, { localId: "asc" }],
                select: { localId: true, messageRole: true, content: true, status: true, createdAt: true, updatedAt: true },
            });

            if (!nextPending) {
                const queuedCount = await tx.sessionPendingMessage.count({
                    where: { sessionId, status: "queued" },
                });
                const blockedCount = await tx.sessionPendingMessage.count({
                    where: { sessionId, status: "queued", deliveryState: "blocked" },
                });
                if ((sessionBefore.pendingCount ?? 0) !== queuedCount || (sessionBefore.pendingBlockedCount ?? 0) !== blockedCount) {
                    await tx.session.updateMany({
                        where: {
                            id: sessionId,
                            pendingCount: sessionBefore.pendingCount,
                            pendingBlockedCount: sessionBefore.pendingBlockedCount,
                            pendingVersion: sessionBefore.pendingVersion,
                        },
                        data: { pendingCount: queuedCount, pendingBlockedCount: blockedCount, pendingVersion: { increment: 1 } },
                    });
                    const latestSession = await tx.session.findUniqueOrThrow({
                        where: { id: sessionId },
                        select: { pendingCount: true, pendingBlockedCount: true, pendingVersion: true },
                    });
                    return {
                        ok: true,
                        didMaterialize: false,
                        pendingCount: latestSession.pendingCount,
                        pendingBlockedCount: latestSession.pendingBlockedCount,
                        pendingVersion: latestSession.pendingVersion,
                        ...(noopDeliveryState ? { deliveryState: noopDeliveryState } : {}),
                    } as const;
                }

                return {
                    ok: true,
                    didMaterialize: false,
                    pendingCount: sessionBefore.pendingCount ?? 0,
                    pendingBlockedCount: sessionBefore.pendingBlockedCount ?? 0,
                    pendingVersion: sessionBefore.pendingVersion ?? 0,
                    ...(noopDeliveryState ? { deliveryState: noopDeliveryState } : {}),
                } as const;
            }

            const localId = nextPending.localId;
            const content = toSessionMessageContentFromPending(nextPending.content as PrismaJson.SessionPendingMessageContent);
            const messageRole = resolveSessionMessageRole({
                content,
                suppliedRole: nextPending.messageRole,
                telemetry: {
                    sessionId,
                    storageMode: sessionEncryptionMode,
                    source: "pending-materialization",
                },
            }).messageRole;

            const writeKind: SessionStoredContentKind = content.t === "plain" ? "plain" : "encrypted";
            if (!isStoredContentKindAllowedForSessionByStoragePolicy(policy.storagePolicy, sessionEncryptionMode, writeKind)) {
                return { ok: false, error: "invalid-params" } as const;
            }

            if (useProviderDeliveryState) {
                const existingTranscriptMessage = await tx.sessionMessage.findFirst({
                    where: { sessionId, localId },
                    select: { content: true, messageRole: true },
                });
                if (existingTranscriptMessage) {
                    const compatibility = resolvePendingTranscriptCompatibility({
                        existing: existingTranscriptMessage,
                        pending: { content, messageRole },
                    });
                    if (!compatibility.ok) {
                        return { ok: false, error: "transcript-conflict" } as const;
                    }
                }

                const delivering = pendingDeliveryStatusV1ToPersistedFields({ status: "delivering" });
                const claimed = await tx.sessionPendingMessage.updateMany({
                    where: { sessionId, localId, ...pendingMessageMaterializationWhere },
                    data: { deliveryState: delivering.deliveryState, deliveryBlockedReason: delivering.deliveryBlockedReason },
                });
                if (claimed.count === 0) {
                    const latestSession = await tx.session.findUniqueOrThrow({
                        where: { id: sessionId },
                        select: { pendingCount: true, pendingBlockedCount: true, pendingVersion: true },
                    });
                    return {
                        ok: true,
                        didMaterialize: false,
                        pendingCount: latestSession.pendingCount,
                        pendingBlockedCount: latestSession.pendingBlockedCount,
                        pendingVersion: latestSession.pendingVersion,
                        ...(noopDeliveryState ? { deliveryState: noopDeliveryState } : {}),
                    } as const;
                }

                const pendingCount = await tx.sessionPendingMessage.count({
                    where: { sessionId, status: "queued" },
                });
                const pendingBlockedCount = await tx.sessionPendingMessage.count({
                    where: { sessionId, status: "queued", deliveryState: "blocked" },
                });
                const session = await tx.session.update({
                    where: { id: sessionId },
                    data: { pendingCount, pendingBlockedCount, pendingVersion: { increment: 1 } },
                    select: {
                        seq: true,
                        pendingCount: true,
                        pendingBlockedCount: true,
                        pendingVersion: true,
                        lastViewedSessionSeq: true,
                        pendingPermissionRequestCount: true,
                        pendingUserActionRequestCount: true,
                        active: true,
                        archivedAt: true,
                    },
                });

                const participantCursorsPending = await markPendingStateChangedParticipants({
                    tx,
                    sessionId,
                    pendingVersion: session.pendingVersion,
                    pendingCount: session.pendingCount,
                    pendingBlockedCount: session.pendingBlockedCount,
                });

                return {
                    ok: true,
                    didMaterialize: true,
                    didWriteMessage: false,
                    message: {
                        id: null,
                        seq: null,
                        localId,
                        messageRole,
                        content,
                        createdAt: nextPending.createdAt,
                        updatedAt: nextPending.updatedAt,
                    },
                    participantCursorsMessage: [] as ParticipantCursor[],
                    participantCursorsPending,
                    pendingCount: session.pendingCount,
                    pendingBlockedCount: session.pendingBlockedCount,
                    pendingVersion: session.pendingVersion,
                    deliveryState: materializedDeliveryState,
                    badgeAttentionChanged: didSessionActivityBadgeContributionChange(
                        sessionBefore,
                        {
                            seq: session.seq,
                            pendingCount: session.pendingCount,
                            pendingBlockedCount: session.pendingBlockedCount,
                            lastViewedSessionSeq: session.lastViewedSessionSeq,
                            pendingPermissionRequestCount: session.pendingPermissionRequestCount,
                            pendingUserActionRequestCount: session.pendingUserActionRequestCount,
                            active: session.active,
                            archivedAt: session.archivedAt,
                        },
                    ),
                } as const;
            }

            const created = await createSessionMessageFromPending(tx, { sessionId, localId, content, messageRole });
            if (!created.ok) {
                return { ok: false, error: created.error } as const;
            }
            const readyProjection = created.didWrite
                ? await updateSessionMessageActivityProjection(tx, {
                    sessionId,
                    created: created.message,
                    trustedSessionEventType: resolveReadyProjectionEventType({
                        actorUserId,
                        sessionOwnerId: actorUserId,
                        content,
                    }),
                })
                : undefined;

            await tx.sessionPendingMessage.delete({
                where: { sessionId_localId: { sessionId, localId } },
            });

            const didDecrementPendingCount =
                (
                    await tx.session.updateMany({
                        where: { id: sessionId, pendingCount: { gt: 0 } },
                        data: { pendingCount: { decrement: 1 }, pendingVersion: { increment: 1 } },
                    })
                ).count > 0;

            if (!didDecrementPendingCount) {
                await tx.session.updateMany({
                    where: { id: sessionId, pendingCount: { lte: 0 } },
                    data: { pendingCount: 0, pendingVersion: { increment: 1 } },
                });
            }

            const session = await tx.session.findUniqueOrThrow({
                where: { id: sessionId },
                select: {
                    seq: true,
                    pendingCount: true,
                    pendingBlockedCount: true,
                    pendingVersion: true,
                    lastViewedSessionSeq: true,
                    pendingPermissionRequestCount: true,
                    pendingUserActionRequestCount: true,
                    active: true,
                    archivedAt: true,
                },
            });

            const participantCursorsMessage = await markSessionParticipantsChanged({
                tx,
                sessionId,
                hint: { lastMessageSeq: created.message.seq, lastMessageId: created.message.id },
            });
            const participantCursorsPending = await markPendingStateChangedParticipants({
                tx,
                sessionId,
                pendingVersion: session.pendingVersion,
                pendingCount: session.pendingCount,
                pendingBlockedCount: session.pendingBlockedCount,
                meaningfulActivityAt: created.didWrite ? created.message.createdAt : undefined,
            });

            return {
                ok: true,
                didMaterialize: true,
                didWriteMessage: created.didWrite,
                message: created.message,
                participantCursorsMessage,
                participantCursorsPending,
                pendingCount: session.pendingCount,
                pendingBlockedCount: session.pendingBlockedCount,
                pendingVersion: session.pendingVersion,
                ...(created.didWrite ? { meaningfulActivityAt: created.message.createdAt } : {}),
                ...(readyProjection ? { readyProjection } : {}),
                badgeAttentionChanged: didSessionActivityBadgeContributionChange(
                    sessionBefore,
                    {
                        seq: session.seq,
                        pendingCount: session.pendingCount,
                        pendingBlockedCount: session.pendingBlockedCount,
                        lastViewedSessionSeq: session.lastViewedSessionSeq,
                        pendingPermissionRequestCount: session.pendingPermissionRequestCount,
                        pendingUserActionRequestCount: session.pendingUserActionRequestCount,
                        active: session.active,
                        archivedAt: session.archivedAt,
                    },
                ),
            } as const;
        });
        if (result.ok && result.didMaterialize) {
            logger.debug({
                sessionId,
                didMaterialize: true,
                localId: result.message.localId,
                messageSeq: result.message.seq,
                messageRole: result.message.messageRole,
                didWriteMessage: result.didWriteMessage,
                pendingCount: result.pendingCount,
                pendingBlockedCount: result.pendingBlockedCount,
                pendingVersion: result.pendingVersion,
            }, "session.pending.materialize");
        }
        return result;
    } catch (error) {
        if (retryRace && (isPrismaErrorCode(error, "P2002") || isPrismaErrorCode(error, "P2025"))) {
            return await materializeNextPendingMessageWithRaceRetry(params, false);
        }
        return { ok: false, error: "internal" };
    }
}
