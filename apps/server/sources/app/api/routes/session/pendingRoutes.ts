import { z } from "zod";
import { type Fastify } from "../../types";
import { buildMessageUpdatedUpdate, buildNewMessageUpdate, buildPendingChangedUpdate, eventRouter } from "@/app/events/eventRouter";
import { refreshSessionParticipantBadgePushes } from "@/app/activity/refreshAccountActivityBadgePushes";
import { publishSessionReadyProjectionUpdate } from "@/app/session/ready/publishSessionReadyProjectionUpdate";
import {
    resolvePendingMaterializeDeliveryStateOptIn,
    resolvePendingMaterializeDeliveryTimingOptIn,
} from "@/app/session/pending/pendingMaterializationRequest";
import { serializePendingMaterializedMessage } from "@/app/session/pending/serializePendingMaterializedMessage";
import {
    blockPendingDeliveriesOnProviderAttach,
    blockPendingDelivery,
    deletePendingMessage,
    discardPendingMessage,
    enqueuePendingMessage,
    listPendingMessages,
    markPendingDeliveryHandled,
    materializeNextPendingMessage,
    reconcileAcceptedPendingDeliveriesThroughSeq,
    reorderPendingMessages,
    resolveAcceptedPendingDelivery,
    retryPendingDelivery,
    restorePendingMessage,
    updatePendingMessage,
    type PendingMessageRow,
} from "@/app/session/pending/pendingMessageService";
import { randomKeyNaked } from "@/utils/keys/randomKeyNaked";
import { log } from "@/utils/logging/log";
import { PendingDeliveryBlockedReasonSchema, SessionStoredMessageContentSchema } from "@happier-dev/protocol";
import { resolveApiHotEndpointRateLimit } from "@/app/api/utils/apiRateLimitCatalog";

type SessionStoredMessageContent = z.infer<typeof SessionStoredMessageContentSchema>;

function toPendingJson(row: PendingMessageRow) {
    return {
        localId: row.localId,
        ...(typeof row.messageRole === "string" ? { messageRole: row.messageRole } : {}),
        content: row.content,
        status: row.status,
        ...(row.deliveryState ? { deliveryState: row.deliveryState } : {}),
        ...(row.deliveryBlockedReason ? { deliveryBlockedReason: row.deliveryBlockedReason } : {}),
        position: row.position,
        createdAt: row.createdAt.getTime(),
        updatedAt: row.updatedAt.getTime(),
        discardedAt: row.discardedAt ? row.discardedAt.getTime() : null,
        discardedReason: row.discardedReason,
        authorAccountId: row.authorAccountId,
    };
}

function getOptionalErrorCode(value: unknown): string | undefined {
    if (!value || typeof value !== "object") return undefined;
    if (!("code" in value)) return undefined;
    const code = (value as { code?: unknown }).code;
    return typeof code === "string" && code.length > 0 ? code : undefined;
}

async function emitPendingChanged(params: {
    sessionId: string;
    changedByAccountId: string;
    pendingCount: number;
    pendingBlockedCount?: number;
    pendingVersion: number;
    meaningfulActivityAt?: Date | null;
    participantCursors: Array<{ accountId: string; cursor: number }>;
}): Promise<void> {
    const results = await Promise.allSettled(
        params.participantCursors.map(async ({ accountId, cursor }) => {
            const payload = buildPendingChangedUpdate(
                {
                    sessionId: params.sessionId,
                    pendingCount: params.pendingCount,
                    ...(typeof params.pendingBlockedCount === "number" ? { pendingBlockedCount: params.pendingBlockedCount } : {}),
                    pendingVersion: params.pendingVersion,
                    meaningfulActivityAt: params.meaningfulActivityAt,
                    changedByAccountId: params.changedByAccountId,
                },
                cursor,
                randomKeyNaked(12),
            );
            eventRouter.emitUpdate({
                userId: accountId,
                payload,
                recipientFilter: { type: "all-interested-in-session", sessionId: params.sessionId },
            });
        }),
    );
    results.forEach((result, index) => {
        if (result.status === "fulfilled") return;
        const accountId = params.participantCursors[index]?.accountId ?? "unknown";
        log(
            { module: "session-pending-routes", level: "warn", sessionId: params.sessionId, accountId },
            "failed to emit pending-changed update",
            result.reason,
        );
    });
}

type PendingResolvedMessage = Parameters<typeof buildNewMessageUpdate>[0];

