import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createEnvPatcher } from "@/testkit/env";
import { createDbMocks, installDbModuleMock } from "../api/testkit/dbMocks";

let shutdownController: AbortController;

// Mocks
const xgroup = vi.fn(async () => "OK");
const xreadgroup: any = vi.fn(async () => null);
const xack = vi.fn(async () => 1);
const xautoclaim: any = vi.fn(async () => ["0-0", []]);

const getRedisClient = vi.fn(() => ({ xgroup, xreadgroup, xack, xautoclaim }));
vi.mock("@/storage/redis/redis", () => ({ getRedisClient }));

const dbMocks = createDbMocks({
    session: ["update", "updateMany"],
    machine: ["update", "updateMany"],
} as const);
installDbModuleMock({ db: dbMocks.db });

vi.mock("@/utils/runtime/forever", () => ({
    forever: (_name: string, fn: () => Promise<void>) => {
        void fn();
    },
}));

vi.mock("@/utils/process/shutdown", async () => {
    const actual = await vi.importActual<any>("@/utils/process/shutdown");
    return {
        ...actual,
        get shutdownSignal() {
            return shutdownController.signal;
        },
    };
});

vi.mock("@/utils/logging/log", () => ({ log: vi.fn() }));

describe("presenceRedisQueue worker", () => {
    const env = createEnvPatcher(["HAPPY_INSTANCE_ID"]);

    beforeEach(() => {
        vi.clearAllMocks();
        shutdownController = new AbortController();
        vi.resetModules();
        env.restore();
        dbMocks.reset();
        dbMocks.db.session.update.mockResolvedValue({});
        dbMocks.db.session.updateMany.mockResolvedValue({ count: 1 });
        dbMocks.db.machine.update.mockResolvedValue({});
        dbMocks.db.machine.updateMany.mockResolvedValue({ count: 1 });
    });

    afterEach(() => {
        env.restore();
    });

    it("ACKs delayed legacy session rows without reactivating archived or successor-owned sessions", async () => {
        env.set("HAPPY_INSTANCE_ID", "inst-1");

        // Released older servers can leave session rows in the shared stream. They do not carry
        // the authenticated machine/socket/fence provenance required by the canonical owner.
        xreadgroup.mockImplementationOnce(async (...args: any[]) => {
            shutdownController.abort();
            return [["presence:alive:v1", [
                ["1-0", ["kind", "session", "id", "archived-session", "ts", "10", "accountId", "u1"]],
                ["2-0", ["kind", "session", "id", "successor-owned-session", "ts", "20", "accountId", "u1"]],
            ]]];
        });

        const { startPresenceRedisWorker } = await import("./presenceRedisQueue");
        const worker = startPresenceRedisWorker({ flushIntervalMs: 60_000, readBlockMs: 1, readCount: 1 });

        await vi.waitFor(() => {
            expect(xautoclaim).toHaveBeenCalled();
        });

        // Not ACKed yet (we only ACK after a successful flush).
        expect(xack).not.toHaveBeenCalled();

        await worker.stop();

        // Consumer name derived from instance id
        expect((xreadgroup as any).mock.calls[0]?.[2]).toBe("inst-1");

        expect(dbMocks.db.session.updateMany).not.toHaveBeenCalled();
        expect(dbMocks.db.session.update).not.toHaveBeenCalled();
        expect(xack).toHaveBeenCalledWith("presence:alive:v1", "presence-worker", "1-0", "2-0");
    });

    it("ACKs reclaimed legacy session rows without writing session state", async () => {
        env.set("HAPPY_INSTANCE_ID", "inst-1");
        xautoclaim.mockImplementationOnce(async () => {
            return ["0-0", [["3-0", ["kind", "session", "id", "stale-session", "ts", "10", "accountId", "u1"]]]];
        });
        xreadgroup.mockImplementationOnce(async () => {
            shutdownController.abort();
            return [["presence:alive:v1", []]];
        });

        const { startPresenceRedisWorker } = await import("./presenceRedisQueue");
        const worker = startPresenceRedisWorker({ flushIntervalMs: 60_000, readBlockMs: 1, readCount: 1 });

        await vi.waitFor(() => {
            expect(xautoclaim).toHaveBeenCalled();
        });

        await worker.stop();

        expect(dbMocks.db.session.updateMany).not.toHaveBeenCalled();
        expect(dbMocks.db.session.update).not.toHaveBeenCalled();
        expect(xack).toHaveBeenCalledWith("presence:alive:v1", "presence-worker", "3-0");
    });

    it("flushes machine presence with a replaced-machine write guard", async () => {
        env.set("HAPPY_INSTANCE_ID", "inst-1");

        xreadgroup.mockImplementationOnce(async () => {
            shutdownController.abort();
            return [["presence:alive:v1", [["1-0", ["kind", "machine", "id", "m1", "ts", "10", "accountId", "u1"]]]]];
        });

        const { startPresenceRedisWorker } = await import("./presenceRedisQueue");
        const worker = startPresenceRedisWorker({ flushIntervalMs: 60_000, readBlockMs: 1, readCount: 1 });

        await vi.waitFor(() => {
            expect(xautoclaim).toHaveBeenCalled();
        });

        await worker.stop();

        expect(dbMocks.db.machine.updateMany).toHaveBeenCalledWith(expect.objectContaining({
            where: {
                accountId: "u1",
                id: "m1",
                revokedAt: null,
                replacedByMachineId: null,
                lastActiveAt: { lte: new Date(10) },
            },
            data: expect.objectContaining({ active: true, lastActiveAt: expect.any(Date) }),
        }));
        expect(dbMocks.db.machine.update).not.toHaveBeenCalled();
    });

    it("ACKs a legacy session row while retaining a failed machine row for a later flush", async () => {
        env.set("HAPPY_INSTANCE_ID", "inst-1");
        dbMocks.db.machine.updateMany
            .mockRejectedValueOnce(new Error("database unavailable"))
            .mockResolvedValueOnce({ count: 1 });

        xreadgroup.mockImplementationOnce(async () => {
            shutdownController.abort();
            return [["presence:alive:v1", [
                ["4-0", ["kind", "machine", "id", "m1", "ts", "10", "accountId", "u1"]],
                ["5-0", ["kind", "session", "id", "legacy-session", "ts", "10", "accountId", "u1"]],
            ]]];
        });

        const { startPresenceRedisWorker } = await import("./presenceRedisQueue");
        const worker = startPresenceRedisWorker({ flushIntervalMs: 60_000, readBlockMs: 1, readCount: 1 });

        await vi.waitFor(() => {
            expect(xautoclaim).toHaveBeenCalled();
        });

        await worker.stop();

        expect(dbMocks.db.machine.updateMany).toHaveBeenCalledTimes(1);
        expect(xack).toHaveBeenCalledTimes(1);
        expect(xack).toHaveBeenNthCalledWith(1, "presence:alive:v1", "presence-worker", "5-0");

        await worker.stop();

        expect(dbMocks.db.machine.updateMany).toHaveBeenCalledTimes(2);
        expect(xack).toHaveBeenCalledTimes(2);
        expect(xack).toHaveBeenNthCalledWith(2, "presence:alive:v1", "presence-worker", "4-0");
    });
});
