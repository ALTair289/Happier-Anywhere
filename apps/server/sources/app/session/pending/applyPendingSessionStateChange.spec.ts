import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    markPendingStateChangedParticipants: vi.fn(async () => []),
}));

vi.mock("@/app/session/pending/markPendingStateChangedParticipants", () => ({
    markPendingStateChangedParticipants: mocks.markPendingStateChangedParticipants,
}));

vi.mock("@/app/activity/accountActivityBadge", () => ({
    didSessionActivityBadgeContributionChange: () => false,
}));

import { applyPendingSessionStateChange } from "./applyPendingSessionStateChange";

describe("applyPendingSessionStateChange", () => {
    const tx = {
        session: {
            findUniqueOrThrow: vi.fn(),
            update: vi.fn(),
            updateMany: vi.fn(),
        },
    };
    // Test fixture only implements the transaction methods exercised by this unit.
    const txFixture = tx as unknown as Parameters<typeof applyPendingSessionStateChange>[0]["tx"];

    beforeEach(() => {
        vi.clearAllMocks();
        mocks.markPendingStateChangedParticipants.mockResolvedValue([]);
        tx.session.findUniqueOrThrow.mockReset();
        tx.session.update.mockReset();
        tx.session.updateMany.mockReset();
    });

    it("uses an atomic guarded decrement so concurrent pending updates cannot drive the count below zero", async () => {
        tx.session.findUniqueOrThrow
            .mockResolvedValueOnce({
                seq: 1,
                pendingCount: 1,
                pendingBlockedCount: 0,
                pendingVersion: 7,
                lastViewedSessionSeq: 0,
                pendingPermissionRequestCount: 0,
                pendingUserActionRequestCount: 0,
                active: true,
                archivedAt: null,
            })
            .mockResolvedValueOnce({ pendingCount: 0, pendingBlockedCount: 0, pendingVersion: 8 })
            .mockResolvedValueOnce({ pendingCount: 0, pendingBlockedCount: 0, pendingVersion: 9 });
        tx.session.updateMany
            .mockResolvedValueOnce({ count: 0 })
            .mockResolvedValueOnce({ count: 1 });
        tx.session.update.mockResolvedValue({ pendingCount: -1, pendingBlockedCount: 0, pendingVersion: 8 });

        const result = await applyPendingSessionStateChange({
            tx: txFixture,
            sessionId: "s1",
            pendingCountDelta: -1,
        });

        expect(tx.session.updateMany).toHaveBeenNthCalledWith(1, {
            where: { id: "s1", pendingCount: 1, pendingBlockedCount: 0, pendingVersion: 7 },
            data: { pendingCount: 0, pendingBlockedCount: 0, pendingVersion: { increment: 1 } },
        });
        expect(tx.session.updateMany).toHaveBeenNthCalledWith(2, {
            where: { id: "s1", pendingCount: 0, pendingBlockedCount: 0, pendingVersion: 8 },
            data: { pendingCount: 0, pendingBlockedCount: 0, pendingVersion: { increment: 1 } },
        });
        expect(tx.session.update).not.toHaveBeenCalled();
        expect(result.pendingCount).toBe(0);
        expect(result.pendingBlockedCount).toBe(0);
        expect(result.pendingVersion).toBe(9);
    });
});