async function emitPendingResolvedMessage(params: {
    sessionId: string;
    message: PendingResolvedMessage | undefined;
    eventKind?: "new-message" | "message-updated";
    readyProjection?: Parameters<typeof publishSessionReadyProjectionUpdate>[0]["readyProjection"];
    participantCursors: Array<{ accountId: string; cursor: number }>;
    logContext: string;
}): Promise<void> {
    if (!params.message || params.participantCursors.length === 0) return;
    const buildMessageUpdate = params.eventKind === "message-updated"
        ? buildMessageUpdatedUpdate
        : buildNewMessageUpdate;
    const messageResults = await Promise.allSettled(
        params.participantCursors.map(async ({ accountId, cursor }) => {
            const payload = buildMessageUpdate(params.message!, params.sessionId, cursor, randomKeyNaked(12));
            eventRouter.emitUpdate({
                userId: accountId,
                payload,
                recipientFilter: { type: "all-interested-in-session", sessionId: params.sessionId },
            });
        }),
    );
    messageResults.forEach((result, index) => {
        if (result.status === "fulfilled") return;
        const accountId = params.participantCursors[index]?.accountId ?? "unknown";
        log(
            { module: "session-pending-routes", level: "warn", sessionId: params.sessionId, accountId },
            params.logContext,
            result.reason,
        );
    });
    await publishSessionReadyProjectionUpdate({
        sessionId: params.sessionId,
        readyProjection: params.readyProjection,
    });
}

