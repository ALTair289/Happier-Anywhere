import { describe, expect, it } from "vitest";
import { UpdateContainerSchema } from "@happier-dev/protocol/updates";
import {
    buildDeleteSessionUpdate,
    buildNewMachineUpdate,
    buildNewMessageUpdate,
    buildNewSessionUpdate,
    buildPendingChangedUpdate,
    buildPublicShareCreatedUpdate,
    buildPublicShareDeletedUpdate,
    buildPublicShareUpdatedUpdate,
    buildUpdateSessionUpdate,
    buildSessionSharedUpdate,
    buildSessionShareRevokedUpdate,
    buildSessionShareUpdatedUpdate,
} from "./eventRouter";

describe("eventRouter payloads (protocol container)", () => {
    it("buildNewMessageUpdate emits a full container", () => {
        const payload = buildNewMessageUpdate(
            {
                id: "m1",
                seq: 1,
                localId: "l1",
                sidechainId: null,
                messageRole: "user",
                content: { t: "encrypted", c: "abc" },
                createdAt: new Date(1),
                updatedAt: new Date(1),
            },
            "s1",
            101,
            "upd-1",
        );

        expect(UpdateContainerSchema.safeParse(payload).success).toBe(true);
        expect((payload.body as any).sid).toBe("s1");
        expect((payload.body as any).id).toBe("s1");
        expect((payload.body as any).message.messageRole).toBe("user");
        expect(Object.prototype.hasOwnProperty.call((payload.body as any).message ?? {}, "sidechainId")).toBe(false);
    });

    it("buildNewSessionUpdate emits a full container", () => {
        const payload = buildNewSessionUpdate(
            {
                id: "s1",
                seq: 1,
                metadata: "enc-meta",
                metadataVersion: 1,
                agentState: null,
                agentStateVersion: 1,
                dataEncryptionKey: new Uint8Array([1, 2, 3]),
                active: true,
                lastActiveAt: new Date(1),
                createdAt: new Date(1),
                updatedAt: new Date(1),
                runtimeActivityActiveCount: 1,
                runtimeActivityObservedAt: BigInt(2_000),
                runtimeActivityExpiresAt: BigInt(4_000),
                runtimeActivitySourceClass: "provider_autonomous_output",
            },
            102,
            "upd-2",
        );

        expect(UpdateContainerSchema.safeParse(payload).success).toBe(true);
        expect((payload.body as any).id).toBe("s1");
        expect((payload.body as any).sid).toBe("s1");
        expect((payload.body as any).runtimeActivityActiveCount).toBe(1);
        expect((payload.body as any).runtimeActivityObservedAt).toBe(2_000);
        expect((payload.body as any).runtimeActivityExpiresAt).toBe(4_000);
        expect((payload.body as any).runtimeActivitySourceClass).toBe("provider_autonomous_output");
    });

    it("buildNewSessionUpdate clears runtime activity timestamps when the aggregate is idle", () => {
        const payload = buildNewSessionUpdate(
            {
                id: "s-idle",
                seq: 1,
                metadata: "enc-meta",
                metadataVersion: 1,
                agentState: null,
                agentStateVersion: 1,
                dataEncryptionKey: null,
                active: false,
                lastActiveAt: new Date(1),
                createdAt: new Date(1),
                updatedAt: new Date(1),
                runtimeActivityActiveCount: 0,
                runtimeActivityObservedAt: BigInt(2_000),
                runtimeActivityExpiresAt: BigInt(4_000),
                runtimeActivitySourceClass: "provider_detached_task",
            },
            102,
            "upd-idle",
        );

        expect(UpdateContainerSchema.safeParse(payload).success).toBe(true);
        expect((payload.body as any).runtimeActivityActiveCount).toBe(0);
        expect((payload.body as any).runtimeActivityObservedAt).toBeNull();
        expect((payload.body as any).runtimeActivityExpiresAt).toBeNull();
        expect((payload.body as any).runtimeActivitySourceClass).toBeNull();
    });

    it("buildUpdateSessionUpdate emits a full container", () => {
        const payload = buildUpdateSessionUpdate(
            "s1",
            103,
            "upd-3",
            { value: "enc-meta", version: 2 },
            { value: null, version: 3 },
            {
                active: false,
                activeAt: 222,
                lastViewedSessionSeq: 7,
                pendingPermissionRequestCount: 2,
                pendingUserActionRequestCount: 1,
                pendingRequestObservedAt: 333,
                latestReadyEventSeq: 8,
                latestReadyEventAt: 444,
                latestTurnId: "turn-1",
                latestTurnStatus: "completed",
                latestTurnStatusObservedAt: 456,
                runtimeActivityActiveCount: 2,
                runtimeActivityObservedAt: 500,
                runtimeActivityExpiresAt: 800,
                runtimeActivitySourceClass: "provider_detached_task",
                meaningfulActivityAt: 999,
                archivedAt: 123,
            },
        );

        expect(UpdateContainerSchema.safeParse(payload).success).toBe(true);
        expect((payload.body as any).id).toBe("s1");
        expect((payload.body as any).sid).toBe("s1");
        expect((payload.body as any).active).toBe(false);
        expect((payload.body as any).activeAt).toBe(222);
        expect((payload.body as any).lastViewedSessionSeq).toBe(7);
        expect((payload.body as any).pendingPermissionRequestCount).toBe(2);
        expect((payload.body as any).pendingUserActionRequestCount).toBe(1);
        expect((payload.body as any).pendingRequestObservedAt).toBe(333);
        expect((payload.body as any).latestReadyEventSeq).toBe(8);
        expect((payload.body as any).latestReadyEventAt).toBe(444);
        expect((payload.body as any).latestTurnId).toBe("turn-1");
        expect((payload.body as any).latestTurnStatus).toBe("completed");
        expect((payload.body as any).latestTurnStatusObservedAt).toBe(456);
        expect((payload.body as any).runtimeActivityActiveCount).toBe(2);
        expect((payload.body as any).runtimeActivityObservedAt).toBe(500);
        expect((payload.body as any).runtimeActivityExpiresAt).toBe(800);
        expect((payload.body as any).runtimeActivitySourceClass).toBe("provider_detached_task");
        expect((payload.body as any).meaningfulActivityAt).toBe(999);
        expect((payload.body as any).archivedAt).toBe(123);
    });

    it("buildUpdateSessionUpdate emits an absolute runtime activity clear", () => {
        const payload = buildUpdateSessionUpdate(
            "s1",
            103,
            "upd-clear",
            undefined,
            undefined,
            {
                runtimeActivityActiveCount: 0,
                runtimeActivityObservedAt: 500,
                runtimeActivityExpiresAt: 800,
                runtimeActivitySourceClass: "provider_detached_task",
            },
        );

        expect(UpdateContainerSchema.safeParse(payload).success).toBe(true);
        expect((payload.body as any).runtimeActivityActiveCount).toBe(0);
        expect((payload.body as any).runtimeActivityObservedAt).toBeNull();
        expect((payload.body as any).runtimeActivityExpiresAt).toBeNull();
        expect((payload.body as any).runtimeActivitySourceClass).toBeNull();
    });

    it("buildDeleteSessionUpdate emits a full container", () => {
        const payload = buildDeleteSessionUpdate("s1", 104, "upd-4");
        expect(UpdateContainerSchema.safeParse(payload).success).toBe(true);
        expect((payload.body as any).sid).toBe("s1");
        expect((payload.body as any).id).toBe("s1");
    });

    it("buildPendingChangedUpdate includes exact meaningfulActivityAt when provided", () => {
        const meaningfulActivityAt = new Date("2026-06-01T12:00:00.000Z");
        const payload = buildPendingChangedUpdate(
            {
                sessionId: "s1",
                pendingVersion: 3,
                pendingCount: 1,
                meaningfulActivityAt,
            },
            105,
            "upd-5",
        );

        expect(UpdateContainerSchema.safeParse(payload).success).toBe(true);
        expect((payload.body as any).sid).toBe("s1");
        expect((payload.body as any).sessionId).toBe("s1");
        expect((payload.body as any).meaningfulActivityAt).toBe(meaningfulActivityAt.getTime());
    });

    it("buildNewMachineUpdate emits a full container", () => {
        const payload = buildNewMachineUpdate(
            {
                id: "m1",
                seq: 1,
                metadata: "enc-meta",
                metadataVersion: 1,
                daemonState: null,
                daemonStateVersion: 1,
                dataEncryptionKey: null,
                active: true,
                lastActiveAt: new Date(1),
                createdAt: new Date(1),
                updatedAt: new Date(1),
            },
            106,
            "upd-6",
        );

        expect(UpdateContainerSchema.safeParse(payload).success).toBe(true);
    });

    it("sharing updates include sessionId + sid for compatibility", () => {
        const shared = buildSessionSharedUpdate(
            {
                id: "shr-1",
                sessionId: "s1",
                sharedByUser: { id: "u1", firstName: null, lastName: null, username: "x", avatar: null },
                accessLevel: "view",
                canApprovePermissions: true,
                encryptedDataKey: new Uint8Array([1, 2, 3]),
                createdAt: new Date(1),
            },
            106,
            "upd-6",
        );
        const updated = buildSessionShareUpdatedUpdate("shr-1", "s1", "edit", false, new Date(2), 107, "upd-7");
        const revoked = buildSessionShareRevokedUpdate("shr-1", "s1", 108, "upd-8");

        expect(UpdateContainerSchema.safeParse(shared).success).toBe(true);
        expect(UpdateContainerSchema.safeParse(updated).success).toBe(true);
        expect(UpdateContainerSchema.safeParse(revoked).success).toBe(true);
        expect((shared.body as any).sessionId).toBe("s1");
        expect((shared.body as any).sid).toBe("s1");
        expect((shared.body as any).canApprovePermissions).toBe(true);
        expect((updated.body as any).sessionId).toBe("s1");
        expect((updated.body as any).sid).toBe("s1");
        expect((updated.body as any).canApprovePermissions).toBe(false);
        expect((revoked.body as any).sessionId).toBe("s1");
        expect((revoked.body as any).sid).toBe("s1");
    });

    it("public share updates include sessionId + sid for compatibility", () => {
        const created = buildPublicShareCreatedUpdate(
            {
                id: "ps-1",
                sessionId: "s1",
                token: "tok",
                expiresAt: null,
                maxUses: null,
                isConsentRequired: false,
                createdAt: new Date(1),
            },
            109,
            "upd-9",
        );
        const updated = buildPublicShareUpdatedUpdate(
            {
                id: "ps-1",
                sessionId: "s1",
                expiresAt: null,
                maxUses: 1,
                isConsentRequired: true,
                updatedAt: new Date(2),
            },
            110,
            "upd-10",
        );
        const deleted = buildPublicShareDeletedUpdate("s1", 111, "upd-11");

        expect(UpdateContainerSchema.safeParse(created).success).toBe(true);
        expect(UpdateContainerSchema.safeParse(updated).success).toBe(true);
        expect(UpdateContainerSchema.safeParse(deleted).success).toBe(true);
        expect((created.body as any).sessionId).toBe("s1");
        expect((created.body as any).sid).toBe("s1");
        expect((updated.body as any).sessionId).toBe("s1");
        expect((updated.body as any).sid).toBe("s1");
        expect((deleted.body as any).sessionId).toBe("s1");
        expect((deleted.body as any).sid).toBe("s1");
    });
});
