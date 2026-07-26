import { beforeEach, describe, expect, it } from "vitest";

import {
    createSessionRouteTestBuilder,
    resetSessionRouteMocks,
    checkSessionAccess,
    getSessionParticipantUserIds,
    txSessionFindUnique,
    txSessionUpdate,
    txSessionUpdateMany,
    markAccountChanged,
    buildUpdateSessionUpdate,
    emitUpdate,
} from "./sessionRoutes.testkit";

describe("sessionRoutes v2 archive", () => {
    beforeEach(() => {
        resetSessionRouteMocks();
    });

    it("archives an inactive session when actor is admin", async () => {
        const now = new Date(1234);
        checkSessionAccess.mockResolvedValue({ level: "admin" });
        getSessionParticipantUserIds.mockResolvedValue(["owner", "u2"]);
        txSessionFindUnique.mockResolvedValue({
            id: "s1",
            active: false,
            archivedAt: null,
            runtimeActivityState: "active",
            runtimeActivityRevision: BigInt(5),
            runtimeActivityActiveCount: 1,
            runtimeActivityObservedAt: BigInt(1_000),
        });
        txSessionUpdateMany.mockResolvedValue({ count: 1 });
        txSessionUpdate.mockResolvedValue({ id: "s1", archivedAt: now });

        const route = await createSessionRouteTestBuilder("POST", "/v2/sessions/:sessionId/archive");
        const { reply, response: res } = await route.invoke({ params: { sessionId: "s1" } });

        expect(reply.code).not.toHaveBeenCalledWith(403);
        expect(res).toEqual({ success: true, archivedAt: now.getTime() });
        expect(txSessionUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({
                runtimeActivityState: "unknown",
                runtimeActivityActiveCount: 0,
            }),
        }));
        expect(markAccountChanged).toHaveBeenCalledTimes(2);
        expect(buildUpdateSessionUpdate).toHaveBeenCalledTimes(2);
        expect(buildUpdateSessionUpdate).toHaveBeenCalledWith(
            "s1",
            expect.any(Number),
            expect.any(String),
            undefined,
            undefined,
            expect.objectContaining({
                archivedAt: now.getTime(),
                runtimeActivityState: "unknown",
                runtimeActivityActiveCount: 0,
            }),
        );
        expect(emitUpdate).toHaveBeenCalledWith(expect.objectContaining({
            recipientFilter: { type: "all-interested-in-session", sessionId: "s1" },
        }));
    });

    it("returns 409 when attempting to archive an active session", async () => {
        checkSessionAccess.mockResolvedValue({ level: "admin" });
        txSessionFindUnique.mockResolvedValue({ id: "s1", active: true, archivedAt: null });

        const route = await createSessionRouteTestBuilder("POST", "/v2/sessions/:sessionId/archive");
        const { reply, response: res } = await route.invoke({ params: { sessionId: "s1" } });

        expect(reply.code).toHaveBeenCalledWith(409);
        expect(res).toEqual({ error: "session-active" });
        expect(txSessionUpdate).not.toHaveBeenCalled();
    });

    it("returns 403 when actor is not admin", async () => {
        checkSessionAccess.mockResolvedValue({ level: "edit" });

        const route = await createSessionRouteTestBuilder("POST", "/v2/sessions/:sessionId/archive");
        const { reply, response: res } = await route.invoke({ params: { sessionId: "s1" } });

        expect(reply.code).toHaveBeenCalledWith(403);
        expect(res).toEqual({ error: "Forbidden" });
    });

    it("unarchives an archived session when actor is admin", async () => {
        checkSessionAccess.mockResolvedValue({ level: "admin" });
        getSessionParticipantUserIds.mockResolvedValue(["owner"]);
        txSessionFindUnique.mockResolvedValue({ id: "s1", active: false, archivedAt: new Date(1) });
        txSessionUpdateMany.mockResolvedValue({ count: 1 });

        const route = await createSessionRouteTestBuilder("POST", "/v2/sessions/:sessionId/unarchive");
        const { response: res } = await route.invoke({ params: { sessionId: "s1" } });

        expect(res).toEqual({ success: true, archivedAt: null });
        expect(txSessionUpdateMany).toHaveBeenCalledWith({
            where: { id: "s1", archivedAt: new Date(1) },
            data: { archivedAt: null },
        });
        expect(markAccountChanged).toHaveBeenCalledTimes(1);
        expect(buildUpdateSessionUpdate).toHaveBeenCalledWith(
            "s1",
            expect.any(Number),
            expect.any(String),
            undefined,
            undefined,
            expect.objectContaining({ archivedAt: null }),
        );
    });

    it("treats an already-unarchived retry as an idempotent no-op without revoking new authority", async () => {
        checkSessionAccess.mockResolvedValue({ level: "admin" });
        txSessionFindUnique.mockResolvedValue({ id: "s1", active: false, archivedAt: null });

        const route = await createSessionRouteTestBuilder("POST", "/v2/sessions/:sessionId/unarchive");
        const { response: res } = await route.invoke({ params: { sessionId: "s1" } });

        expect(res).toEqual({ success: true, archivedAt: null });
        expect(txSessionUpdate).not.toHaveBeenCalled();
        expect(markAccountChanged).not.toHaveBeenCalled();
        expect(buildUpdateSessionUpdate).not.toHaveBeenCalled();
        expect(emitUpdate).not.toHaveBeenCalled();
    });

    it("treats a concurrent unarchive winner as an idempotent no-op without revoking authority", async () => {
        checkSessionAccess.mockResolvedValue({ level: "admin" });
        txSessionFindUnique
            .mockResolvedValueOnce({ id: "s1", active: false, archivedAt: new Date(1) })
            .mockResolvedValueOnce({ archivedAt: null });
        txSessionUpdateMany.mockResolvedValue({ count: 0 });

        const route = await createSessionRouteTestBuilder("POST", "/v2/sessions/:sessionId/unarchive");
        const { response: res } = await route.invoke({ params: { sessionId: "s1" } });

        expect(res).toEqual({ success: true, archivedAt: null });
        expect(markAccountChanged).not.toHaveBeenCalled();
        expect(emitUpdate).not.toHaveBeenCalled();
    });
});
