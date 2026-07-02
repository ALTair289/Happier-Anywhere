import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createDbMocks, installDbModuleMock } from "../../api/testkit/dbMocks";

const resolveSessionPendingOwnerAccess = vi.fn(async () => ({ ok: true as const }));
vi.mock("@/app/session/pending/resolveSessionPendingAccess", () => ({
    resolveSessionPendingOwnerAccess,
}));

const dbMocks = createDbMocks({
    account: ["findUnique"],
    session: ["findUnique"],
    sessionPendingMessage: ["findFirst", "count"],
} as const);
installDbModuleMock({ db: dbMocks.db });

const txSessionFindUniqueOrThrow = vi.fn();
const txSessionUpdate = vi.fn();
const txSessionUpdateMany = vi.fn();
const txSessionPendingMessageFindFirst = vi.fn();
const txSessionPendingMessageCount = vi.fn();
const txSessionPendingMessageUpdateMany = vi.fn();
const txSessionMessageFindFirst = vi.fn();
const tx = {
    session: {
        findUniqueOrThrow: txSessionFindUniqueOrThrow,
        update: txSessionUpdate,
        updateMany: txSessionUpdateMany,
    },
    sessionPendingMessage: {
        findFirst: txSessionPendingMessageFindFirst,
        count: txSessionPendingMessageCount,
        updateMany: txSessionPendingMessageUpdateMany,
    },
    sessionMessage: {
        findFirst: txSessionMessageFindFirst,
    },
};

const inTx = vi.fn(async (run: (txArg: typeof tx) => Promise<unknown>) => {
    return await run(tx);
});
vi.mock("@/storage/inTx", () => ({
    inTx,
}));

let materializeNextPendingMessage: typeof import("./materializeNextPendingMessage").materializeNextPendingMessage;

