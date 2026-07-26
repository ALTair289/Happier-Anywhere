import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createSessionPublisherPresence } from "@/app/presence/sessionPublisherPresence";
import { enqueuePendingMessage } from "@/app/session/pending/pendingMessageService";
import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { createFakeSocket, getSocketHandler } from "../testkit/socketHarness";

import { sessionUpdateHandler } from "./sessionUpdateHandler";

describe("accepted Pending settlement publisher replacement race on SQLite", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-accepted-settlement-publisher-race-",
            initAuth: false,
            initEncrypt: false,
            initFiles: false,
        });
    });
    beforeEach(() => harness.resetEnv());
    afterAll(async () => await harness.close());

    it("fails closed when a successor publisher commits after handler prevalidation and before settlement CAS", async () => {
        const owner = await db.account.create({
            data: { publicKey: `pk-${randomUUID()}` },
            select: { id: true },
        });
        const session = await db.session.create({
            data: {
                tag: `session-${randomUUID()}`,
                accountId: owner.id,
                metadata: "{}",
                metadataVersion: 0,
                agentState: null,
                agentStateVersion: 0,
            },
            select: { id: true },
        });
        const machineId = `machine-${randomUUID()}`;
        await db.machine.create({ data: { id: machineId, accountId: owner.id, metadata: "{}" } });
        await db.accessKey.create({
            data: { accountId: owner.id, machineId, sessionId: session.id, data: "encrypted" },
        });
        const localId = `pending-${randomUUID()}`;
        await enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            ciphertext: "ciphertext",
            requestedAction: { v: 1, kind: "enqueue" },
        });
        await db.sessionPendingMessage.update({
            where: { sessionId_localId: { sessionId: session.id, localId } },
            data: { deliveryState: "delivering", providerAction: "send" },
        });

        let nowMs = new Date("2026-07-19T10:00:00.000Z").getTime();
        const presence = createSessionPublisherPresence({ now: () => new Date(nowMs++) });
        const predecessorSocket = createFakeSocket({
            id: "predecessor-socket",
            data: {
                clientType: "session-scoped",
                sessionScopedBinding: {
                    sessionId: session.id,
                    machineId,
                    proof: "machine-access-key",
                },
            },
        });
        const successorSocket = createFakeSocket({ id: "successor-socket" });
        const binding = { accountId: owner.id, machineId, sessionId: session.id };
        const registered = await presence.registerPublisher({
            socket: predecessorSocket,
            binding,
            completeActivitySnapshot: { state: "idle", activeCount: 0 },
        });
        expect(registered.status).toBe("registered");

        let replacementBaseline: { status: string; deliveryState: string | null; deliveryBlockedReason: string | null } | null = null;
        const racingPresence = {
            resolveCurrentPublisher: presence.resolveCurrentPublisher,
            runAsCurrentPublisher: async <T>(params: Parameters<typeof presence.runAsCurrentPublisher<T>>[0]) => (
                await presence.runAsCurrentPublisher({
                    ...params,
                    action: async (publisher) => {
                        const replacement = await presence.registerPublisher({
                            socket: successorSocket,
                            binding,
                            completeActivitySnapshot: { state: "active", activeCount: 1 },
                        });
                        expect(replacement.status).toBe("registered");
                        replacementBaseline = await db.sessionPendingMessage.findUniqueOrThrow({
                            where: { sessionId_localId: { sessionId: session.id, localId } },
                            select: { status: true, deliveryState: true, deliveryBlockedReason: true },
                        });
                        return await params.action(publisher);
                    },
                })
            ),
        };
        const connection = {
            connectionType: "session-scoped",
            socket: predecessorSocket,
            userId: owner.id,
            sessionId: session.id,
        } as any;
        sessionUpdateHandler(owner.id, predecessorSocket as any, connection, {
            presence: racingPresence,
            binding,
        });
        const callback = vi.fn();

        await getSocketHandler(predecessorSocket, "pending-delivery-accepted-v1")({
            v: 1,
            sessionId: session.id,
            localId,
        }, callback);

        expect(callback).toHaveBeenCalledWith({ ok: false, error: "forbidden" });
        expect(replacementBaseline).not.toBeNull();
        await expect(db.sessionPendingMessage.findUnique({
            where: { sessionId_localId: { sessionId: session.id, localId } },
            select: { status: true, deliveryState: true, deliveryBlockedReason: true },
        })).resolves.toEqual(replacementBaseline);
        await expect(db.sessionMessage.count({ where: { sessionId: session.id, localId } })).resolves.toBe(0);
    });
});
