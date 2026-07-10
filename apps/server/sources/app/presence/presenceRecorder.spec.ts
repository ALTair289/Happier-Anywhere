import { beforeEach, describe, expect, it, vi } from "vitest";

const queueSessionUpdate = vi.fn();
const queueMachineUpdate = vi.fn();
const markSessionUpdateSent = vi.fn();
const markMachineUpdateSent = vi.fn();
vi.mock("./sessionCache", () => ({
    activityCache: { queueSessionUpdate, queueMachineUpdate, markSessionUpdateSent, markMachineUpdateSent },
}));

const shouldPublishPresenceToRedis = vi.fn();
vi.mock("./presenceMode", () => ({ shouldPublishPresenceToRedis }));

const publishSessionAlive = vi.fn(async () => {});
const publishMachineAlive = vi.fn(async () => {});
vi.mock("./presenceRedisQueue", () => ({ publishSessionAlive, publishMachineAlive }));

const reassertSessionLatestTurnStatus = vi.fn(async () => ({
    ok: true,
    didApply: true,
    latestTurnId: "turn-1",
    latestTurnStatus: "completed",
    latestTurnStatusObservedAt: 20,
    lastRuntimeIssue: null,
    participantCursors: [],
    badgeAttentionChanged: false,
}));
vi.mock("@/app/session/sessionWriteService", () => ({ reassertSessionLatestTurnStatus }));

const publishSessionTurnUpdate = vi.fn(async () => {});
vi.mock("@/app/session/turns/publishSessionTurnUpdate", () => ({ publishSessionTurnUpdate }));

vi.mock("@/utils/logging/log", () => ({ log: vi.fn() }));

describe("presenceRecorder", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        shouldPublishPresenceToRedis.mockReturnValue(true);
    });

    it("publishes session alive only when queue returns true and redis mode enabled", async () => {
        queueSessionUpdate.mockReturnValueOnce(false).mockReturnValueOnce(true);

        const { recordSessionAlive } = await import("./presenceRecorder");
        await recordSessionAlive({ accountId: "u1", sessionId: "s1", timestamp: 10, thinking: false });
        await recordSessionAlive({ accountId: "u1", sessionId: "s1", timestamp: 11, thinking: true });

        expect(queueSessionUpdate).toHaveBeenNthCalledWith(1, "s1", "u1", 10, false);
        expect(queueSessionUpdate).toHaveBeenNthCalledWith(2, "s1", "u1", 11, true);

        expect(publishSessionAlive).toHaveBeenCalledTimes(1);
        expect(publishSessionAlive).toHaveBeenCalledWith({ sessionId: "s1", timestamp: 11, accountId: "u1" });
        expect(markSessionUpdateSent).toHaveBeenCalledTimes(1);
        expect(markSessionUpdateSent).toHaveBeenCalledWith("s1", "u1", 11);
    });

    it("does not publish when redis mode disabled", async () => {
        shouldPublishPresenceToRedis.mockReturnValue(false);
        queueSessionUpdate.mockReturnValueOnce(true);

        const { recordSessionAlive } = await import("./presenceRecorder");
        await recordSessionAlive({ accountId: "u1", sessionId: "s1", timestamp: 10 });

        expect(publishSessionAlive).not.toHaveBeenCalled();
        expect(markSessionUpdateSent).not.toHaveBeenCalled();
    });

    it("replays latest turn status before the presence queue decision", async () => {
        queueSessionUpdate.mockReturnValueOnce(false);

        const { recordSessionAlive } = await import("./presenceRecorder");
        await recordSessionAlive({
            accountId: "u1",
            sessionId: "s1",
            timestamp: 20,
            thinking: false,
            latestTurnStatus: "completed",
            latestTurnStatusObservedAt: 20,
        });

        expect(reassertSessionLatestTurnStatus).toHaveBeenCalledWith({
            actorUserId: "u1",
            sessionId: "s1",
            latestTurnStatus: "completed",
            latestTurnStatusObservedAt: 20,
        });
        expect(publishSessionTurnUpdate).toHaveBeenCalledWith({
            sessionId: "s1",
            actorUserId: "u1",
            result: expect.objectContaining({
                ok: true,
                latestTurnStatus: "completed",
                latestTurnStatusObservedAt: 20,
            }),
        });
        expect(queueSessionUpdate).toHaveBeenCalledWith("s1", "u1", 20, false);
        expect(publishSessionAlive).not.toHaveBeenCalled();
    });

    it("publishes machine alive only when queue returns true and redis mode enabled", async () => {
        queueMachineUpdate.mockReturnValueOnce(true);

        const { recordMachineAlive } = await import("./presenceRecorder");
        await recordMachineAlive({ accountId: "u1", machineId: "m1", timestamp: 10 });

        expect(publishMachineAlive).toHaveBeenCalledTimes(1);
        expect(publishMachineAlive).toHaveBeenCalledWith({ accountId: "u1", machineId: "m1", timestamp: 10 });
        expect(markMachineUpdateSent).toHaveBeenCalledTimes(1);
        expect(markMachineUpdateSent).toHaveBeenCalledWith("m1", 10);
    });

    it("does not mark as sent when publish fails", async () => {
        queueSessionUpdate.mockReturnValueOnce(true);
        publishSessionAlive.mockRejectedValueOnce(new Error("redis down"));

        const { recordSessionAlive } = await import("./presenceRecorder");
        await recordSessionAlive({ accountId: "u1", sessionId: "s1", timestamp: 10 });

        expect(markSessionUpdateSent).not.toHaveBeenCalled();
    });
});
