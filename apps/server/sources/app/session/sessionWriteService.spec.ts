import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createEnvPatcher } from "@/testkit/env";
import { createDbMocks, installDbModuleMock } from "../api/testkit/dbMocks";

let currentTx: any;

vi.mock("@/storage/inTx", () => ({
    inTx: async (fn: any) => await fn(currentTx),
}));

const getSessionParticipantUserIds = vi.fn();
vi.mock("@/app/share/sessionParticipants", () => ({
    getSessionParticipantUserIds: (...args: any[]) => getSessionParticipantUserIds(...args),
}));

const markAccountChanged = vi.fn();
vi.mock("@/app/changes/markAccountChanged", () => ({
    markAccountChanged: (...args: any[]) => markAccountChanged(...args),
}));

const dbMocks = createDbMocks({
    session: ["findUnique"],
    sessionShare: ["findUnique"],
    sessionMessage: ["findUnique"],
    sessionTurnMutationReceipt: ["findUnique"],
} as const);
installDbModuleMock({ db: dbMocks.db });

let createSessionMessage: typeof import("./sessionWriteService").createSessionMessage;
let patchSession: typeof import("./sessionWriteService").patchSession;
let updateSessionAgentState: typeof import("./sessionWriteService").updateSessionAgentState;
let updateSessionRuntimeActivityProjection: typeof import("./sessionWriteService").updateSessionRuntimeActivityProjection;
let updateSessionMetadata: typeof import("./sessionWriteService").updateSessionMetadata;
let updateSessionReadCursor: typeof import("./sessionWriteService").updateSessionReadCursor;
let applySessionReadCursorOperation: typeof import("./sessionWriteService").applySessionReadCursorOperation;
let applySessionTurnMutation: typeof import("./sessionWriteService").applySessionTurnMutation;

