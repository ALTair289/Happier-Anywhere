import { beforeEach, describe, expect, it, vi } from "vitest";
import { createEnvReset } from "../../testkit/env";

import {
    buildSessionActivityEphemeral,
    buildUpdateSessionUpdate,
    createSessionRouteTestBuilder,
    emitEphemeral,
    emitUpdate,
    getSessionParticipantUserIds,
    markAccountChanged,
    resetSessionRouteMocks,
    sessionFindFirst,
    sessionFindMany,
    sessionShareFindMany,
    txAccountFindUnique,
    txSessionFindFirst,
    txSessionCreate,
    txSessionUpdate,
} from "./sessionRoutes.testkit";

describe("sessionRoutes v1 sessions snapshot", () => {
    const resetStoragePolicyEnv = createEnvReset();

    beforeEach(() => {
        resetStoragePolicyEnv();
        resetSessionRouteMocks();
        sessionFindMany.mockReset();
        sessionShareFindMany.mockReset();
        sessionFindFirst.mockReset();
        txSessionFindFirst.mockReset();
        txAccountFindUnique.mockReset();
        txAccountFindUnique.mockResolvedValue({ encryptionMode: "e2ee" });
        txSessionCreate.mockReset();
    });

    it("GET /v1/sessions returns pendingCount + pendingVersion for owned sessions", async () => {
        const now = new Date(1);
        sessionFindMany.mockResolvedValue([
            {
                id: "s1",
                seq: 1,
                createdAt: now,
                updatedAt: now,
                metadata: "m1",
                metadataVersion: 1,
                agentState: null,
                agentStateVersion: 0,
                dataEncryptionKey: null,
                pendingCount: 2,
                pendingVersion: 7,
                active: true,
                lastActiveAt: now,
            },
        ]);
        sessionShareFindMany.mockResolvedValue([]);

        const route = await createSessionRouteTestBuilder("GET", "/v1/sessions");
        const { response: res } = await route.invoke();

        expect(res).toEqual({
            sessions: [
                expect.objectContaining({
                    id: "s1",
                    pendingCount: 2,
                    pendingVersion: 7,
                }),
            ],
        });
    });

    it("GET /v1/sessions returns primary turn projection observation time for owned sessions", async () => {
        const now = new Date(1);
        sessionFindMany.mockResolvedValue([
            {
                id: "s1",
                seq: 1,
                createdAt: now,
                updatedAt: now,
                meaningfulActivityAt: now,
                archivedAt: null,
                encryptionMode: "e2ee",
                metadata: "m1",
                metadataVersion: 1,
                agentState: null,
                agentStateVersion: 0,
                lastViewedSessionSeq: null,
                pendingPermissionRequestCount: 0,
                pendingUserActionRequestCount: 0,
                latestTurnId: "turn-1",
                latestTurnStatus: "in_progress",
                latestTurnStatusObservedAt: 1_234,
                lastRuntimeIssue: null,
                dataEncryptionKey: null,
                pendingCount: 0,
                pendingVersion: 0,
                active: true,
                lastActiveAt: now,
            },
        ]);
        sessionShareFindMany.mockResolvedValue([]);

        const route = await createSessionRouteTestBuilder("GET", "/v1/sessions");
        const { response: res } = await route.invoke();

        expect(res).toEqual({
            sessions: [
                expect.objectContaining({
                    id: "s1",
                    latestTurnId: "turn-1",
                    latestTurnStatus: "in_progress",
                    latestTurnStatusObservedAt: 1_234,
                }),
            ],
        });
    });

    it("GET /v1/sessions returns runtime activity projection for owned and shared sessions", async () => {
        const now = new Date(1);
        sessionFindMany.mockResolvedValue([
            {
                id: "s-owned-runtime",
                seq: 1,
                createdAt: now,
                updatedAt: new Date(3),
                meaningfulActivityAt: now,
                archivedAt: null,
                encryptionMode: "e2ee",
                metadata: "m1",
                metadataVersion: 1,
                agentState: null,
                agentStateVersion: 0,
                lastViewedSessionSeq: null,
                pendingPermissionRequestCount: 0,
                pendingUserActionRequestCount: 0,
                latestTurnId: null,
                latestTurnStatus: null,
                latestTurnStatusObservedAt: null,
                lastRuntimeIssue: null,
                runtimeActivityActiveCount: 2,
                runtimeActivityObservedAt: BigInt(2_000),
                runtimeActivityExpiresAt: BigInt(5_000),
                runtimeActivitySourceClass: "provider_detached_task",
                dataEncryptionKey: null,
                pendingCount: 0,
                pendingBlockedCount: 0,
                pendingVersion: 0,
                active: true,
                lastActiveAt: now,
            },
        ]);
        sessionShareFindMany.mockResolvedValue([
            {
                accessLevel: "edit",
                canApprovePermissions: true,
                encryptedDataKey: Buffer.from([1, 2, 3]),
                sharedByUserId: "owner",
                sharedByUser: {},
                session: {
                    id: "s-shared-runtime",
                    seq: 2,
                    createdAt: now,
                    updatedAt: new Date(2),
                    meaningfulActivityAt: now,
                    archivedAt: null,
                    encryptionMode: "e2ee",
                    metadata: "m2",
                    metadataVersion: 1,
                    agentState: null,
                    agentStateVersion: 0,
                    lastViewedSessionSeq: null,
                    pendingPermissionRequestCount: 0,
                    pendingUserActionRequestCount: 0,
                    latestTurnId: null,
                    latestTurnStatus: null,
                    latestTurnStatusObservedAt: null,
                    lastRuntimeIssue: null,
                    runtimeActivityActiveCount: 1,
                    runtimeActivityObservedAt: BigInt(3_000),
                    runtimeActivityExpiresAt: BigInt(6_000),
                    runtimeActivitySourceClass: "provider_autonomous_output",
                    pendingCount: 0,
                    pendingBlockedCount: 0,
                    pendingVersion: 0,
                    active: true,
                    lastActiveAt: now,
                },
            },
        ]);

        const route = await createSessionRouteTestBuilder("GET", "/v1/sessions");
        const { response: res } = await route.invoke();

        expect(res).toEqual({
            sessions: [
                expect.objectContaining({
                    id: "s-owned-runtime",
                    runtimeActivityActiveCount: 2,
                    runtimeActivityObservedAt: 2_000,
                    runtimeActivityExpiresAt: 5_000,
                    runtimeActivitySourceClass: "provider_detached_task",
                }),
                expect.objectContaining({
                    id: "s-shared-runtime",
                    runtimeActivityActiveCount: 1,
                    runtimeActivityObservedAt: 3_000,
                    runtimeActivityExpiresAt: 6_000,
                    runtimeActivitySourceClass: "provider_autonomous_output",
                }),
            ],
        });
    });

    it("GET /v1/sessions falls back to legacy session projection when runtime activity columns are missing", async () => {
        const now = new Date(1);
        const missingRuntimeActivityColumn = Object.assign(
            new Error('No such column: Session.runtimeActivityActiveCount'),
            { code: 'P2022' },
        );
        sessionFindMany
            .mockRejectedValueOnce(missingRuntimeActivityColumn)
            .mockResolvedValueOnce([
                {
                    id: "s-legacy-runtime",
                    seq: 1,
                    createdAt: now,
                    updatedAt: now,
                    meaningfulActivityAt: now,
                    archivedAt: null,
                    encryptionMode: "e2ee",
                    metadata: "m1",
                    metadataVersion: 1,
                    agentState: null,
                    agentStateVersion: 0,
                    lastViewedSessionSeq: null,
                    pendingPermissionRequestCount: 0,
                    pendingUserActionRequestCount: 0,
                    latestTurnId: null,
                    latestTurnStatus: null,
                    latestTurnStatusObservedAt: null,
                    lastRuntimeIssue: null,
                    dataEncryptionKey: null,
                    pendingCount: 0,
                    pendingBlockedCount: 0,
                    pendingVersion: 0,
                    active: true,
                    lastActiveAt: now,
                },
            ]);
        sessionShareFindMany.mockResolvedValue([]);

        const route = await createSessionRouteTestBuilder("GET", "/v1/sessions");
        const { response: res } = await route.invoke();

        expect(sessionFindMany).toHaveBeenCalledTimes(2);
        expect(sessionFindMany.mock.calls[0]?.[0]?.select).toEqual(expect.objectContaining({
            runtimeActivityActiveCount: true,
        }));
        expect(sessionFindMany.mock.calls[1]?.[0]?.select).not.toHaveProperty("runtimeActivityActiveCount");
        expect(res).toEqual({
            sessions: [
                expect.objectContaining({
                    id: "s-legacy-runtime",
                    runtimeActivityActiveCount: 0,
                    runtimeActivityObservedAt: null,
                    runtimeActivityExpiresAt: null,
                    runtimeActivitySourceClass: null,
                }),
            ],
        });
    });

    it("GET /v1/sessions returns pendingCount + pendingVersion for shared sessions", async () => {
        const now = new Date(1);
        sessionFindMany.mockResolvedValue([]);
        sessionShareFindMany.mockResolvedValue([
            {
                accessLevel: "edit",
                canApprovePermissions: true,
                encryptedDataKey: Buffer.from([1, 2, 3]),
                sharedByUserId: "owner",
                sharedByUser: {},
                session: {
                    id: "s2",
                    seq: 2,
                    createdAt: now,
                    updatedAt: now,
                    metadata: "m2",
                    metadataVersion: 1,
                    agentState: null,
                    agentStateVersion: 0,
                    pendingCount: 9,
                    pendingVersion: 10,
                    active: true,
                    lastActiveAt: now,
                },
            },
        ]);

        const route = await createSessionRouteTestBuilder("GET", "/v1/sessions");
        const { response: res } = await route.invoke();

        expect(res).toEqual({
            sessions: [
                expect.objectContaining({
                    id: "s2",
                    pendingCount: 9,
                    pendingVersion: 10,
                }),
            ],
        });
    });

    it("POST /v1/sessions returns pendingCount + pendingVersion when loading an existing session", async () => {
        const now = new Date(1);
        txSessionFindFirst.mockResolvedValue({
            id: "s1",
            seq: 1,
            createdAt: now,
            updatedAt: now,
            metadata: "m1",
            metadataVersion: 1,
            agentState: null,
            agentStateVersion: 0,
            dataEncryptionKey: null,
            pendingCount: 3,
            pendingVersion: 4,
            active: true,
            lastActiveAt: now,
        });

        const route = await createSessionRouteTestBuilder("POST", "/v1/sessions");
        const { response: res } = await route.invoke({
            body: { tag: "t1", metadata: "m1", agentState: null, dataEncryptionKey: null },
        });

        expect(sessionFindFirst).not.toHaveBeenCalled();
        expect(txSessionFindFirst).toHaveBeenCalled();
        expect(res).toEqual({
            session: expect.objectContaining({
                id: "s1",
                pendingCount: 3,
                pendingVersion: 4,
            }),
        });
    });

    it("POST /v1/sessions reactivates an existing inactive session", async () => {
        const now = new Date(1);
        const reactivatedAt = 1_000;
        vi.spyOn(Date, "now").mockReturnValueOnce(reactivatedAt);
        txSessionFindFirst.mockResolvedValue({
            id: "s1",
            seq: 1,
            createdAt: now,
            updatedAt: now,
            meaningfulActivityAt: now,
            metadata: "m1",
            metadataVersion: 1,
            agentState: null,
            agentStateVersion: 0,
            dataEncryptionKey: null,
            pendingCount: 3,
            pendingBlockedCount: 0,
            pendingVersion: 4,
            latestTurnId: null,
            latestTurnStatus: null,
            latestTurnStatusObservedAt: null,
            lastRuntimeIssue: null,
            runtimeActivityActiveCount: 0,
            runtimeActivityObservedAt: null,
            runtimeActivityExpiresAt: null,
            runtimeActivitySourceClass: null,
            active: false,
            lastActiveAt: now,
            encryptionMode: "e2ee",
        });
        txSessionUpdate.mockResolvedValue({
            id: "s1",
            seq: 1,
            createdAt: now,
            updatedAt: new Date(reactivatedAt),
            meaningfulActivityAt: new Date(reactivatedAt),
            metadata: "m1",
            metadataVersion: 1,
            agentState: null,
            agentStateVersion: 0,
            dataEncryptionKey: null,
            pendingCount: 3,
            pendingBlockedCount: 0,
            pendingVersion: 4,
            latestTurnId: null,
            latestTurnStatus: null,
            latestTurnStatusObservedAt: null,
            lastRuntimeIssue: null,
            runtimeActivityActiveCount: 0,
            runtimeActivityObservedAt: null,
            runtimeActivityExpiresAt: null,
            runtimeActivitySourceClass: null,
            active: true,
            lastActiveAt: new Date(reactivatedAt),
            encryptionMode: "e2ee",
        });
        getSessionParticipantUserIds.mockResolvedValueOnce(["u1", "u2"]);
        markAccountChanged.mockResolvedValueOnce(101).mockResolvedValueOnce(102);

        const route = await createSessionRouteTestBuilder("POST", "/v1/sessions");
        const { response: res } = await route.invoke({
            body: { tag: "t1", metadata: "m1", agentState: null, dataEncryptionKey: null },
        });

        expect(txSessionUpdate).toHaveBeenCalledWith({
            where: { id: "s1" },
            data: {
                active: true,
                lastActiveAt: new Date(reactivatedAt),
                meaningfulActivityAt: new Date(reactivatedAt),
            },
        });
        expect(buildUpdateSessionUpdate).toHaveBeenNthCalledWith(1, "s1", 101, expect.any(String), undefined, undefined, {
            active: true,
            activeAt: reactivatedAt,
            meaningfulActivityAt: reactivatedAt,
        });
        expect(buildUpdateSessionUpdate).toHaveBeenNthCalledWith(2, "s1", 102, expect.any(String), undefined, undefined, {
            active: true,
            activeAt: reactivatedAt,
            meaningfulActivityAt: reactivatedAt,
        });
        expect(emitUpdate).toHaveBeenCalledTimes(2);
        expect(buildSessionActivityEphemeral).toHaveBeenCalledWith("s1", true, reactivatedAt, false);
        expect(emitEphemeral).toHaveBeenCalledWith(expect.objectContaining({
            userId: "u1",
            recipientFilter: { type: "user-scoped-only" },
        }));
        expect(res).toEqual({
            session: expect.objectContaining({
                id: "s1",
                active: true,
                activeAt: reactivatedAt,
                meaningfulActivityAt: reactivatedAt,
                pendingCount: 3,
                pendingVersion: 4,
            }),
        });
    });

    it("POST /v1/sessions returns pendingCount + pendingVersion when creating a new session", async () => {
        const now = new Date(1);
        txSessionFindFirst.mockResolvedValue(null);
        txSessionCreate.mockResolvedValue({
            id: "s2",
            seq: 2,
            createdAt: now,
            updatedAt: now,
            metadata: "m2",
            metadataVersion: 1,
            agentState: null,
            agentStateVersion: 0,
            dataEncryptionKey: null,
            pendingCount: 0,
            pendingVersion: 0,
            active: true,
            lastActiveAt: now,
        });

        const route = await createSessionRouteTestBuilder("POST", "/v1/sessions");
        const { response: res } = await route.invoke({
            body: { tag: "t2", metadata: "m2", agentState: null, dataEncryptionKey: null },
        });

        expect(sessionFindFirst).not.toHaveBeenCalled();
        expect(txSessionFindFirst).toHaveBeenCalled();
        expect(res).toEqual({
            session: expect.objectContaining({
                id: "s2",
                pendingCount: 0,
                pendingVersion: 0,
            }),
        });
    });

    it("POST /v1/sessions forwards encryptionMode=plain when plaintext storage is optional", async () => {
        resetStoragePolicyEnv({ HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional" });

        const now = new Date(1);
        txSessionFindFirst.mockResolvedValue(null);
        txSessionCreate.mockResolvedValue({
            id: "s2",
            seq: 2,
            createdAt: now,
            updatedAt: now,
            metadata: "m2",
            metadataVersion: 1,
            agentState: null,
            agentStateVersion: 0,
            dataEncryptionKey: null,
            pendingCount: 0,
            pendingVersion: 0,
            active: true,
            lastActiveAt: now,
            encryptionMode: "plain",
        });

        const route = await createSessionRouteTestBuilder("POST", "/v1/sessions");
        await route.invoke({
            body: { tag: "t2", metadata: "m2", agentState: null, dataEncryptionKey: null, encryptionMode: "plain" },
        });

        expect(txSessionCreate).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    encryptionMode: "plain",
                }),
            }),
        );
    });

    it("POST /v1/sessions defaults encryptionMode to the account mode when not specified", async () => {
        resetStoragePolicyEnv({ HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional" });

        const now = new Date(1);
        txSessionFindFirst.mockResolvedValue(null);
        txAccountFindUnique.mockResolvedValue({ encryptionMode: "plain" });
        txSessionCreate.mockResolvedValue({
            id: "s2",
            seq: 2,
            createdAt: now,
            updatedAt: now,
            metadata: "m2",
            metadataVersion: 1,
            agentState: null,
            agentStateVersion: 0,
            dataEncryptionKey: null,
            pendingCount: 0,
            pendingVersion: 0,
            active: true,
            lastActiveAt: now,
            encryptionMode: "plain",
        });

        const route = await createSessionRouteTestBuilder("POST", "/v1/sessions");
        await route.invoke({
            body: { tag: "t2", metadata: "m2", agentState: null, dataEncryptionKey: null },
        });

        expect(txSessionCreate).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    encryptionMode: "plain",
                }),
            }),
        );
    });

    it("POST /v1/sessions stores agentState when provided", async () => {
        const now = new Date(1);
        txSessionFindFirst.mockResolvedValue(null);
        txSessionCreate.mockResolvedValue({
            id: "s2",
            seq: 2,
            createdAt: now,
            updatedAt: now,
            metadata: "m2",
            metadataVersion: 0,
            agentState: "state-1",
            agentStateVersion: 0,
            dataEncryptionKey: null,
            pendingCount: 0,
            pendingVersion: 0,
            active: true,
            lastActiveAt: now,
            encryptionMode: "e2ee",
        });

        const route = await createSessionRouteTestBuilder("POST", "/v1/sessions");
        await route.invoke({
            body: { tag: "t2", metadata: "m2", agentState: "state-1", dataEncryptionKey: null },
        });

        expect(txSessionCreate).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    agentState: "state-1",
                }),
            }),
        );
    });

    it("POST /v1/sessions returns a stable error code when the requested encryptionMode is disallowed by storage policy", async () => {
        resetStoragePolicyEnv({ HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "required_e2ee" });

        const route = await createSessionRouteTestBuilder("POST", "/v1/sessions");
        const { reply } = await route.invoke({
            body: { tag: "t1", metadata: "m1", agentState: null, dataEncryptionKey: null, encryptionMode: "plain" },
        });

        expect(reply.code).toHaveBeenCalledWith(400);
        expect(reply.send).toHaveBeenCalledWith({
            error: "invalid-params",
            code: "storage_policy_requires_e2ee",
        });
    });
});
