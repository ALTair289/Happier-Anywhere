import { beforeEach, describe, expect, it, vi } from "vitest";

const queueMachineUpdate = vi.fn();
const markMachineUpdateSent = vi.fn();
vi.mock("./sessionCache", () => ({
    activityCache: { queueMachineUpdate, markMachineUpdateSent },
}));

const shouldPublishPresenceToRedis = vi.fn();
vi.mock("./presenceMode", () => ({ shouldPublishPresenceToRedis }));

const publishMachineAlive = vi.fn(async () => {});
vi.mock("./presenceRedisQueue", () => ({ publishMachineAlive }));

vi.mock("@/utils/logging/log", () => ({ log: vi.fn() }));

describe("presenceRecorder", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        shouldPublishPresenceToRedis.mockReturnValue(true);
    });

    it("publishes machine alive only when queue returns true and redis mode is enabled", async () => {
        queueMachineUpdate.mockReturnValueOnce(true);

        const { recordMachineAlive } = await import("./presenceRecorder");
        await recordMachineAlive({ accountId: "u1", machineId: "m1", timestamp: 10 });

        expect(publishMachineAlive).toHaveBeenCalledWith({ accountId: "u1", machineId: "m1", timestamp: 10 });
        expect(markMachineUpdateSent).toHaveBeenCalledWith("m1", 10);
    });

    it("does not mark a machine update as sent when publishing fails", async () => {
        queueMachineUpdate.mockReturnValueOnce(true);
        publishMachineAlive.mockRejectedValueOnce(new Error("redis down"));

        const { recordMachineAlive } = await import("./presenceRecorder");
        await recordMachineAlive({ accountId: "u1", machineId: "m1", timestamp: 10 });

        expect(markMachineUpdateSent).not.toHaveBeenCalled();
    });

    it("does not publish machine presence when redis publishing is disabled", async () => {
        shouldPublishPresenceToRedis.mockReturnValue(false);
        queueMachineUpdate.mockReturnValueOnce(true);

        const { recordMachineAlive } = await import("./presenceRecorder");
        await recordMachineAlive({ accountId: "u1", machineId: "m1", timestamp: 10 });

        expect(publishMachineAlive).not.toHaveBeenCalled();
        expect(markMachineUpdateSent).not.toHaveBeenCalled();
    });
});
