import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createDbMocks, installDbModuleMock } from "../api/testkit/dbMocks";

vi.mock("@/utils/logging/log", () => ({ log: vi.fn() }));

vi.mock("@/app/monitoring/metrics2", () => ({
    sessionCacheCounter: { inc: vi.fn() },
    databaseUpdatesSkippedCounter: { inc: vi.fn() },
}));

vi.mock("@/app/share/accessControl", () => ({
    checkSessionAccess: vi.fn(async () => ({
        userId: "u1",
        sessionId: "s1",
        level: "owner",
        isOwner: true,
    })),
}));

const dbMocks = createDbMocks({
    session: ["findUnique", "updateMany"],
} as const);
installDbModuleMock({ db: dbMocks.db });

describe("ActivityCache session observation", () => {
    let activityCache: typeof import("./sessionCache").activityCache | null = null;
    let sessionActive = false;

    beforeEach(() => {
        vi.clearAllMocks();
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
        sessionActive = false;
        dbMocks.reset();
        dbMocks.db.session.findUnique.mockImplementation(async () => ({
            id: "s1",
            lastActiveAt: new Date(),
            active: sessionActive,
        }));
    });

    afterEach(async () => {
        await activityCache?.shutdown();
        activityCache = null;
        vi.useRealTimers();
    });

    it("observes cached session state without enqueueing a competing presence write", async () => {
        ({ activityCache } = await import("./sessionCache"));
        activityCache.enableDbFlush();

        await expect(activityCache.isSessionValid("s1", "u1")).resolves.toBe(true);
        expect(activityCache.isSessionObservedActive("s1")).toBe(false);

        await (activityCache as any).flushPendingUpdates();

        expect(dbMocks.db.session.updateMany).not.toHaveBeenCalled();
    });

    it("reports a cached active session and expires it using the caller-provided clock", async () => {
        sessionActive = true;
        ({ activityCache } = await import("./sessionCache"));

        await expect(activityCache.isSessionValid("s1", "u1")).resolves.toBe(true);
        expect(activityCache.isSessionObservedActive("s1")).toBe(true);
        expect(activityCache.isSessionObservedActive("s1", Date.now() + 60_000)).toBe(false);
    });

    it("invalidates every cached participant observation when a session ends", async () => {
        sessionActive = true;
        ({ activityCache } = await import("./sessionCache"));

        await activityCache.isSessionValid("s1", "u1");
        await activityCache.isSessionValid("s1", "u2");

        activityCache.markSessionInactive("s1", "u1", Date.now());

        expect(activityCache.isSessionObservedActive("s1")).toBe(false);
        expect((activityCache as any).sessionCache.size).toBe(0);
        expect(dbMocks.db.session.updateMany).not.toHaveBeenCalled();
    });
});