describe("materializeNextPendingMessage (pendingCount fast path)", () => {
    beforeAll(async () => {
        ({ materializeNextPendingMessage } = await import("./materializeNextPendingMessage"));
    });

    beforeEach(() => {
        vi.clearAllMocks();
        dbMocks.reset();
        txSessionFindUniqueOrThrow.mockReset();
        txSessionUpdate.mockReset();
        txSessionUpdateMany.mockReset();
        txSessionPendingMessageFindFirst.mockReset();
        txSessionPendingMessageCount.mockReset();
        txSessionPendingMessageUpdateMany.mockReset();
        txSessionMessageFindFirst.mockReset();
        dbMocks.db.account.findUnique.mockResolvedValue({ settings: null });
        dbMocks.db.session.findUnique.mockResolvedValue({ encryptionMode: "e2ee", pendingCount: 0, pendingBlockedCount: 0, pendingVersion: 5 });
        dbMocks.db.sessionPendingMessage.findFirst.mockResolvedValue(null);
        dbMocks.db.sessionPendingMessage.count.mockResolvedValue(0);
        txSessionPendingMessageCount.mockResolvedValue(0);
        txSessionPendingMessageUpdateMany.mockResolvedValue({ count: 0 });
        txSessionMessageFindFirst.mockResolvedValue(null);
    });

    it("returns didMaterialize=false without starting a transaction when pendingCount is 0", async () => {
        const result = await materializeNextPendingMessage({ actorUserId: "u1", sessionId: "s1" });

        expect(resolveSessionPendingOwnerAccess).toHaveBeenCalledTimes(1);
        expect(dbMocks.db.session.findUnique).toHaveBeenCalledTimes(1);
        expect(dbMocks.db.sessionPendingMessage.findFirst).toHaveBeenCalledTimes(1);
        expect(inTx).not.toHaveBeenCalled();
        expect(result).toEqual({ ok: true, didMaterialize: false, pendingCount: 0, pendingBlockedCount: 0, pendingVersion: 5 });
    });

    it("defers materialization for after-runtime-idle timing while runtime activity has a valid future expiry", async () => {
        dbMocks.db.session.findUnique.mockResolvedValue({
            encryptionMode: "e2ee",
            pendingCount: 1,
            pendingBlockedCount: 0,
            pendingVersion: 7,
            runtimeActivityActiveCount: 1,
            runtimeActivityObservedAt: BigInt(Date.now()),
            runtimeActivityExpiresAt: BigInt(Date.now() + 60_000),
            runtimeActivitySourceClass: "provider_detached_task",
        });
        dbMocks.db.sessionPendingMessage.findFirst.mockResolvedValue({ localId: "queued-runtime" });
        txSessionFindUniqueOrThrow.mockResolvedValue({
            pendingCount: 1,
            pendingBlockedCount: 0,
            pendingVersion: 7,
        });
        txSessionPendingMessageFindFirst.mockResolvedValue(null);

        const result = await materializeNextPendingMessage({
            actorUserId: "u1",
            sessionId: "s1",
            deliveryTiming: "after_runtime_idle",
        });

        expect(inTx).not.toHaveBeenCalled();
        expect(result).toEqual({
            ok: true,
            didMaterialize: false,
            pendingCount: 1,
            pendingBlockedCount: 0,
            pendingVersion: 7,
            deferredReason: "runtime_activity_active",
        });
    });

    it("does not defer materialization for after-runtime-idle timing when runtime activity projection is stale even if the session is active", async () => {
        dbMocks.db.session.findUnique.mockResolvedValue({
            encryptionMode: "e2ee",
            pendingCount: 1,
            pendingBlockedCount: 0,
            pendingVersion: 7,
            active: true,
            runtimeActivityActiveCount: 1,
            runtimeActivityObservedAt: BigInt(Date.now() - 120_000),
            runtimeActivityExpiresAt: BigInt(Date.now() - 1),
            runtimeActivitySourceClass: "provider_detached_task",
        });
        dbMocks.db.sessionPendingMessage.findFirst.mockResolvedValue({ localId: "queued-runtime" });
        txSessionFindUniqueOrThrow.mockResolvedValue({
            pendingCount: 1,
            pendingBlockedCount: 0,
            pendingVersion: 7,
            active: true,
            runtimeActivityActiveCount: 1,
            runtimeActivityObservedAt: BigInt(Date.now() - 120_000),
            runtimeActivityExpiresAt: BigInt(Date.now() - 1),
            runtimeActivitySourceClass: "provider_detached_task",
        });
        txSessionPendingMessageFindFirst.mockResolvedValue(null);

        const result = await materializeNextPendingMessage({
            actorUserId: "u1",
            sessionId: "s1",
            deliveryTiming: "after_runtime_idle",
        });

        expect(inTx).toHaveBeenCalledTimes(1);
        expect(result).toEqual({
            ok: true,
            didMaterialize: false,
            pendingCount: 1,
            pendingBlockedCount: 0,
            pendingVersion: 7,
        });
    });

    it("defers materialization from the account after-runtime-idle setting without a request opt-in", async () => {
        dbMocks.db.account.findUnique.mockResolvedValue({
            settings: JSON.stringify({
                t: "plain",
                v: { sessionPendingQueueDeliveryTiming: "after_runtime_idle" },
            }),
        });
        dbMocks.db.session.findUnique.mockResolvedValue({
            encryptionMode: "e2ee",
            pendingCount: 1,
            pendingBlockedCount: 0,
            pendingVersion: 8,
            runtimeActivityActiveCount: 1,
            runtimeActivityObservedAt: BigInt(Date.now()),
            runtimeActivityExpiresAt: BigInt(Date.now() + 60_000),
            runtimeActivitySourceClass: "provider_detached_task",
        });
        dbMocks.db.sessionPendingMessage.findFirst.mockResolvedValue({ localId: "queued-runtime" });

        const result = await materializeNextPendingMessage({
            actorUserId: "u1",
            sessionId: "s1",
        });

        expect(dbMocks.db.account.findUnique).toHaveBeenCalledWith({
            where: { id: "u1" },
            select: { settings: true },
        });
        expect(inTx).not.toHaveBeenCalled();
        expect(result).toEqual({
            ok: true,
            didMaterialize: false,
            pendingCount: 1,
            pendingBlockedCount: 0,
            pendingVersion: 8,
            deferredReason: "runtime_activity_active",
        });
    });

    it("rechecks after-runtime-idle inside the transaction before claiming queued work", async () => {
        dbMocks.db.session.findUnique.mockResolvedValue({
            encryptionMode: "e2ee",
            pendingCount: 1,
            pendingBlockedCount: 0,
            pendingVersion: 9,
            runtimeActivityActiveCount: 0,
            runtimeActivityObservedAt: null,
            runtimeActivityExpiresAt: null,
            runtimeActivitySourceClass: null,
        });
        txSessionFindUniqueOrThrow.mockResolvedValue({
            pendingCount: 1,
            pendingBlockedCount: 0,
            pendingVersion: 9,
            runtimeActivityActiveCount: 1,
            runtimeActivityObservedAt: BigInt(Date.now()),
            runtimeActivityExpiresAt: BigInt(Date.now() + 60_000),
            runtimeActivitySourceClass: "provider_detached_task",
        });
        txSessionPendingMessageFindFirst.mockResolvedValue({
            localId: "queued-runtime",
            messageRole: "user",
            content: { t: "encrypted", c: "encrypted-user-message" },
            status: "queued",
            createdAt: new Date("2026-07-02T08:00:00.000Z"),
            updatedAt: new Date("2026-07-02T08:00:00.000Z"),
        });

        const result = await materializeNextPendingMessage({
            actorUserId: "u1",
            sessionId: "s1",
            deliveryState: "provider",
            deliveryTiming: "after_runtime_idle",
        });

        expect(inTx).toHaveBeenCalledTimes(1);
        expect(txSessionMessageFindFirst).not.toHaveBeenCalled();
        expect(txSessionPendingMessageUpdateMany).toHaveBeenCalledTimes(1);
        expect(result).toEqual({
            ok: true,
            didMaterialize: false,
            pendingCount: 1,
            pendingBlockedCount: 0,
            pendingVersion: 9,
            deferredReason: "runtime_activity_active",
            deliveryState: { mode: "provider", unresolved: false },
        });
    });

    it("repairs stale positive pendingCount when no queued pending message exists", async () => {
        dbMocks.db.session.findUnique.mockResolvedValue({
            encryptionMode: "e2ee",
            pendingCount: 2,
            pendingBlockedCount: 0,
            pendingVersion: 9,
        });
        txSessionFindUniqueOrThrow
            .mockResolvedValueOnce({
                pendingCount: 2,
                pendingBlockedCount: 0,
                pendingVersion: 9,
            })
            .mockResolvedValueOnce({ pendingCount: 0, pendingBlockedCount: 0, pendingVersion: 10 });
        txSessionPendingMessageFindFirst.mockResolvedValue(null);
        txSessionUpdateMany.mockResolvedValue({ count: 1 });

        const result = await materializeNextPendingMessage({ actorUserId: "u1", sessionId: "s1" });

        expect(inTx).toHaveBeenCalledTimes(1);
        expect(txSessionUpdateMany).toHaveBeenCalledWith({
            where: { id: "s1", pendingCount: 2, pendingBlockedCount: 0, pendingVersion: 9 },
            data: { pendingCount: 0, pendingBlockedCount: 0, pendingVersion: { increment: 1 } },
        });
        expect(txSessionUpdate).not.toHaveBeenCalled();
        expect(result).toEqual({ ok: true, didMaterialize: false, pendingCount: 0, pendingBlockedCount: 0, pendingVersion: 10 });
    });

    it("does not hide a concurrent pending enqueue when stale positive repair loses the version race", async () => {
        dbMocks.db.session.findUnique.mockResolvedValue({
            encryptionMode: "e2ee",
            pendingCount: 2,
            pendingBlockedCount: 0,
            pendingVersion: 9,
        });
        txSessionFindUniqueOrThrow
            .mockResolvedValueOnce({
                pendingCount: 2,
                pendingBlockedCount: 0,
                pendingVersion: 9,
            })
            .mockResolvedValueOnce({ pendingCount: 3, pendingBlockedCount: 0, pendingVersion: 10 });
        txSessionPendingMessageFindFirst.mockResolvedValue(null);
        txSessionUpdateMany.mockResolvedValue({ count: 0 });

        const result = await materializeNextPendingMessage({ actorUserId: "u1", sessionId: "s1" });

        expect(txSessionUpdateMany).toHaveBeenCalledWith({
            where: { id: "s1", pendingCount: 2, pendingBlockedCount: 0, pendingVersion: 9 },
            data: { pendingCount: 0, pendingBlockedCount: 0, pendingVersion: { increment: 1 } },
        });
        expect(txSessionUpdate).not.toHaveBeenCalled();
        expect(result).toEqual({ ok: true, didMaterialize: false, pendingCount: 3, pendingBlockedCount: 0, pendingVersion: 10 });
    });

    it("retries a benign unique-message materialization race as an idempotent no-op", async () => {
        dbMocks.db.session.findUnique.mockResolvedValue({
            encryptionMode: "e2ee",
            pendingCount: 1,
            pendingBlockedCount: 0,
            pendingVersion: 9,
        });
        inTx
            .mockRejectedValueOnce({ code: "P2002" })
            .mockImplementationOnce(async (run: (txArg: typeof tx) => Promise<unknown>) => await run(tx));
        txSessionFindUniqueOrThrow.mockResolvedValue({
            pendingCount: 0,
            pendingBlockedCount: 0,
            pendingVersion: 10,
        });
        txSessionPendingMessageFindFirst.mockResolvedValue(null);

        const result = await materializeNextPendingMessage({ actorUserId: "u1", sessionId: "s1" });

        expect(inTx).toHaveBeenCalledTimes(2);
        expect(result).toEqual({ ok: true, didMaterialize: false, pendingCount: 0, pendingBlockedCount: 0, pendingVersion: 10 });
    });
});
