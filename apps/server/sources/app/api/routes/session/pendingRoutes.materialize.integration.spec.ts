import { beforeEach, describe, expect, it, vi } from "vitest";

import { createRouteTestBuilder } from "../../testkit/routeTestBuilder";

const emitUpdate = vi.fn();
const buildNewMessageUpdate = vi.fn(() => ({ type: "new-message" }));
const buildMessageUpdatedUpdate = vi.fn(() => ({ type: "message-updated" }));
const buildPendingChangedUpdate = vi.fn(() => ({ type: "pending-changed" }));
const buildUpdateSessionUpdate = vi.fn(() => ({ type: "update-session" }));
const getSessionParticipantUserIds = vi.fn(async () => ["u1"]);
const markAccountChanged = vi.fn(async () => 10);
const refreshSessionParticipantBadgePushes = vi.fn(async () => {});

const materializeNextPendingMessage = vi.fn();
const listPendingMessages = vi.fn();
const resolveAcceptedPendingDelivery = vi.fn();
const reconcileAcceptedPendingDeliveriesThroughSeq = vi.fn();
const blockPendingDeliveriesOnProviderAttach = vi.fn();
const blockPendingDelivery = vi.fn();
const retryPendingDelivery = vi.fn();
const markPendingDeliveryHandled = vi.fn();
const updatePendingMessage = vi.fn();

vi.mock("@/app/events/eventRouter", () => ({
    eventRouter: { emitUpdate },
    buildNewMessageUpdate,
    buildMessageUpdatedUpdate,
    buildPendingChangedUpdate,
    buildUpdateSessionUpdate,
}));

vi.mock("@/utils/keys/randomKeyNaked", () => ({ randomKeyNaked: () => "k" }));
vi.mock("@/app/share/sessionParticipants", () => ({ getSessionParticipantUserIds }));
vi.mock("@/app/changes/markAccountChanged", () => ({ markAccountChanged }));
vi.mock("@/app/activity/refreshAccountActivityBadgePushes", () => ({ refreshSessionParticipantBadgePushes }));
vi.mock("@/storage/inTx", () => ({
    inTx: vi.fn(async (fn: (tx: unknown) => unknown) => await fn({})),
}));

vi.mock("@/app/session/pending/pendingMessageService", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@/app/session/pending/pendingMessageService")>();
    return {
        ...actual,
        listPendingMessages,
        materializeNextPendingMessage,
        resolveAcceptedPendingDelivery,
        reconcileAcceptedPendingDeliveriesThroughSeq,
        blockPendingDeliveriesOnProviderAttach,
        blockPendingDelivery,
        retryPendingDelivery,
        markPendingDeliveryHandled,
        updatePendingMessage,
    };
});

