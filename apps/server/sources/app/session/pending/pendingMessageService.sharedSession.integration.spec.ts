import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";

import { db } from "@/storage/db";
import { auth } from "@/app/auth/auth";
import {
    blockPendingDeliveriesOnProviderAttach,
    blockPendingDelivery,
    deletePendingMessage,
    discardPendingMessage,
    enqueuePendingMessage,
    listPendingMessages,
    materializeNextPendingMessage,
    markPendingDeliveryHandled,
    reorderPendingMessages,
    reconcileAcceptedPendingDeliveriesThroughSeq,
    resolveAcceptedPendingDelivery,
    retryPendingDelivery,
    restorePendingMessage,
    updatePendingMessage,
} from "./pendingMessageService";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

describe("pendingMessageService (shared sessions)", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-pending-shared-",
            initAuth: true,
        });
    }, 120_000);

    afterAll(async () => {
        await harness.close();
    });

    beforeEach(() => {
        harness.resetEnv();
    });

    const createAccount = async (kind: string) => {
        return db.account.create({
            data: { publicKey: `pk-${kind}-${randomUUID()}` },
            select: { id: true },
        });
    };

    const createSession = async <TSelect extends Prisma.SessionSelect>(
        ownerId: string,
        select: TSelect = { id: true } as TSelect,
    ): Promise<Prisma.SessionGetPayload<{ select: TSelect }>> => {
        return db.session.create({
            data: {
                tag: `tag-${randomUUID()}`,
                accountId: ownerId,
                metadata: "meta",
                metadataVersion: 0,
                agentState: null,
                agentStateVersion: 0,
            },
            select,
        });
    };

    const markPendingProviderDeliveryClaimed = async (params: {
        sessionId: string;
        localId: string;
    }) => {
        await db.sessionPendingMessage.update({
            where: { sessionId_localId: { sessionId: params.sessionId, localId: params.localId } },
            data: { deliveryState: "delivering", deliveryBlockedReason: null },
        });
    };

    const createCommittedTranscriptMessage = async (params: {
        sessionId: string;
        localId: string;
        seq: number;
        messageRole: "user" | "agent" | null;
        ciphertext: string;
    }) => {
        await db.session.update({ where: { id: params.sessionId }, data: { seq: params.seq } });
        await db.sessionMessage.create({
            data: {
                sessionId: params.sessionId,
                seq: params.seq,
                localId: params.localId,
                messageRole: params.messageRole,
                content: { t: "encrypted", c: params.ciphertext },
            },
        });
    };

    const shareSession = async (params: {
        sessionId: string;
        ownerId: string;
        participantId: string;
        accessLevel: "edit" | "view";
    }) => {
        return db.sessionShare.create({
            data: {
                sessionId: params.sessionId,
                sharedByUserId: params.ownerId,
                sharedWithUserId: params.participantId,
                accessLevel: params.accessLevel,
                canApprovePermissions: false,
                encryptedDataKey: Buffer.from([0, ...new Array(80).fill(1)]),
            },
            select: { id: true },
        });
    };

    it("allows shared edit participants to edit/reorder/discard/restore pending (queue is session-global)", async () => {
        const owner = await createAccount("owner");
        const collaborator = await createAccount("collab");
        const session = await createSession(owner.id);

        await shareSession({
            sessionId: session.id,
            ownerId: owner.id,
            participantId: collaborator.id,
            accessLevel: "edit",
        });

        const localIdA = `a-${randomUUID()}`;
        const localIdB = `b-${randomUUID()}`;
        const localIdC = `c-${randomUUID()}`;

        const enqueueA = await enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId: localIdA,
            ciphertext: "cipher-a-1",
        });
        expect(enqueueA.ok).toBe(true);

        const enqueueB = await enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId: localIdB,
            ciphertext: "cipher-b-1",
        });
        expect(enqueueB.ok).toBe(true);

        const enqueueC = await enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId: localIdC,
            ciphertext: "cipher-c-1",
        });
        expect(enqueueC.ok).toBe(true);

        const editA = await updatePendingMessage({
            actorUserId: collaborator.id,
            sessionId: session.id,
            localId: localIdA,
            ciphertext: "cipher-a-2",
        });
        expect(editA.ok).toBe(true);

        const reorder1 = await reorderPendingMessages({
            actorUserId: collaborator.id,
            sessionId: session.id,
            orderedLocalIds: [localIdB, localIdC, localIdA],
        });
        expect(reorder1.ok).toBe(true);

        const discardC = await discardPendingMessage({
            actorUserId: collaborator.id,
            sessionId: session.id,
            localId: localIdC,
            reason: "test",
        });
        expect(discardC.ok).toBe(true);

        const restoreC = await restorePendingMessage({
            actorUserId: collaborator.id,
            sessionId: session.id,
            localId: localIdC,
        });
        expect(restoreC.ok).toBe(true);

        const reorder2 = await reorderPendingMessages({
            actorUserId: collaborator.id,
            sessionId: session.id,
            orderedLocalIds: [localIdB, localIdC, localIdA],
        });
        expect(reorder2.ok).toBe(true);

        const listQueued = await listPendingMessages({
            actorUserId: collaborator.id,
            sessionId: session.id,
            includeDiscarded: false,
        });
        expect(listQueued.ok).toBe(true);
        if (!listQueued.ok) throw new Error("unexpected list failure");
        expect(listQueued.pending.map((p) => p.localId)).toEqual([localIdB, localIdC, localIdA]);

        // Owner materializes into transcript; edits + order must be preserved.
        const materializedLocalIds: string[] = [];
        for (;;) {
            const res = await materializeNextPendingMessage({ actorUserId: owner.id, sessionId: session.id });
            expect(res.ok).toBe(true);
            if (!res.ok) throw new Error("unexpected materialize failure");
            if (!res.didMaterialize) break;
            materializedLocalIds.push(res.message.localId ?? "");
        }
        expect(materializedLocalIds).toEqual([localIdB, localIdC, localIdA]);

        const messages = await db.sessionMessage.findMany({
            where: { sessionId: session.id },
            orderBy: { seq: "asc" },
            select: { localId: true, content: true },
        });
        expect(messages.map((m) => m.localId)).toEqual([localIdB, localIdC, localIdA]);
        const aMsg = messages.find((m) => m.localId === localIdA);
        expect((aMsg?.content as any)?.c).toBe("cipher-a-2");
    });

    it("keeps newly queued messages after pre-existing queued rows when the queue counter lags behind", async () => {
        const owner = await createAccount("owner");
        const session = await createSession(owner.id);

        const localIdA = `seed-a-${randomUUID()}`;
        const localIdB = `seed-b-${randomUUID()}`;
        const localIdC = `new-c-${randomUUID()}`;

        await db.sessionPendingMessage.create({
            data: {
                sessionId: session.id,
                localId: localIdA,
                content: { t: "encrypted", c: "cipher-seed-a" },
                status: "queued",
                position: 5,
                authorAccountId: owner.id,
            },
        });
        await db.sessionPendingMessage.create({
            data: {
                sessionId: session.id,
                localId: localIdB,
                content: { t: "encrypted", c: "cipher-seed-b" },
                status: "queued",
                position: 6,
                authorAccountId: owner.id,
            },
        });
        await db.session.update({
            where: { id: session.id },
            data: { pendingQueueSeq: 0 },
        });

        const enqueue = await enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId: localIdC,
            ciphertext: "cipher-new-c",
        });
        expect(enqueue.ok).toBe(true);
        if (!enqueue.ok) throw new Error("expected enqueue to succeed");
        expect(enqueue.pending.position).toBe(7);

        const listQueued = await listPendingMessages({
            actorUserId: owner.id,
            sessionId: session.id,
            includeDiscarded: false,
        });
        expect(listQueued.ok).toBe(true);
        if (!listQueued.ok) throw new Error("unexpected list failure");
        expect(listQueued.pending.map((p) => p.localId)).toEqual([localIdA, localIdB, localIdC]);
        expect(listQueued.pending.map((p) => p.position)).toEqual([5, 6, 7]);
    });

    it("persists and returns a ready projection when a queued owner-authored ready event is materialized", async () => {
        const owner = await createAccount("owner");
        const session = await createSession(owner.id);

        await db.session.update({
            where: { id: session.id },
            data: { encryptionMode: "plain" },
        });

        const localId = `ready-${randomUUID()}`;
        const readyContent = {
            t: "plain",
            v: {
                role: "agent",
                content: {
                    type: "event",
                    id: "ready-event-1",
                    data: { type: "ready" },
                },
            },
        } satisfies PrismaJson.SessionPendingMessageContent;

        const enqueue = await enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            content: readyContent,
            messageRole: "event",
        });
        expect(enqueue.ok).toBe(true);

        const materialize = await materializeNextPendingMessage({ actorUserId: owner.id, sessionId: session.id });
        expect(materialize.ok).toBe(true);
        if (!materialize.ok) throw new Error("unexpected materialize failure");
        expect(materialize).toMatchObject({
            didMaterialize: true,
            didWriteMessage: true,
            readyProjection: {
                latestReadyEventSeq: expect.any(Number),
                latestReadyEventAt: expect.any(Number),
            },
        });
        if (!materialize.didMaterialize) throw new Error("expected materialization");
        if (!materialize.readyProjection) throw new Error("expected ready projection");

        const persistedSession = await db.session.findUniqueOrThrow({
            where: { id: session.id },
            select: {
                latestReadyEventSeq: true,
                latestReadyEventAt: true,
            },
        });

        expect(persistedSession.latestReadyEventSeq).toBe(materialize.message.seq);
        expect(persistedSession.latestReadyEventAt?.getTime()).toBe(materialize.readyProjection.latestReadyEventAt);
    });

    it("forbids non-owner participants from materializing pending", async () => {
        const owner = await createAccount("owner");
        const collaborator = await createAccount("collab");
        const session = await createSession(owner.id);

        await shareSession({
            sessionId: session.id,
            ownerId: owner.id,
            participantId: collaborator.id,
            accessLevel: "edit",
        });

        const localId = `a-${randomUUID()}`;
        const enqueue = await enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            ciphertext: "cipher-a-1",
        });
        expect(enqueue.ok).toBe(true);

        const materialize = await materializeNextPendingMessage({ actorUserId: collaborator.id, sessionId: session.id });
        expect(materialize.ok).toBe(false);
        if (materialize.ok) throw new Error("expected forbidden");
        expect(materialize.error).toBe("forbidden");
    });

    it("does not decrement pendingCount below 0 when session state is inconsistent", async () => {
        const owner = await createAccount("owner");
        const session = await createSession(owner.id, { id: true, pendingVersion: true });

        const localId = `a-${randomUUID()}`;
        const enqueue = await enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            ciphertext: "cipher-a-1",
        });
        expect(enqueue.ok).toBe(true);

        // Simulate a race or data inconsistency where pendingCount is already 0.
        await db.session.update({ where: { id: session.id }, data: { pendingCount: 0 } });
        const before = await db.session.findUniqueOrThrow({
            where: { id: session.id },
            select: { pendingCount: true, pendingVersion: true },
        });

        const materialize = await materializeNextPendingMessage({ actorUserId: owner.id, sessionId: session.id });
        expect(materialize.ok).toBe(true);
        if (!materialize.ok) throw new Error("unexpected materialize failure");
        expect(materialize.didMaterialize).toBe(true);

        const after = await db.session.findUniqueOrThrow({
            where: { id: session.id },
            select: { pendingCount: true, pendingVersion: true },
        });
        expect(after.pendingCount).toBe(0);
        expect(after.pendingVersion).toBe(before.pendingVersion + 1);
    });

    it("claims provider-delivery prompt rows without writing transcript before provider acceptance", async () => {
        const owner = await createAccount("owner");
        const session = await createSession(owner.id);
        const localId = `provider-delivery-${randomUUID()}`;

        const enqueue = await enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            ciphertext: "cipher-provider-delivery",
            messageRole: "user",
        });
        expect(enqueue.ok).toBe(true);

        const materializeParams = {
            actorUserId: owner.id,
            sessionId: session.id,
            deliveryState: "provider" as const,
        };
        const materialize = await materializeNextPendingMessage(materializeParams);
        expect(materialize.ok).toBe(true);
        if (!materialize.ok) throw new Error("unexpected materialize failure");
        expect(materialize).toMatchObject({
            didMaterialize: true,
            didWriteMessage: false,
            pendingCount: 1,
            deliveryState: {
                mode: "provider",
                unresolved: true,
            },
        });
        if (!materialize.didMaterialize) throw new Error("expected materialization");
        expect(materialize.message).toEqual(expect.objectContaining({
            id: null,
            seq: null,
            localId,
            messageRole: "user",
        }));

        await expect(db.sessionMessage.count({ where: { sessionId: session.id, localId } })).resolves.toBe(0);
        await expect(db.sessionPendingMessage.findUniqueOrThrow({
            where: { sessionId_localId: { sessionId: session.id, localId } },
            select: { status: true, deliveryState: true, deliveryBlockedReason: true },
        })).resolves.toEqual({ status: "queued", deliveryState: "delivering", deliveryBlockedReason: null });
        await expect(db.session.findUniqueOrThrow({
            where: { id: session.id },
            select: { pendingCount: true },
        })).resolves.toEqual({ pendingCount: 1 });

        const accepted = await resolveAcceptedPendingDelivery({ actorUserId: owner.id, sessionId: session.id, localId });
        expect(accepted.ok).toBe(true);
        if (!accepted.ok || !accepted.didResolve || !accepted.message) throw new Error("expected accepted resolution");
        expect(accepted.message).toEqual(expect.objectContaining({ seq: 1, localId, messageRole: "user" }));
        expect(accepted.pendingCount).toBe(0);
        await expect(db.sessionPendingMessage.count({ where: { sessionId: session.id, localId } })).resolves.toBe(0);
        await expect(db.sessionMessage.count({ where: { sessionId: session.id, localId } })).resolves.toBe(1);
    });

    it("blocks accepted provider delivery that collides with divergent transcript content", async () => {
        const owner = await createAccount("owner");
        const session = await createSession(owner.id);
        const localId = `provider-delivery-conflict-${randomUUID()}`;

        await expect(enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            ciphertext: "cipher-pending-authoritative",
        })).resolves.toMatchObject({ ok: true });

        await markPendingProviderDeliveryClaimed({ sessionId: session.id, localId });
        await createCommittedTranscriptMessage({
            sessionId: session.id,
            localId,
            seq: 1,
            messageRole: "user",
            ciphertext: "cipher-stale-transcript",
        });

        const accepted = await resolveAcceptedPendingDelivery({ actorUserId: owner.id, sessionId: session.id, localId });
        expect(accepted.ok).toBe(false);
        if (accepted.ok) throw new Error("expected accept conflict");
        expect(accepted.error).toBe("transcript-conflict");
        expect(accepted.pendingStateChanged).toBe(true);
        expect(accepted.pendingCount).toBe(1);
        expect(accepted.pendingBlockedCount).toBe(1);
        expect(accepted.pendingVersion).toBeGreaterThan(0);
        expect(accepted.participantCursors).toEqual([
            expect.objectContaining({ accountId: owner.id, cursor: expect.any(Number) }),
        ]);
        expect(accepted).toHaveProperty("badgeAttentionChanged", false);

        await expect(db.sessionMessage.findUniqueOrThrow({
            where: { sessionId_localId: { sessionId: session.id, localId } },
            select: { content: true, messageRole: true },
        })).resolves.toEqual({ content: { t: "encrypted", c: "cipher-stale-transcript" }, messageRole: "user" });
        await expect(db.sessionPendingMessage.findUniqueOrThrow({
            where: { sessionId_localId: { sessionId: session.id, localId } },
            select: { status: true, deliveryState: true, deliveryBlockedReason: true, content: true },
        })).resolves.toEqual({
            status: "queued",
            deliveryState: "blocked",
            deliveryBlockedReason: "unknown",
            content: { t: "encrypted", c: "cipher-pending-authoritative" },
        });
    });

    it("leaves legacy materialization pending when it collides with divergent transcript content", async () => {
        const owner = await createAccount("owner");
        const session = await createSession(owner.id);
        const localId = `legacy-materialize-conflict-${randomUUID()}`;

        await expect(enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            ciphertext: "cipher-legacy-pending-authoritative",
        })).resolves.toMatchObject({ ok: true });

        await db.session.update({ where: { id: session.id }, data: { seq: 1 } });
        await db.sessionMessage.create({
            data: {
                sessionId: session.id,
                seq: 1,
                localId,
                messageRole: "user",
                content: { t: "encrypted", c: "cipher-legacy-stale-transcript" },
            },
        });

        const materialized = await materializeNextPendingMessage({ actorUserId: owner.id, sessionId: session.id });
        expect(materialized.ok).toBe(false);
        if (materialized.ok) throw new Error("expected materialization conflict");
        expect(materialized.error).toBe("transcript-conflict");

        await expect(db.sessionMessage.findUniqueOrThrow({
            where: { sessionId_localId: { sessionId: session.id, localId } },
            select: { content: true, messageRole: true },
        })).resolves.toEqual({ content: { t: "encrypted", c: "cipher-legacy-stale-transcript" }, messageRole: "user" });
        await expect(db.sessionPendingMessage.findUniqueOrThrow({
            where: { sessionId_localId: { sessionId: session.id, localId } },
            select: { status: true, deliveryState: true, deliveryBlockedReason: true, content: true },
        })).resolves.toEqual({
            status: "queued",
            deliveryState: null,
            deliveryBlockedReason: null,
            content: { t: "encrypted", c: "cipher-legacy-pending-authoritative" },
        });
    });

    it("leaves provider materialization pending when it collides with divergent transcript content", async () => {
        const owner = await createAccount("owner");
        const session = await createSession(owner.id);
        const localId = `provider-materialize-conflict-${randomUUID()}`;

        await expect(enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            ciphertext: "cipher-provider-pending-authoritative",
        })).resolves.toMatchObject({ ok: true });

        await createCommittedTranscriptMessage({
            sessionId: session.id,
            localId,
            seq: 1,
            messageRole: "user",
            ciphertext: "cipher-provider-stale-transcript",
        });

        const materialized = await materializeNextPendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            deliveryState: "provider",
        });
        expect(materialized.ok).toBe(false);
        if (materialized.ok) throw new Error("expected materialization conflict");
        expect(materialized.error).toBe("transcript-conflict");

        await expect(db.sessionMessage.findUniqueOrThrow({
            where: { sessionId_localId: { sessionId: session.id, localId } },
            select: { content: true, messageRole: true },
        })).resolves.toEqual({ content: { t: "encrypted", c: "cipher-provider-stale-transcript" }, messageRole: "user" });
        await expect(db.sessionPendingMessage.findUniqueOrThrow({
            where: { sessionId_localId: { sessionId: session.id, localId } },
            select: { status: true, deliveryState: true, deliveryBlockedReason: true, content: true },
        })).resolves.toEqual({
            status: "queued",
            deliveryState: null,
            deliveryBlockedReason: null,
            content: { t: "encrypted", c: "cipher-provider-pending-authoritative" },
        });
    });

    it("joins accepted provider delivery with a compatible transcript row without rewriting content", async () => {
        const owner = await createAccount("owner");
        const session = await createSession(owner.id);
        const localId = `provider-delivery-compatible-${randomUUID()}`;

        await expect(enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            ciphertext: "cipher-compatible",
            messageRole: "user",
        })).resolves.toMatchObject({ ok: true });

        await markPendingProviderDeliveryClaimed({ sessionId: session.id, localId });
        await createCommittedTranscriptMessage({
            sessionId: session.id,
            localId,
            seq: 1,
            messageRole: null,
            ciphertext: "cipher-compatible",
        });

        const accepted = await resolveAcceptedPendingDelivery({ actorUserId: owner.id, sessionId: session.id, localId });
        expect(accepted.ok).toBe(true);
        if (!accepted.ok || !accepted.didResolve || !accepted.message) throw new Error("expected accepted join");
        expect(accepted.message.content).toEqual({ t: "encrypted", c: "cipher-compatible" });
        expect(accepted.message.messageRole).toBe("user");

        await expect(db.sessionMessage.findUniqueOrThrow({
            where: { sessionId_localId: { sessionId: session.id, localId } },
            select: { content: true, messageRole: true },
        })).resolves.toEqual({ content: { t: "encrypted", c: "cipher-compatible" }, messageRole: "user" });
        await expect(db.sessionPendingMessage.count({ where: { sessionId: session.id, localId } })).resolves.toBe(0);
    });

    it("blocks accepted provider delivery that collides with an incompatible transcript role", async () => {
        const owner = await createAccount("owner");
        const session = await createSession(owner.id);
        const localId = `provider-delivery-role-conflict-${randomUUID()}`;

        await expect(enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            ciphertext: "cipher-role-conflict",
            messageRole: "user",
        })).resolves.toMatchObject({ ok: true });

        await markPendingProviderDeliveryClaimed({ sessionId: session.id, localId });
        await createCommittedTranscriptMessage({
            sessionId: session.id,
            localId,
            seq: 1,
            messageRole: "agent",
            ciphertext: "cipher-role-conflict",
        });

        const accepted = await resolveAcceptedPendingDelivery({ actorUserId: owner.id, sessionId: session.id, localId });
        expect(accepted.ok).toBe(false);
        if (accepted.ok) throw new Error("expected role conflict");
        expect(accepted.error).toBe("transcript-conflict");

        await expect(db.sessionMessage.findUniqueOrThrow({
            where: { sessionId_localId: { sessionId: session.id, localId } },
            select: { content: true, messageRole: true },
        })).resolves.toEqual({ content: { t: "encrypted", c: "cipher-role-conflict" }, messageRole: "agent" });
        await expect(db.sessionPendingMessage.findUniqueOrThrow({
            where: { sessionId_localId: { sessionId: session.id, localId } },
            select: { status: true, deliveryState: true, deliveryBlockedReason: true },
        })).resolves.toEqual({
            status: "queued",
            deliveryState: "blocked",
            deliveryBlockedReason: "unknown",
        });
    });

    it("keeps claimed provider-delivery rows immutable to normal pending edits", async () => {
        const owner = await createAccount("owner");
        const session = await createSession(owner.id);
        const localId = `provider-delivery-immutable-${randomUUID()}`;

        await expect(enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            ciphertext: "cipher-provider-delivery-original",
        })).resolves.toMatchObject({ ok: true });

        const materialize = await materializeNextPendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            deliveryState: "provider",
        });
        expect(materialize.ok).toBe(true);
        if (!materialize.ok || !materialize.didMaterialize) throw new Error("expected provider delivery claim");
        expect(materialize.didWriteMessage).toBe(false);

        await expect(updatePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            ciphertext: "cipher-provider-delivery-edited",
        })).resolves.toMatchObject({ ok: false, error: "not-found" });

        await expect(db.sessionPendingMessage.findUniqueOrThrow({
            where: { sessionId_localId: { sessionId: session.id, localId } },
            select: { status: true, deliveryState: true, deliveryBlockedReason: true, content: true },
        })).resolves.toEqual({
            status: "queued",
            deliveryState: "delivering",
            deliveryBlockedReason: null,
            content: { t: "encrypted", c: "cipher-provider-delivery-original" },
        });
        await expect(db.sessionMessage.count({ where: { sessionId: session.id, localId } })).resolves.toBe(0);
    });

    it("skips unresolved provider-delivery rows when materializing later queued rows", async () => {
        const owner = await createAccount("owner");
        const session = await createSession(owner.id);
        const firstLocalId = `provider-delivery-first-${randomUUID()}`;
        const secondLocalId = `provider-delivery-second-${randomUUID()}`;

        await expect(enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId: firstLocalId,
            ciphertext: "cipher-provider-delivery-first",
        })).resolves.toMatchObject({ ok: true });

        const firstMaterialize = await materializeNextPendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            deliveryState: "provider",
        });
        expect(firstMaterialize.ok).toBe(true);
        if (!firstMaterialize.ok || !firstMaterialize.didMaterialize) throw new Error("expected first materialization");
        expect(firstMaterialize.message.localId).toBe(firstLocalId);

        await expect(db.sessionPendingMessage.findUniqueOrThrow({
            where: { sessionId_localId: { sessionId: session.id, localId: firstLocalId } },
            select: { deliveryState: true, deliveryBlockedReason: true },
        })).resolves.toEqual({ deliveryState: "delivering", deliveryBlockedReason: null });

        await expect(enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId: secondLocalId,
            ciphertext: "cipher-provider-delivery-second",
        })).resolves.toMatchObject({ ok: true });

        const secondMaterialize = await materializeNextPendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            deliveryState: "provider",
        });
        expect(secondMaterialize.ok).toBe(true);
        if (!secondMaterialize.ok || !secondMaterialize.didMaterialize) throw new Error("expected second materialization");
        expect(secondMaterialize.message.localId).toBe(secondLocalId);

        await expect(db.sessionPendingMessage.findMany({
            where: { sessionId: session.id, status: "queued" },
            orderBy: [{ position: "asc" }, { localId: "asc" }],
            select: { localId: true, deliveryState: true },
        })).resolves.toEqual([
            { localId: firstLocalId, deliveryState: "delivering" },
            { localId: secondLocalId, deliveryState: "delivering" },
        ]);
    });

    it("blocks and retries provider delivery claims without changing pendingCount or writing a transcript row", async () => {
        const owner = await createAccount("owner");
        const session = await createSession(owner.id);
        const localId = `provider-delivery-blocked-${randomUUID()}`;

        await expect(enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            ciphertext: "cipher-provider-delivery-blocked",
        })).resolves.toMatchObject({ ok: true });

        const firstMaterialize = await materializeNextPendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            deliveryState: "provider",
        });
        expect(firstMaterialize.ok).toBe(true);
        if (!firstMaterialize.ok || !firstMaterialize.didMaterialize) throw new Error("expected first materialization");
        expect(firstMaterialize.didWriteMessage).toBe(false);
        await expect(db.sessionMessage.count({ where: { sessionId: session.id, localId } })).resolves.toBe(0);

        const blocked = await blockPendingDelivery({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            reason: "terminal_composer_draft",
        });
        expect(blocked.ok).toBe(true);
        if (!blocked.ok) throw new Error("expected block to succeed");
        expect(blocked.pendingCount).toBe(1);
        await expect(db.session.findUniqueOrThrow({
            where: { id: session.id },
            select: { pendingCount: true, pendingBlockedCount: true },
        })).resolves.toEqual({ pendingCount: 1, pendingBlockedCount: 1 });

        await expect(db.sessionPendingMessage.findUniqueOrThrow({
            where: { sessionId_localId: { sessionId: session.id, localId } },
            select: { deliveryState: true, deliveryBlockedReason: true },
        })).resolves.toEqual({ deliveryState: "blocked", deliveryBlockedReason: "terminal_composer_draft" });

        const blockedMaterialize = await materializeNextPendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            deliveryState: "provider",
        });
        expect(blockedMaterialize.ok).toBe(true);
        if (!blockedMaterialize.ok) throw new Error("expected blocked materialize result");
        expect(blockedMaterialize.didMaterialize).toBe(false);
        expect(blockedMaterialize.pendingCount).toBe(1);

        const retry = await retryPendingDelivery({ actorUserId: owner.id, sessionId: session.id, localId });
        expect(retry.ok).toBe(true);
        if (!retry.ok) throw new Error("expected retry to succeed");
        expect(retry.pendingCount).toBe(1);
        await expect(db.session.findUniqueOrThrow({
            where: { id: session.id },
            select: { pendingCount: true, pendingBlockedCount: true },
        })).resolves.toEqual({ pendingCount: 1, pendingBlockedCount: 0 });
        await expect(db.sessionPendingMessage.findUniqueOrThrow({
            where: { sessionId_localId: { sessionId: session.id, localId } },
            select: { deliveryState: true, deliveryBlockedReason: true },
        })).resolves.toEqual({ deliveryState: null, deliveryBlockedReason: null });

        const retryMaterialize = await materializeNextPendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            deliveryState: "provider",
        });
        expect(retryMaterialize.ok).toBe(true);
        if (!retryMaterialize.ok || !retryMaterialize.didMaterialize) throw new Error("expected retry materialization");
        expect(retryMaterialize.didWriteMessage).toBe(false);
        await expect(db.sessionMessage.count({ where: { sessionId: session.id, localId } })).resolves.toBe(0);
        await expect(db.sessionPendingMessage.findUniqueOrThrow({
            where: { sessionId_localId: { sessionId: session.id, localId } },
            select: { deliveryState: true, deliveryBlockedReason: true },
        })).resolves.toEqual({ deliveryState: "delivering", deliveryBlockedReason: null });
    });

    it("does not retry an in-flight delivering row into duplicate materialization eligibility", async () => {
        const owner = await createAccount("owner");
        const session = await createSession(owner.id);
        const localId = `provider-delivery-delivering-retry-${randomUUID()}`;

        await expect(enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            ciphertext: "cipher-provider-delivery-delivering-retry",
        })).resolves.toMatchObject({ ok: true });

        const materialize = await materializeNextPendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            deliveryState: "provider",
        });
        expect(materialize.ok).toBe(true);
        if (!materialize.ok || !materialize.didMaterialize) throw new Error("expected materialization");

        const retry = await retryPendingDelivery({ actorUserId: owner.id, sessionId: session.id, localId });
        expect(retry.ok).toBe(true);
        if (!retry.ok) throw new Error("expected retry no-op");
        expect(retry.didUpdate).toBe(false);

        await expect(db.sessionPendingMessage.findUniqueOrThrow({
            where: { sessionId_localId: { sessionId: session.id, localId } },
            select: { deliveryState: true, deliveryBlockedReason: true },
        })).resolves.toEqual({ deliveryState: "delivering", deliveryBlockedReason: null });

        const nextMaterialize = await materializeNextPendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            deliveryState: "provider",
        });
        expect(nextMaterialize.ok).toBe(true);
        if (!nextMaterialize.ok) throw new Error("expected materialize result");
        expect(nextMaterialize.didMaterialize).toBe(false);
    });

    it("does not refresh an in-flight delivering row during queue reorder", async () => {
        const owner = await createAccount("owner");
        const session = await createSession(owner.id);
        const localId = `provider-delivery-reorder-stale-${randomUUID()}`;

        await expect(enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            ciphertext: "cipher-provider-delivery-reorder-stale",
        })).resolves.toMatchObject({ ok: true });

        const claim = await materializeNextPendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            deliveryState: "provider",
        });
        expect(claim.ok).toBe(true);
        if (!claim.ok || !claim.didMaterialize) throw new Error("expected provider claim");
        expect(claim.didWriteMessage).toBe(false);

        await db.sessionPendingMessage.update({
            where: { sessionId_localId: { sessionId: session.id, localId } },
            data: { updatedAt: new Date(Date.now() - 10 * 60_000) },
        });

        const reorder = await reorderPendingMessages({
            actorUserId: owner.id,
            sessionId: session.id,
            orderedLocalIds: [localId],
        });
        expect(reorder.ok).toBe(true);

        const blocked = await materializeNextPendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            deliveryState: "provider",
        });
        expect(blocked.ok).toBe(true);
        if (!blocked.ok) throw new Error("expected stale claim materialization result");
        expect(blocked.didMaterialize).toBe(false);
        expect(blocked).toMatchObject({
            pendingStateChanged: true,
            pendingCount: 1,
            pendingBlockedCount: 1,
            deliveryState: { mode: "provider", unresolved: false },
        });
        await expect(db.sessionPendingMessage.findUniqueOrThrow({
            where: { sessionId_localId: { sessionId: session.id, localId } },
            select: { deliveryState: true, deliveryBlockedReason: true },
        })).resolves.toEqual({ deliveryState: "blocked", deliveryBlockedReason: "provider_acceptance_timeout" });
    });

    it("blocks a stale provider-delivery claim instead of reclaiming it for restart delivery", async () => {
        const owner = await createAccount("owner");
        const session = await createSession(owner.id);
        const localId = `provider-delivery-stale-block-${randomUUID()}`;

        await expect(enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            ciphertext: "cipher-provider-delivery-stale-block",
        })).resolves.toMatchObject({ ok: true });

        const firstMaterialize = await materializeNextPendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            deliveryState: "provider",
        });
        expect(firstMaterialize.ok).toBe(true);
        if (!firstMaterialize.ok || !firstMaterialize.didMaterialize) throw new Error("expected first materialization");
        expect(firstMaterialize.didWriteMessage).toBe(false);

        await db.sessionPendingMessage.update({
            where: { sessionId_localId: { sessionId: session.id, localId } },
            data: { updatedAt: new Date(Date.now() - 10 * 60_000) },
        });

        const blocked = await materializeNextPendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            deliveryState: "provider",
        });
        expect(blocked.ok).toBe(true);
        if (!blocked.ok) throw new Error("expected stale claim materialization result");
        expect(blocked.didMaterialize).toBe(false);
        if (blocked.didMaterialize) throw new Error("expected stale claim to block without materialization");
        expect(blocked.pendingStateChanged).toBe(true);
        expect(blocked.pendingCount).toBe(1);
        expect(blocked.pendingBlockedCount).toBe(1);

        await expect(db.sessionMessage.count({ where: { sessionId: session.id, localId } })).resolves.toBe(0);
        await expect(db.sessionPendingMessage.findUniqueOrThrow({
            where: { sessionId_localId: { sessionId: session.id, localId } },
            select: { deliveryState: true, deliveryBlockedReason: true },
        })).resolves.toEqual({ deliveryState: "blocked", deliveryBlockedReason: "provider_acceptance_timeout" });
    });

    it("does not block a fresh inherited provider-delivery claim on provider attach", async () => {
        const owner = await createAccount("owner");
        const session = await createSession(owner.id);
        const localId = `provider-delivery-attach-recovery-${randomUUID()}`;

        await expect(enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            ciphertext: "cipher-provider-delivery-attach-recovery",
        })).resolves.toMatchObject({ ok: true });

        const firstMaterialize = await materializeNextPendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            deliveryState: "provider",
        });
        expect(firstMaterialize.ok).toBe(true);
        if (!firstMaterialize.ok || !firstMaterialize.didMaterialize) throw new Error("expected first materialization");
        expect(firstMaterialize.didWriteMessage).toBe(false);

        const recovered = await blockPendingDeliveriesOnProviderAttach({
            actorUserId: owner.id,
            sessionId: session.id,
        });
        expect(recovered.ok).toBe(true);
        if (!recovered.ok) throw new Error("expected attach recovery");
        expect(recovered.didUpdate).toBe(false);
        expect(recovered.blockedCount).toBe(0);
        expect(recovered.pendingCount).toBe(1);
        expect(recovered.pendingBlockedCount).toBe(0);

        await expect(db.sessionMessage.count({ where: { sessionId: session.id, localId } })).resolves.toBe(0);
        await expect(db.sessionPendingMessage.findUniqueOrThrow({
            where: { sessionId_localId: { sessionId: session.id, localId } },
            select: { deliveryState: true, deliveryBlockedReason: true },
        })).resolves.toEqual({ deliveryState: "delivering", deliveryBlockedReason: null });
    });

    it("blocks stale inherited provider-delivery claims on provider attach without writing a transcript row", async () => {
        const owner = await createAccount("owner");
        const session = await createSession(owner.id);
        const localId = `provider-delivery-stale-attach-recovery-${randomUUID()}`;

        await expect(enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            ciphertext: "cipher-provider-delivery-stale-attach-recovery",
        })).resolves.toMatchObject({ ok: true });

        const firstMaterialize = await materializeNextPendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            deliveryState: "provider",
        });
        expect(firstMaterialize.ok).toBe(true);
        if (!firstMaterialize.ok || !firstMaterialize.didMaterialize) throw new Error("expected first materialization");
        expect(firstMaterialize.didWriteMessage).toBe(false);

        await db.sessionPendingMessage.update({
            where: { sessionId_localId: { sessionId: session.id, localId } },
            data: { updatedAt: new Date(Date.now() - 10 * 60_000) },
        });

        const recovered = await blockPendingDeliveriesOnProviderAttach({
            actorUserId: owner.id,
            sessionId: session.id,
        });
        expect(recovered.ok).toBe(true);
        if (!recovered.ok) throw new Error("expected attach recovery");
        expect(recovered.didUpdate).toBe(true);
        expect(recovered.blockedCount).toBe(1);
        expect(recovered.pendingCount).toBe(1);
        expect(recovered.pendingBlockedCount).toBe(1);

        await expect(db.sessionMessage.count({ where: { sessionId: session.id, localId } })).resolves.toBe(0);
        await expect(db.sessionPendingMessage.findUniqueOrThrow({
            where: { sessionId_localId: { sessionId: session.id, localId } },
            select: { deliveryState: true, deliveryBlockedReason: true },
        })).resolves.toEqual({ deliveryState: "blocked", deliveryBlockedReason: "provider_acceptance_timeout" });
    });

    it("marks a blocked provider delivery as handled by committing the pending row", async () => {
        const owner = await createAccount("owner");
        const session = await createSession(owner.id);
        const localId = `provider-delivery-handled-${randomUUID()}`;

        await expect(enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            ciphertext: "cipher-provider-delivery-handled",
        })).resolves.toMatchObject({ ok: true });

        const materialize = await materializeNextPendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            deliveryState: "provider",
        });
        expect(materialize.ok).toBe(true);
        if (!materialize.ok || !materialize.didMaterialize) throw new Error("expected materialization");
        expect(materialize.didWriteMessage).toBe(false);

        await expect(blockPendingDelivery({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            reason: "ambiguous_terminal_delivery",
        })).resolves.toMatchObject({ ok: true, pendingCount: 1 });

        const handled = await markPendingDeliveryHandled({ actorUserId: owner.id, sessionId: session.id, localId });
        expect(handled.ok).toBe(true);
        if (!handled.ok || !handled.didResolve || !handled.message) throw new Error("expected handled resolution");
        expect(handled.pendingCount).toBe(0);
        await expect(db.session.findUniqueOrThrow({
            where: { id: session.id },
            select: { pendingCount: true, pendingBlockedCount: true },
        })).resolves.toEqual({ pendingCount: 0, pendingBlockedCount: 0 });

        await expect(db.sessionPendingMessage.count({ where: { sessionId: session.id, localId } })).resolves.toBe(0);
        await expect(db.sessionMessage.count({ where: { sessionId: session.id, localId } })).resolves.toBe(1);
        expect(handled.message).toEqual(expect.objectContaining({ seq: 1, localId }));

        await expect(markPendingDeliveryHandled({ actorUserId: owner.id, sessionId: session.id, localId }))
            .resolves.toMatchObject({ ok: true, didResolve: false, pendingCount: 0 });
    });

    it("marks a delivering provider delivery as handled by committing the pending row", async () => {
        const owner = await createAccount("owner");
        const session = await createSession(owner.id);
        const localId = `provider-delivery-delivering-handled-${randomUUID()}`;

        await expect(enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            ciphertext: "cipher-provider-delivery-delivering-handled",
        })).resolves.toMatchObject({ ok: true });

        const materialize = await materializeNextPendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            deliveryState: "provider",
        });
        expect(materialize.ok).toBe(true);
        if (!materialize.ok || !materialize.didMaterialize) throw new Error("expected materialization");
        expect(materialize.didWriteMessage).toBe(false);

        const handled = await markPendingDeliveryHandled({ actorUserId: owner.id, sessionId: session.id, localId });
        expect(handled.ok).toBe(true);
        if (!handled.ok || !handled.message) throw new Error("expected handled resolution");
        expect(handled.didResolve).toBe(true);
        expect(handled.pendingCount).toBe(0);

        await expect(db.session.findUniqueOrThrow({
            where: { id: session.id },
            select: { pendingCount: true, pendingBlockedCount: true },
        })).resolves.toEqual({ pendingCount: 0, pendingBlockedCount: 0 });

        await expect(db.sessionPendingMessage.count({ where: { sessionId: session.id, localId } })).resolves.toBe(0);
        await expect(db.sessionMessage.count({ where: { sessionId: session.id, localId } })).resolves.toBe(1);
        expect(handled.message).toEqual(expect.objectContaining({ seq: 1, localId }));
    });

    it("does not advance ready projection when a shared editor marks provider delivery handled", async () => {
        const owner = await createAccount("owner");
        const collaborator = await createAccount("collab");
        const session = await createSession(owner.id);

        await shareSession({
            sessionId: session.id,
            ownerId: owner.id,
            participantId: collaborator.id,
            accessLevel: "edit",
        });
        await db.session.update({
            where: { id: session.id },
            data: { encryptionMode: "plain" },
        });

        const localId = `provider-delivery-editor-ready-handled-${randomUUID()}`;
        const readyContent = {
            t: "plain",
            v: {
                role: "agent",
                content: {
                    type: "event",
                    id: "ready-event-editor-handled",
                    data: { type: "ready" },
                },
            },
        } satisfies PrismaJson.SessionPendingMessageContent;

        await expect(enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            content: readyContent,
            messageRole: "event",
        })).resolves.toMatchObject({ ok: true });

        const materialize = await materializeNextPendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            deliveryState: "provider",
        });
        expect(materialize.ok).toBe(true);
        if (!materialize.ok || !materialize.didMaterialize) throw new Error("expected provider materialization");
        expect(materialize.didWriteMessage).toBe(false);

        const handled = await markPendingDeliveryHandled({ actorUserId: collaborator.id, sessionId: session.id, localId });
        expect(handled.ok).toBe(true);
        if (!handled.ok || !handled.didResolve || !handled.message) throw new Error("expected handled resolution");
        expect(handled).not.toHaveProperty("readyProjection");

        await expect(db.session.findUniqueOrThrow({
            where: { id: session.id },
            select: { latestReadyEventSeq: true, latestReadyEventAt: true },
        })).resolves.toEqual({ latestReadyEventSeq: null, latestReadyEventAt: null });
    });

    it("handles duplicate handled delivery resolution races idempotently", async () => {
        const owner = await createAccount("owner");
        const session = await createSession(owner.id);
        const localId = `provider-delivery-handled-race-${randomUUID()}`;

        await expect(enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            ciphertext: "cipher-provider-delivery-handled-race",
        })).resolves.toMatchObject({ ok: true });

        await markPendingProviderDeliveryClaimed({ sessionId: session.id, localId });

        const results = await Promise.all([
            markPendingDeliveryHandled({ actorUserId: owner.id, sessionId: session.id, localId }),
            markPendingDeliveryHandled({ actorUserId: owner.id, sessionId: session.id, localId }),
        ]);

        expect(results.every((result) => result.ok)).toBe(true);
        expect(results.filter((result) => result.ok && result.didResolve).length).toBe(1);
        expect(results.filter((result) => result.ok && !result.didResolve).length).toBe(1);
        await expect(db.sessionMessage.count({ where: { sessionId: session.id, localId } })).resolves.toBe(1);
        await expect(db.sessionPendingMessage.count({ where: { sessionId: session.id, localId } })).resolves.toBe(0);
        await expect(db.session.findUniqueOrThrow({
            where: { id: session.id },
            select: { pendingCount: true, pendingBlockedCount: true },
        })).resolves.toEqual({ pendingCount: 0, pendingBlockedCount: 0 });
    });

    it("does not mark an unmaterialized queued row handled", async () => {
        const owner = await createAccount("owner");
        const session = await createSession(owner.id);
        const localId = `provider-delivery-unmaterialized-handled-${randomUUID()}`;

        await expect(enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            ciphertext: "cipher-provider-delivery-unmaterialized-handled",
        })).resolves.toMatchObject({ ok: true });

        const handled = await markPendingDeliveryHandled({ actorUserId: owner.id, sessionId: session.id, localId });
        expect(handled.ok).toBe(true);
        if (!handled.ok) throw new Error("expected handled no-op");
        expect(handled.didResolve).toBe(false);
        expect(handled.pendingCount).toBe(1);

        await expect(db.sessionPendingMessage.count({ where: { sessionId: session.id, localId, status: "queued" } })).resolves.toBe(1);
        await expect(db.sessionMessage.count({ where: { sessionId: session.id, localId } })).resolves.toBe(0);
    });

    it("reconciles materialized provider-delivery rows covered by a durable accepted seq", async () => {
        const owner = await createAccount("owner");
        const session = await createSession(owner.id);
        const firstLocalId = `provider-delivery-reconcile-first-${randomUUID()}`;
        const secondLocalId = `provider-delivery-reconcile-second-${randomUUID()}`;

        await expect(enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId: firstLocalId,
            ciphertext: "cipher-provider-delivery-reconcile-first",
        })).resolves.toMatchObject({ ok: true });
        await expect(enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId: secondLocalId,
            ciphertext: "cipher-provider-delivery-reconcile-second",
        })).resolves.toMatchObject({ ok: true });

        const firstMaterialize = await materializeNextPendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            deliveryState: "provider",
        });
        expect(firstMaterialize.ok).toBe(true);
        if (!firstMaterialize.ok || !firstMaterialize.didMaterialize) throw new Error("expected first materialization");
        expect(firstMaterialize.didWriteMessage).toBe(false);

        const secondMaterialize = await materializeNextPendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            deliveryState: "provider",
        });
        expect(secondMaterialize.ok).toBe(true);
        if (!secondMaterialize.ok || !secondMaterialize.didMaterialize) throw new Error("expected second materialization");
        expect(secondMaterialize.didWriteMessage).toBe(false);

        await createCommittedTranscriptMessage({
            sessionId: session.id,
            localId: firstLocalId,
            seq: 1,
            messageRole: "user",
            ciphertext: "cipher-provider-delivery-reconcile-first",
        });

        const reconciled = await reconcileAcceptedPendingDeliveriesThroughSeq({
            actorUserId: owner.id,
            sessionId: session.id,
            maxAcceptedSeq: 1,
        });
        expect(reconciled.ok).toBe(true);
        if (!reconciled.ok) throw new Error("expected reconciliation");
        expect(reconciled.didResolve).toBe(true);
        expect(reconciled.resolvedCount).toBe(1);
        expect(reconciled).toMatchObject({ resolvedLocalIds: [firstLocalId] });
        expect(reconciled.pendingCount).toBe(1);
        await expect(db.session.findUniqueOrThrow({
            where: { id: session.id },
            select: { pendingCount: true, pendingBlockedCount: true },
        })).resolves.toEqual({ pendingCount: 1, pendingBlockedCount: 0 });

        await expect(db.sessionPendingMessage.findMany({
            where: { sessionId: session.id },
            orderBy: [{ position: "asc" }, { localId: "asc" }],
            select: { localId: true, deliveryState: true },
        })).resolves.toEqual([
            { localId: secondLocalId, deliveryState: "delivering" },
        ]);
    });

    it("blocks accepted-through-seq provider delivery that collides with divergent transcript content", async () => {
        const owner = await createAccount("owner");
        const session = await createSession(owner.id);
        const localId = `provider-delivery-reconcile-conflict-${randomUUID()}`;

        await expect(enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            ciphertext: "cipher-provider-delivery-reconcile-conflict-pending",
        })).resolves.toMatchObject({ ok: true });

        await markPendingProviderDeliveryClaimed({ sessionId: session.id, localId });
        await createCommittedTranscriptMessage({
            sessionId: session.id,
            localId,
            seq: 50,
            messageRole: "user",
            ciphertext: "cipher-provider-delivery-reconcile-conflict-transcript",
        });

        const reconciled = await reconcileAcceptedPendingDeliveriesThroughSeq({
            actorUserId: owner.id,
            sessionId: session.id,
            maxAcceptedSeq: 50,
        });
        expect(reconciled.ok).toBe(true);
        if (!reconciled.ok) throw new Error("expected reconciliation result");
        expect(reconciled.didResolve).toBe(false);
        expect(reconciled.resolvedCount).toBe(0);
        expect(reconciled.pendingCount).toBe(1);
        expect(reconciled.pendingBlockedCount).toBe(1);

        await expect(db.sessionPendingMessage.findUniqueOrThrow({
            where: { sessionId_localId: { sessionId: session.id, localId } },
            select: { deliveryState: true, deliveryBlockedReason: true },
        })).resolves.toEqual({ deliveryState: "blocked", deliveryBlockedReason: "unknown" });
    });

    it("blocks accepted-through-seq provider delivery that collides with an incompatible transcript role", async () => {
        const owner = await createAccount("owner");
        const session = await createSession(owner.id);
        const localId = `provider-delivery-reconcile-role-conflict-${randomUUID()}`;

        await expect(enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            ciphertext: "cipher-provider-delivery-reconcile-role-conflict",
            messageRole: "user",
        })).resolves.toMatchObject({ ok: true });

        await markPendingProviderDeliveryClaimed({ sessionId: session.id, localId });
        await createCommittedTranscriptMessage({
            sessionId: session.id,
            localId,
            seq: 51,
            messageRole: "agent",
            ciphertext: "cipher-provider-delivery-reconcile-role-conflict",
        });

        const reconciled = await reconcileAcceptedPendingDeliveriesThroughSeq({
            actorUserId: owner.id,
            sessionId: session.id,
            maxAcceptedSeq: 51,
        });
        expect(reconciled.ok).toBe(true);
        if (!reconciled.ok) throw new Error("expected reconciliation result");
        expect(reconciled.didResolve).toBe(false);
        expect(reconciled.resolvedCount).toBe(0);
        expect(reconciled.pendingCount).toBe(1);
        expect(reconciled.pendingBlockedCount).toBe(1);

        await expect(db.sessionPendingMessage.findUniqueOrThrow({
            where: { sessionId_localId: { sessionId: session.id, localId } },
            select: { deliveryState: true, deliveryBlockedReason: true },
        })).resolves.toEqual({ deliveryState: "blocked", deliveryBlockedReason: "unknown" });
    });

    it("resolves accepted provider delivery from a queued row by committing it to the transcript", async () => {
        const owner = await createAccount("owner");
        const session = await createSession(owner.id);
        const localId = `provider-delivery-prewrite-${randomUUID()}`;

        const enqueue = await enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            ciphertext: "cipher-provider-delivery-prewrite",
        });
        expect(enqueue.ok).toBe(true);

        const accepted = await resolveAcceptedPendingDelivery({ actorUserId: owner.id, sessionId: session.id, localId });
        expect(accepted.ok).toBe(true);
        if (!accepted.ok || !accepted.didResolve || !accepted.message) throw new Error("expected accepted resolution");
        expect(accepted.message).toEqual(expect.objectContaining({ seq: 1, localId }));
        await expect(db.sessionPendingMessage.count({ where: { sessionId: session.id, localId } })).resolves.toBe(0);
        await expect(db.sessionMessage.count({ where: { sessionId: session.id, localId } })).resolves.toBe(1);
        await expect(db.session.findUniqueOrThrow({
            where: { id: session.id },
            select: { pendingCount: true },
        })).resolves.toEqual({ pendingCount: 0 });
    });

    it("handles duplicate accepted delivery resolution races idempotently", async () => {
        const owner = await createAccount("owner");
        const session = await createSession(owner.id);
        const localId = `provider-delivery-accepted-race-${randomUUID()}`;

        await expect(enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            ciphertext: "cipher-provider-delivery-accepted-race",
        })).resolves.toMatchObject({ ok: true });

        const results = await Promise.all([
            resolveAcceptedPendingDelivery({ actorUserId: owner.id, sessionId: session.id, localId }),
            resolveAcceptedPendingDelivery({ actorUserId: owner.id, sessionId: session.id, localId }),
        ]);

        expect(results.every((result) => result.ok)).toBe(true);
        expect(results.filter((result) => result.ok && result.didResolve).length).toBe(1);
        expect(results.filter((result) => result.ok && !result.didResolve).length).toBe(1);
        await expect(db.sessionMessage.count({ where: { sessionId: session.id, localId } })).resolves.toBe(1);
        await expect(db.sessionPendingMessage.count({ where: { sessionId: session.id, localId } })).resolves.toBe(0);
        await expect(db.session.findUniqueOrThrow({
            where: { id: session.id },
            select: { pendingCount: true, pendingBlockedCount: true },
        })).resolves.toEqual({ pendingCount: 0, pendingBlockedCount: 0 });
    });

    it("rejects accepted provider delivery when neither a pending row nor a committed legacy message exists", async () => {
        const owner = await createAccount("owner");
        const session = await createSession(owner.id);
        const localId = `provider-delivery-missing-${randomUUID()}`;

        const accepted = await resolveAcceptedPendingDelivery({ actorUserId: owner.id, sessionId: session.id, localId });
        expect(accepted.ok).toBe(false);
        if (accepted.ok) throw new Error("expected accepted resolution rejection");
        expect(accepted.error).toBe("not-found");
    });

    it("treats accepted provider delivery as idempotent when the pending row is gone but a committed legacy message exists", async () => {
        const owner = await createAccount("owner");
        const session = await createSession(owner.id);
        const localId = `provider-delivery-legacy-${randomUUID()}`;

        await db.sessionMessage.create({
            data: {
                sessionId: session.id,
                localId,
                seq: 1,
                messageRole: "user",
                content: { t: "encrypted", c: "cipher-provider-delivery-legacy" },
            },
        });

        const accepted = await resolveAcceptedPendingDelivery({ actorUserId: owner.id, sessionId: session.id, localId });
        expect(accepted.ok).toBe(true);
        if (!accepted.ok) throw new Error("expected accepted resolution to be idempotent");
        expect(accepted.didResolve).toBe(false);
        expect(accepted.pendingCount).toBe(0);
    });

    it("does not resolve a later provider-delivery claim while an earlier claim is unresolved", async () => {
        const owner = await createAccount("owner");
        const session = await createSession(owner.id);
        const firstLocalId = `provider-delivery-order-first-${randomUUID()}`;
        const secondLocalId = `provider-delivery-order-second-${randomUUID()}`;

        await expect(enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId: firstLocalId,
            ciphertext: "cipher-provider-delivery-order-first",
        })).resolves.toMatchObject({ ok: true });
        await expect(enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId: secondLocalId,
            ciphertext: "cipher-provider-delivery-order-second",
        })).resolves.toMatchObject({ ok: true });

        const firstClaim = await materializeNextPendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            deliveryState: "provider",
        });
        expect(firstClaim.ok).toBe(true);
        if (!firstClaim.ok || !firstClaim.didMaterialize) throw new Error("expected first claim");
        expect(firstClaim.message.localId).toBe(firstLocalId);

        const secondClaim = await materializeNextPendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            deliveryState: "provider",
        });
        expect(secondClaim.ok).toBe(true);
        if (!secondClaim.ok || !secondClaim.didMaterialize) throw new Error("expected second claim");
        expect(secondClaim.message.localId).toBe(secondLocalId);

        const secondAcceptedFirst = await resolveAcceptedPendingDelivery({
            actorUserId: owner.id,
            sessionId: session.id,
            localId: secondLocalId,
        });
        expect(secondAcceptedFirst.ok).toBe(false);
        if (secondAcceptedFirst.ok) throw new Error("expected ordering rejection");
        expect(secondAcceptedFirst.error).toBe("blocked-by-earlier-pending");
        await expect(db.sessionMessage.count({ where: { sessionId: session.id, localId: secondLocalId } })).resolves.toBe(0);

        const firstAccepted = await resolveAcceptedPendingDelivery({
            actorUserId: owner.id,
            sessionId: session.id,
            localId: firstLocalId,
        });
        expect(firstAccepted.ok).toBe(true);
        if (!firstAccepted.ok || !firstAccepted.didResolve) throw new Error("expected first accept");

        const secondAccepted = await resolveAcceptedPendingDelivery({
            actorUserId: owner.id,
            sessionId: session.id,
            localId: secondLocalId,
        });
        expect(secondAccepted.ok).toBe(true);
        if (!secondAccepted.ok || !secondAccepted.didResolve) throw new Error("expected second accept");

        await expect(db.sessionMessage.findMany({
            where: { sessionId: session.id },
            orderBy: { seq: "asc" },
            select: { localId: true },
        })).resolves.toEqual([
            { localId: firstLocalId },
            { localId: secondLocalId },
        ]);
    });

    it("materializes a concurrently claimed queued row idempotently", async () => {
        const owner = await createAccount("owner");
        const session = await createSession(owner.id);
        const localId = `race-${randomUUID()}`;

        const enqueue = await enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            ciphertext: "cipher-race",
        });
        expect(enqueue.ok).toBe(true);

        const results = await Promise.all([
            materializeNextPendingMessage({ actorUserId: owner.id, sessionId: session.id }),
            materializeNextPendingMessage({ actorUserId: owner.id, sessionId: session.id }),
        ]);

        expect(results.every((result) => result.ok)).toBe(true);
        expect(results.filter((result) => result.ok && result.didMaterialize).length).toBe(1);
        expect(results.filter((result) => result.ok && !result.didMaterialize).length).toBe(1);
        await expect(db.sessionMessage.count({ where: { sessionId: session.id, localId } })).resolves.toBe(1);
        await expect(db.sessionPendingMessage.count({ where: { sessionId: session.id, localId } })).resolves.toBe(0);

        const after = await db.session.findUniqueOrThrow({
            where: { id: session.id },
            select: { pendingCount: true },
        });
        expect(after.pendingCount).toBe(0);
    });

    it("claims a provider-delivery row at most once under concurrent materialization", async () => {
        const owner = await createAccount("owner");
        const session = await createSession(owner.id);
        const localId = `provider-race-${randomUUID()}`;

        await expect(enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            ciphertext: "cipher-provider-race",
        })).resolves.toMatchObject({ ok: true });

        const results = await Promise.all([
            materializeNextPendingMessage({ actorUserId: owner.id, sessionId: session.id, deliveryState: "provider" }),
            materializeNextPendingMessage({ actorUserId: owner.id, sessionId: session.id, deliveryState: "provider" }),
        ]);

        expect(results.every((result) => result.ok)).toBe(true);
        expect(results.filter((result) => result.ok && result.didMaterialize).length).toBe(1);
        expect(results.filter((result) => result.ok && !result.didMaterialize).length).toBe(1);
        const materialized = results.find((result) => result.ok && result.didMaterialize);
        if (!materialized?.ok || !materialized.didMaterialize) throw new Error("expected provider delivery claim");
        expect(materialized.didWriteMessage).toBe(false);
        expect(materialized.message).toEqual(expect.objectContaining({
            id: null,
            seq: null,
            localId,
            content: { t: "encrypted", c: "cipher-provider-race" },
        }));
        await expect(db.sessionMessage.count({ where: { sessionId: session.id, localId } })).resolves.toBe(0);
        await expect(db.sessionPendingMessage.findUniqueOrThrow({
            where: { sessionId_localId: { sessionId: session.id, localId } },
            select: { status: true, deliveryState: true, deliveryBlockedReason: true },
        })).resolves.toEqual({
            status: "queued",
            deliveryState: "delivering",
            deliveryBlockedReason: null,
        });
        await expect(db.session.findUniqueOrThrow({
            where: { id: session.id },
            select: { pendingCount: true, pendingBlockedCount: true },
        })).resolves.toEqual({ pendingCount: 1, pendingBlockedCount: 0 });
    });

    it("clamps pendingCount when discarding a queued message after the counter is already 0", async () => {
        const owner = await createAccount("owner");
        const session = await createSession(owner.id);

        const localId = `a-${randomUUID()}`;
        const enqueue = await enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            ciphertext: "cipher-a-1",
        });
        expect(enqueue.ok).toBe(true);

        await db.session.update({ where: { id: session.id }, data: { pendingCount: 0 } });
        const before = await db.session.findUniqueOrThrow({
            where: { id: session.id },
            select: { pendingCount: true, pendingVersion: true },
        });
        expect(before.pendingCount).toBe(0);

        const discard = await discardPendingMessage({ actorUserId: owner.id, sessionId: session.id, localId, reason: "test" });
        expect(discard.ok).toBe(true);
        if (!discard.ok) throw new Error("expected discard to succeed");
        expect(discard.pendingCount).toBe(0);
        expect(discard.pendingVersion).toBe(before.pendingVersion + 1);

        const after = await db.session.findUniqueOrThrow({
            where: { id: session.id },
            select: { pendingCount: true, pendingVersion: true },
        });
        expect(after.pendingCount).toBe(0);
        expect(after.pendingVersion).toBe(before.pendingVersion + 1);
    });

    it("discards a delivering provider-owned pending row", async () => {
        const owner = await createAccount("owner");
        const session = await createSession(owner.id);
        const localId = `provider-discard-delivering-${randomUUID()}`;

        await expect(enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            ciphertext: "cipher-provider-discard-delivering",
        })).resolves.toMatchObject({ ok: true });

        const materialized = await materializeNextPendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            deliveryState: "provider",
        });
        expect(materialized.ok).toBe(true);
        if (!materialized.ok || !materialized.didMaterialize) throw new Error("expected materialized provider claim");
        expect(materialized.didWriteMessage).toBe(false);
        const beforeDiscard = await db.session.findUniqueOrThrow({
            where: { id: session.id },
            select: { pendingCount: true, pendingBlockedCount: true, pendingVersion: true },
        });
        await expect(db.sessionPendingMessage.findUnique({
            where: { sessionId_localId: { sessionId: session.id, localId } },
            select: { status: true, deliveryState: true },
        })).resolves.toEqual({ status: "queued", deliveryState: "delivering" });

        const discard = await discardPendingMessage({ actorUserId: owner.id, sessionId: session.id, localId, reason: "test" });
        expect(discard.ok).toBe(true);
        if (!discard.ok) throw new Error("expected discard to succeed");
        expect(discard.pendingCount).toBe(beforeDiscard.pendingCount - 1);
        expect(discard.pendingBlockedCount).toBe(beforeDiscard.pendingBlockedCount);
        expect(discard.pendingVersion).toBe(beforeDiscard.pendingVersion + 1);

        await expect(db.sessionPendingMessage.findUnique({
            where: { sessionId_localId: { sessionId: session.id, localId } },
            select: { status: true, deliveryState: true, discardedReason: true },
        })).resolves.toEqual({
            status: "discarded",
            deliveryState: null,
            discardedReason: "test",
        });
        await expect(db.sessionMessage.count({ where: { sessionId: session.id, localId } })).resolves.toBe(0);
    });

    it("deletes a delivering provider-owned pending row", async () => {
        const owner = await createAccount("owner");
        const session = await createSession(owner.id);
        const localId = `provider-delete-delivering-${randomUUID()}`;

        await expect(enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            ciphertext: "cipher-provider-delete-delivering",
        })).resolves.toMatchObject({ ok: true });

        const materialized = await materializeNextPendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            deliveryState: "provider",
        });
        expect(materialized.ok).toBe(true);
        if (!materialized.ok || !materialized.didMaterialize) throw new Error("expected materialized provider claim");
        expect(materialized.didWriteMessage).toBe(false);

        const beforeDelete = await db.session.findUniqueOrThrow({
            where: { id: session.id },
            select: { pendingCount: true, pendingBlockedCount: true, pendingVersion: true },
        });

        const deleted = await deletePendingMessage({ actorUserId: owner.id, sessionId: session.id, localId });
        expect(deleted.ok).toBe(true);
        if (!deleted.ok) throw new Error("expected delete to succeed");
        expect(deleted.pendingCount).toBe(beforeDelete.pendingCount - 1);
        expect(deleted.pendingBlockedCount).toBe(beforeDelete.pendingBlockedCount);
        expect(deleted.pendingVersion).toBe(beforeDelete.pendingVersion + 1);

        await expect(db.sessionPendingMessage.findUnique({
            where: { sessionId_localId: { sessionId: session.id, localId } },
        })).resolves.toBeNull();
        await expect(db.sessionMessage.count({ where: { sessionId: session.id, localId } })).resolves.toBe(0);
    });

    it("forbids view-only participants from mutating pending (but allows listing)", async () => {
        const owner = await createAccount("owner");
        const viewer = await createAccount("viewer");
        const session = await createSession(owner.id);

        await shareSession({
            sessionId: session.id,
            ownerId: owner.id,
            participantId: viewer.id,
            accessLevel: "view",
        });

        const localId = `a-${randomUUID()}`;
        const enqueueOwner = await enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            ciphertext: "cipher-a-1",
        });
        expect(enqueueOwner.ok).toBe(true);

        const list = await listPendingMessages({ actorUserId: viewer.id, sessionId: session.id, includeDiscarded: true });
        expect(list.ok).toBe(true);

        const enqueueViewer = await enqueuePendingMessage({
            actorUserId: viewer.id,
            sessionId: session.id,
            localId: `v-${randomUUID()}`,
            ciphertext: "cipher-view",
        });
        expect(enqueueViewer.ok).toBe(false);
        if (enqueueViewer.ok) throw new Error("expected forbidden");
        expect(enqueueViewer.error).toBe("forbidden");

        const edit = await updatePendingMessage({
            actorUserId: viewer.id,
            sessionId: session.id,
            localId,
            ciphertext: "cipher-a-2",
        });
        expect(edit.ok).toBe(false);
        if (edit.ok) throw new Error("expected forbidden");
        expect(edit.error).toBe("forbidden");

        const reorder = await reorderPendingMessages({ actorUserId: viewer.id, sessionId: session.id, orderedLocalIds: [localId] });
        expect(reorder.ok).toBe(false);
        if (reorder.ok) throw new Error("expected forbidden");
        expect(reorder.error).toBe("forbidden");

        const discard = await discardPendingMessage({ actorUserId: viewer.id, sessionId: session.id, localId, reason: "test" });
        expect(discard.ok).toBe(false);
        if (discard.ok) throw new Error("expected forbidden");
        expect(discard.error).toBe("forbidden");

        const block = await blockPendingDelivery({
            actorUserId: viewer.id,
            sessionId: session.id,
            localId,
            reason: "terminal_composer_draft",
        });
        expect(block.ok).toBe(false);
        if (block.ok) throw new Error("expected forbidden");
        expect(block.error).toBe("forbidden");

        const retry = await retryPendingDelivery({ actorUserId: viewer.id, sessionId: session.id, localId });
        expect(retry.ok).toBe(false);
        if (retry.ok) throw new Error("expected forbidden");
        expect(retry.error).toBe("forbidden");

        const handled = await markPendingDeliveryHandled({ actorUserId: viewer.id, sessionId: session.id, localId });
        expect(handled.ok).toBe(false);
        if (handled.ok) throw new Error("expected forbidden");
        expect(handled.error).toBe("forbidden");

        const restore = await restorePendingMessage({ actorUserId: viewer.id, sessionId: session.id, localId });
        expect(restore.ok).toBe(false);
        if (restore.ok) throw new Error("expected forbidden");
        expect(restore.error).toBe("forbidden");

        const del = await deletePendingMessage({ actorUserId: viewer.id, sessionId: session.id, localId });
        expect(del.ok).toBe(false);
        if (del.ok) throw new Error("expected forbidden");
        expect(del.error).toBe("forbidden");
    });

    it("treats deletePendingMessage as a no-op when the localId does not exist", async () => {
        const owner = await createAccount("owner");
        const session = await createSession(owner.id, { id: true, pendingVersion: true, pendingCount: true });

        const localId = `missing-${randomUUID()}`;
        const res = await deletePendingMessage({ actorUserId: owner.id, sessionId: session.id, localId });
        expect(res.ok).toBe(true);
        if (!res.ok) throw new Error("expected ok");
        expect(res.pendingVersion).toBe(session.pendingVersion);
        expect(res.pendingCount).toBe(session.pendingCount);
        expect(res.participantCursors).toEqual([]);

        const after = await db.session.findUnique({
            where: { id: session.id },
            select: { pendingVersion: true, pendingCount: true },
        });
        expect(after?.pendingVersion).toBe(session.pendingVersion);
        expect(after?.pendingCount).toBe(session.pendingCount);
    });

    it("treats discardPendingMessage as a no-op when message is already discarded", async () => {
        const owner = await createAccount("owner");
        const session = await createSession(owner.id);

        const localId = `a-${randomUUID()}`;
        const enqueue = await enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            ciphertext: "cipher-a-1",
        });
        expect(enqueue.ok).toBe(true);
        if (!enqueue.ok) throw new Error("expected enqueue to succeed");

        const firstDiscard = await discardPendingMessage({ actorUserId: owner.id, sessionId: session.id, localId, reason: "test" });
        expect(firstDiscard.ok).toBe(true);
        if (!firstDiscard.ok) throw new Error("expected first discard to succeed");

        const beforeSecondDiscard = await db.session.findUniqueOrThrow({
            where: { id: session.id },
            select: { pendingVersion: true, pendingCount: true },
        });

        const secondDiscard = await discardPendingMessage({ actorUserId: owner.id, sessionId: session.id, localId, reason: "test-2" });
        expect(secondDiscard.ok).toBe(true);
        if (!secondDiscard.ok) throw new Error("expected second discard to succeed");
        expect(secondDiscard.pendingVersion).toBe(beforeSecondDiscard.pendingVersion);
        expect(secondDiscard.pendingCount).toBe(beforeSecondDiscard.pendingCount);
        expect(secondDiscard.participantCursors).toEqual([]);

        const afterSecondDiscard = await db.session.findUniqueOrThrow({
            where: { id: session.id },
            select: { pendingVersion: true, pendingCount: true },
        });
        expect(afterSecondDiscard.pendingVersion).toBe(beforeSecondDiscard.pendingVersion);
        expect(afterSecondDiscard.pendingCount).toBe(beforeSecondDiscard.pendingCount);
    });

    it("treats non-participants as session-not-found", async () => {
        const owner = await createAccount("owner");
        const stranger = await createAccount("stranger");
        const session = await createSession(owner.id);

        const list = await listPendingMessages({ actorUserId: stranger.id, sessionId: session.id, includeDiscarded: true });
        expect(list.ok).toBe(false);
        if (list.ok) throw new Error("expected session-not-found");
        expect(list.error).toBe("session-not-found");
    });
});
