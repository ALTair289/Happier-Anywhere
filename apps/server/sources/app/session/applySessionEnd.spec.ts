import { beforeEach, describe, expect, it, vi } from "vitest";

let currentTx: any;

vi.mock("@/storage/inTx", () => ({
    inTx: async (fn: (tx: unknown) => Promise<unknown>) => await fn(currentTx),
}));

const refreshSessionParticipantBadgePushes = vi.fn();
vi.mock("@/app/activity/refreshAccountActivityBadgePushes", () => ({
    refreshSessionParticipantBadgePushes: (...args: unknown[]) => refreshSessionParticipantBadgePushes(...args),
}));

const emitUpdate = vi.fn();
const emitEphemeral = vi.fn();
vi.mock("@/app/events/eventRouter", () => ({
    buildSessionActivityEphemeral: vi.fn(() => ({ type: "session-activity" })),
    buildUpdateSessionUpdate: vi.fn(() => ({ type: "session-update" })),
    eventRouter: {
        emitUpdate: (...args: unknown[]) => emitUpdate(...args),
        emitEphemeral: (...args: unknown[]) => emitEphemeral(...args),
    },
}));

const markSessionParticipantsChanged = vi.fn();
vi.mock("@/app/session/changeTracking/markSessionParticipantsChanged", () => ({
    markSessionParticipantsChanged: (...args: unknown[]) => markSessionParticipantsChanged(...args),
}));

const markSessionInactive = vi.fn();
vi.mock("@/app/presence/sessionCache", () => ({
    activityCache: {
        markSessionInactive: (...args: unknown[]) => markSessionInactive(...args),
    },
}));

vi.mock("@/utils/keys/randomKeyNaked", () => ({
    randomKeyNaked: vi.fn(() => "random-key"),
}));

import { applySessionEnd } from "./applySessionEnd";

describe("applySessionEnd", () => {
    beforeEach(() => {
        refreshSessionParticipantBadgePushes.mockReset();
        emitUpdate.mockReset();
        emitEphemeral.mockReset();
        markSessionParticipantsChanged.mockReset();
        markSessionInactive.mockReset();

        currentTx = {
            session: {
                findUnique: vi.fn(),
                update: vi.fn(),
            },
            sessionTurn: {
                findMany: vi.fn(),
                update: vi.fn(),
                create: vi.fn(),
            },
            sessionTurnMutationReceipt: {
                findUnique: vi.fn(),
                create: vi.fn(),
            },
        };
    });

    it("preserves applied false for already-inactive no-op retries", async () => {
        currentTx.session.findUnique.mockResolvedValue({
            id: "s1",
            latestTurnId: null,
            seq: 7,
            pendingCount: 0,
            lastViewedSessionSeq: 7,
            pendingPermissionRequestCount: 0,
            pendingUserActionRequestCount: 0,
            latestTurnStatus: "completed",
            latestTurnStatusObservedAt: BigInt(200),
            lastRuntimeIssue: null,
            meaningfulActivityAt: null,
            active: false,
            lastActiveAt: new Date(400),
            archivedAt: null,
        });

        const res = await applySessionEnd({
            actorUserId: "u1",
            sessionId: "s1",
            now: 500,
            time: 400,
        });

        expect(res).toEqual({
            ok: true,
            applied: false,
            time: 400,
            active: false,
            activeAt: 400,
            latestTurnId: null,
            latestTurnStatus: "completed",
            latestTurnStatusObservedAt: 200,
            lastRuntimeIssue: null,
        });
        expect(currentTx.session.update).not.toHaveBeenCalled();
        expect(currentTx.sessionTurn.findMany).not.toHaveBeenCalled();
        expect(currentTx.sessionTurn.update).not.toHaveBeenCalled();
        expect(currentTx.sessionTurn.create).not.toHaveBeenCalled();
        expect(currentTx.sessionTurnMutationReceipt.create).not.toHaveBeenCalled();
        expect(markSessionParticipantsChanged).not.toHaveBeenCalled();
        expect(refreshSessionParticipantBadgePushes).not.toHaveBeenCalled();
        expect(markSessionInactive).not.toHaveBeenCalled();
        expect(emitUpdate).not.toHaveBeenCalled();
        expect(emitEphemeral).not.toHaveBeenCalled();
    });

    it("clears runtime activity projection when marking an active session inactive", async () => {
        currentTx.session.findUnique.mockResolvedValue({
            id: "s1",
            latestTurnId: null,
            seq: 7,
            pendingCount: 0,
            pendingBlockedCount: 0,
            lastViewedSessionSeq: 7,
            pendingPermissionRequestCount: 0,
            pendingUserActionRequestCount: 0,
            latestTurnStatus: "completed",
            latestTurnStatusObservedAt: BigInt(200),
            lastRuntimeIssue: null,
            meaningfulActivityAt: null,
            active: true,
            lastActiveAt: new Date(400),
            archivedAt: null,
            runtimeActivityActiveCount: 1,
            runtimeActivityObservedAt: BigInt(450),
            runtimeActivityExpiresAt: BigInt(600_000),
            runtimeActivitySourceClass: "provider_detached_task",
        });

        const res = await applySessionEnd({
            actorUserId: "u1",
            sessionId: "s1",
            now: 500,
            time: 500,
        });

        expect(res).toMatchObject({
            ok: true,
            applied: true,
            active: false,
            activeAt: 500,
        });
        expect(currentTx.session.update).toHaveBeenCalledWith({
            where: { id: "s1" },
            data: expect.objectContaining({
                active: false,
                runtimeActivityActiveCount: 0,
                runtimeActivityObservedAt: null,
                runtimeActivityExpiresAt: null,
                runtimeActivitySourceClass: null,
            }),
        });
        expect(markSessionParticipantsChanged).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: "s1",
            hint: expect.objectContaining({
                runtimeActivityActiveCount: 0,
                runtimeActivityObservedAt: null,
                runtimeActivityExpiresAt: null,
                runtimeActivitySourceClass: null,
            }),
        }));
    });
});