describe("sessionPendingRoutes (materialize-next)", () => {
    beforeEach(() => {
        vi.resetModules();
        emitUpdate.mockReset();
        buildNewMessageUpdate.mockClear();
        buildMessageUpdatedUpdate.mockClear();
        buildPendingChangedUpdate.mockClear();
        buildUpdateSessionUpdate.mockClear();
        getSessionParticipantUserIds.mockReset();
        getSessionParticipantUserIds.mockResolvedValue(["u1"]);
        markAccountChanged.mockReset();
        markAccountChanged.mockResolvedValue(10);
        refreshSessionParticipantBadgePushes.mockReset();
        refreshSessionParticipantBadgePushes.mockResolvedValue(undefined);
        materializeNextPendingMessage.mockReset();
        listPendingMessages.mockReset();
        resolveAcceptedPendingDelivery.mockReset();
        reconcileAcceptedPendingDeliveriesThroughSeq.mockReset();
        blockPendingDeliveriesOnProviderAttach.mockReset();
        blockPendingDelivery.mockReset();
        retryPendingDelivery.mockReset();
        markPendingDeliveryHandled.mockReset();
        updatePendingMessage.mockReset();
    });

    it("projects typed deliveryStatus in pending GET responses while retaining raw delivery fields", async () => {
        const createdAt = new Date(1_000);
        const updatedAt = new Date(2_000);
        listPendingMessages.mockResolvedValueOnce({
            ok: true,
            pending: [
                {
                    localId: "l-blocked",
                    messageRole: "user",
                    content: { t: "plain", v: { role: "user", content: { type: "text", text: "hello" } } },
                    status: "queued",
                    deliveryState: "blocked",
                    deliveryBlockedReason: "terminal_composer_draft",
                    deliveryStatus: { status: "blocked", reason: "terminal_composer_draft" },
                    position: 1,
                    createdAt,
                    updatedAt,
                    discardedAt: null,
                    discardedReason: null,
                    authorAccountId: "actor",
                },
            ],
        });

        const { sessionPendingRoutes } = await import("./pendingRoutes");
        const route = createRouteTestBuilder({
            method: "GET",
            path: "/v2/sessions/:sessionId/pending",
            registerRoutes(app) {
                sessionPendingRoutes(app as any);
            },
        });
        const { response: res } = await route.invoke({
            userId: "actor",
            params: { sessionId: "s1" },
        });

        expect(listPendingMessages).toHaveBeenCalledWith({
            actorUserId: "actor",
            sessionId: "s1",
            includeDiscarded: false,
        });
        expect(res).toEqual({
            pending: [
                expect.objectContaining({
                    localId: "l-blocked",
                    status: "queued",
                    deliveryState: "blocked",
                    deliveryBlockedReason: "terminal_composer_draft",
                    deliveryStatus: { status: "blocked", reason: "terminal_composer_draft" },
                }),
            ],
        });
    });

    it("emits new-message and pending-changed updates on successful materialization", async () => {
        materializeNextPendingMessage.mockResolvedValueOnce({
            ok: true,
            didMaterialize: true,
            didWriteMessage: true,
            message: { id: "m1", seq: 1, localId: "l1", messageRole: "user", content: { t: "plain", v: { role: "user", content: { type: "text", text: "hello" } } }, createdAt: new Date(1_000), updatedAt: new Date(1_000) },
            pendingCount: 0,
            pendingVersion: 2,
            participantCursorsMessage: [
                { accountId: "u1", cursor: 10 },
                { accountId: "u2", cursor: 11 },
            ],
            participantCursorsPending: [
                { accountId: "u1", cursor: 20 },
                { accountId: "u2", cursor: 21 },
            ],
        });

        const { sessionPendingRoutes } = await import("./pendingRoutes");
        const route = createRouteTestBuilder({
            method: "POST",
            path: "/v2/sessions/:sessionId/pending/materialize-next",
            registerRoutes(app) {
                sessionPendingRoutes(app as any);
            },
        });
        const { response: res } = await route.invoke({ userId: "actor", params: { sessionId: "s1" } });

        expect(res).toEqual({
            ok: true,
            didMaterialize: true,
            didWriteMessage: true,
            pendingCount: 0,
            pendingVersion: 2,
            message: { id: "m1", seq: 1, localId: "l1", messageRole: "user", content: { t: "plain", v: { role: "user", content: { type: "text", text: "hello" } } }, createdAt: 1_000, updatedAt: 1_000 },
        });

        expect(buildNewMessageUpdate).toHaveBeenCalledTimes(2);
        expect(buildPendingChangedUpdate).toHaveBeenCalledTimes(2);
        expect(buildPendingChangedUpdate).toHaveBeenNthCalledWith(
            1,
            expect.objectContaining({ meaningfulActivityAt: new Date(1_000) }),
            20,
            "k",
        );
        expect(buildPendingChangedUpdate).toHaveBeenNthCalledWith(
            2,
            expect.objectContaining({ meaningfulActivityAt: new Date(1_000) }),
            21,
            "k",
        );
        expect(buildUpdateSessionUpdate).not.toHaveBeenCalled();
        expect(emitUpdate).toHaveBeenCalledTimes(4);
    });

    it("returns pending state when there is no pending message to materialize", async () => {
        materializeNextPendingMessage.mockResolvedValueOnce({
            ok: true,
            didMaterialize: false,
            pendingCount: 0,
            pendingVersion: 5,
        });

        const { sessionPendingRoutes } = await import("./pendingRoutes");
        const route = createRouteTestBuilder({
            method: "POST",
            path: "/v2/sessions/:sessionId/pending/materialize-next",
            registerRoutes(app) {
                sessionPendingRoutes(app as any);
            },
        });
        const { response: res } = await route.invoke({ userId: "actor", params: { sessionId: "s1" } });

        expect(res).toEqual({ ok: true, didMaterialize: false, pendingCount: 0, pendingVersion: 5 });
        expect(emitUpdate).not.toHaveBeenCalled();
    });

    it("passes runtime-idle delivery timing through materialize-next", async () => {
        materializeNextPendingMessage.mockResolvedValueOnce({
            ok: true,
            didMaterialize: false,
            pendingCount: 1,
            pendingBlockedCount: 0,
            pendingVersion: 6,
            deferredReason: "runtime_activity_active",
        });

        const { sessionPendingRoutes } = await import("./pendingRoutes");
        const route = createRouteTestBuilder({
            method: "POST",
            path: "/v2/sessions/:sessionId/pending/materialize-next",
            registerRoutes(app) {
                sessionPendingRoutes(app as any);
            },
        });
        const { response: res } = await route.invoke({
            userId: "actor",
            params: { sessionId: "s1" },
            body: { deliveryTiming: "after_runtime_idle" },
        });

        expect(materializeNextPendingMessage).toHaveBeenCalledWith({
            actorUserId: "actor",
            sessionId: "s1",
            deliveryTiming: "after_runtime_idle",
        });
        expect(res).toEqual({
            ok: true,
            didMaterialize: false,
            pendingCount: 1,
            pendingBlockedCount: 0,
            pendingVersion: 6,
            deferredReason: "runtime_activity_active",
        });
    });

    it("rejects legacy materialization when the transcript row conflicts with pending content", async () => {
        materializeNextPendingMessage.mockResolvedValueOnce({ ok: false, error: "transcript-conflict" });

        const { sessionPendingRoutes } = await import("./pendingRoutes");
        const route = createRouteTestBuilder({
            method: "POST",
            path: "/v2/sessions/:sessionId/pending/materialize-next",
            registerRoutes(app) {
                sessionPendingRoutes(app as any);
            },
        });
        const { reply, response: res } = await route.invoke({
            userId: "actor",
            params: { sessionId: "s1" },
        });

        expect(reply.statusCode).toBe(409);
        expect(res).toEqual({ error: "transcript-conflict" });
        expect(emitUpdate).not.toHaveBeenCalled();
    });

    it("emits pending-changed when materialization blocks stale provider delivery without writing a message", async () => {
        materializeNextPendingMessage.mockResolvedValueOnce({
            ok: true,
            didMaterialize: false,
            pendingCount: 1,
            pendingBlockedCount: 1,
            pendingVersion: 8,
            pendingStateChanged: true,
            participantCursorsPending: [{ accountId: "u1", cursor: 30 }],
            badgeAttentionChanged: true,
            deliveryState: { mode: "provider", unresolved: false },
        });

        const { sessionPendingRoutes } = await import("./pendingRoutes");
        const route = createRouteTestBuilder({
            method: "POST",
            path: "/v2/sessions/:sessionId/pending/materialize-next",
            registerRoutes(app) {
                sessionPendingRoutes(app as any);
            },
        });
        const { response: res } = await route.invoke({
            userId: "actor",
            params: { sessionId: "s1" },
            body: { deliveryState: "provider" },
        });

        expect(res).toEqual({
            ok: true,
            didMaterialize: false,
            pendingCount: 1,
            pendingBlockedCount: 1,
            pendingVersion: 8,
            deliveryState: { mode: "provider", unresolved: false },
        });
        expect(buildPendingChangedUpdate).toHaveBeenCalledWith(
            expect.objectContaining({
                sessionId: "s1",
                pendingCount: 1,
                pendingBlockedCount: 1,
                pendingVersion: 8,
                changedByAccountId: "actor",
            }),
            30,
            "k",
        );
        expect(refreshSessionParticipantBadgePushes).toHaveBeenCalledWith({
            badgeAttentionChanged: true,
            participantCursors: [{ accountId: "u1", cursor: 30 }],
        });
        expect(emitUpdate).toHaveBeenCalledTimes(1);
    });

    it("maps stale pending update races to a client-safe not-found response", async () => {
        updatePendingMessage.mockResolvedValueOnce({ ok: false, error: "not-found" });

        const { sessionPendingRoutes } = await import("./pendingRoutes");
        const route = createRouteTestBuilder({
            method: "PATCH",
            path: "/v2/sessions/:sessionId/pending/:localId",
            registerRoutes(app) {
                sessionPendingRoutes(app as any);
            },
        });
        const { reply, response: res } = await route.invoke({
            userId: "actor",
            params: { sessionId: "s1", localId: "missing-local" },
            body: { ciphertext: "cipher-updated" },
        });

        expect(reply.statusCode).toBe(404);
        expect(res).toEqual({ error: "not-found" });
        expect(emitUpdate).not.toHaveBeenCalled();
    });

    it("passes provider delivery-state opt-in without changing the legacy default", async () => {
        materializeNextPendingMessage.mockResolvedValueOnce({
            ok: true,
            didMaterialize: true,
            didWriteMessage: false,
            message: {
                id: null,
                seq: null,
                localId: "l-provider",
                messageRole: "user",
                content: { t: "plain", v: { role: "user", content: { type: "text", text: "hello" } } },
                createdAt: new Date(1_000),
                updatedAt: new Date(1_000),
            },
            pendingCount: 1,
            pendingVersion: 2,
            deliveryState: {
                mode: "provider",
                unresolved: true,
            },
            participantCursorsMessage: [],
            participantCursorsPending: [],
            badgeAttentionChanged: false,
        });

        const { sessionPendingRoutes } = await import("./pendingRoutes");
        const route = createRouteTestBuilder({
            method: "POST",
            path: "/v2/sessions/:sessionId/pending/materialize-next",
            registerRoutes(app) {
                sessionPendingRoutes(app as any);
            },
        });
        const { response: res } = await route.invoke({
            userId: "actor",
            params: { sessionId: "s1" },
            body: { deliveryState: "provider" },
        });

        expect(materializeNextPendingMessage).toHaveBeenCalledWith({
            actorUserId: "actor",
            sessionId: "s1",
            deliveryState: "provider",
        });
        expect(res).toEqual(expect.objectContaining({
            ok: true,
            didMaterialize: true,
            didWriteMessage: false,
            pendingCount: 1,
            pendingVersion: 2,
            deliveryState: {
                mode: "provider",
                unresolved: true,
            },
            message: expect.objectContaining({
                id: null,
                seq: null,
                localId: "l-provider",
            }),
        }));
        expect(buildNewMessageUpdate).not.toHaveBeenCalled();
    });

    it("resolves accepted provider delivery through a dedicated pending operation", async () => {
        resolveAcceptedPendingDelivery.mockResolvedValueOnce({
            ok: true,
            didResolve: true,
            message: {
                id: "m-provider-accepted",
                seq: 12,
                localId: "l-provider",
                messageRole: "user",
                content: { t: "plain", v: { role: "user", content: { type: "text", text: "hello" } } },
                createdAt: new Date(2_000),
                updatedAt: new Date(2_000),
            },
            pendingCount: 0,
            pendingVersion: 3,
            participantCursorsMessage: [
                { accountId: "u1", cursor: 25 },
                { accountId: "u2", cursor: 26 },
            ],
            participantCursorsPending: [
                { accountId: "u1", cursor: 30 },
                { accountId: "u2", cursor: 31 },
            ],
            badgeAttentionChanged: true,
        });

        const { sessionPendingRoutes } = await import("./pendingRoutes");
        const route = createRouteTestBuilder({
            method: "POST",
            path: "/v2/sessions/:sessionId/pending/:localId/delivery/accepted",
            registerRoutes(app) {
                sessionPendingRoutes(app as any);
            },
        });
        const { response: res } = await route.invoke({
            userId: "actor",
            params: { sessionId: "s1", localId: "l-provider" },
        });

        expect(resolveAcceptedPendingDelivery).toHaveBeenCalledWith({
            actorUserId: "actor",
            sessionId: "s1",
            localId: "l-provider",
        });
        expect(res).toEqual({
            ok: true,
            pendingCount: 0,
            pendingVersion: 3,
            message: {
                id: "m-provider-accepted",
                seq: 12,
                localId: "l-provider",
                messageRole: "user",
                content: { t: "plain", v: { role: "user", content: { type: "text", text: "hello" } } },
                createdAt: 2_000,
                updatedAt: 2_000,
            },
        });
        expect(buildNewMessageUpdate).toHaveBeenCalledTimes(2);
        expect(buildMessageUpdatedUpdate).not.toHaveBeenCalled();
        expect(buildPendingChangedUpdate).toHaveBeenCalledTimes(2);
        expect(emitUpdate).toHaveBeenCalledTimes(4);
    });

    it("emits message-updated when accepted provider delivery only updates an existing transcript row", async () => {
        resolveAcceptedPendingDelivery.mockResolvedValueOnce({
            ok: true,
            didResolve: true,
            didWrite: false,
            didUpdate: true,
            message: {
                id: "m-provider-accepted-existing",
                seq: 12,
                localId: "l-provider",
                messageRole: "user",
                content: { t: "plain", v: { role: "user", content: { type: "text", text: "hello" } } },
                createdAt: new Date(2_000),
                updatedAt: new Date(2_100),
            },
            pendingCount: 0,
            pendingVersion: 3,
            participantCursorsMessage: [
                { accountId: "u1", cursor: 25 },
                { accountId: "u2", cursor: 26 },
            ],
            participantCursorsPending: [{ accountId: "u1", cursor: 30 }],
            badgeAttentionChanged: false,
        });

        const { sessionPendingRoutes } = await import("./pendingRoutes");
        const route = createRouteTestBuilder({
            method: "POST",
            path: "/v2/sessions/:sessionId/pending/:localId/delivery/accepted",
            registerRoutes(app) {
                sessionPendingRoutes(app as any);
            },
        });
        const { response: res } = await route.invoke({
            userId: "actor",
            params: { sessionId: "s1", localId: "l-provider" },
        });

        expect(res).toEqual({
            ok: true,
            pendingCount: 0,
            pendingVersion: 3,
            message: {
                id: "m-provider-accepted-existing",
                seq: 12,
                localId: "l-provider",
                messageRole: "user",
                content: { t: "plain", v: { role: "user", content: { type: "text", text: "hello" } } },
                createdAt: 2_000,
                updatedAt: 2_100,
            },
        });
        expect(buildMessageUpdatedUpdate).toHaveBeenCalledTimes(2);
        expect(buildNewMessageUpdate).not.toHaveBeenCalled();
        expect(buildPendingChangedUpdate).toHaveBeenCalledTimes(1);
        expect(emitUpdate).toHaveBeenCalledTimes(3);
    });

    it("rejects accepted provider delivery when the pending row has not been materialized", async () => {
        resolveAcceptedPendingDelivery.mockResolvedValueOnce({ ok: false, error: "not-materialized" });

        const { sessionPendingRoutes } = await import("./pendingRoutes");
        const route = createRouteTestBuilder({
            method: "POST",
            path: "/v2/sessions/:sessionId/pending/:localId/delivery/accepted",
            registerRoutes(app) {
                sessionPendingRoutes(app as any);
            },
        });
        const { reply, response: res } = await route.invoke({
            userId: "actor",
            params: { sessionId: "s1", localId: "l-provider" },
        });

        expect(reply.statusCode).toBe(409);
        expect(res).toEqual({ error: "not-materialized" });
        expect(emitUpdate).not.toHaveBeenCalled();
    });

    it("returns not-found for accepted provider delivery when no pending or committed row matches", async () => {
        resolveAcceptedPendingDelivery.mockResolvedValueOnce({ ok: false, error: "not-found" });

        const { sessionPendingRoutes } = await import("./pendingRoutes");
        const route = createRouteTestBuilder({
            method: "POST",
            path: "/v2/sessions/:sessionId/pending/:localId/delivery/accepted",
            registerRoutes(app) {
                sessionPendingRoutes(app as any);
            },
        });
        const { reply, response: res } = await route.invoke({
            userId: "actor",
            params: { sessionId: "s1", localId: "l-provider-missing" },
        });

        expect(reply.statusCode).toBe(404);
        expect(res).toEqual({ error: "not-found" });
        expect(emitUpdate).not.toHaveBeenCalled();
    });

    it("rejects accepted provider delivery when an earlier pending row is unresolved", async () => {
        resolveAcceptedPendingDelivery.mockResolvedValueOnce({ ok: false, error: "blocked-by-earlier-pending" });

        const { sessionPendingRoutes } = await import("./pendingRoutes");
        const route = createRouteTestBuilder({
            method: "POST",
            path: "/v2/sessions/:sessionId/pending/:localId/delivery/accepted",
            registerRoutes(app) {
                sessionPendingRoutes(app as any);
            },
        });
        const { reply, response: res } = await route.invoke({
            userId: "actor",
            params: { sessionId: "s1", localId: "l-provider-later" },
        });

        expect(reply.statusCode).toBe(409);
        expect(res).toEqual({ error: "blocked-by-earlier-pending" });
        expect(emitUpdate).not.toHaveBeenCalled();
    });

    it("rejects accepted provider delivery when the transcript row conflicts with pending content", async () => {
        resolveAcceptedPendingDelivery.mockResolvedValueOnce({ ok: false, error: "transcript-conflict" });

        const { sessionPendingRoutes } = await import("./pendingRoutes");
        const route = createRouteTestBuilder({
            method: "POST",
            path: "/v2/sessions/:sessionId/pending/:localId/delivery/accepted",
            registerRoutes(app) {
                sessionPendingRoutes(app as any);
            },
        });
        const { reply, response: res } = await route.invoke({
            userId: "actor",
            params: { sessionId: "s1", localId: "l-provider-conflict" },
        });

        expect(reply.statusCode).toBe(409);
        expect(res).toEqual({ error: "transcript-conflict" });
        expect(emitUpdate).not.toHaveBeenCalled();
    });

    it("emits pending-changed when accepted provider delivery blocks on transcript conflict", async () => {
        resolveAcceptedPendingDelivery.mockResolvedValueOnce({
            ok: false,
            error: "transcript-conflict",
            pendingStateChanged: true,
            pendingCount: 1,
            pendingBlockedCount: 1,
            pendingVersion: 8,
            participantCursors: [{ accountId: "u1", cursor: 33 }],
            badgeAttentionChanged: true,
        });

        const { sessionPendingRoutes } = await import("./pendingRoutes");
        const route = createRouteTestBuilder({
            method: "POST",
            path: "/v2/sessions/:sessionId/pending/:localId/delivery/accepted",
            registerRoutes(app) {
                sessionPendingRoutes(app as any);
            },
        });
        const { reply, response: res } = await route.invoke({
            userId: "actor",
            params: { sessionId: "s1", localId: "l-provider-conflict" },
        });

        expect(reply.statusCode).toBe(409);
        expect(res).toEqual({ error: "transcript-conflict" });
        expect(buildPendingChangedUpdate).toHaveBeenCalledWith(
            expect.objectContaining({
                sessionId: "s1",
                pendingCount: 1,
                pendingBlockedCount: 1,
                pendingVersion: 8,
            }),
            33,
            "k",
        );
        expect(emitUpdate).toHaveBeenCalledTimes(1);
        expect(refreshSessionParticipantBadgePushes).toHaveBeenCalledWith({
            badgeAttentionChanged: true,
            participantCursors: [{ accountId: "u1", cursor: 33 }],
        });
    });

    it("reconciles accepted provider deliveries covered by a durable accepted seq", async () => {
        reconcileAcceptedPendingDeliveriesThroughSeq.mockResolvedValueOnce({
            ok: true,
            pendingCount: 0,
            pendingVersion: 4,
            participantCursors: [
                { accountId: "u1", cursor: 35 },
                { accountId: "u2", cursor: 36 },
            ],
            badgeAttentionChanged: true,
            didResolve: true,
            resolvedCount: 2,
            resolvedLocalIds: ["accepted-a", "accepted-b"],
        });

        const { sessionPendingRoutes } = await import("./pendingRoutes");
        const route = createRouteTestBuilder({
            method: "POST",
            path: "/v2/sessions/:sessionId/pending/delivery/accepted-through-seq",
            registerRoutes(app) {
                sessionPendingRoutes(app as any);
            },
        });
        const { response: res } = await route.invoke({
            userId: "actor",
            params: { sessionId: "s1" },
            body: { maxAcceptedSeq: 42 },
        });

        expect(reconcileAcceptedPendingDeliveriesThroughSeq).toHaveBeenCalledWith({
            actorUserId: "actor",
            sessionId: "s1",
            maxAcceptedSeq: 42,
        });
        expect(res).toEqual({
            ok: true,
            pendingCount: 0,
            pendingVersion: 4,
            resolvedCount: 2,
            resolvedLocalIds: ["accepted-a", "accepted-b"],
        });
        expect(buildPendingChangedUpdate).toHaveBeenCalledTimes(2);
        expect(emitUpdate).toHaveBeenCalledTimes(2);
    });

    it("blocks inherited provider delivery claims on provider attach", async () => {
        blockPendingDeliveriesOnProviderAttach.mockResolvedValueOnce({
            ok: true,
            pendingCount: 1,
            pendingBlockedCount: 1,
            pendingVersion: 5,
            participantCursors: [
                { accountId: "u1", cursor: 45 },
                { accountId: "u2", cursor: 46 },
            ],
            badgeAttentionChanged: true,
            didUpdate: true,
            blockedCount: 1,
        });

        const { sessionPendingRoutes } = await import("./pendingRoutes");
        const route = createRouteTestBuilder({
            method: "POST",
            path: "/v2/sessions/:sessionId/pending/delivery/provider-attach",
            registerRoutes(app) {
                sessionPendingRoutes(app as any);
            },
        });
        const { response: res } = await route.invoke({
            userId: "actor",
            params: { sessionId: "s1" },
            body: {},
        });

        expect(blockPendingDeliveriesOnProviderAttach).toHaveBeenCalledWith({
            actorUserId: "actor",
            sessionId: "s1",
        });
        expect(res).toEqual({
            ok: true,
            pendingCount: 1,
            pendingBlockedCount: 1,
            pendingVersion: 5,
            blockedCount: 1,
        });
        expect(buildPendingChangedUpdate).toHaveBeenCalledTimes(2);
        expect(emitUpdate).toHaveBeenCalledTimes(2);
    });

    it("blocks provider delivery with a durable reason", async () => {
        blockPendingDelivery.mockResolvedValueOnce({
            ok: true,
            pendingCount: 1,
            pendingVersion: 4,
            participantCursors: [
                { accountId: "u1", cursor: 40 },
                { accountId: "u2", cursor: 41 },
            ],
            badgeAttentionChanged: false,
            didUpdate: true,
        });

        const { sessionPendingRoutes } = await import("./pendingRoutes");
        const route = createRouteTestBuilder({
            method: "POST",
            path: "/v2/sessions/:sessionId/pending/:localId/delivery/block",
            registerRoutes(app) {
                sessionPendingRoutes(app as any);
            },
        });
        const { response: res } = await route.invoke({
            userId: "actor",
            params: { sessionId: "s1", localId: "l-provider" },
            body: { reason: "terminal_composer_draft" },
        });

        expect(blockPendingDelivery).toHaveBeenCalledWith({
            actorUserId: "actor",
            sessionId: "s1",
            localId: "l-provider",
            reason: "terminal_composer_draft",
        });
        expect(res).toEqual({
            ok: true,
            pendingCount: 1,
            pendingVersion: 4,
        });
        expect(buildPendingChangedUpdate).toHaveBeenCalledTimes(2);
        expect(emitUpdate).toHaveBeenCalledTimes(2);
    });

    it("retries a blocked provider delivery by clearing the durable delivery state", async () => {
        retryPendingDelivery.mockResolvedValueOnce({
            ok: true,
            pendingCount: 1,
            pendingVersion: 5,
            participantCursors: [{ accountId: "u1", cursor: 50 }],
            badgeAttentionChanged: false,
            didUpdate: true,
        });

        const { sessionPendingRoutes } = await import("./pendingRoutes");
        const route = createRouteTestBuilder({
            method: "POST",
            path: "/v2/sessions/:sessionId/pending/:localId/delivery/retry",
            registerRoutes(app) {
                sessionPendingRoutes(app as any);
            },
        });
        const { response: res } = await route.invoke({
            userId: "actor",
            params: { sessionId: "s1", localId: "l-provider" },
        });

        expect(retryPendingDelivery).toHaveBeenCalledWith({
            actorUserId: "actor",
            sessionId: "s1",
            localId: "l-provider",
        });
        expect(res).toEqual({
            ok: true,
            pendingCount: 1,
            pendingVersion: 5,
        });
        expect(buildPendingChangedUpdate).toHaveBeenCalledTimes(1);
        expect(emitUpdate).toHaveBeenCalledTimes(1);
    });

    it("marks a provider delivery handled by explicit user resolution", async () => {
        markPendingDeliveryHandled.mockResolvedValueOnce({
            ok: true,
            pendingCount: 0,
            pendingVersion: 6,
            participantCursors: [
                { accountId: "u1", cursor: 60 },
                { accountId: "u2", cursor: 61 },
            ],
            participantCursorsPending: [
                { accountId: "u1", cursor: 60 },
                { accountId: "u2", cursor: 61 },
            ],
            badgeAttentionChanged: true,
            didResolve: true,
        });

        const { sessionPendingRoutes } = await import("./pendingRoutes");
        const route = createRouteTestBuilder({
            method: "POST",
            path: "/v2/sessions/:sessionId/pending/:localId/delivery/handled",
            registerRoutes(app) {
                sessionPendingRoutes(app as any);
            },
        });
        const { response: res } = await route.invoke({
            userId: "actor",
            params: { sessionId: "s1", localId: "l-provider" },
        });

        expect(markPendingDeliveryHandled).toHaveBeenCalledWith({
            actorUserId: "actor",
            sessionId: "s1",
            localId: "l-provider",
        });
        expect(res).toEqual({
            ok: true,
            pendingCount: 0,
            pendingVersion: 6,
        });
        expect(buildNewMessageUpdate).not.toHaveBeenCalled();
        expect(buildPendingChangedUpdate).toHaveBeenCalledTimes(2);
        expect(emitUpdate).toHaveBeenCalledTimes(2);
    });

    it("emits pending-changed when handled provider delivery blocks on transcript conflict", async () => {
        markPendingDeliveryHandled.mockResolvedValueOnce({
            ok: false,
            error: "transcript-conflict",
            pendingStateChanged: true,
            pendingCount: 1,
            pendingBlockedCount: 1,
            pendingVersion: 9,
            participantCursors: [{ accountId: "u1", cursor: 63 }],
            badgeAttentionChanged: true,
        });

        const { sessionPendingRoutes } = await import("./pendingRoutes");
        const route = createRouteTestBuilder({
            method: "POST",
            path: "/v2/sessions/:sessionId/pending/:localId/delivery/handled",
            registerRoutes(app) {
                sessionPendingRoutes(app as any);
            },
        });
        const { reply, response: res } = await route.invoke({
            userId: "actor",
            params: { sessionId: "s1", localId: "l-provider-conflict" },
        });

        expect(reply.statusCode).toBe(409);
        expect(res).toEqual({ error: "transcript-conflict" });
        expect(buildPendingChangedUpdate).toHaveBeenCalledWith(
            expect.objectContaining({
                sessionId: "s1",
                pendingCount: 1,
                pendingBlockedCount: 1,
                pendingVersion: 9,
            }),
            63,
            "k",
        );
        expect(emitUpdate).toHaveBeenCalledTimes(1);
        expect(refreshSessionParticipantBadgePushes).toHaveBeenCalledWith({
            badgeAttentionChanged: true,
            participantCursors: [{ accountId: "u1", cursor: 63 }],
        });
    });

    it("emits ready projection updates when materialization returns a ready projection", async () => {
        materializeNextPendingMessage.mockResolvedValueOnce({
            ok: true,
            didMaterialize: true,
            didWriteMessage: true,
            message: {
                id: "m-ready",
                seq: 7,
                localId: "ready-local",
                messageRole: "event",
                content: { t: "plain", v: { type: "event" } },
                createdAt: new Date(1_000),
                updatedAt: new Date(1_000),
            },
            pendingCount: 0,
            pendingVersion: 2,
            participantCursorsMessage: [{ accountId: "u1", cursor: 10 }],
            participantCursorsPending: [{ accountId: "u1", cursor: 20 }],
            readyProjection: {
                latestReadyEventSeq: 7,
                latestReadyEventAt: 1_000,
            },
        });

        const { sessionPendingRoutes } = await import("./pendingRoutes");
        const route = createRouteTestBuilder({
            method: "POST",
            path: "/v2/sessions/:sessionId/pending/materialize-next",
            registerRoutes(app) {
                sessionPendingRoutes(app as any);
            },
        });
        await route.invoke({ userId: "actor", params: { sessionId: "s1" } });

        expect(buildUpdateSessionUpdate).toHaveBeenCalledWith("s1", 10, expect.any(String), undefined, undefined, {
            latestReadyEventSeq: 7,
            latestReadyEventAt: 1_000,
        });
        expect(emitUpdate).toHaveBeenCalledTimes(3);
    });

    it("keeps the route successful when one emitUpdate throws", async () => {
        materializeNextPendingMessage.mockResolvedValueOnce({
            ok: true,
            didMaterialize: true,
            didWriteMessage: true,
            message: { id: "m1", seq: 1, localId: "l1", messageRole: "user", content: { t: "plain", v: { role: "user", content: { type: "text", text: "hello" } } }, createdAt: new Date(1_000), updatedAt: new Date(1_000) },
            pendingCount: 0,
            pendingVersion: 2,
            participantCursorsMessage: [
                { accountId: "u1", cursor: 10 },
                { accountId: "u2", cursor: 11 },
            ],
            participantCursorsPending: [
                { accountId: "u1", cursor: 20 },
                { accountId: "u2", cursor: 21 },
            ],
        });
        emitUpdate
            .mockImplementationOnce(() => {
                throw new Error("emit failed");
            })
            .mockImplementation(() => undefined);

        const { sessionPendingRoutes } = await import("./pendingRoutes");
        const route = createRouteTestBuilder({
            method: "POST",
            path: "/v2/sessions/:sessionId/pending/materialize-next",
            registerRoutes(app) {
                sessionPendingRoutes(app as any);
            },
        });
        const { response: res } = await route.invoke({ userId: "actor", params: { sessionId: "s1" } });

        expect(res).toEqual({
            ok: true,
            didMaterialize: true,
            didWriteMessage: true,
            pendingCount: 0,
            pendingVersion: 2,
            message: { id: "m1", seq: 1, localId: "l1", messageRole: "user", content: { t: "plain", v: { role: "user", content: { type: "text", text: "hello" } } }, createdAt: 1_000, updatedAt: 1_000 },
        });
        expect(buildPendingChangedUpdate).toHaveBeenCalledTimes(2);
    });
});