export function sessionPendingRoutes(app: Fastify) {
    app.get(
        "/v2/sessions/:sessionId/pending",
        {
            preHandler: app.authenticate,
            schema: {
                params: z.object({ sessionId: z.string() }),
                querystring: z
                    .object({
                        includeDiscarded: z
                            .union([z.literal("true"), z.literal("false"), z.literal("1"), z.literal("0")])
                            .optional(),
                    })
                    .optional(),
            },
            config: {
                rateLimit: resolveApiHotEndpointRateLimit(process.env, "session.pending"),
            },
        },
        async (request, reply) => {
            const { sessionId } = request.params;
            const includeDiscardedRaw = request.query?.includeDiscarded;
            const includeDiscarded = includeDiscardedRaw === "true" || includeDiscardedRaw === "1";

            const res = await listPendingMessages({
                actorUserId: request.userId,
                sessionId,
                includeDiscarded,
            });

            if (!res.ok) {
                if (res.error === "invalid-params") {
                    const payload: { error: string; code?: string } = { error: res.error };
                    const code = getOptionalErrorCode(res);
                    if (code) payload.code = code;
                    return reply.code(400).send(payload);
                }
                if (res.error === "forbidden") return reply.code(403).send({ error: res.error });
                if (res.error === "session-not-found") return reply.code(404).send({ error: res.error });
                return reply.code(500).send({ error: res.error });
            }

            return reply.send({ pending: res.pending.map(toPendingJson) });
        },
    );

    app.post(
        "/v2/sessions/:sessionId/pending",
        {
            preHandler: app.authenticate,
            schema: {
                params: z.object({ sessionId: z.string() }),
                body: z.union([
                    z.object({
                        ciphertext: z.string().min(1),
                        localId: z.string().min(1),
                        messageRole: z.unknown().optional(),
                    }),
                    z.object({
                        content: SessionStoredMessageContentSchema,
                        localId: z.string().min(1),
                        messageRole: z.unknown().optional(),
                    }),
                ]),
            },
            config: {
                rateLimit: resolveApiHotEndpointRateLimit(process.env, "session.pending"),
            },
        },
        async (request, reply) => {
            const { sessionId } = request.params;
            const body = request.body as unknown;
            const localId =
                body && typeof body === "object" && "localId" in body && typeof (body as { localId?: unknown }).localId === "string"
                    ? (body as { localId: string }).localId
                    : "";
            const ciphertext =
                body && typeof body === "object" && "ciphertext" in body && typeof (body as { ciphertext?: unknown }).ciphertext === "string"
                    ? (body as { ciphertext: string }).ciphertext
                    : null;
            const content =
                body && typeof body === "object" && "content" in body
                    ? ((body as { content: SessionStoredMessageContent }).content ?? null)
                    : null;
            const messageRole =
                body && typeof body === "object" && "messageRole" in body
                    ? (body as { messageRole?: unknown }).messageRole
                    : null;

            const res = await (content
                ? enqueuePendingMessage({
                      actorUserId: request.userId,
                      sessionId,
                      localId,
                      content,
                      messageRole,
                  })
                : enqueuePendingMessage({
                      actorUserId: request.userId,
                      sessionId,
                      localId,
                      ciphertext: ciphertext ?? "",
                      messageRole,
                  }));

            if (!res.ok) {
                if (res.error === "invalid-params") {
                    const payload: { error: string; code?: string } = { error: res.error };
                    const code = getOptionalErrorCode(res);
                    if (code) payload.code = code;
                    return reply.code(400).send(payload);
                }
                if (res.error === "forbidden") return reply.code(403).send({ error: res.error });
                if (res.error === "session-not-found") return reply.code(404).send({ error: res.error });
                return reply.code(500).send({ error: res.error });
            }

            await emitPendingChanged({
                sessionId,
                changedByAccountId: request.userId,
                pendingCount: res.pendingCount,
                pendingBlockedCount: res.pendingBlockedCount,
                pendingVersion: res.pendingVersion,
                meaningfulActivityAt: res.didWrite ? res.meaningfulActivityAt : undefined,
                participantCursors: res.participantCursors,
            });
            await refreshSessionParticipantBadgePushes({
                badgeAttentionChanged: res.badgeAttentionChanged,
                participantCursors: res.participantCursors,
            });

            return reply.send({
                didWrite: res.didWrite,
                pending: toPendingJson(res.pending),
                pendingCount: res.pendingCount,
                pendingBlockedCount: res.pendingBlockedCount,
                pendingVersion: res.pendingVersion,
            });
        },
    );

    app.patch(
        "/v2/sessions/:sessionId/pending/:localId",
        {
            preHandler: app.authenticate,
            schema: {
                params: z.object({ sessionId: z.string(), localId: z.string() }),
                body: z.union([
                    z.object({ ciphertext: z.string().min(1), messageRole: z.unknown().optional() }),
                    z.object({ content: SessionStoredMessageContentSchema, messageRole: z.unknown().optional() }),
                ]),
            },
            config: {
                rateLimit: resolveApiHotEndpointRateLimit(process.env, "session.pending"),
            },
        },
        async (request, reply) => {
            const { sessionId, localId } = request.params;
            const body = request.body as unknown;
            const ciphertext =
                body && typeof body === "object" && "ciphertext" in body && typeof (body as { ciphertext?: unknown }).ciphertext === "string"
                    ? (body as { ciphertext: string }).ciphertext
                    : null;
            const content =
                body && typeof body === "object" && "content" in body
                    ? ((body as { content: SessionStoredMessageContent }).content ?? null)
                    : null;
            const messageRole =
                body && typeof body === "object" && "messageRole" in body
                    ? (body as { messageRole?: unknown }).messageRole
                    : null;

            const res = await (content
                ? updatePendingMessage({ actorUserId: request.userId, sessionId, localId, content, messageRole })
                : updatePendingMessage({ actorUserId: request.userId, sessionId, localId, ciphertext: ciphertext ?? "", messageRole }));
            if (!res.ok) {
                if (res.error === "invalid-params") {
                    const payload: { error: string; code?: string } = { error: res.error };
                    const code = getOptionalErrorCode(res);
                    if (code) payload.code = code;
                    return reply.code(400).send(payload);
                }
                if (res.error === "forbidden") return reply.code(403).send({ error: res.error });
                if (res.error === "session-not-found") return reply.code(404).send({ error: res.error });
                if (res.error === "not-found") return reply.code(404).send({ error: res.error });
                return reply.code(500).send({ error: res.error });
            }

            await emitPendingChanged({
                sessionId,
                changedByAccountId: request.userId,
                pendingCount: res.pendingCount,
                pendingBlockedCount: res.pendingBlockedCount,
                pendingVersion: res.pendingVersion,
                participantCursors: res.participantCursors,
            });
            await refreshSessionParticipantBadgePushes({
                badgeAttentionChanged: res.badgeAttentionChanged,
                participantCursors: res.participantCursors,
            });
            return reply.send({ ok: true, pendingCount: res.pendingCount, pendingBlockedCount: res.pendingBlockedCount, pendingVersion: res.pendingVersion });
        },
    );

    app.delete(
        "/v2/sessions/:sessionId/pending/:localId",
        {
            preHandler: app.authenticate,
            schema: { params: z.object({ sessionId: z.string(), localId: z.string() }) },
            config: {
                rateLimit: resolveApiHotEndpointRateLimit(process.env, "session.pending"),
            },
        },
        async (request, reply) => {
            const { sessionId, localId } = request.params;
            const res = await deletePendingMessage({ actorUserId: request.userId, sessionId, localId });
            if (!res.ok) {
                if (res.error === "invalid-params") {
                    const payload: { error: string; code?: string } = { error: res.error };
                    const code = getOptionalErrorCode(res);
                    if (code) payload.code = code;
                    return reply.code(400).send(payload);
                }
                if (res.error === "forbidden") return reply.code(403).send({ error: res.error });
                if (res.error === "session-not-found") return reply.code(404).send({ error: res.error });
                return reply.code(500).send({ error: res.error });
            }

            await emitPendingChanged({
                sessionId,
                changedByAccountId: request.userId,
                pendingCount: res.pendingCount,
                pendingBlockedCount: res.pendingBlockedCount,
                pendingVersion: res.pendingVersion,
                participantCursors: res.participantCursors,
            });
            await refreshSessionParticipantBadgePushes({
                badgeAttentionChanged: res.badgeAttentionChanged,
                participantCursors: res.participantCursors,
            });
            return reply.send({ ok: true, pendingCount: res.pendingCount, pendingBlockedCount: res.pendingBlockedCount, pendingVersion: res.pendingVersion });
        },
    );

    app.post(
        "/v2/sessions/:sessionId/pending/:localId/delivery/accepted",
        {
            preHandler: app.authenticate,
            schema: {
                params: z.object({ sessionId: z.string(), localId: z.string().min(1) }),
                body: z.object({}).optional(),
            },
            config: {
                rateLimit: resolveApiHotEndpointRateLimit(process.env, "session.pending.materialize"),
            },
        },
        async (request, reply) => {
            const { sessionId, localId } = request.params;
            const res = await resolveAcceptedPendingDelivery({ actorUserId: request.userId, sessionId, localId });
            if (!res.ok) {
                if (res.error === "invalid-params") return reply.code(400).send({ error: res.error });
                if (res.error === "forbidden") return reply.code(403).send({ error: res.error });
                if (res.error === "session-not-found") return reply.code(404).send({ error: res.error });
                if (res.error === "not-found") return reply.code(404).send({ error: res.error });
                if (res.error === "not-materialized") return reply.code(409).send({ error: res.error });
                if (res.error === "blocked-by-earlier-pending") return reply.code(409).send({ error: res.error });
                if (res.error === "transcript-conflict") {
                    if (res.pendingStateChanged === true) {
                        const participantCursors = res.participantCursors ?? [];
                        await emitPendingChanged({
                            sessionId,
                            changedByAccountId: request.userId,
                            pendingCount: res.pendingCount ?? 0,
                            pendingBlockedCount: res.pendingBlockedCount,
                            pendingVersion: res.pendingVersion ?? 0,
                            participantCursors,
                        });
                        await refreshSessionParticipantBadgePushes({
                            badgeAttentionChanged: res.badgeAttentionChanged ?? false,
                            participantCursors,
                        });
                    }
                    return reply.code(409).send({ error: res.error });
                }
                return reply.code(500).send({ error: res.error });
            }

            const participantCursorsMessage = res.participantCursorsMessage ?? [];
            const participantCursorsPending = res.participantCursorsPending ?? res.participantCursors;
            await emitPendingResolvedMessage({
                sessionId,
                message: res.message,
                eventKind: res.didUpdate === true && res.didWrite !== true ? "message-updated" : "new-message",
                readyProjection: res.readyProjection,
                participantCursors: participantCursorsMessage,
                logContext: "failed to emit new-message update after accepted pending delivery",
            });

            await emitPendingChanged({
                sessionId,
                changedByAccountId: request.userId,
                pendingCount: res.pendingCount,
                pendingBlockedCount: res.pendingBlockedCount,
                pendingVersion: res.pendingVersion,
                participantCursors: participantCursorsPending,
            });
            await refreshSessionParticipantBadgePushes({
                badgeAttentionChanged: res.badgeAttentionChanged,
                participantCursors: [...participantCursorsMessage, ...participantCursorsPending],
            });
            return reply.send({
                ok: true,
                pendingCount: res.pendingCount,
                pendingBlockedCount: res.pendingBlockedCount,
                pendingVersion: res.pendingVersion,
                ...(res.message ? { message: serializePendingMaterializedMessage(res.message) } : {}),
            });
        },
    );

    app.post(
        "/v2/sessions/:sessionId/pending/delivery/accepted-through-seq",
        {
            preHandler: app.authenticate,
            schema: {
                params: z.object({ sessionId: z.string() }),
                body: z.object({ maxAcceptedSeq: z.number().int().nonnegative() }),
            },
            config: {
                rateLimit: resolveApiHotEndpointRateLimit(process.env, "session.pending.materialize"),
            },
        },
        async (request, reply) => {
            const { sessionId } = request.params;
            const res = await reconcileAcceptedPendingDeliveriesThroughSeq({
                actorUserId: request.userId,
                sessionId,
                maxAcceptedSeq: request.body.maxAcceptedSeq,
            });
            if (!res.ok) {
                if (res.error === "invalid-params") return reply.code(400).send({ error: res.error });
                if (res.error === "forbidden") return reply.code(403).send({ error: res.error });
                if (res.error === "session-not-found") return reply.code(404).send({ error: res.error });
                return reply.code(500).send({ error: res.error });
            }

            await emitPendingChanged({
                sessionId,
                changedByAccountId: request.userId,
                pendingCount: res.pendingCount,
                pendingBlockedCount: res.pendingBlockedCount,
                pendingVersion: res.pendingVersion,
                participantCursors: res.participantCursors,
            });
            await refreshSessionParticipantBadgePushes({
                badgeAttentionChanged: res.badgeAttentionChanged,
                participantCursors: res.participantCursors,
            });
            return reply.send({
                ok: true,
                pendingCount: res.pendingCount,
                pendingBlockedCount: res.pendingBlockedCount,
                pendingVersion: res.pendingVersion,
                resolvedCount: res.resolvedCount,
                resolvedLocalIds: res.resolvedLocalIds,
            });
        },
    );

    app.post(
        "/v2/sessions/:sessionId/pending/delivery/provider-attach",
        {
            preHandler: app.authenticate,
            schema: {
                params: z.object({ sessionId: z.string() }),
                body: z.object({}).optional(),
            },
            config: {
                rateLimit: resolveApiHotEndpointRateLimit(process.env, "session.pending.materialize"),
            },
        },
        async (request, reply) => {
            const { sessionId } = request.params;
            const res = await blockPendingDeliveriesOnProviderAttach({
                actorUserId: request.userId,
                sessionId,
            });
            if (!res.ok) {
                if (res.error === "invalid-params") return reply.code(400).send({ error: res.error });
                if (res.error === "forbidden") return reply.code(403).send({ error: res.error });
                if (res.error === "session-not-found") return reply.code(404).send({ error: res.error });
                return reply.code(500).send({ error: res.error });
            }

            if (res.didUpdate) {
                await emitPendingChanged({
                    sessionId,
                    changedByAccountId: request.userId,
                    pendingCount: res.pendingCount,
                    pendingBlockedCount: res.pendingBlockedCount,
                    pendingVersion: res.pendingVersion,
                    participantCursors: res.participantCursors,
                });
                await refreshSessionParticipantBadgePushes({
                    badgeAttentionChanged: res.badgeAttentionChanged,
                    participantCursors: res.participantCursors,
                });
            }

            return reply.send({
                ok: true,
                pendingCount: res.pendingCount,
                pendingBlockedCount: res.pendingBlockedCount,
                pendingVersion: res.pendingVersion,
                blockedCount: res.blockedCount,
            });
        },
    );

    app.post(
        "/v2/sessions/:sessionId/pending/:localId/delivery/block",
        {
            preHandler: app.authenticate,
            schema: {
                params: z.object({ sessionId: z.string(), localId: z.string().min(1) }),
                body: z.object({ reason: PendingDeliveryBlockedReasonSchema }),
            },
            config: {
                rateLimit: resolveApiHotEndpointRateLimit(process.env, "session.pending.materialize"),
            },
        },
        async (request, reply) => {
            const { sessionId, localId } = request.params;
            const res = await blockPendingDelivery({
                actorUserId: request.userId,
                sessionId,
                localId,
                reason: request.body.reason,
            });
            if (!res.ok) {
                if (res.error === "invalid-params") return reply.code(400).send({ error: res.error });
                if (res.error === "forbidden") return reply.code(403).send({ error: res.error });
                if (res.error === "session-not-found" || res.error === "not-found") return reply.code(404).send({ error: res.error });
                return reply.code(500).send({ error: res.error });
            }

            await emitPendingChanged({
                sessionId,
                changedByAccountId: request.userId,
                pendingCount: res.pendingCount,
                pendingBlockedCount: res.pendingBlockedCount,
                pendingVersion: res.pendingVersion,
                participantCursors: res.participantCursors,
            });
            await refreshSessionParticipantBadgePushes({
                badgeAttentionChanged: res.badgeAttentionChanged,
                participantCursors: res.participantCursors,
            });
            return reply.send({ ok: true, pendingCount: res.pendingCount, pendingBlockedCount: res.pendingBlockedCount, pendingVersion: res.pendingVersion });
        },
    );

    app.post(
        "/v2/sessions/:sessionId/pending/:localId/delivery/retry",
        {
            preHandler: app.authenticate,
            schema: {
                params: z.object({ sessionId: z.string(), localId: z.string().min(1) }),
                body: z.object({}).optional(),
            },
            config: {
                rateLimit: resolveApiHotEndpointRateLimit(process.env, "session.pending.materialize"),
            },
        },
        async (request, reply) => {
            const { sessionId, localId } = request.params;
            const res = await retryPendingDelivery({ actorUserId: request.userId, sessionId, localId });
            if (!res.ok) {
                if (res.error === "invalid-params") return reply.code(400).send({ error: res.error });
                if (res.error === "forbidden") return reply.code(403).send({ error: res.error });
                if (res.error === "session-not-found" || res.error === "not-found") return reply.code(404).send({ error: res.error });
                return reply.code(500).send({ error: res.error });
            }

            await emitPendingChanged({
                sessionId,
                changedByAccountId: request.userId,
                pendingCount: res.pendingCount,
                pendingBlockedCount: res.pendingBlockedCount,
                pendingVersion: res.pendingVersion,
                participantCursors: res.participantCursors,
            });
            await refreshSessionParticipantBadgePushes({
                badgeAttentionChanged: res.badgeAttentionChanged,
                participantCursors: res.participantCursors,
            });
            return reply.send({ ok: true, pendingCount: res.pendingCount, pendingBlockedCount: res.pendingBlockedCount, pendingVersion: res.pendingVersion });
        },
    );

    app.post(
        "/v2/sessions/:sessionId/pending/:localId/delivery/handled",
        {
            preHandler: app.authenticate,
            schema: {
                params: z.object({ sessionId: z.string(), localId: z.string().min(1) }),
                body: z.object({}).optional(),
            },
            config: {
                rateLimit: resolveApiHotEndpointRateLimit(process.env, "session.pending.materialize"),
            },
        },
        async (request, reply) => {
            const { sessionId, localId } = request.params;
            const res = await markPendingDeliveryHandled({ actorUserId: request.userId, sessionId, localId });
            if (!res.ok) {
                if (res.error === "invalid-params") return reply.code(400).send({ error: res.error });
                if (res.error === "forbidden") return reply.code(403).send({ error: res.error });
                if (res.error === "session-not-found") return reply.code(404).send({ error: res.error });
                if (res.error === "transcript-conflict") {
                    if (res.pendingStateChanged === true) {
                        const participantCursors = res.participantCursors ?? [];
                        await emitPendingChanged({
                            sessionId,
                            changedByAccountId: request.userId,
                            pendingCount: res.pendingCount ?? 0,
                            pendingBlockedCount: res.pendingBlockedCount,
                            pendingVersion: res.pendingVersion ?? 0,
                            participantCursors,
                        });
                        await refreshSessionParticipantBadgePushes({
                            badgeAttentionChanged: res.badgeAttentionChanged ?? false,
                            participantCursors,
                        });
                    }
                    return reply.code(409).send({ error: res.error });
                }
                return reply.code(500).send({ error: res.error });
            }

            const participantCursorsMessage = res.participantCursorsMessage ?? [];
            const participantCursorsPending = res.participantCursorsPending ?? res.participantCursors;
            await emitPendingResolvedMessage({
                sessionId,
                message: res.message,
                eventKind: res.didUpdate === true && res.didWrite !== true ? "message-updated" : "new-message",
                readyProjection: res.readyProjection,
                participantCursors: participantCursorsMessage,
                logContext: "failed to emit new-message update after handled pending delivery",
            });

            await emitPendingChanged({
                sessionId,
                changedByAccountId: request.userId,
                pendingCount: res.pendingCount,
                pendingBlockedCount: res.pendingBlockedCount,
                pendingVersion: res.pendingVersion,
                participantCursors: participantCursorsPending,
            });
            await refreshSessionParticipantBadgePushes({
                badgeAttentionChanged: res.badgeAttentionChanged,
                participantCursors: [...participantCursorsMessage, ...participantCursorsPending],
            });
            return reply.send({
                ok: true,
                pendingCount: res.pendingCount,
                pendingBlockedCount: res.pendingBlockedCount,
                pendingVersion: res.pendingVersion,
                ...(res.message ? { message: serializePendingMaterializedMessage(res.message) } : {}),
            });
        },
    );

    app.post(
        "/v2/sessions/:sessionId/pending/:localId/discard",
        {
            preHandler: app.authenticate,
            schema: {
                params: z.object({ sessionId: z.string(), localId: z.string() }),
                body: z.object({ reason: z.string().optional() }).optional(),
            },
            config: {
                rateLimit: resolveApiHotEndpointRateLimit(process.env, "session.pending"),
            },
        },
        async (request, reply) => {
            const { sessionId, localId } = request.params;
            const reason = request.body?.reason;

            const res = await discardPendingMessage({ actorUserId: request.userId, sessionId, localId, reason });
            if (!res.ok) {
                if (res.error === "invalid-params") return reply.code(400).send({ error: res.error });
                if (res.error === "forbidden") return reply.code(403).send({ error: res.error });
                if (res.error === "session-not-found" || res.error === "not-found") return reply.code(404).send({ error: res.error });
                return reply.code(500).send({ error: res.error });
            }

            await emitPendingChanged({
                sessionId,
                changedByAccountId: request.userId,
                pendingCount: res.pendingCount,
                pendingBlockedCount: res.pendingBlockedCount,
                pendingVersion: res.pendingVersion,
                participantCursors: res.participantCursors,
            });
            await refreshSessionParticipantBadgePushes({
                badgeAttentionChanged: res.badgeAttentionChanged,
                participantCursors: res.participantCursors,
            });
            return reply.send({ ok: true, pendingCount: res.pendingCount, pendingBlockedCount: res.pendingBlockedCount, pendingVersion: res.pendingVersion });
        },
    );

    app.post(
        "/v2/sessions/:sessionId/pending/:localId/restore",
        {
            preHandler: app.authenticate,
            schema: { params: z.object({ sessionId: z.string(), localId: z.string() }) },
            config: {
                rateLimit: resolveApiHotEndpointRateLimit(process.env, "session.pending"),
            },
        },
        async (request, reply) => {
            const { sessionId, localId } = request.params;
            const res = await restorePendingMessage({ actorUserId: request.userId, sessionId, localId });
            if (!res.ok) {
                if (res.error === "invalid-params") return reply.code(400).send({ error: res.error });
                if (res.error === "forbidden") return reply.code(403).send({ error: res.error });
                if (res.error === "session-not-found" || res.error === "not-found") return reply.code(404).send({ error: res.error });
                return reply.code(500).send({ error: res.error });
            }

            await emitPendingChanged({
                sessionId,
                changedByAccountId: request.userId,
                pendingCount: res.pendingCount,
                pendingBlockedCount: res.pendingBlockedCount,
                pendingVersion: res.pendingVersion,
                participantCursors: res.participantCursors,
            });
            await refreshSessionParticipantBadgePushes({
                badgeAttentionChanged: res.badgeAttentionChanged,
                participantCursors: res.participantCursors,
            });
            return reply.send({ ok: true, pendingCount: res.pendingCount, pendingBlockedCount: res.pendingBlockedCount, pendingVersion: res.pendingVersion });
        },
    );

    app.post(
        "/v2/sessions/:sessionId/pending/reorder",
        {
            preHandler: app.authenticate,
            schema: {
                params: z.object({ sessionId: z.string() }),
                body: z.object({ orderedLocalIds: z.array(z.string().min(1)).min(1) }),
            },
            config: {
                rateLimit: resolveApiHotEndpointRateLimit(process.env, "session.pending"),
            },
        },
        async (request, reply) => {
            const { sessionId } = request.params;
            const res = await reorderPendingMessages({ actorUserId: request.userId, sessionId, orderedLocalIds: request.body.orderedLocalIds });
            if (!res.ok) {
                if (res.error === "invalid-params") return reply.code(400).send({ error: res.error });
                if (res.error === "forbidden") return reply.code(403).send({ error: res.error });
                if (res.error === "session-not-found") return reply.code(404).send({ error: res.error });
                return reply.code(500).send({ error: res.error });
            }

            await emitPendingChanged({
                sessionId,
                changedByAccountId: request.userId,
                pendingCount: res.pendingCount,
                pendingBlockedCount: res.pendingBlockedCount,
                pendingVersion: res.pendingVersion,
                participantCursors: res.participantCursors,
            });
            await refreshSessionParticipantBadgePushes({
                badgeAttentionChanged: res.badgeAttentionChanged,
                participantCursors: res.participantCursors,
            });
            return reply.send({ ok: true, pendingCount: res.pendingCount, pendingBlockedCount: res.pendingBlockedCount, pendingVersion: res.pendingVersion });
        },
    );

    // Optional: HTTP materialize helper (debug/fallback when socket RPC isn't available).
    app.post(
        "/v2/sessions/:sessionId/pending/materialize-next",
        {
            preHandler: app.authenticate,
            schema: {
                params: z.object({ sessionId: z.string() }),
                body: z
                    .object({
                        deliveryState: z.literal("provider").optional(),
                        deliveryTiming: z
                            .union([z.literal("after_foreground_ready"), z.literal("after_runtime_idle")])
                            .optional(),
                    })
                    .optional(),
            },
            config: {
                rateLimit: resolveApiHotEndpointRateLimit(process.env, "session.pending.materialize"),
            },
        },
        async (request, reply) => {
            const { sessionId } = request.params;
            const deliveryState = resolvePendingMaterializeDeliveryStateOptIn(request.body);
            const deliveryTiming = resolvePendingMaterializeDeliveryTimingOptIn(request.body);
            const res = await materializeNextPendingMessage({
                actorUserId: request.userId,
                sessionId,
                ...(deliveryState ? { deliveryState } : {}),
                ...(deliveryTiming ? { deliveryTiming } : {}),
            });
            if (!res.ok) {
                if (res.error === "invalid-params") return reply.code(400).send({ error: res.error });
                if (res.error === "forbidden") return reply.code(403).send({ error: res.error });
                if (res.error === "session-not-found") return reply.code(404).send({ error: res.error });
                if (res.error === "transcript-conflict") return reply.code(409).send({ error: res.error });
                return reply.code(500).send({ error: res.error });
            }
            if (!res.didMaterialize) {
                if (res.pendingStateChanged === true) {
                    const participantCursorsPending = res.participantCursorsPending ?? [];
                    await emitPendingChanged({
                        sessionId,
                        changedByAccountId: request.userId,
                        pendingCount: res.pendingCount,
                        pendingBlockedCount: res.pendingBlockedCount,
                        pendingVersion: res.pendingVersion,
                        participantCursors: participantCursorsPending,
                    });
                    await refreshSessionParticipantBadgePushes({
                        badgeAttentionChanged: res.badgeAttentionChanged ?? false,
                        participantCursors: participantCursorsPending,
                    });
                }
                return reply.send({
                    ok: true,
                    didMaterialize: false,
                    pendingCount: res.pendingCount,
                    pendingBlockedCount: res.pendingBlockedCount,
                    pendingVersion: res.pendingVersion,
                    ...(res.deliveryState ? { deliveryState: res.deliveryState } : {}),
                    ...(res.deferredReason ? { deferredReason: res.deferredReason } : {}),
                });
            }

            const committedMessage =
                res.didWriteMessage && res.message.id !== null && res.message.seq !== null
                    ? { ...res.message, id: res.message.id, seq: res.message.seq }
                    : null;
            if (committedMessage) {
                const messageResults = await Promise.allSettled(
                    res.participantCursorsMessage.map(async ({ accountId, cursor }) => {
                        const payload = buildNewMessageUpdate(committedMessage, sessionId, cursor, randomKeyNaked(12));
                        eventRouter.emitUpdate({
                            userId: accountId,
                            payload,
                            recipientFilter: { type: "all-interested-in-session", sessionId },
                        });
                    }),
                );
                messageResults.forEach((result, index) => {
                    if (result.status === "fulfilled") return;
                    const accountId = res.participantCursorsMessage[index]?.accountId ?? "unknown";
                    log(
                        { module: "session-pending-routes", level: "warn", sessionId, accountId },
                        "failed to emit new-message update after materialize-next",
                        result.reason,
                    );
                });
                await publishSessionReadyProjectionUpdate({
                    sessionId,
                    readyProjection: res.readyProjection,
                });
            }

            await emitPendingChanged({
                sessionId,
                changedByAccountId: request.userId,
                pendingCount: res.pendingCount,
                pendingBlockedCount: res.pendingBlockedCount,
                pendingVersion: res.pendingVersion,
                meaningfulActivityAt: res.meaningfulActivityAt ?? (res.didWriteMessage ? res.message.createdAt : undefined),
                participantCursors: res.participantCursorsPending,
            });
            await refreshSessionParticipantBadgePushes({
                badgeAttentionChanged: res.badgeAttentionChanged,
                participantCursors: [...res.participantCursorsMessage, ...res.participantCursorsPending],
            });

            return reply.send({
                ok: true,
                didMaterialize: true,
                didWriteMessage: res.didWriteMessage,
                pendingCount: res.pendingCount,
                pendingBlockedCount: res.pendingBlockedCount,
                pendingVersion: res.pendingVersion,
                ...(res.deliveryState ? { deliveryState: res.deliveryState } : {}),
                message: serializePendingMaterializedMessage(res.message),
            });
        },
    );
}