describe("sessionWriteService", () => {
    const storagePolicyEnv = createEnvPatcher([
        "HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY",
    ]);

    beforeAll(async () => {
        ({
            createSessionMessage,
            patchSession,
            updateSessionAgentState,
            updateSessionRuntimeActivityProjection,
            updateSessionMetadata,
            updateSessionReadCursor,
            applySessionReadCursorOperation,
            applySessionTurnMutation,
        } = await import("./sessionWriteService"));
    });

    beforeEach(() => {
        getSessionParticipantUserIds.mockReset();
        markAccountChanged.mockReset();
        dbMocks.reset();
        storagePolicyEnv.restore();

        currentTx = {
            session: {
                findUnique: vi.fn(),
                update: vi.fn(),
                updateMany: vi.fn(),
            },
            sessionTurn: {
                create: vi.fn(),
                findMany: vi.fn(),
                findUnique: vi.fn(),
                update: vi.fn(),
            },
            sessionTurnMutationReceipt: {
                create: vi.fn(),
                findUnique: vi.fn(),
            },
            sessionShare: {
                findUnique: vi.fn(),
            },
            sessionMessage: {
                findUnique: vi.fn(),
                findFirst: vi.fn(),
                findMany: vi.fn(),
                create: vi.fn(),
                update: vi.fn(),
            },
        };
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    describe("reassertSessionLatestTurnStatus", () => {
        it("persists a newer replayed terminal turn status and participant update projection", async () => {
            currentTx.session.findUnique
                .mockResolvedValueOnce({ accountId: "u1", encryptionMode: "e2ee" })
                .mockResolvedValueOnce({
                    seq: 10,
                    latestReadyEventSeq: null,
                    pendingCount: 0,
                    pendingBlockedCount: 0,
                    lastViewedSessionSeq: null,
                    pendingPermissionRequestCount: 0,
                    pendingUserActionRequestCount: 0,
                    latestTurnId: "turn-1",
                    latestTurnStatus: "in_progress",
                    latestTurnStatusObservedAt: BigInt(100),
                    lastRuntimeIssue: null,
                    active: true,
                    archivedAt: null,
                });
            currentTx.session.update.mockResolvedValue({});
            getSessionParticipantUserIds.mockResolvedValue(["u1", "u2"]);
            markAccountChanged.mockResolvedValueOnce(201).mockResolvedValueOnce(202);

            const res = await reassertSessionLatestTurnStatus({
                actorUserId: "u1",
                sessionId: "s1",
                latestTurnStatus: "completed",
                latestTurnStatusObservedAt: 200,
            });

            expect(currentTx.session.update).toHaveBeenCalledWith({
                where: { id: "s1" },
                data: {
                    latestTurnStatus: "completed",
                    latestTurnStatusObservedAt: BigInt(200),
                    thinking: false,
                    thinkingAt: new Date(200),
                },
            });
            expect(res).toEqual({
                ok: true,
                didApply: true,
                latestTurnId: "turn-1",
                latestTurnStatus: "completed",
                latestTurnStatusObservedAt: 200,
                lastRuntimeIssue: null,
                participantCursors: [
                    { accountId: "u1", cursor: 201 },
                    { accountId: "u2", cursor: 202 },
                ],
                badgeAttentionChanged: false,
            });
        });

        it("does not overwrite a newer materialized turn projection", async () => {
            currentTx.session.findUnique
                .mockResolvedValueOnce({ accountId: "u1", encryptionMode: "e2ee" })
                .mockResolvedValueOnce({
                    seq: 10,
                    latestReadyEventSeq: null,
                    pendingCount: 0,
                    pendingBlockedCount: 0,
                    lastViewedSessionSeq: null,
                    pendingPermissionRequestCount: 0,
                    pendingUserActionRequestCount: 0,
                    latestTurnId: "turn-1",
                    latestTurnStatus: "in_progress",
                    latestTurnStatusObservedAt: BigInt(300),
                    lastRuntimeIssue: null,
                    active: true,
                    archivedAt: null,
                });

            const res = await reassertSessionLatestTurnStatus({
                actorUserId: "u1",
                sessionId: "s1",
                latestTurnStatus: "completed",
                latestTurnStatusObservedAt: 200,
            });

            expect(currentTx.session.update).not.toHaveBeenCalled();
            expect(res).toEqual(expect.objectContaining({
                ok: true,
                didApply: false,
                latestTurnStatus: "in_progress",
                latestTurnStatusObservedAt: 300,
            }));
        });
    });

    describe("updateSessionRuntimeActivityProjection", () => {
        it("persists a minimal runtime activity projection without touching foreground or ordering fields", async () => {
            currentTx.session.findUnique
                .mockResolvedValueOnce({ accountId: "u1", encryptionMode: "e2ee" })
                .mockResolvedValueOnce({
                    runtimeActivityActiveCount: 0,
                    runtimeActivityObservedAt: null,
                    runtimeActivityExpiresAt: null,
                    runtimeActivitySourceClass: null,
                });
            currentTx.session.updateMany.mockResolvedValue({ count: 1 });
            getSessionParticipantUserIds.mockResolvedValue(["u1", "u2"]);
            markAccountChanged.mockResolvedValueOnce(201).mockResolvedValueOnce(202);

            const res = await updateSessionRuntimeActivityProjection({
                actorUserId: "u1",
                sessionId: "s1",
                activeCount: 2,
                observedAt: 500,
                expiresAt: 900,
                sourceClass: "provider_detached_task",
            });

            expect(currentTx.session.updateMany).toHaveBeenCalledWith({
                where: { id: "s1" },
                data: {
                    runtimeActivityActiveCount: 2,
                    runtimeActivityObservedAt: BigInt(500),
                    runtimeActivityExpiresAt: BigInt(900),
                    runtimeActivitySourceClass: "provider_detached_task",
                },
            });
            expect(currentTx.session.updateMany.mock.calls[0]?.[0].data).not.toHaveProperty("thinking");
            expect(currentTx.session.updateMany.mock.calls[0]?.[0].data).not.toHaveProperty("active");
            expect(currentTx.session.updateMany.mock.calls[0]?.[0].data).not.toHaveProperty("activeAt");
            expect(currentTx.session.updateMany.mock.calls[0]?.[0].data).not.toHaveProperty("meaningfulActivityAt");
            expect(currentTx.session.updateMany.mock.calls[0]?.[0].data).not.toHaveProperty("latestTurnStatus");
            expect(res).toEqual({
                ok: true,
                didWrite: true,
                projection: {
                    runtimeActivityActiveCount: 2,
                    runtimeActivityObservedAt: 500,
                    runtimeActivityExpiresAt: 900,
                    runtimeActivitySourceClass: "provider_detached_task",
                },
                participantCursors: [
                    { accountId: "u1", cursor: 201 },
                    { accountId: "u2", cursor: 202 },
                ],
                badgeAttentionChanged: false,
            });
        });

        it("clears runtime activity absolutely and treats identical clears as no-ops", async () => {
            currentTx.session.findUnique
                .mockResolvedValueOnce({ accountId: "u1", encryptionMode: "e2ee" })
                .mockResolvedValueOnce({
                    runtimeActivityActiveCount: 0,
                    runtimeActivityObservedAt: null,
                    runtimeActivityExpiresAt: null,
                    runtimeActivitySourceClass: null,
                });

            const res = await updateSessionRuntimeActivityProjection({
                actorUserId: "u1",
                sessionId: "s1",
                activeCount: 0,
                observedAt: 500,
                expiresAt: 900,
                sourceClass: "provider_detached_task",
            });

            expect(currentTx.session.updateMany).not.toHaveBeenCalled();
            expect(res).toEqual({
                ok: true,
                didWrite: false,
                projection: {
                    runtimeActivityActiveCount: 0,
                    runtimeActivityObservedAt: null,
                    runtimeActivityExpiresAt: null,
                    runtimeActivitySourceClass: null,
                },
                participantCursors: [],
                badgeAttentionChanged: false,
            });
        });
    });

    describe("createSessionMessage", () => {
        it("returns existing message for (sessionId, localId) without writing or marking changes", async () => {
            currentTx.sessionMessage.findUnique.mockResolvedValue({
                id: "m1",
                seq: 4,
                localId: "l1",
                sidechainId: null,
                content: { t: "encrypted", c: "c1" },
                createdAt: new Date(1),
                updatedAt: new Date(2),
            });
            currentTx.session.findUnique.mockResolvedValue({ accountId: "u1" });
            currentTx.sessionShare.findUnique.mockResolvedValue(null);

            const res = await createSessionMessage({
                actorUserId: "u1",
                sessionId: "s1",
                ciphertext: "c1",
                localId: "l1",
            });

            expect(res).toEqual({
                ok: true,
                didWrite: false,
                didUpdate: false,
                badgeAttentionChanged: false,
                message: {
                    id: "m1",
                    seq: 4,
                    localId: "l1",
                    sidechainId: null,
                    messageRole: null,
                    content: { t: "encrypted", c: "c1" },
                    createdAt: new Date(1),
                    updatedAt: new Date(2),
                },
                participantCursors: [],
            });
            expect(currentTx.session.update).not.toHaveBeenCalled();
            expect(currentTx.sessionMessage.create).not.toHaveBeenCalled();
            expect(currentTx.sessionMessage.update).not.toHaveBeenCalled();
            expect(markAccountChanged).not.toHaveBeenCalled();
        });

        it("rejects (sessionId, localId) reuse across sidechains", async () => {
            currentTx.sessionMessage.findUnique.mockResolvedValue({
                id: "m1",
                seq: 4,
                localId: "l1",
                sidechainId: "sc-1",
                content: { t: "encrypted", c: "c1" },
                createdAt: new Date(1),
                updatedAt: new Date(2),
            });
            currentTx.session.findUnique.mockResolvedValue({ accountId: "u1" });
            currentTx.sessionShare.findUnique.mockResolvedValue(null);

            const res = await createSessionMessage({
                actorUserId: "u1",
                sessionId: "s1",
                ciphertext: "c1",
                localId: "l1",
                sidechainId: null,
            });

            expect(res).toEqual({ ok: false, error: "invalid-params" });
            expect(currentTx.session.update).not.toHaveBeenCalled();
            expect(currentTx.sessionMessage.create).not.toHaveBeenCalled();
            expect(currentTx.sessionMessage.update).not.toHaveBeenCalled();
            expect(markAccountChanged).not.toHaveBeenCalled();
        });

        it("updates existing message content for (sessionId, localId) when payload changes", async () => {
            const createdAt = new Date("2020-01-01T00:00:00.000Z");
            const updatedAt = new Date("2020-01-01T00:00:00.000Z");

            currentTx.sessionMessage.findUnique.mockResolvedValue({
                id: "m1",
                seq: 4,
                localId: "l1",
                sidechainId: null,
                content: { t: "encrypted", c: "prev" },
                createdAt,
                updatedAt,
            });
            currentTx.session.findUnique.mockResolvedValue({ accountId: "u1" });
            currentTx.sessionShare.findUnique.mockResolvedValue(null);

            currentTx.sessionMessage.update.mockResolvedValue({
                id: "m1",
                seq: 4,
                localId: "l1",
                sidechainId: null,
                content: { t: "encrypted", c: "next" },
                createdAt,
                updatedAt,
            });

            getSessionParticipantUserIds.mockResolvedValue(["u1", "u2"]);
            markAccountChanged.mockResolvedValueOnce(101).mockResolvedValueOnce(102);

            const res = await createSessionMessage({
                actorUserId: "u1",
                sessionId: "s1",
                ciphertext: "next",
                localId: "l1",
            });

            expect(res.ok).toBe(true);
            if (!res.ok) throw new Error("expected ok");

            expect(res).toEqual({
                ok: true,
                didWrite: false,
                didUpdate: true,
                badgeAttentionChanged: false,
                attentionImpact: {
                    affectsUnread: true,
                    affectsMeaningfulActivity: true,
                },
                message: expect.objectContaining({ id: "m1", seq: 4, localId: "l1" }),
                participantCursors: [
                    { accountId: "u1", cursor: 101 },
                    { accountId: "u2", cursor: 102 },
                ],
            });

            expect(currentTx.session.update).not.toHaveBeenCalled();
            expect(currentTx.sessionMessage.create).not.toHaveBeenCalled();
            expect(currentTx.sessionMessage.update).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: { id: "m1" },
                    data: { content: { t: "encrypted", c: "next" }, sidechainId: null, messageRole: null },
                }),
            );
        });

        it("rejects message creation if actor has no edit access", async () => {
            currentTx.sessionMessage.findUnique.mockResolvedValue(null);
            currentTx.session.findUnique.mockResolvedValue({ accountId: "owner" });
            currentTx.sessionShare.findUnique.mockResolvedValue(null);

            const res = await createSessionMessage({
                actorUserId: "u2",
                sessionId: "s1",
                ciphertext: "c1",
            });

            expect(res).toEqual({ ok: false, error: "forbidden" });
            expect(currentTx.session.update).not.toHaveBeenCalled();
            expect(markAccountChanged).not.toHaveBeenCalled();
        });

        it("creates a message, marks changes for all participants, and returns per-recipient cursors", async () => {
            currentTx.sessionMessage.findUnique.mockResolvedValue(null);
            currentTx.session.findUnique
                .mockResolvedValueOnce({ accountId: "u1" })
                .mockResolvedValueOnce({
                    seq: 9,
                    lastViewedSessionSeq: 9,
                    pendingCount: 0,
                    pendingPermissionRequestCount: 0,
                    pendingUserActionRequestCount: 0,
                    active: true,
                    archivedAt: null,
                });
            currentTx.session.update.mockResolvedValue({ seq: 10 });
            currentTx.sessionMessage.create.mockImplementation(async (args: { data: { createdAt: Date } }) => ({
                id: "m1",
                seq: 10,
                localId: "l1",
                sidechainId: null,
                content: { t: "encrypted", c: "cipher" },
                createdAt: args.data.createdAt,
                updatedAt: args.data.createdAt,
            }));

            getSessionParticipantUserIds.mockResolvedValue(["u1", "u2"]);
            markAccountChanged.mockResolvedValueOnce(101).mockResolvedValueOnce(102);

            const res = await createSessionMessage({
                actorUserId: "u1",
                sessionId: "s1",
                ciphertext: "cipher",
                localId: "l1",
            });

            expect(res.ok).toBe(true);
            if (!res.ok || res.didWrite === false) throw new Error("expected ok + didWrite");
            expect(res.didUpdate).toBe(false);

            expect(res.message.id).toBe("m1");
            expect(res.message.seq).toBe(10);
            expect(res.badgeAttentionChanged).toBe(true);
            const sessionActivityAt = currentTx.session.updateMany.mock.calls[0]?.[0]?.data?.meaningfulActivityAt;
            expect(sessionActivityAt).toBeInstanceOf(Date);
            expect(currentTx.session.update).toHaveBeenCalledWith(expect.objectContaining({
                data: expect.objectContaining({
                        seq: { increment: 1 },
                }),
            }));
            expect(currentTx.session.updateMany).toHaveBeenCalledWith({
                where: { id: "s1", seq: 10 },
                data: {
                    meaningfulActivityAt: sessionActivityAt,
                },
            });
            expect(currentTx.session.updateMany).toHaveBeenCalledTimes(1);
            expect(currentTx.sessionMessage.create).toHaveBeenCalledWith(expect.objectContaining({
                data: expect.objectContaining({
                    createdAt: sessionActivityAt,
                }),
            }));
            expect(res.participantCursors).toEqual([
                { accountId: "u1", cursor: 101 },
                { accountId: "u2", cursor: 102 },
            ]);

            expect(markAccountChanged).toHaveBeenCalledWith(expect.anything(), {
                accountId: "u1",
                kind: "session",
                entityId: "s1",
                hint: { lastMessageSeq: 10, lastMessageId: "m1" },
            });
            expect(markAccountChanged).toHaveBeenCalledWith(expect.anything(), {
                accountId: "u2",
                kind: "session",
                entityId: "s1",
                hint: { lastMessageSeq: 10, lastMessageId: "m1" },
            });
        });

        it("does not make a non-unread system message create unread activity when the session was already read", async () => {
            const createdAt = new Date("2020-01-01T00:00:00.000Z");

            currentTx.sessionMessage.findUnique.mockResolvedValue(null);
            currentTx.session.findUnique
                .mockResolvedValueOnce({ accountId: "u1" })
                .mockResolvedValueOnce({
                    seq: 9,
                    lastViewedSessionSeq: 9,
                    pendingCount: 0,
                    pendingPermissionRequestCount: 0,
                    pendingUserActionRequestCount: 0,
                    active: true,
                    archivedAt: null,
                });
            currentTx.session.update.mockResolvedValueOnce({ seq: 10 });
            currentTx.session.updateMany.mockResolvedValue({ count: 1 });
            currentTx.sessionMessage.create.mockResolvedValue({
                id: "m-system",
                seq: 10,
                localId: "system-local",
                sidechainId: null,
                messageRole: "event",
                content: { t: "encrypted", c: "cipher" },
                createdAt,
                updatedAt: createdAt,
            });
            getSessionParticipantUserIds.mockResolvedValue(["u1"]);
            markAccountChanged.mockResolvedValueOnce(101);

            const res = await createSessionMessage({
                actorUserId: "u1",
                sessionId: "s1",
                ciphertext: "cipher",
                localId: "system-local",
                messageRole: "event",
                trustedAttentionImpact: {
                    affectsUnread: false,
                    affectsMeaningfulActivity: false,
                },
            } as Parameters<typeof createSessionMessage>[0]);

            expect(res.ok).toBe(true);
            if (!res.ok || res.didWrite === false) throw new Error("expected ok + didWrite");
            expect(res.badgeAttentionChanged).toBe(false);
            expect(currentTx.session.update).toHaveBeenNthCalledWith(1, {
                where: { id: "s1" },
                select: { seq: true },
                data: {
                    seq: { increment: 1 },
                },
            });
            expect(currentTx.session.updateMany).toHaveBeenCalledWith({
                where: {
                    id: "s1",
                    OR: [{ lastViewedSessionSeq: { lt: 10 } }, { lastViewedSessionSeq: null }],
                },
                data: { lastViewedSessionSeq: 10 },
            });
            expect(currentTx.session.update).toHaveBeenCalledTimes(1);
        });

        it("derives non-unread attention for owner-authored encrypted maintenance event local ids", async () => {
            const createdAt = new Date("2020-01-01T00:00:00.000Z");

            currentTx.sessionMessage.findUnique.mockResolvedValue(null);
            currentTx.session.findUnique
                .mockResolvedValueOnce({ accountId: "u1", encryptionMode: "e2ee" })
                .mockResolvedValueOnce({
                    seq: 9,
                    lastViewedSessionSeq: 9,
                    pendingCount: 0,
                    pendingPermissionRequestCount: 0,
                    pendingUserActionRequestCount: 0,
                    active: true,
                    archivedAt: null,
                });
            currentTx.session.update.mockResolvedValueOnce({ seq: 10 });
            currentTx.session.updateMany.mockResolvedValue({ count: 1 });
            currentTx.sessionMessage.create.mockResolvedValue({
                id: "m-quota",
                seq: 10,
                localId: "provider-quota-wait:quota-blocked_openai-codex_main:reset_at_1900000:connected_service_group_quota_exhausted",
                sidechainId: null,
                messageRole: "event",
                content: { t: "encrypted", c: "cipher" },
                createdAt,
                updatedAt: createdAt,
            });
            getSessionParticipantUserIds.mockResolvedValue(["u1"]);
            markAccountChanged.mockResolvedValueOnce(101);

            const res = await createSessionMessage({
                actorUserId: "u1",
                sessionId: "s1",
                ciphertext: "cipher",
                localId: "provider-quota-wait:quota-blocked_openai-codex_main:reset_at_1900000:connected_service_group_quota_exhausted",
                messageRole: "event",
            } as Parameters<typeof createSessionMessage>[0]);

            expect(res.ok).toBe(true);
            if (!res.ok || res.didWrite === false) throw new Error("expected ok + didWrite");
            expect(res.badgeAttentionChanged).toBe(false);
            expect(currentTx.session.updateMany).toHaveBeenCalledTimes(1);
            expect(currentTx.session.updateMany).toHaveBeenCalledWith({
                where: {
                    id: "s1",
                    OR: [{ lastViewedSessionSeq: { lt: 10 } }, { lastViewedSessionSeq: null }],
                },
                data: { lastViewedSessionSeq: 10 },
            });
        });

        it("derives non-unread attention for owner-authored plaintext maintenance events", async () => {
            const createdAt = new Date("2020-01-01T00:00:00.000Z");
            const content = {
                t: "plain",
                v: {
                    role: "agent",
                    content: {
                        type: "event",
                        id: "quota-wait-event",
                        data: {
                            type: "provider-quota-wait",
                            serviceId: "openai-codex",
                            groupId: "main",
                            resetAtMs: 1_900_000,
                            reason: "connected_service_group_quota_exhausted",
                        },
                    },
                },
            } satisfies PrismaJson.SessionMessageContent;

            currentTx.sessionMessage.findUnique.mockResolvedValue(null);
            currentTx.session.findUnique
                .mockResolvedValueOnce({ accountId: "u1", encryptionMode: "plain" })
                .mockResolvedValueOnce({
                    seq: 9,
                    lastViewedSessionSeq: 9,
                    pendingCount: 0,
                    pendingPermissionRequestCount: 0,
                    pendingUserActionRequestCount: 0,
                    active: true,
                    archivedAt: null,
                });
            currentTx.session.update.mockResolvedValueOnce({ seq: 10 });
            currentTx.session.updateMany.mockResolvedValue({ count: 1 });
            currentTx.sessionMessage.create.mockResolvedValue({
                id: "m-quota-plain",
                seq: 10,
                localId: "provider-quota-wait:quota-blocked_openai-codex_main:reset_at_1900000:connected_service_group_quota_exhausted",
                sidechainId: null,
                messageRole: "event",
                content,
                createdAt,
                updatedAt: createdAt,
            });
            getSessionParticipantUserIds.mockResolvedValue(["u1"]);
            markAccountChanged.mockResolvedValueOnce(101);

            const res = await createSessionMessage({
                actorUserId: "u1",
                sessionId: "s1",
                content,
                localId: "provider-quota-wait:quota-blocked_openai-codex_main:reset_at_1900000:connected_service_group_quota_exhausted",
                messageRole: "event",
            });

            expect(res.ok).toBe(true);
            if (!res.ok || res.didWrite === false) throw new Error("expected ok + didWrite");
            expect(res.badgeAttentionChanged).toBe(false);
            expect(res.attentionImpact).toEqual({
                affectsUnread: false,
                affectsMeaningfulActivity: false,
            });
            expect(currentTx.session.updateMany).toHaveBeenCalledTimes(1);
            expect(currentTx.session.updateMany).toHaveBeenCalledWith({
                where: {
                    id: "s1",
                    OR: [{ lastViewedSessionSeq: { lt: 10 } }, { lastViewedSessionSeq: null }],
                },
                data: { lastViewedSessionSeq: 10 },
            });
        });

        it("does not derive non-unread attention from maintenance local ids for shared editors", async () => {
            const createdAt = new Date("2020-01-01T00:00:00.000Z");

            currentTx.sessionMessage.findUnique.mockResolvedValue(null);
            currentTx.session.findUnique
                .mockResolvedValueOnce({ accountId: "u1", encryptionMode: "e2ee" })
                .mockResolvedValueOnce({
                    seq: 9,
                    lastViewedSessionSeq: 9,
                    pendingCount: 0,
                    pendingPermissionRequestCount: 0,
                    pendingUserActionRequestCount: 0,
                    active: true,
                    archivedAt: null,
                });
            currentTx.sessionShare.findUnique.mockResolvedValue({ accessLevel: "edit" });
            currentTx.session.update.mockResolvedValueOnce({ seq: 10 });
            currentTx.session.updateMany.mockResolvedValue({ count: 1 });
            currentTx.sessionMessage.create.mockResolvedValue({
                id: "m-quota",
                seq: 10,
                localId: "provider-quota-recovered:quota-blocked_openai-codex_main:reset_at_1900000:fresh_quota_evidence",
                sidechainId: null,
                messageRole: "event",
                content: { t: "encrypted", c: "cipher" },
                createdAt,
                updatedAt: createdAt,
            });
            getSessionParticipantUserIds.mockResolvedValue(["u1", "u2"]);
            markAccountChanged.mockResolvedValueOnce(101).mockResolvedValueOnce(102);

            const res = await createSessionMessage({
                actorUserId: "u2",
                sessionId: "s1",
                ciphertext: "cipher",
                localId: "provider-quota-recovered:quota-blocked_openai-codex_main:reset_at_1900000:fresh_quota_evidence",
                messageRole: "event",
            } as Parameters<typeof createSessionMessage>[0]);

            expect(res.ok).toBe(true);
            if (!res.ok || res.didWrite === false) throw new Error("expected ok + didWrite");
            expect(currentTx.session.updateMany).toHaveBeenCalledTimes(1);
            expect(currentTx.session.updateMany).toHaveBeenCalledWith({
                where: { id: "s1", seq: 10 },
                data: { meaningfulActivityAt: createdAt },
            });
        });

        it("does not let a non-unread system message clear pre-existing unread activity", async () => {
            const createdAt = new Date("2020-01-01T00:00:00.000Z");

            currentTx.sessionMessage.findUnique.mockResolvedValue(null);
            currentTx.session.findUnique
                .mockResolvedValueOnce({ accountId: "u1" })
                .mockResolvedValueOnce({
                    seq: 9,
                    lastViewedSessionSeq: 7,
                    pendingCount: 0,
                    pendingPermissionRequestCount: 0,
                    pendingUserActionRequestCount: 0,
                    active: true,
                    archivedAt: null,
                });
            currentTx.session.update.mockResolvedValue({ seq: 10 });
            currentTx.sessionMessage.create.mockResolvedValue({
                id: "m-system",
                seq: 10,
                localId: "system-local",
                sidechainId: null,
                messageRole: "event",
                content: { t: "encrypted", c: "cipher" },
                createdAt,
                updatedAt: createdAt,
            });
            getSessionParticipantUserIds.mockResolvedValue(["u1"]);
            markAccountChanged.mockResolvedValueOnce(101);

            const res = await createSessionMessage({
                actorUserId: "u1",
                sessionId: "s1",
                ciphertext: "cipher",
                localId: "system-local",
                messageRole: "event",
                trustedAttentionImpact: {
                    affectsUnread: false,
                    affectsMeaningfulActivity: false,
                },
            } as Parameters<typeof createSessionMessage>[0]);

            expect(res.ok).toBe(true);
            if (!res.ok || res.didWrite === false) throw new Error("expected ok + didWrite");
            expect(res.badgeAttentionChanged).toBe(false);
            expect(currentTx.session.update).toHaveBeenCalledTimes(1);
            expect(currentTx.session.updateMany).not.toHaveBeenCalled();
        });

        it("does not move the read cursor backward when a concurrent update already advanced past a non-unread message", async () => {
            const createdAt = new Date("2020-01-01T00:00:00.000Z");

            currentTx.sessionMessage.findUnique.mockResolvedValue(null);
            currentTx.session.findUnique
                .mockResolvedValueOnce({ accountId: "u1" })
                .mockResolvedValueOnce({
                    seq: 9,
                    lastViewedSessionSeq: 9,
                    pendingCount: 0,
                    pendingPermissionRequestCount: 0,
                    pendingUserActionRequestCount: 0,
                    active: true,
                    archivedAt: null,
                })
                .mockResolvedValueOnce({
                    lastViewedSessionSeq: 12,
                });
            currentTx.session.update.mockResolvedValue({ seq: 10 });
            currentTx.session.updateMany.mockResolvedValue({ count: 0 });
            currentTx.sessionMessage.create.mockResolvedValue({
                id: "m-system",
                seq: 10,
                localId: "system-local",
                sidechainId: null,
                messageRole: "event",
                content: { t: "encrypted", c: "cipher" },
                createdAt,
                updatedAt: createdAt,
            });
            getSessionParticipantUserIds.mockResolvedValue(["u1"]);
            markAccountChanged.mockResolvedValueOnce(101);

            const res = await createSessionMessage({
                actorUserId: "u1",
                sessionId: "s1",
                ciphertext: "cipher",
                localId: "system-local",
                messageRole: "event",
                trustedAttentionImpact: {
                    affectsUnread: false,
                    affectsMeaningfulActivity: false,
                },
            } as Parameters<typeof createSessionMessage>[0]);

            expect(res.ok).toBe(true);
            if (!res.ok || res.didWrite === false) throw new Error("expected ok + didWrite");
            expect(res.badgeAttentionChanged).toBe(false);
            expect(currentTx.session.update).toHaveBeenCalledTimes(1);
            expect(currentTx.session.updateMany).toHaveBeenCalledWith({
                where: {
                    id: "s1",
                    OR: [{ lastViewedSessionSeq: { lt: 10 } }, { lastViewedSessionSeq: null }],
                },
                data: { lastViewedSessionSeq: 10 },
            });
            expect(currentTx.session.findUnique).toHaveBeenNthCalledWith(3, {
                where: { id: "s1" },
                select: { lastViewedSessionSeq: true },
            });
        });

        it("persists a ready-event list projection beside encrypted transcript content", async () => {
            const createdAt = new Date("2020-01-01T00:00:00.000Z");

            currentTx.sessionMessage.findUnique.mockResolvedValue(null);
            currentTx.session.findUnique
                .mockResolvedValueOnce({ accountId: "u1" })
                .mockResolvedValueOnce({
                    seq: 9,
                    lastViewedSessionSeq: 9,
                    pendingCount: 0,
                    pendingPermissionRequestCount: 0,
                    pendingUserActionRequestCount: 0,
                    active: true,
                    archivedAt: null,
                });
            currentTx.session.update.mockResolvedValue({ seq: 10 });
            currentTx.session.updateMany.mockResolvedValue({ count: 1 });
            currentTx.sessionMessage.create.mockResolvedValue({
                id: "m_ready",
                seq: 10,
                localId: "ready-local",
                sidechainId: null,
                messageRole: "event",
                content: { t: "encrypted", c: "cipher" },
                createdAt,
                updatedAt: createdAt,
            });
            getSessionParticipantUserIds.mockResolvedValue(["u1"]);
            markAccountChanged.mockResolvedValueOnce(101);

            const res = await createSessionMessage({
                actorUserId: "u1",
                sessionId: "s1",
                ciphertext: "cipher",
                localId: "ready-local",
                messageRole: "event",
                trustedSessionEventType: "ready",
            } as Parameters<typeof createSessionMessage>[0]);

            expect(res.ok).toBe(true);
            expect(currentTx.session.updateMany).toHaveBeenNthCalledWith(1, {
                where: { id: "s1", seq: 10 },
                data: {
                    meaningfulActivityAt: createdAt,
                },
            });
            expect(currentTx.session.updateMany).toHaveBeenNthCalledWith(2, {
                where: {
                    id: "s1",
                    OR: [
                        { latestReadyEventSeq: null },
                        { latestReadyEventSeq: { lt: 10 } },
                    ],
                },
                data: {
                    latestReadyEventSeq: 10,
                    latestReadyEventAt: createdAt,
                },
            });
            expect(res).toMatchObject({
                ok: true,
                didWrite: true,
                readyProjection: {
                    latestReadyEventSeq: 10,
                    latestReadyEventAt: createdAt.getTime(),
                },
            });
        });

        it("persists a ready-event projection when a later message already advanced the session seq", async () => {
            const createdAt = new Date("2020-01-01T00:00:00.000Z");

            currentTx.sessionMessage.findUnique.mockResolvedValue(null);
            currentTx.session.findUnique
                .mockResolvedValueOnce({ accountId: "u1" })
                .mockResolvedValueOnce({
                    seq: 9,
                    lastViewedSessionSeq: 9,
                    pendingCount: 0,
                    pendingPermissionRequestCount: 0,
                    pendingUserActionRequestCount: 0,
                    active: true,
                    archivedAt: null,
                });
            currentTx.session.update.mockResolvedValue({ seq: 10 });
            currentTx.session.updateMany
                .mockResolvedValueOnce({ count: 0 })
                .mockResolvedValueOnce({ count: 1 });
            currentTx.sessionMessage.create.mockResolvedValue({
                id: "m_ready",
                seq: 10,
                localId: "ready-local",
                sidechainId: null,
                messageRole: "event",
                content: { t: "encrypted", c: "cipher" },
                createdAt,
                updatedAt: createdAt,
            });
            getSessionParticipantUserIds.mockResolvedValue(["u1"]);
            markAccountChanged.mockResolvedValueOnce(101);

            const res = await createSessionMessage({
                actorUserId: "u1",
                sessionId: "s1",
                ciphertext: "cipher",
                localId: "ready-local",
                messageRole: "event",
                trustedSessionEventType: "ready",
            } as Parameters<typeof createSessionMessage>[0]);

            expect(res.ok).toBe(true);
            expect(currentTx.session.updateMany).toHaveBeenNthCalledWith(1, {
                where: { id: "s1", seq: 10 },
                data: {
                    meaningfulActivityAt: createdAt,
                },
            });
            expect(currentTx.session.updateMany).toHaveBeenNthCalledWith(2, {
                where: {
                    id: "s1",
                    OR: [
                        { latestReadyEventSeq: null },
                        { latestReadyEventSeq: { lt: 10 } },
                    ],
                },
                data: {
                    latestReadyEventSeq: 10,
                    latestReadyEventAt: createdAt,
                },
            });
            expect(res).toMatchObject({
                ok: true,
                didWrite: true,
                readyProjection: {
                    latestReadyEventSeq: 10,
                    latestReadyEventAt: createdAt.getTime(),
                },
            });
        });

        it("does not return a ready-event projection when a newer ready event already won", async () => {
            const createdAt = new Date("2020-01-01T00:00:00.000Z");

            currentTx.sessionMessage.findUnique.mockResolvedValue(null);
            currentTx.session.findUnique
                .mockResolvedValueOnce({ accountId: "u1" })
                .mockResolvedValueOnce({
                    seq: 9,
                    lastViewedSessionSeq: 9,
                    pendingCount: 0,
                    pendingPermissionRequestCount: 0,
                    pendingUserActionRequestCount: 0,
                    active: true,
                    archivedAt: null,
                });
            currentTx.session.update.mockResolvedValue({ seq: 10 });
            currentTx.session.updateMany
                .mockResolvedValueOnce({ count: 1 })
                .mockResolvedValueOnce({ count: 0 });
            currentTx.sessionMessage.create.mockResolvedValue({
                id: "m_ready",
                seq: 10,
                localId: "ready-local",
                sidechainId: null,
                messageRole: "event",
                content: { t: "encrypted", c: "cipher" },
                createdAt,
                updatedAt: createdAt,
            });
            getSessionParticipantUserIds.mockResolvedValue(["u1"]);
            markAccountChanged.mockResolvedValueOnce(101);

            const res = await createSessionMessage({
                actorUserId: "u1",
                sessionId: "s1",
                ciphertext: "cipher",
                localId: "ready-local",
                messageRole: "event",
                trustedSessionEventType: "ready",
            } as Parameters<typeof createSessionMessage>[0]);

            expect(res.ok).toBe(true);
            expect(currentTx.session.updateMany).toHaveBeenNthCalledWith(2, {
                where: {
                    id: "s1",
                    OR: [
                        { latestReadyEventSeq: null },
                        { latestReadyEventSeq: { lt: 10 } },
                    ],
                },
                data: {
                    latestReadyEventSeq: 10,
                    latestReadyEventAt: createdAt,
                },
            });
            expect(res).toMatchObject({
                ok: true,
                didWrite: true,
            });
            expect(res).not.toHaveProperty("readyProjection");
        });

        it("persists a ready-event projection for owner-authored plaintext ready events without a trusted hint", async () => {
            const createdAt = new Date("2020-01-01T00:00:00.000Z");
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
            } satisfies PrismaJson.SessionMessageContent;

            currentTx.sessionMessage.findUnique.mockResolvedValue(null);
            currentTx.session.findUnique
                .mockResolvedValueOnce({ accountId: "u1", encryptionMode: "plain" })
                .mockResolvedValueOnce({
                    seq: 9,
                    lastViewedSessionSeq: 9,
                    pendingCount: 0,
                    pendingPermissionRequestCount: 0,
                    pendingUserActionRequestCount: 0,
                    active: true,
                    archivedAt: null,
                });
            currentTx.session.update.mockResolvedValue({ seq: 10 });
            currentTx.session.updateMany.mockResolvedValue({ count: 1 });
            currentTx.sessionMessage.create.mockResolvedValue({
                id: "m_ready_plain",
                seq: 10,
                localId: "ready-plain-local",
                sidechainId: null,
                messageRole: "event",
                content: readyContent,
                createdAt,
                updatedAt: createdAt,
            });
            getSessionParticipantUserIds.mockResolvedValue(["u1"]);
            markAccountChanged.mockResolvedValueOnce(101);

            const res = await createSessionMessage({
                actorUserId: "u1",
                sessionId: "s1",
                content: readyContent,
                localId: "ready-plain-local",
                messageRole: "event",
            });

            expect(res.ok).toBe(true);
            expect(currentTx.session.updateMany).toHaveBeenNthCalledWith(1, {
                where: { id: "s1", seq: 10 },
                data: {
                    meaningfulActivityAt: createdAt,
                },
            });
            expect(currentTx.session.updateMany).toHaveBeenNthCalledWith(2, {
                where: {
                    id: "s1",
                    OR: [
                        { latestReadyEventSeq: null },
                        { latestReadyEventSeq: { lt: 10 } },
                    ],
                },
                data: {
                    latestReadyEventSeq: 10,
                    latestReadyEventAt: createdAt,
                },
            });
            expect(res).toMatchObject({
                ok: true,
                didWrite: true,
                readyProjection: {
                    latestReadyEventSeq: 10,
                    latestReadyEventAt: createdAt.getTime(),
                },
            });
        });

        it("does not let collaborators project ready state from a supplied ready event hint", async () => {
            const createdAt = new Date("2020-01-01T00:00:00.000Z");

            currentTx.sessionMessage.findUnique.mockResolvedValue(null);
            currentTx.session.findUnique
                .mockResolvedValueOnce({ accountId: "owner-1" })
                .mockResolvedValueOnce({
                    seq: 9,
                    lastViewedSessionSeq: 9,
                    pendingCount: 0,
                    pendingPermissionRequestCount: 0,
                    pendingUserActionRequestCount: 0,
                    active: true,
                    archivedAt: null,
                });
            currentTx.sessionShare.findUnique.mockResolvedValue({ accessLevel: "edit" });
            currentTx.session.update.mockResolvedValue({ seq: 10 });
            currentTx.session.updateMany.mockResolvedValue({ count: 1 });
            currentTx.sessionMessage.create.mockResolvedValue({
                id: "m_collab_ready",
                seq: 10,
                localId: "collab-ready-local",
                sidechainId: null,
                messageRole: "event",
                content: { t: "encrypted", c: "cipher" },
                createdAt,
                updatedAt: createdAt,
            });
            getSessionParticipantUserIds.mockResolvedValue(["owner-1", "collab-1"]);
            markAccountChanged.mockResolvedValueOnce(101).mockResolvedValueOnce(102);

            const res = await createSessionMessage({
                actorUserId: "collab-1",
                sessionId: "s1",
                ciphertext: "cipher",
                localId: "collab-ready-local",
                messageRole: "event",
                trustedSessionEventType: "ready",
            } as Parameters<typeof createSessionMessage>[0]);

            expect(res.ok).toBe(true);
            expect(currentTx.session.updateMany).toHaveBeenCalledTimes(1);
            expect(currentTx.session.updateMany).toHaveBeenCalledWith({
                where: { id: "s1", seq: 10 },
                data: {
                    meaningfulActivityAt: createdAt,
                },
            });
            expect(res).toMatchObject({
                ok: true,
                didWrite: true,
            });
            expect(res).not.toHaveProperty("readyProjection");
        });

        it("stores supplied encrypted message role metadata when creating a message", async () => {
            const createdAt = new Date("2020-01-01T00:00:00.000Z");

            currentTx.sessionMessage.findUnique.mockResolvedValue(null);
            currentTx.session.findUnique
                .mockResolvedValueOnce({ accountId: "u1" })
                .mockResolvedValueOnce({
                    seq: 9,
                    lastViewedSessionSeq: 9,
                    pendingCount: 0,
                    pendingPermissionRequestCount: 0,
                    pendingUserActionRequestCount: 0,
                    active: true,
                    archivedAt: null,
                });
            currentTx.session.update.mockResolvedValue({ seq: 10 });
            currentTx.sessionMessage.create.mockResolvedValue({
                id: "m1",
                seq: 10,
                localId: "l1",
                sidechainId: null,
                messageRole: "user",
                content: { t: "encrypted", c: "cipher" },
                createdAt,
                updatedAt: createdAt,
            });

            getSessionParticipantUserIds.mockResolvedValue(["u1"]);
            markAccountChanged.mockResolvedValueOnce(101);

            const res = await createSessionMessage({
                actorUserId: "u1",
                sessionId: "s1",
                ciphertext: "cipher",
                localId: "l1",
                messageRole: "user",
            });

            expect(res.ok).toBe(true);
            if (!res.ok) throw new Error("expected ok");
            expect(res.message.messageRole).toBe("user");
            expect(currentTx.sessionMessage.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: expect.objectContaining({
                        messageRole: "user",
                    }),
                }),
            );
        });

        it("handles localId races by returning the winner row on P2002", async () => {
            currentTx.sessionMessage.findUnique.mockResolvedValue(null);
            currentTx.session.findUnique.mockResolvedValue({ accountId: "u1" });
            currentTx.session.update.mockResolvedValue({ seq: 10 });
            currentTx.sessionMessage.create.mockRejectedValue({ code: "P2002" });

            dbMocks.db.session.findUnique.mockResolvedValue({ accountId: "u1" });
            dbMocks.db.sessionShare.findUnique.mockResolvedValue(null);
            dbMocks.db.sessionMessage.findUnique.mockResolvedValue({
                id: "mExisting",
                seq: 9,
                localId: "l1",
                sidechainId: null,
                content: { t: "encrypted", c: "cipher" },
                createdAt: new Date(1),
                updatedAt: new Date(1),
            });

            const res = await createSessionMessage({
                actorUserId: "u1",
                sessionId: "s1",
                ciphertext: "cipher",
                localId: "l1",
            });

            expect(res).toEqual({
                ok: true,
                didWrite: false,
                didUpdate: false,
                badgeAttentionChanged: false,
                message: {
                    id: "mExisting",
                    seq: 9,
                    localId: "l1",
                    sidechainId: null,
                    messageRole: null,
                    content: { t: "encrypted", c: "cipher" },
                    createdAt: new Date(1),
                    updatedAt: new Date(1),
                },
                participantCursors: [],
            });
        });

        it("handles localId races by updating the winner row when content differs", async () => {
            currentTx.sessionMessage.findUnique.mockResolvedValue(null);
            currentTx.session.findUnique.mockResolvedValue({ accountId: "u1" });
            currentTx.session.update.mockResolvedValue({ seq: 10 });
            currentTx.sessionMessage.create.mockRejectedValue({ code: "P2002" });

            dbMocks.db.session.findUnique.mockResolvedValue({ accountId: "u1" });
            dbMocks.db.sessionShare.findUnique.mockResolvedValue(null);
            dbMocks.db.sessionMessage.findUnique.mockResolvedValue({
                id: "mExisting",
                seq: 9,
                localId: "l1",
                sidechainId: null,
                content: { t: "encrypted", c: "prev" },
                createdAt: new Date(1),
                updatedAt: new Date(1),
            });

            currentTx.sessionMessage.update.mockResolvedValue({
                id: "mExisting",
                seq: 9,
                localId: "l1",
                sidechainId: null,
                content: { t: "encrypted", c: "next" },
                createdAt: new Date(1),
                updatedAt: new Date(2),
            });

            getSessionParticipantUserIds.mockResolvedValue(["u1", "u2"]);
            markAccountChanged.mockResolvedValueOnce(101).mockResolvedValueOnce(102);

            const res = await createSessionMessage({
                actorUserId: "u1",
                sessionId: "s1",
                ciphertext: "next",
                localId: "l1",
            });

            expect(res).toEqual({
                ok: true,
                didWrite: false,
                didUpdate: true,
                badgeAttentionChanged: false,
                attentionImpact: {
                    affectsUnread: true,
                    affectsMeaningfulActivity: true,
                },
                message: {
                    id: "mExisting",
                    seq: 9,
                    localId: "l1",
                    sidechainId: null,
                    messageRole: null,
                    content: { t: "encrypted", c: "next" },
                    createdAt: new Date(1),
                    updatedAt: new Date(2),
                },
                participantCursors: [
                    { accountId: "u1", cursor: 101 },
                    { accountId: "u2", cursor: 102 },
                ],
            });

            expect(currentTx.sessionMessage.update).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: { id: "mExisting" },
                    data: { content: { t: "encrypted", c: "next" }, sidechainId: null, messageRole: null },
                }),
            );
        });

        it("rejects encrypted writes when the session encryptionMode is plain (with a stable code)", async () => {
            const createdAt = new Date("2020-01-01T00:00:00.000Z");
            storagePolicyEnv.set("HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY", "optional");
            currentTx.sessionMessage.findUnique.mockResolvedValue(null);
            currentTx.session.findUnique.mockResolvedValue({ accountId: "u1", encryptionMode: "plain" });
            currentTx.sessionShare.findUnique.mockResolvedValue(null);
            currentTx.session.update.mockResolvedValue({ seq: 1 });
            currentTx.sessionMessage.create.mockResolvedValue({
                id: "m1",
                seq: 1,
                localId: null,
                content: { t: "encrypted", c: "cipher" },
                createdAt,
                updatedAt: createdAt,
            });
            getSessionParticipantUserIds.mockResolvedValue(["u1"]);
            markAccountChanged.mockResolvedValueOnce(101);

            const res = await createSessionMessage({
                actorUserId: "u1",
                sessionId: "s1",
                ciphertext: "cipher",
            });

            expect(res).toEqual({ ok: false, error: "invalid-params", code: "session_encryption_mode_mismatch" });
            expect(currentTx.session.update).not.toHaveBeenCalled();
            expect(currentTx.sessionMessage.create).not.toHaveBeenCalled();
            expect(markAccountChanged).not.toHaveBeenCalled();
        });

        it("stores plain content when the session encryptionMode is plain and storagePolicy is optional", async () => {
            const createdAt = new Date("2020-01-01T00:00:00.000Z");
            storagePolicyEnv.set("HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY", "optional");

            currentTx.sessionMessage.findUnique.mockResolvedValue(null);
            currentTx.session.findUnique.mockResolvedValue({ accountId: "u1", encryptionMode: "plain" });
            currentTx.sessionShare.findUnique.mockResolvedValue(null);
            currentTx.session.update.mockResolvedValue({ seq: 1 });
            currentTx.sessionMessage.create.mockResolvedValue({
                id: "m1",
                seq: 1,
                localId: null,
                content: { t: "plain", v: { type: "user", text: "hi" } },
                createdAt,
                updatedAt: createdAt,
            });
            getSessionParticipantUserIds.mockResolvedValue(["u1"]);
            markAccountChanged.mockResolvedValueOnce(101);

                const res = await createSessionMessage({
                    actorUserId: "u1",
                    sessionId: "s1",
                    content: { t: "plain", v: { type: "user", text: "hi" } },
            });

            expect(res.ok).toBe(true);
            expect(currentTx.sessionMessage.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: expect.objectContaining({
                        content: { t: "plain", v: { type: "user", text: "hi" } },
                        messageRole: "user",
                    }),
                }),
            );
        });

        it("stores supplied role for plaintext ACP tool rows instead of envelope role", async () => {
            const createdAt = new Date("2020-01-01T00:00:00.000Z");
            const content = {
                t: "plain",
                v: {
                    role: "agent",
                    content: {
                        type: "acp",
                        data: { type: "tool-call", name: "CodexBash" },
                    },
                },
            } satisfies PrismaJson.SessionMessageContent;
            storagePolicyEnv.set("HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY", "optional");

            currentTx.sessionMessage.findUnique.mockResolvedValue(null);
            currentTx.session.findUnique.mockResolvedValue({ accountId: "u1", encryptionMode: "plain" });
            currentTx.sessionShare.findUnique.mockResolvedValue(null);
            currentTx.session.update.mockResolvedValue({ seq: 1 });
            currentTx.sessionMessage.create.mockResolvedValue({
                id: "m1",
                seq: 1,
                localId: null,
                messageRole: "event",
                content,
                createdAt,
                updatedAt: createdAt,
            });
            getSessionParticipantUserIds.mockResolvedValue(["u1"]);
            markAccountChanged.mockResolvedValueOnce(101);

            const res = await createSessionMessage({
                actorUserId: "u1",
                sessionId: "s1",
                content,
                messageRole: "event",
            });

            expect(res.ok).toBe(true);
            if (!res.ok) throw new Error("expected ok");
            expect(res.message.messageRole).toBe("event");
            expect(currentTx.sessionMessage.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: expect.objectContaining({
                        content,
                        messageRole: "event",
                    }),
                }),
            );
        });

        it("captures message and ready timestamps after the session seq increment lock is acquired", async () => {
            vi.useFakeTimers();
            const beforeLock = new Date("2020-01-01T00:00:00.000Z");
            const afterLock = new Date("2020-01-01T00:00:01.000Z");
            vi.setSystemTime(beforeLock);

            currentTx.sessionMessage.findUnique.mockResolvedValue(null);
            currentTx.session.findUnique
                .mockResolvedValueOnce({ accountId: "u1" })
                .mockResolvedValueOnce({
                    seq: 9,
                    lastViewedSessionSeq: 9,
                    pendingCount: 0,
                    pendingPermissionRequestCount: 0,
                    pendingUserActionRequestCount: 0,
                    active: true,
                    archivedAt: null,
                });
            currentTx.session.update.mockImplementation(async (args: { data: { seq: { increment: number } } }) => {
                expect(args.data.seq).toEqual({ increment: 1 });
                vi.setSystemTime(afterLock);
                return { seq: 10 };
            });
            currentTx.sessionMessage.create.mockImplementation(async (args: { data: { createdAt: Date } }) => ({
                id: "m1",
                seq: 10,
                localId: "l1",
                sidechainId: null,
                messageRole: null,
                content: { t: "encrypted", c: "cipher" },
                createdAt: args.data.createdAt,
                updatedAt: args.data.createdAt,
            }));
            currentTx.session.updateMany.mockResolvedValue({ count: 1 });
            getSessionParticipantUserIds.mockResolvedValue(["u1"]);
            markAccountChanged.mockResolvedValueOnce(101);

            const res = await createSessionMessage({
                actorUserId: "u1",
                sessionId: "s1",
                ciphertext: "cipher",
                localId: "l1",
                trustedSessionEventType: "ready",
            });

            expect(currentTx.session.update).toHaveBeenCalledWith({
                where: { id: "s1" },
                select: { seq: true },
                data: {
                    seq: { increment: 1 },
                },
            });
            expect(currentTx.sessionMessage.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: expect.objectContaining({
                        createdAt: afterLock,
                    }),
                }),
            );
            expect(currentTx.session.updateMany).toHaveBeenNthCalledWith(1, {
                where: { id: "s1", seq: 10 },
                data: {
                    meaningfulActivityAt: afterLock,
                },
            });
            expect(currentTx.session.updateMany).toHaveBeenNthCalledWith(2, {
                where: {
                    id: "s1",
                    OR: [
                        { latestReadyEventSeq: null },
                        { latestReadyEventSeq: { lt: 10 } },
                    ],
                },
                data: {
                    latestReadyEventSeq: 10,
                    latestReadyEventAt: afterLock,
                },
            });
            expect(res).toEqual({
                ok: true,
                didWrite: true,
                didUpdate: false,
                badgeAttentionChanged: true,
                attentionImpact: {
                    affectsUnread: true,
                    affectsMeaningfulActivity: true,
                },
                message: {
                    id: "m1",
                    seq: 10,
                    localId: "l1",
                    sidechainId: null,
                    messageRole: null,
                    content: { t: "encrypted", c: "cipher" },
                    createdAt: afterLock,
                    updatedAt: afterLock,
                },
                participantCursors: [{ accountId: "u1", cursor: 101 }],
                readyProjection: {
                    latestReadyEventSeq: 10,
                    latestReadyEventAt: afterLock.getTime(),
                },
            });
        });
    });

    describe("updateSessionMetadata", () => {
        it("returns version-mismatch with current value", async () => {
            currentTx.sessionShare.findUnique.mockResolvedValue(null);
            currentTx.session.findUnique
                .mockResolvedValueOnce({ accountId: "u1" })
                .mockResolvedValueOnce({ metadataVersion: 5, metadata: "mCurrent" });

            const res = await updateSessionMetadata({
                actorUserId: "u1",
                sessionId: "s1",
                expectedVersion: 4,
                metadataCiphertext: "mNew",
            });

            expect(res).toEqual({ ok: false, error: "version-mismatch", current: { version: 5, metadata: "mCurrent" } });
            expect(currentTx.session.updateMany).not.toHaveBeenCalled();
        });

        it("re-fetches on CAS miss (count=0) and returns the fresh current value", async () => {
            currentTx.sessionShare.findUnique.mockResolvedValue(null);
            currentTx.session.findUnique
                .mockResolvedValueOnce({ accountId: "u1" })
                .mockResolvedValueOnce({ metadataVersion: 4, metadata: "mOld" })
                .mockResolvedValueOnce({ metadataVersion: 5, metadata: "mFresh" });
            currentTx.session.updateMany.mockResolvedValue({ count: 0 });

            const res = await updateSessionMetadata({
                actorUserId: "u1",
                sessionId: "s1",
                expectedVersion: 4,
                metadataCiphertext: "mNew",
            });

            expect(res).toEqual({ ok: false, error: "version-mismatch", current: { version: 5, metadata: "mFresh" } });
        });

        it("returns session-not-found when CAS miss re-fetch finds no row", async () => {
            currentTx.sessionShare.findUnique.mockResolvedValue(null);
            currentTx.session.findUnique
                .mockResolvedValueOnce({ accountId: "u1" })
                .mockResolvedValueOnce({ metadataVersion: 4, metadata: "mOld" })
                .mockResolvedValueOnce(null);
            currentTx.session.updateMany.mockResolvedValue({ count: 0 });

            const res = await updateSessionMetadata({
                actorUserId: "u1",
                sessionId: "s1",
                expectedVersion: 4,
                metadataCiphertext: "mNew",
            });

            expect(res).toEqual({ ok: false, error: "session-not-found" });
        });
    });

    describe("updateSessionAgentState", () => {
        it("updates with CAS and marks participants", async () => {
            currentTx.session.findUnique
                .mockResolvedValueOnce({ accountId: "u1" })
                .mockResolvedValueOnce({
                    agentStateVersion: 1,
                    agentState: "a1",
                    seq: 2,
                    lastViewedSessionSeq: 2,
                    pendingCount: 0,
                    pendingPermissionRequestCount: 0,
                    pendingUserActionRequestCount: 0,
                    active: true,
                    archivedAt: null,
                });
            currentTx.sessionShare.findUnique.mockResolvedValue(null);
            currentTx.session.updateMany.mockResolvedValue({ count: 1 });
            getSessionParticipantUserIds.mockResolvedValue(["u1"]);
            markAccountChanged.mockResolvedValueOnce(200);

            const res = await updateSessionAgentState({
                actorUserId: "u1",
                sessionId: "s1",
                expectedVersion: 1,
                agentStateCiphertext: null,
            });

            expect(res).toEqual({
                ok: true,
                version: 2,
                agentState: null,
                participantCursors: [{ accountId: "u1", cursor: 200 }],
                badgeAttentionChanged: false,
            });
        });

        it("persists pending permission and user action counts atomically with agentState", async () => {
            currentTx.session.findUnique
                .mockResolvedValueOnce({ accountId: "u1" })
                .mockResolvedValueOnce({
                    agentStateVersion: 1,
                    agentState: "a1",
                    seq: 2,
                    lastViewedSessionSeq: 2,
                    pendingCount: 0,
                    pendingPermissionRequestCount: 0,
                    pendingUserActionRequestCount: 0,
                    active: true,
                    archivedAt: null,
                });
            currentTx.sessionShare.findUnique.mockResolvedValue(null);
            currentTx.session.updateMany.mockResolvedValue({ count: 1 });
            getSessionParticipantUserIds.mockResolvedValue(["u1"]);
            markAccountChanged.mockResolvedValueOnce(200);

            const res = await updateSessionAgentState({
                actorUserId: "u1",
                sessionId: "s1",
                expectedVersion: 1,
                agentStateCiphertext: "a2",
                pendingPermissionRequestCount: 2,
                pendingUserActionRequestCount: 1,
            });

            expect(currentTx.session.updateMany).toHaveBeenCalledWith({
                where: { id: "s1", agentStateVersion: 1 },
                data: {
                    agentState: "a2",
                    agentStateVersion: 2,
                    pendingPermissionRequestCount: 2,
                    pendingUserActionRequestCount: 1,
                    pendingRequestObservedAt: expect.any(Date),
                },
            });
            expect(res).toEqual({
                ok: true,
                version: 2,
                agentState: "a2",
                participantCursors: [{ accountId: "u1", cursor: 200 }],
                badgeAttentionChanged: true,
                pendingPermissionRequestCount: 2,
                pendingUserActionRequestCount: 1,
                pendingRequestObservedAt: expect.any(Number),
            });
        });

        it("ignores runtime issue summary boundary input while updating agentState", async () => {
            const runtimeIssue = {
                v: 1,
                scope: "primary_session",
                status: "failed",
                code: "auth_error",
                source: "auth_error",
                occurredAt: 123,
                provider: "codex",
                sanitizedPreview: "Authentication failed",
            } as const;
            currentTx.session.findUnique
                .mockResolvedValueOnce({ accountId: "u1" })
                .mockResolvedValueOnce({
                    agentStateVersion: 1,
                    agentState: "a1",
                    seq: 2,
                    lastViewedSessionSeq: 2,
                    pendingCount: 0,
                    pendingPermissionRequestCount: 0,
                    pendingUserActionRequestCount: 0,
                    latestTurnId: null,
                    latestTurnStatus: null,
                    latestTurnStatusObservedAt: null,
                    lastRuntimeIssue: null,
                    active: true,
                    archivedAt: null,
                });
            currentTx.sessionShare.findUnique.mockResolvedValue(null);
            currentTx.session.updateMany.mockResolvedValue({ count: 1 });
            currentTx.sessionTurnMutationReceipt.findUnique.mockResolvedValue(null);
            currentTx.sessionTurn.findMany.mockResolvedValue([]);
            currentTx.sessionTurn.create.mockResolvedValue({});
            currentTx.sessionTurn.update.mockResolvedValue({});
            currentTx.sessionTurnMutationReceipt.create.mockResolvedValue({});
            currentTx.session.update.mockResolvedValue({});
            getSessionParticipantUserIds.mockResolvedValue(["u1"]);
            markAccountChanged.mockResolvedValueOnce(200);

            const params: Parameters<typeof updateSessionAgentState>[0] & {
                runtimeIssueSummaryV1: unknown;
            } = {
                actorUserId: "u1",
                sessionId: "s1",
                expectedVersion: 1,
                agentStateCiphertext: "a2",
                runtimeIssueSummaryV1: {
                    latestTurnStatus: "failed",
                    lastRuntimeIssue: runtimeIssue,
                },
            };
            const res = await updateSessionAgentState(params);

            expect(currentTx.session.updateMany).toHaveBeenCalledWith({
                where: {
                    id: "s1",
                    agentStateVersion: 1,
                },
                data: {
                    agentState: "a2",
                    agentStateVersion: 2,
                },
            });
            expect(currentTx.sessionTurn.findMany).not.toHaveBeenCalled();
            expect(currentTx.sessionTurn.create).not.toHaveBeenCalled();
            expect(currentTx.sessionTurn.update).not.toHaveBeenCalled();
            expect(currentTx.sessionTurnMutationReceipt.create).not.toHaveBeenCalled();
            expect(currentTx.session.update).not.toHaveBeenCalled();
            expect(res).toEqual({
                ok: true,
                version: 2,
                agentState: "a2",
                participantCursors: [{ accountId: "u1", cursor: 200 }],
                badgeAttentionChanged: false,
            });
        });

        it("does not expose runtimeIssueSummaryV1 in typed update-state params", () => {
            const params: Parameters<typeof updateSessionAgentState>[0] = {
                actorUserId: "u1",
                sessionId: "s1",
                expectedVersion: 1,
                agentStateCiphertext: "a2",
                // @ts-expect-error runtimeIssueSummaryV1 was a dev-only update-state bridge and is no longer accepted.
                runtimeIssueSummaryV1: { latestTurnStatus: "failed" },
            };

            expect(params).toMatchObject({
                actorUserId: "u1",
                sessionId: "s1",
                expectedVersion: 1,
                agentStateCiphertext: "a2",
            });
        });

        it("ignores malformed runtime issue summary boundary input", async () => {
            const invalidRuntimeIssueSummaryV1: unknown = {
                latestTurnStatus: "failed",
                lastRuntimeIssue: {
                    v: 1,
                    scope: "primary_session",
                    status: "completed",
                    code: "auth_error",
                    source: "auth_error",
                    occurredAt: 123,
                },
            };
            currentTx.session.findUnique
                .mockResolvedValueOnce({ accountId: "u1" })
                .mockResolvedValueOnce({
                    agentStateVersion: 1,
                    agentState: "a1",
                    seq: 2,
                    lastViewedSessionSeq: 2,
                    pendingCount: 0,
                    pendingPermissionRequestCount: 0,
                    pendingUserActionRequestCount: 0,
                    latestTurnId: null,
                    latestTurnStatus: null,
                    latestTurnStatusObservedAt: null,
                    lastRuntimeIssue: null,
                    active: true,
                    archivedAt: null,
                });
            currentTx.sessionShare.findUnique.mockResolvedValue(null);
            currentTx.session.updateMany.mockResolvedValue({ count: 1 });
            getSessionParticipantUserIds.mockResolvedValue(["u1"]);
            markAccountChanged.mockResolvedValueOnce(200);

            const params: Parameters<typeof updateSessionAgentState>[0] & Record<"runtimeIssueSummaryV1", unknown> = {
                actorUserId: "u1",
                sessionId: "s1",
                expectedVersion: 1,
                agentStateCiphertext: "a2",
                runtimeIssueSummaryV1: invalidRuntimeIssueSummaryV1,
            };

            const res = await updateSessionAgentState(params);

            expect(currentTx.session.updateMany).toHaveBeenCalledWith({
                where: { id: "s1", agentStateVersion: 1 },
                data: {
                    agentState: "a2",
                    agentStateVersion: 2,
                },
            });
            expect(currentTx.sessionTurn.findMany).not.toHaveBeenCalled();
            expect(currentTx.sessionTurn.create).not.toHaveBeenCalled();
            expect(currentTx.sessionTurn.update).not.toHaveBeenCalled();
            expect(currentTx.sessionTurnMutationReceipt.create).not.toHaveBeenCalled();
            expect(res).toEqual({
                ok: true,
                version: 2,
                agentState: "a2",
                participantCursors: [{ accountId: "u1", cursor: 200 }],
                badgeAttentionChanged: false,
            });
        });

        it("re-fetches on CAS miss (count=0) and returns the fresh current value", async () => {
            currentTx.session.findUnique
                .mockResolvedValueOnce({ accountId: "u1" })
                .mockResolvedValueOnce({ agentStateVersion: 4, agentState: "aOld" })
                .mockResolvedValueOnce({ agentStateVersion: 5, agentState: "aFresh" });
            currentTx.sessionShare.findUnique.mockResolvedValue(null);
            currentTx.session.updateMany.mockResolvedValue({ count: 0 });

            const res = await updateSessionAgentState({
                actorUserId: "u1",
                sessionId: "s1",
                expectedVersion: 4,
                agentStateCiphertext: null,
            });

            expect(res).toEqual({ ok: false, error: "version-mismatch", current: { version: 5, agentState: "aFresh" } });
        });

        it("returns session-not-found when CAS miss re-fetch finds no row", async () => {
            currentTx.session.findUnique
                .mockResolvedValueOnce({ accountId: "u1" })
                .mockResolvedValueOnce({ agentStateVersion: 4, agentState: "aOld" })
                .mockResolvedValueOnce(null);
            currentTx.sessionShare.findUnique.mockResolvedValue(null);
            currentTx.session.updateMany.mockResolvedValue({ count: 0 });

            const res = await updateSessionAgentState({
                actorUserId: "u1",
                sessionId: "s1",
                expectedVersion: 4,
                agentStateCiphertext: null,
            });

            expect(res).toEqual({ ok: false, error: "session-not-found" });
        });
    });

    describe("updateSessionReadCursor", () => {
        it("applies a monotonic max update and marks participants", async () => {
            currentTx.session.findUnique
                .mockResolvedValueOnce({ accountId: "u1" })
                .mockResolvedValueOnce({
                    seq: 8,
                    lastViewedSessionSeq: 3,
                    pendingCount: 0,
                    pendingPermissionRequestCount: 0,
                    pendingUserActionRequestCount: 0,
                    active: true,
                    archivedAt: null,
                });
            currentTx.sessionShare.findUnique.mockResolvedValue(null);
            currentTx.session.updateMany.mockResolvedValue({ count: 1 });
            getSessionParticipantUserIds.mockResolvedValue(["u1"]);
            markAccountChanged.mockResolvedValueOnce(200);

            const res = await updateSessionReadCursor({
                actorUserId: "u1",
                sessionId: "s1",
                lastViewedSessionSeq: 9,
            });

            expect(currentTx.session.updateMany).toHaveBeenCalledWith({
                where: {
                    id: "s1",
                    OR: [{ lastViewedSessionSeq: { lt: 8 } }, { lastViewedSessionSeq: null }],
                },
                data: { lastViewedSessionSeq: 8 },
            });
            expect(res).toEqual({
                ok: true,
                lastViewedSessionSeq: 8,
                participantCursors: [{ accountId: "u1", cursor: 200 }],
                badgeAttentionChanged: true,
            });
        });

        it("persists when the existing cursor is null", async () => {
            currentTx.session.findUnique
                .mockResolvedValueOnce({ accountId: "u1" })
                .mockResolvedValueOnce({
                    seq: 8,
                    lastViewedSessionSeq: null,
                    pendingCount: 0,
                    pendingPermissionRequestCount: 0,
                    pendingUserActionRequestCount: 0,
                    active: true,
                    archivedAt: null,
                });
            currentTx.sessionShare.findUnique.mockResolvedValue(null);
            currentTx.session.updateMany.mockResolvedValue({ count: 1 });
            getSessionParticipantUserIds.mockResolvedValue(["u1"]);
            markAccountChanged.mockResolvedValueOnce(200);

            const res = await updateSessionReadCursor({
                actorUserId: "u1",
                sessionId: "s1",
                lastViewedSessionSeq: 4,
            });

            expect(currentTx.session.updateMany).toHaveBeenCalledWith({
                where: {
                    id: "s1",
                    OR: [{ lastViewedSessionSeq: { lt: 4 } }, { lastViewedSessionSeq: null }],
                },
                data: { lastViewedSessionSeq: 4 },
            });
            expect(res).toEqual({
                ok: true,
                lastViewedSessionSeq: 4,
                participantCursors: [{ accountId: "u1", cursor: 200 }],
                badgeAttentionChanged: false,
            });
        });

        it("returns ok without marking participants when the incoming cursor does not advance", async () => {
            currentTx.session.findUnique
                .mockResolvedValueOnce({ accountId: "u1" })
                .mockResolvedValueOnce({
                    seq: 8,
                    lastViewedSessionSeq: 5,
                    pendingCount: 0,
                    pendingPermissionRequestCount: 0,
                    pendingUserActionRequestCount: 0,
                    active: true,
                    archivedAt: null,
                });
            currentTx.sessionShare.findUnique.mockResolvedValue(null);

            const res = await updateSessionReadCursor({
                actorUserId: "u1",
                sessionId: "s1",
                lastViewedSessionSeq: 4,
            });

            expect(currentTx.session.updateMany).not.toHaveBeenCalled();
            expect(markAccountChanged).not.toHaveBeenCalled();
            expect(res).toEqual({
                ok: true,
                lastViewedSessionSeq: 5,
                participantCursors: [],
                badgeAttentionChanged: false,
            });
        });
    });

    describe("applySessionTurnMutation", () => {
        const completedMutation = {
            v: 1,
            sessionId: "s1",
            mutationId: "mutation-completed",
            action: "complete",
            turnId: "turn-1",
            provider: "codex",
            providerTurnId: "provider-turn-1",
            observedAt: 200,
        } as const;

        it("does not create a terminal turn row when the turn is missing", async () => {
            currentTx.session.findUnique
                .mockResolvedValueOnce({ accountId: "u1" })
                .mockResolvedValueOnce({
                    id: "s1",
                    seq: 5,
                    lastViewedSessionSeq: 5,
                    pendingCount: 0,
                    pendingPermissionRequestCount: 0,
                    pendingUserActionRequestCount: 0,
                    latestTurnStatus: null,
                    latestTurnStatusObservedAt: null,
                    latestTurnId: null,
                    lastRuntimeIssue: null,
                    active: true,
                    archivedAt: null,
                });
            currentTx.sessionShare.findUnique.mockResolvedValue(null);
            currentTx.sessionTurnMutationReceipt.findUnique.mockResolvedValue(null);
            currentTx.sessionTurn.findMany.mockResolvedValue([]);
            currentTx.sessionTurnMutationReceipt.create.mockResolvedValue({});

            const res = await applySessionTurnMutation({
                actorUserId: "u1",
                mutation: completedMutation,
            });

            expect(currentTx.sessionTurnMutationReceipt.findUnique).toHaveBeenCalledWith({
                where: { sessionId_mutationId: { sessionId: "s1", mutationId: "mutation-completed" } },
            });
            expect(currentTx.sessionTurn.create).not.toHaveBeenCalled();
            expect(currentTx.sessionTurn.update).not.toHaveBeenCalled();
            expect(currentTx.sessionTurnMutationReceipt.create).toHaveBeenCalledWith({
                data: expect.objectContaining({
                    sessionId: "s1",
                    mutationId: "mutation-completed",
                    turnId: "turn-1",
                    action: "complete",
                    decision: "missing-turn",
                    observedAt: BigInt(200),
                }),
            });
            expect(currentTx.session.update).not.toHaveBeenCalled();
            expect(currentTx.session.updateMany).not.toHaveBeenCalled();
            expect(markAccountChanged).not.toHaveBeenCalled();
            expect(res).toEqual({
                ok: true,
                didApply: false,
                reason: "missing-turn",
                receipt: expect.objectContaining({
                    v: 1,
                    sessionId: "s1",
                    mutationId: "mutation-completed",
                    turnId: "turn-1",
                    action: "complete",
                    decision: "missing-turn",
                    observedAt: 200,
                }),
                latestTurnId: null,
                latestTurnStatus: null,
                latestTurnStatusObservedAt: null,
                lastRuntimeIssue: null,
                participantCursors: [],
                badgeAttentionChanged: false,
            });
        });

        it("terminalizes an existing in-progress turn", async () => {
            currentTx.session.findUnique
                .mockResolvedValueOnce({ accountId: "u1" })
                .mockResolvedValueOnce({
                    id: "s1",
                    seq: 5,
                    lastViewedSessionSeq: 5,
                    pendingCount: 0,
                    pendingPermissionRequestCount: 0,
                    pendingUserActionRequestCount: 0,
                    latestTurnStatus: "in_progress",
                    latestTurnStatusObservedAt: 100,
                    latestTurnId: "turn-1",
                    lastRuntimeIssue: null,
                    active: true,
                    archivedAt: null,
                });
            currentTx.sessionShare.findUnique.mockResolvedValue(null);
            currentTx.sessionTurnMutationReceipt.findUnique.mockResolvedValue(null);
            currentTx.sessionTurn.findMany.mockResolvedValue([{
                turnId: "turn-1",
                provider: "codex",
                providerTurnId: "provider-turn-1",
                status: "in_progress",
                startedAt: BigInt(100),
                updatedAt: BigInt(100),
                terminalAt: null,
                lastRuntimeIssueJson: null,
                transcriptAnchorsJson: null,
                rollbackState: null,
                rollbackReason: null,
                providerRollbackOrdinal: null,
                rollbackUpdatedAt: null,
                lastMutationId: "mutation-begin",
            }]);
            currentTx.sessionTurn.update.mockResolvedValue({});
            currentTx.sessionTurnMutationReceipt.create.mockResolvedValue({});
            currentTx.session.update.mockResolvedValue({});
            getSessionParticipantUserIds.mockResolvedValue(["u1"]);
            markAccountChanged.mockResolvedValueOnce(101);

            const res = await applySessionTurnMutation({
                actorUserId: "u1",
                mutation: completedMutation,
            });

            expect(currentTx.sessionTurn.update).toHaveBeenCalledWith({
                where: { sessionId_turnId: { sessionId: "s1", turnId: "turn-1" } },
                data: expect.objectContaining({
                    status: "completed",
                    terminalAt: BigInt(200),
                    updatedAt: BigInt(200),
                    lastMutationId: "mutation-completed",
                }),
            });
            expect(currentTx.session.update).toHaveBeenCalledWith({
                where: { id: "s1" },
                data: expect.objectContaining({
                    latestTurnId: "turn-1",
                    latestTurnStatus: "completed",
                    latestTurnStatusObservedAt: BigInt(200),
                    lastRuntimeIssue: null,
                    thinking: false,
                    thinkingAt: new Date(200),
                }),
            });
            expect(res).toEqual({
                ok: true,
                didApply: true,
                receipt: expect.objectContaining({
                    v: 1,
                    sessionId: "s1",
                    mutationId: "mutation-completed",
                    turnId: "turn-1",
                    action: "complete",
                    decision: "applied",
                    observedAt: 200,
                }),
                latestTurnId: "turn-1",
                latestTurnStatus: "completed",
                latestTurnStatusObservedAt: 200,
                lastRuntimeIssue: null,
                participantCursors: [{ accountId: "u1", cursor: 101 }],
                badgeAttentionChanged: false,
            });
        });

        it("rejects session turn mutations from shared edit actors", async () => {
            currentTx.session.findUnique.mockResolvedValueOnce({ accountId: "owner" });
            currentTx.sessionShare.findUnique.mockResolvedValue({ accessLevel: "edit" });

            const res = await applySessionTurnMutation({
                actorUserId: "u2",
                mutation: completedMutation,
            });

            expect(res).toEqual({ ok: false, error: "forbidden" });
            expect(currentTx.session.updateMany).not.toHaveBeenCalled();
            expect(markAccountChanged).not.toHaveBeenCalled();
        });

        it("treats duplicate mutation ids from receipts as acknowledged no-ops", async () => {
            currentTx.session.findUnique
                .mockResolvedValueOnce({ accountId: "u1" })
                .mockResolvedValueOnce({
                    id: "s1",
                    seq: 5,
                    lastViewedSessionSeq: 5,
                    pendingCount: 0,
                    pendingPermissionRequestCount: 0,
                    pendingUserActionRequestCount: 0,
                    latestTurnId: "turn-1",
                    latestTurnStatus: "completed",
                    latestTurnStatusObservedAt: 200,
                    lastRuntimeIssue: null,
                    active: true,
                    archivedAt: null,
                });
            currentTx.sessionShare.findUnique.mockResolvedValue(null);
            currentTx.sessionTurnMutationReceipt.findUnique.mockResolvedValue({
                sessionId: "s1",
                mutationId: "mutation-completed",
                turnId: "turn-1",
                action: "complete",
                decision: "applied",
                observedAt: BigInt(200),
                appliedAt: BigInt(201),
            });

            const res = await applySessionTurnMutation({
                actorUserId: "u1",
                mutation: completedMutation,
            });

            expect(currentTx.sessionTurnMutationReceipt.findUnique).toHaveBeenCalledWith({
                where: { sessionId_mutationId: { sessionId: "s1", mutationId: "mutation-completed" } },
            });
            expect(currentTx.sessionTurn.findMany).not.toHaveBeenCalled();
            expect(currentTx.sessionTurn.create).not.toHaveBeenCalled();
            expect(currentTx.sessionTurn.update).not.toHaveBeenCalled();
            expect(currentTx.sessionTurnMutationReceipt.create).not.toHaveBeenCalled();
            expect(currentTx.session.updateMany).not.toHaveBeenCalled();
            expect(currentTx.session.update).not.toHaveBeenCalled();
            expect(markAccountChanged).not.toHaveBeenCalled();
            expect(res).toEqual({
                ok: true,
                didApply: false,
                reason: "duplicate-mutation",
                receipt: {
                    v: 1,
                    sessionId: "s1",
                    mutationId: "mutation-completed",
                    turnId: "turn-1",
                    action: "complete",
                    decision: "applied",
                    observedAt: 200,
                    appliedAt: 201,
                },
                latestTurnId: "turn-1",
                latestTurnStatus: "completed",
                latestTurnStatusObservedAt: 200,
                lastRuntimeIssue: null,
                participantCursors: [],
                badgeAttentionChanged: false,
            });
        });

        it("replays the stored duplicate receipt after a begin-turn P2002 race", async () => {
            currentTx.session.findUnique
                .mockResolvedValueOnce({ accountId: "u1" })
                .mockResolvedValueOnce({
                    id: "s1",
                    seq: 5,
                    lastViewedSessionSeq: 5,
                    pendingCount: 0,
                    pendingPermissionRequestCount: 0,
                    pendingUserActionRequestCount: 0,
                    latestTurnId: null,
                    latestTurnStatus: null,
                    latestTurnStatusObservedAt: null,
                    lastRuntimeIssue: null,
                    active: true,
                    archivedAt: null,
                })
                .mockResolvedValueOnce({ accountId: "u1" })
                .mockResolvedValueOnce({
                    id: "s1",
                    seq: 5,
                    lastViewedSessionSeq: 5,
                    pendingCount: 0,
                    pendingPermissionRequestCount: 0,
                    pendingUserActionRequestCount: 0,
                    latestTurnId: "turn-1",
                    latestTurnStatus: "in_progress",
                    latestTurnStatusObservedAt: BigInt(100),
                    lastRuntimeIssue: null,
                    active: true,
                    archivedAt: null,
                });
            currentTx.sessionShare.findUnique.mockResolvedValue(null);
            currentTx.sessionTurnMutationReceipt.findUnique
                .mockResolvedValueOnce(null)
                .mockResolvedValueOnce({
                    sessionId: "s1",
                    mutationId: "mutation-begin-race",
                    turnId: "turn-1",
                    action: "begin",
                    decision: "applied",
                    observedAt: BigInt(100),
                    appliedAt: BigInt(101),
                });
            currentTx.sessionTurn.findMany.mockResolvedValue([]);
            currentTx.sessionTurn.create.mockRejectedValue({ code: "P2002", meta: { target: ["sessionId", "turnId"] } });

            const res = await applySessionTurnMutation({
                actorUserId: "u1",
                mutation: {
                    v: 1,
                    sessionId: "s1",
                    mutationId: "mutation-begin-race",
                    action: "begin",
                    turnId: "turn-1",
                    provider: "codex",
                    observedAt: 100,
                },
            });

            expect(res).toEqual({
                ok: true,
                didApply: false,
                reason: "duplicate-mutation",
                receipt: {
                    v: 1,
                    sessionId: "s1",
                    mutationId: "mutation-begin-race",
                    turnId: "turn-1",
                    action: "begin",
                    decision: "applied",
                    observedAt: 100,
                    appliedAt: 101,
                },
                latestTurnId: "turn-1",
                latestTurnStatus: "in_progress",
                latestTurnStatusObservedAt: 100,
                lastRuntimeIssue: null,
                participantCursors: [],
                badgeAttentionChanged: false,
            });
        });

        it("replays the stored duplicate receipt after a receipt-create P2002 race", async () => {
            currentTx.session.findUnique
                .mockResolvedValueOnce({ accountId: "u1" })
                .mockResolvedValueOnce({
                    id: "s1",
                    seq: 5,
                    lastViewedSessionSeq: 5,
                    pendingCount: 0,
                    pendingPermissionRequestCount: 0,
                    pendingUserActionRequestCount: 0,
                    latestTurnStatus: "in_progress",
                    latestTurnStatusObservedAt: 100,
                    latestTurnId: "turn-1",
                    lastRuntimeIssue: null,
                    active: true,
                    archivedAt: null,
                })
                .mockResolvedValueOnce({ accountId: "u1" })
                .mockResolvedValueOnce({
                    id: "s1",
                    seq: 5,
                    lastViewedSessionSeq: 5,
                    pendingCount: 0,
                    pendingPermissionRequestCount: 0,
                    pendingUserActionRequestCount: 0,
                    latestTurnStatus: "completed",
                    latestTurnStatusObservedAt: BigInt(200),
                    latestTurnId: "turn-1",
                    lastRuntimeIssue: null,
                    active: true,
                    archivedAt: null,
                });
            currentTx.sessionShare.findUnique.mockResolvedValue(null);
            currentTx.sessionTurnMutationReceipt.findUnique
                .mockResolvedValueOnce(null)
                .mockResolvedValueOnce({
                    sessionId: "s1",
                    mutationId: "mutation-completed",
                    turnId: "turn-1",
                    action: "complete",
                    decision: "applied",
                    observedAt: BigInt(200),
                    appliedAt: BigInt(200),
                });
            currentTx.sessionTurn.findMany.mockResolvedValue([{
                turnId: "turn-1",
                provider: "codex",
                providerTurnId: "provider-turn-1",
                status: "in_progress",
                startedAt: BigInt(100),
                updatedAt: BigInt(100),
                terminalAt: null,
                lastRuntimeIssueJson: null,
                transcriptAnchorsJson: null,
                rollbackState: null,
                rollbackReason: null,
                providerRollbackOrdinal: null,
                rollbackUpdatedAt: null,
                lastMutationId: "mutation-begin",
            }]);
            currentTx.sessionTurn.update.mockResolvedValue({});
            currentTx.session.update.mockResolvedValue({});
            currentTx.sessionTurnMutationReceipt.create.mockRejectedValue({ code: "P2002", meta: { target: ["sessionId", "mutationId"] } });

            const res = await applySessionTurnMutation({
                actorUserId: "u1",
                mutation: completedMutation,
            });

            expect(res).toEqual({
                ok: true,
                didApply: false,
                reason: "duplicate-mutation",
                receipt: {
                    v: 1,
                    sessionId: "s1",
                    mutationId: "mutation-completed",
                    turnId: "turn-1",
                    action: "complete",
                    decision: "applied",
                    observedAt: 200,
                    appliedAt: 200,
                },
                latestTurnId: "turn-1",
                latestTurnStatus: "completed",
                latestTurnStatusObservedAt: 200,
                lastRuntimeIssue: null,
                participantCursors: [],
                badgeAttentionChanged: false,
            });
        });

        it("keeps rollback state separate from lifecycle status", async () => {
            currentTx.session.findUnique
                .mockResolvedValueOnce({ accountId: "u1" })
                .mockResolvedValueOnce({
                    id: "s1",
                    seq: 5,
                    lastViewedSessionSeq: 5,
                    pendingCount: 0,
                    pendingPermissionRequestCount: 0,
                    pendingUserActionRequestCount: 0,
                    latestTurnId: "turn-1",
                    latestTurnStatus: "completed",
                    latestTurnStatusObservedAt: 200,
                    lastRuntimeIssue: null,
                    active: true,
                    archivedAt: null,
                });
            currentTx.sessionShare.findUnique.mockResolvedValue(null);
            currentTx.sessionTurnMutationReceipt.findUnique.mockResolvedValue(null);
            currentTx.sessionTurn.findMany.mockResolvedValue([{
                turnId: "turn-1",
                provider: "codex",
                providerTurnId: "provider-turn-1",
                status: "completed",
                startedAt: BigInt(100),
                updatedAt: BigInt(200),
                terminalAt: BigInt(200),
                lastRuntimeIssueJson: null,
                transcriptAnchorsJson: null,
                rollbackState: null,
                rollbackReason: null,
                providerRollbackOrdinal: null,
                rollbackUpdatedAt: null,
                lastMutationId: "mutation-completed",
            }]);
            currentTx.sessionTurn.update.mockResolvedValue({});
            currentTx.sessionTurnMutationReceipt.create.mockResolvedValue({});
            currentTx.session.update.mockResolvedValue({});
            getSessionParticipantUserIds.mockResolvedValue(["u1"]);
            markAccountChanged.mockResolvedValueOnce(102);

            const res = await applySessionTurnMutation({
                actorUserId: "u1",
                mutation: {
                    ...completedMutation,
                    mutationId: "mutation-rollback",
                    action: "mark_rolled_back",
                    observedAt: 300,
                    reason: "user_rollback",
                },
            });

            expect(currentTx.sessionTurn.update).toHaveBeenCalledWith({
                where: { sessionId_turnId: { sessionId: "s1", turnId: "turn-1" } },
                data: expect.objectContaining({
                    rollbackState: "rolled_back",
                    rollbackReason: "user_rollback",
                    rollbackUpdatedAt: BigInt(300),
                }),
            });
            expect(currentTx.session.update).toHaveBeenCalledWith(expect.objectContaining({
                data: expect.objectContaining({
                    latestTurnId: "turn-1",
                    latestTurnStatus: "completed",
                    latestTurnStatusObservedAt: BigInt(200),
                    lastRuntimeIssue: null,
                }),
            }));
            expect(res).toMatchObject({
                ok: true,
                didApply: true,
                latestTurnId: "turn-1",
                latestTurnStatus: "completed",
                latestTurnStatusObservedAt: 200,
                lastRuntimeIssue: null,
            });
        });

        it("does not mark rollback eligible without trusted transcript anchors", async () => {
            currentTx.session.findUnique
                .mockResolvedValueOnce({ accountId: "u1" })
                .mockResolvedValueOnce({
                    id: "s1",
                    seq: 5,
                    lastViewedSessionSeq: 5,
                    pendingCount: 0,
                    pendingPermissionRequestCount: 0,
                    pendingUserActionRequestCount: 0,
                    latestTurnId: "turn-1",
                    latestTurnStatus: "completed",
                    latestTurnStatusObservedAt: 200,
                    lastRuntimeIssue: null,
                    active: true,
                    archivedAt: null,
                });
            currentTx.sessionShare.findUnique.mockResolvedValue(null);
            currentTx.sessionTurnMutationReceipt.findUnique.mockResolvedValue(null);
            currentTx.sessionTurn.findMany.mockResolvedValue([{
                turnId: "turn-1",
                provider: "codex",
                providerTurnId: "provider-turn-1",
                status: "completed",
                startedAt: BigInt(100),
                updatedAt: BigInt(200),
                terminalAt: BigInt(200),
                lastRuntimeIssueJson: null,
                transcriptAnchorsJson: null,
                rollbackState: null,
                rollbackReason: null,
                providerRollbackOrdinal: null,
                rollbackUpdatedAt: null,
                lastMutationId: "mutation-completed",
            }]);
            currentTx.sessionTurnMutationReceipt.create.mockResolvedValue({});

            const res = await applySessionTurnMutation({
                actorUserId: "u1",
                mutation: {
                    ...completedMutation,
                    mutationId: "mutation-rollback-eligible-without-anchors",
                    action: "mark_rollback_eligible",
                    observedAt: 300,
                },
            });

            expect(currentTx.sessionTurn.update).not.toHaveBeenCalled();
            expect(currentTx.session.update).not.toHaveBeenCalled();
            expect(currentTx.sessionTurnMutationReceipt.create).toHaveBeenCalledWith({
                data: expect.objectContaining({
                    sessionId: "s1",
                    mutationId: "mutation-rollback-eligible-without-anchors",
                    turnId: "turn-1",
                    action: "mark_rollback_eligible",
                    decision: "stale-terminal",
                }),
            });
            expect(res).toMatchObject({
                ok: true,
                didApply: false,
                reason: "stale-terminal",
                latestTurnId: "turn-1",
                latestTurnStatus: "completed",
                latestTurnStatusObservedAt: 200,
                lastRuntimeIssue: null,
            });
        });

        it("does not let lifecycle terminal mutations author rollback state", async () => {
            currentTx.session.findUnique
                .mockResolvedValueOnce({ accountId: "u1" })
                .mockResolvedValueOnce({
                    id: "s1",
                    seq: 5,
                    lastViewedSessionSeq: 5,
                    pendingCount: 0,
                    pendingPermissionRequestCount: 0,
                    pendingUserActionRequestCount: 0,
                    latestTurnStatus: "in_progress",
                    latestTurnStatusObservedAt: 100,
                    latestTurnId: "turn-1",
                    lastRuntimeIssue: null,
                    active: true,
                    archivedAt: null,
                });
            currentTx.sessionShare.findUnique.mockResolvedValue(null);
            currentTx.sessionTurnMutationReceipt.findUnique.mockResolvedValue(null);
            currentTx.sessionTurn.findMany.mockResolvedValue([{
                turnId: "turn-1",
                provider: "codex",
                providerTurnId: "provider-turn-1",
                status: "in_progress",
                startedAt: BigInt(100),
                updatedAt: BigInt(100),
                terminalAt: null,
                lastRuntimeIssueJson: null,
                transcriptAnchorsJson: null,
                rollbackState: null,
                rollbackReason: null,
                providerRollbackOrdinal: null,
                rollbackUpdatedAt: null,
                lastMutationId: "mutation-begin",
            }]);
            currentTx.sessionTurn.update.mockResolvedValue({});
            currentTx.sessionTurnMutationReceipt.create.mockResolvedValue({});
            currentTx.session.update.mockResolvedValue({});
            getSessionParticipantUserIds.mockResolvedValue(["u1"]);
            markAccountChanged.mockResolvedValueOnce(105);

            const res = await applySessionTurnMutation({
                actorUserId: "u1",
                mutation: {
                    ...completedMutation,
                    rollback: { state: "eligible", reason: "terminal_payload" },
                },
            });

            expect(res).toEqual({ ok: false, error: "invalid-params" });
            expect(currentTx.sessionTurn.update).not.toHaveBeenCalled();
        });

        it("attaches a late provider turn id without changing the session turn id", async () => {
            currentTx.session.findUnique
                .mockResolvedValueOnce({ accountId: "u1" })
                .mockResolvedValueOnce({
                    id: "s1",
                    seq: 5,
                    lastViewedSessionSeq: 5,
                    pendingCount: 0,
                    pendingPermissionRequestCount: 0,
                    pendingUserActionRequestCount: 0,
                    latestTurnId: "turn-1",
                    latestTurnStatus: "in_progress",
                    latestTurnStatusObservedAt: 100,
                    lastRuntimeIssue: null,
                    active: true,
                    archivedAt: null,
                });
            currentTx.sessionShare.findUnique.mockResolvedValue(null);
            currentTx.sessionTurnMutationReceipt.findUnique.mockResolvedValue(null);
            currentTx.sessionTurn.findMany.mockResolvedValue([{
                turnId: "turn-1",
                provider: "codex",
                providerTurnId: null,
                status: "in_progress",
                startedAt: BigInt(100),
                updatedAt: BigInt(100),
                terminalAt: null,
                lastRuntimeIssueJson: null,
                transcriptAnchorsJson: null,
                rollbackState: null,
                rollbackReason: null,
                providerRollbackOrdinal: null,
                rollbackUpdatedAt: null,
                lastMutationId: "mutation-begin",
            }]);
            currentTx.sessionTurn.update.mockResolvedValue({});
            currentTx.sessionTurnMutationReceipt.create.mockResolvedValue({});
            currentTx.session.update.mockResolvedValue({});
            getSessionParticipantUserIds.mockResolvedValue(["u1"]);
            markAccountChanged.mockResolvedValueOnce(103);

            const res = await applySessionTurnMutation({
                actorUserId: "u1",
                mutation: {
                    ...completedMutation,
                    mutationId: "mutation-provider-turn",
                    action: "attach_provider_turn_id",
                    observedAt: 150,
                },
            });

            expect(currentTx.sessionTurn.update).toHaveBeenCalledWith({
                where: { sessionId_turnId: { sessionId: "s1", turnId: "turn-1" } },
                data: expect.objectContaining({
                    providerTurnId: "provider-turn-1",
                    updatedAt: BigInt(150),
                }),
            });
            expect(currentTx.session.update).toHaveBeenCalledWith({
                where: { id: "s1" },
                data: expect.objectContaining({
                    latestTurnId: "turn-1",
                    latestTurnStatus: "in_progress",
                    latestTurnStatusObservedAt: BigInt(150),
                    lastRuntimeIssue: null,
                    thinking: true,
                    thinkingAt: new Date(150),
                }),
            });
            expect(res).toMatchObject({
                ok: true,
                didApply: true,
                latestTurnId: "turn-1",
                latestTurnStatus: "in_progress",
                latestTurnStatusObservedAt: 150,
            });
        });

        it("lets a newer turn become in progress after the previous turn is terminal", async () => {
            currentTx.session.findUnique
                .mockResolvedValueOnce({ accountId: "u1" })
                .mockResolvedValueOnce({
                    id: "s1",
                    seq: 5,
                    lastViewedSessionSeq: 5,
                    pendingCount: 0,
                    pendingPermissionRequestCount: 0,
                    pendingUserActionRequestCount: 0,
                    latestTurnId: "turn-1",
                    latestTurnStatus: "completed",
                    latestTurnStatusObservedAt: 200,
                    lastRuntimeIssue: null,
                    active: true,
                    archivedAt: null,
                });
            currentTx.sessionShare.findUnique.mockResolvedValue(null);
            currentTx.sessionTurnMutationReceipt.findUnique.mockResolvedValue(null);
            currentTx.sessionTurn.findMany.mockResolvedValue([{
                turnId: "turn-1",
                provider: "codex",
                providerTurnId: "provider-turn-1",
                status: "completed",
                startedAt: BigInt(100),
                updatedAt: BigInt(200),
                terminalAt: BigInt(200),
                lastRuntimeIssueJson: null,
                transcriptAnchorsJson: null,
                rollbackState: null,
                rollbackReason: null,
                providerRollbackOrdinal: null,
                rollbackUpdatedAt: null,
                lastMutationId: "mutation-completed",
            }]);
            currentTx.sessionTurn.create.mockResolvedValue({});
            currentTx.sessionTurnMutationReceipt.create.mockResolvedValue({});
            currentTx.session.update.mockResolvedValue({});
            getSessionParticipantUserIds.mockResolvedValue(["u1"]);
            markAccountChanged.mockResolvedValueOnce(104);

            const res = await applySessionTurnMutation({
                actorUserId: "u1",
                mutation: {
                    ...completedMutation,
                    mutationId: "mutation-begin-next",
                    action: "begin",
                    turnId: "turn-2",
                    providerTurnId: undefined,
                    observedAt: 300,
                },
            });

            expect(currentTx.sessionTurn.create).toHaveBeenCalledWith({
                data: expect.objectContaining({
                    sessionId: "s1",
                    turnId: "turn-2",
                    provider: "codex",
                    status: "in_progress",
                    startedAt: BigInt(300),
                    updatedAt: BigInt(300),
                }),
            });
            expect(currentTx.sessionTurn.create.mock.calls[0]?.[0]?.data).not.toHaveProperty("providerTurnId");
            expect(currentTx.session.update).toHaveBeenCalledWith({
                where: { id: "s1" },
                data: expect.objectContaining({
                    latestTurnId: "turn-2",
                    latestTurnStatus: "in_progress",
                    latestTurnStatusObservedAt: BigInt(300),
                    lastRuntimeIssue: null,
                }),
            });
            expect(res).toMatchObject({
                ok: true,
                didApply: true,
                latestTurnId: "turn-2",
                latestTurnStatus: "in_progress",
                latestTurnStatusObservedAt: 300,
            });
        });

        it("does not let a stale begin reopen a terminal turn", async () => {
            currentTx.session.findUnique
                .mockResolvedValueOnce({ accountId: "u1" })
                .mockResolvedValueOnce({
                    id: "s1",
                    seq: 5,
                    lastViewedSessionSeq: 5,
                    pendingCount: 0,
                    pendingPermissionRequestCount: 0,
                    pendingUserActionRequestCount: 0,
                    latestTurnId: "turn-1",
                    latestTurnStatus: "completed",
                    latestTurnStatusObservedAt: 200,
                    lastRuntimeIssue: null,
                    active: true,
                    archivedAt: null,
                });
            currentTx.sessionShare.findUnique.mockResolvedValue(null);
            currentTx.sessionTurnMutationReceipt.findUnique.mockResolvedValue(null);
            currentTx.sessionTurn.findMany.mockResolvedValue([{
                turnId: "turn-1",
                provider: "codex",
                providerTurnId: "provider-turn-1",
                status: "completed",
                startedAt: BigInt(100),
                updatedAt: BigInt(200),
                terminalAt: BigInt(200),
                lastRuntimeIssueJson: null,
                transcriptAnchorsJson: null,
                rollbackState: null,
                rollbackReason: null,
                providerRollbackOrdinal: null,
                rollbackUpdatedAt: null,
                lastMutationId: "mutation-completed",
            }]);

            const res = await applySessionTurnMutation({
                actorUserId: "u1",
                mutation: {
                    ...completedMutation,
                    mutationId: "mutation-stale",
                    action: "begin",
                    observedAt: 100,
                },
            });

            expect(currentTx.sessionTurn.update).not.toHaveBeenCalled();
            expect(currentTx.sessionTurn.create).not.toHaveBeenCalled();
            expect(currentTx.session.update).not.toHaveBeenCalled();
            expect(currentTx.sessionTurnMutationReceipt.create).toHaveBeenCalledWith({
                data: expect.objectContaining({
                    sessionId: "s1",
                    mutationId: "mutation-stale",
                    turnId: "turn-1",
                    action: "begin",
                    decision: "stale-in-progress",
                }),
            });
            expect(markAccountChanged).not.toHaveBeenCalled();
            expect(res).toEqual({
                ok: true,
                didApply: false,
                reason: "stale-in-progress",
                receipt: expect.objectContaining({
                    sessionId: "s1",
                    mutationId: "mutation-stale",
                    turnId: "turn-1",
                    action: "begin",
                    decision: "stale-in-progress",
                    observedAt: 100,
                }),
                latestTurnId: "turn-1",
                latestTurnStatus: "completed",
                latestTurnStatusObservedAt: 200,
                lastRuntimeIssue: null,
                participantCursors: [],
                badgeAttentionChanged: false,
            });
        });

        it("rejects malformed session turn mutations before access lookup", async () => {
            const res = await applySessionTurnMutation({
                actorUserId: "u1",
                mutation: {
                    ...completedMutation,
                    mutationId: "",
                },
            });

            expect(res).toEqual({ ok: false, error: "invalid-params" });
            expect(currentTx.session.findUnique).not.toHaveBeenCalled();
            expect(currentTx.session.updateMany).not.toHaveBeenCalled();
        });
    });

    describe("applySessionReadCursorOperation", () => {
        it("marks unread by lowering the cursor with a lowering-aware write", async () => {
            currentTx.session.findUnique
                .mockResolvedValueOnce({ accountId: "u1" })
                .mockResolvedValueOnce({
                    seq: 8,
                    lastViewedSessionSeq: 8,
                    pendingCount: 0,
                    pendingPermissionRequestCount: 0,
                    pendingUserActionRequestCount: 0,
                    active: true,
                    archivedAt: null,
                });
            currentTx.sessionShare.findUnique.mockResolvedValue(null);
            currentTx.session.updateMany.mockResolvedValue({ count: 1 });
            getSessionParticipantUserIds.mockResolvedValue(["u1"]);
            markAccountChanged.mockResolvedValueOnce(200);

            const res = await applySessionReadCursorOperation({
                actorUserId: "u1",
                sessionId: "s1",
                operation: { kind: "mark-unread" },
            });

            expect(currentTx.session.updateMany).toHaveBeenCalledWith({
                where: {
                    id: "s1",
                    lastViewedSessionSeq: { gt: 7 },
                },
                data: { lastViewedSessionSeq: 7 },
            });
            expect(res).toEqual({
                ok: true,
                lastViewedSessionSeq: 7,
                participantCursors: [{ accountId: "u1", cursor: 200 }],
                badgeAttentionChanged: true,
                didChange: true,
                readState: "unread",
            });
        });

        it("marks unread below the latest readable main transcript seq when raw session seq is ahead", async () => {
            currentTx.session.findUnique
                .mockResolvedValueOnce({ accountId: "u1" })
                .mockResolvedValueOnce({
                    seq: 742,
                    lastViewedSessionSeq: 742,
                    latestReadyEventSeq: 110,
                    latestTurnStatus: "completed",
                    pendingCount: 0,
                    pendingBlockedCount: 0,
                    pendingPermissionRequestCount: 0,
                    pendingUserActionRequestCount: 0,
                    active: true,
                    archivedAt: null,
                });
            currentTx.sessionMessage.findMany.mockResolvedValue([
                {
                    seq: 742,
                    localId: "connected-service-account-switch-attempt:ok:restart_requested:manual:restart:succeeded:restarted:none",
                    messageRole: "event",
                    content: { t: "encrypted", c: "cipher-742" },
                },
                {
                    seq: 741,
                    localId: "connected-service-account-switch-attempt:failed:hot_applied:manual:hot_apply:failed:none:post_switch_verification_failed",
                    messageRole: "event",
                    content: { t: "encrypted", c: "cipher-741" },
                },
                {
                    seq: 740,
                    localId: "connected-service-account-switch-attempt:failed:restart_requested:manual:restart:failed:none:profile_action_required",
                    messageRole: "event",
                    content: { t: "encrypted", c: "cipher-740" },
                },
                {
                    seq: 739,
                    localId: "claude-jsonl:main:assistant:0a9393af-3ed1-4933-ade2-c7e2b0389c00",
                    messageRole: "agent",
                    content: { t: "encrypted", c: "cipher-739" },
                },
            ]);
            currentTx.sessionShare.findUnique.mockResolvedValue(null);
            currentTx.session.updateMany.mockResolvedValue({ count: 1 });
            getSessionParticipantUserIds.mockResolvedValue(["u1"]);
            markAccountChanged.mockResolvedValueOnce(200);

            const res = await applySessionReadCursorOperation({
                actorUserId: "u1",
                sessionId: "s1",
                operation: { kind: "mark-unread" },
            });

            expect(currentTx.sessionMessage.findMany).toHaveBeenCalledWith({
                where: {
                    sessionId: "s1",
                    sidechainId: null,
                },
                orderBy: { seq: "desc" },
                take: 100,
                select: {
                    seq: true,
                    localId: true,
                    messageRole: true,
                    content: true,
                },
            });
            expect(currentTx.session.updateMany).toHaveBeenCalledWith({
                where: {
                    id: "s1",
                    lastViewedSessionSeq: { gt: 738 },
                },
                data: { lastViewedSessionSeq: 738 },
            });
            expect(res).toEqual({
                ok: true,
                lastViewedSessionSeq: 738,
                participantCursors: [{ accountId: "u1", cursor: 200 }],
                badgeAttentionChanged: true,
                didChange: true,
                readState: "unread",
            });
        });

        it("preserves null when marking unread is already represented by a missing cursor", async () => {
            currentTx.session.findUnique
                .mockResolvedValueOnce({ accountId: "u1" })
                .mockResolvedValueOnce({
                    seq: 8,
                    lastViewedSessionSeq: null,
                    pendingCount: 0,
                    pendingPermissionRequestCount: 0,
                    pendingUserActionRequestCount: 0,
                    active: true,
                    archivedAt: null,
                });
            currentTx.sessionShare.findUnique.mockResolvedValue(null);

            const res = await applySessionReadCursorOperation({
                actorUserId: "u1",
                sessionId: "s1",
                operation: { kind: "mark-unread" },
            });

            expect(currentTx.session.updateMany).not.toHaveBeenCalled();
            expect(markAccountChanged).not.toHaveBeenCalled();
            expect(res).toEqual({
                ok: true,
                lastViewedSessionSeq: null,
                participantCursors: [],
                badgeAttentionChanged: false,
                didChange: false,
                readState: "unread",
            });
        });

        it("does not make archived sessions contribute badge attention when marked unread", async () => {
            currentTx.session.findUnique
                .mockResolvedValueOnce({ accountId: "u1" })
                .mockResolvedValueOnce({
                    seq: 8,
                    lastViewedSessionSeq: 8,
                    pendingCount: 0,
                    pendingPermissionRequestCount: 0,
                    pendingUserActionRequestCount: 0,
                    active: true,
                    archivedAt: new Date(123),
                });
            currentTx.sessionShare.findUnique.mockResolvedValue(null);
            currentTx.session.updateMany.mockResolvedValue({ count: 1 });
            getSessionParticipantUserIds.mockResolvedValue(["u1"]);
            markAccountChanged.mockResolvedValueOnce(200);

            const res = await applySessionReadCursorOperation({
                actorUserId: "u1",
                sessionId: "s1",
                operation: { kind: "mark-unread" },
            });

            expect(res).toEqual({
                ok: true,
                lastViewedSessionSeq: 7,
                participantCursors: [{ accountId: "u1", cursor: 200 }],
                badgeAttentionChanged: false,
                didChange: true,
                readState: "unread",
            });
        });

        it("marks read by advancing to the current sequence", async () => {
            currentTx.session.findUnique
                .mockResolvedValueOnce({ accountId: "u1" })
                .mockResolvedValueOnce({
                    seq: 8,
                    lastViewedSessionSeq: 3,
                    pendingCount: 0,
                    pendingPermissionRequestCount: 0,
                    pendingUserActionRequestCount: 0,
                    active: true,
                    archivedAt: null,
                });
            currentTx.sessionShare.findUnique.mockResolvedValue(null);
            currentTx.session.updateMany.mockResolvedValue({ count: 1 });
            getSessionParticipantUserIds.mockResolvedValue(["u1"]);
            markAccountChanged.mockResolvedValueOnce(200);

            const res = await applySessionReadCursorOperation({
                actorUserId: "u1",
                sessionId: "s1",
                operation: { kind: "mark-read" },
            });

            expect(currentTx.session.updateMany).toHaveBeenCalledWith({
                where: {
                    id: "s1",
                    OR: [{ lastViewedSessionSeq: { lt: 8 } }, { lastViewedSessionSeq: null }],
                },
                data: { lastViewedSessionSeq: 8 },
            });
            expect(res).toEqual({
                ok: true,
                lastViewedSessionSeq: 8,
                participantCursors: [{ accountId: "u1", cursor: 200 }],
                badgeAttentionChanged: true,
                didChange: true,
                readState: "read",
            });
        });

        it("recomputes read state from a fresh session snapshot when a concurrent write wins the update", async () => {
            currentTx.session.findUnique
                .mockResolvedValueOnce({ accountId: "u1" })
                .mockResolvedValueOnce({
                    seq: 8,
                    lastViewedSessionSeq: 3,
                    pendingCount: 0,
                    pendingPermissionRequestCount: 0,
                    pendingUserActionRequestCount: 0,
                    active: true,
                    archivedAt: null,
                })
                .mockResolvedValueOnce({
                    seq: 9,
                    lastViewedSessionSeq: 8,
                });
            currentTx.sessionShare.findUnique.mockResolvedValue(null);
            currentTx.session.updateMany.mockResolvedValue({ count: 0 });

            const res = await applySessionReadCursorOperation({
                actorUserId: "u1",
                sessionId: "s1",
                operation: { kind: "mark-read" },
            });

            expect(res).toEqual({
                ok: true,
                lastViewedSessionSeq: 8,
                participantCursors: [],
                badgeAttentionChanged: false,
                didChange: false,
                readState: "unread",
            });
        });

        it("returns session-not-found when a concurrent delete wins the update", async () => {
            currentTx.session.findUnique
                .mockResolvedValueOnce({ accountId: "u1" })
                .mockResolvedValueOnce({
                    seq: 8,
                    lastViewedSessionSeq: 3,
                    pendingCount: 0,
                    pendingPermissionRequestCount: 0,
                    pendingUserActionRequestCount: 0,
                    active: true,
                    archivedAt: null,
                })
                .mockResolvedValueOnce(null);
            currentTx.sessionShare.findUnique.mockResolvedValue(null);
            currentTx.session.updateMany.mockResolvedValue({ count: 0 });

            const res = await applySessionReadCursorOperation({
                actorUserId: "u1",
                sessionId: "s1",
                operation: { kind: "mark-read" },
            });

            expect(res).toEqual({ ok: false, error: "session-not-found" });
        });
    });

    describe("patchSession", () => {
        it("returns version-mismatch with current values for requested fields", async () => {
            currentTx.session.findUnique
                .mockResolvedValueOnce({ accountId: "u1" })
                .mockResolvedValueOnce({
                    metadataVersion: 5,
                    metadata: "mCurrent",
                    agentStateVersion: 9,
                    agentState: "aCurrent",
                });
            currentTx.sessionShare.findUnique.mockResolvedValue(null);

            const res = await patchSession({
                actorUserId: "u1",
                sessionId: "s1",
                metadata: { ciphertext: "mNew", expectedVersion: 4 },
                agentState: { ciphertext: null, expectedVersion: 9 },
            });

            expect(res).toEqual({
                ok: false,
                error: "version-mismatch",
                current: {
                    metadata: { version: 5, value: "mCurrent" },
                    agentState: { version: 9, value: "aCurrent" },
                },
            });
            expect(currentTx.session.updateMany).not.toHaveBeenCalled();
        });

        it("updates both fields in one CAS and marks participants once", async () => {
            currentTx.session.findUnique
                .mockResolvedValueOnce({ accountId: "u1" })
                .mockResolvedValueOnce({
                    metadataVersion: 1,
                    metadata: "m1",
                    agentStateVersion: 2,
                    agentState: "a2",
                });
            currentTx.sessionShare.findUnique.mockResolvedValue(null);
            currentTx.session.updateMany.mockResolvedValue({ count: 1 });
            getSessionParticipantUserIds.mockResolvedValue(["u1", "u2"]);
            markAccountChanged.mockResolvedValueOnce(10).mockResolvedValueOnce(11);

            const res = await patchSession({
                actorUserId: "u1",
                sessionId: "s1",
                metadata: { ciphertext: "mNew", expectedVersion: 1 },
                agentState: { ciphertext: null, expectedVersion: 2 },
            });

            expect(res).toEqual({
                ok: true,
                participantCursors: [
                    { accountId: "u1", cursor: 10 },
                    { accountId: "u2", cursor: 11 },
                ],
                metadata: { version: 2, value: "mNew" },
                agentState: { version: 3, value: null },
            });
        });
    });
});
