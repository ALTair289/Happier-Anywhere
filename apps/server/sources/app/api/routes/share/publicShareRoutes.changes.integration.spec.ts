import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { encodeBase64, stringifySerializedJsonValue } from "@happier-dev/protocol";

import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { withAuthenticatedTestApp } from "../../testkit/sqliteFastify";
import { publicShareRoutes } from "./publicShareRoutes";

vi.mock("@/app/share/accessControl", () => ({
    isSessionOwner: vi.fn(async () => true),
}));

const { emitUpdate, buildPublicShareCreatedUpdate, buildPublicShareUpdatedUpdate, buildPublicShareDeletedUpdate, randomKeyNaked, markAccountChanged } =
    vi.hoisted(() => ({
        emitUpdate: vi.fn(),
        buildPublicShareCreatedUpdate: vi.fn((_ps: any, updSeq: number, updId: string) => ({
            id: updId,
            seq: updSeq,
            body: { t: "public-share-created" },
        })),
        buildPublicShareUpdatedUpdate: vi.fn((_ps: any, updSeq: number, updId: string) => ({
            id: updId,
            seq: updSeq,
            body: { t: "public-share-updated" },
        })),
        buildPublicShareDeletedUpdate: vi.fn((_sessionId: string, updSeq: number, updId: string) => ({
            id: updId,
            seq: updSeq,
            body: { t: "public-share-deleted" },
        })),
        randomKeyNaked: vi.fn(() => "upd-id"),
        markAccountChanged: vi.fn(async (_tx: any, params: any) => {
            if (params.kind === "share") return 50;
            if (params.kind === "session") return 51;
            return 99;
        }),
    }));

vi.mock("@/app/events/eventRouter", () => ({
    eventRouter: { emitUpdate },
    buildPublicShareCreatedUpdate,
    buildPublicShareUpdatedUpdate,
    buildPublicShareDeletedUpdate,
}));

vi.mock("@/utils/keys/randomKeyNaked", () => ({ randomKeyNaked }));
vi.mock("@/app/changes/markAccountChanged", () => ({ markAccountChanged }));

const validEncryptedDataKey = encodeBase64(
    new Uint8Array(
        24 + 16 + new TextEncoder().encode(
            stringifySerializedJsonValue({ v: 0, keyB64: "A".repeat(44) }),
        ).byteLength,
    ).fill(1),
    "base64",
);
const validEncryptedDataKeyBytes = Buffer.from(validEncryptedDataKey, "base64");

describe("publicShareRoutes (AccountChange integration)", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-public-share-changes-",
            initAuth: false,
            initEncrypt: false,
            initFiles: false,
        });
    }, 120_000);

    afterAll(async () => {
        await harness.close();
    });

    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        harness.resetEnv();
    });

    afterEach(async () => {
        harness.resetEnv();
        await harness.resetDbTables([
            () => db.publicShareAccessLog.deleteMany(),
            () => db.publicShareBlockedUser.deleteMany(),
            () => db.publicSessionShare.deleteMany(),
            () => db.sessionMessage.deleteMany(),
            () => db.accountChange.deleteMany(),
            () => db.session.deleteMany(),
            () => db.repeatKey.deleteMany(),
            () => db.account.deleteMany(),
        ]);
    });

    async function seedOwnerSession(encryptionMode: "e2ee" | "plain" = "e2ee") {
        const owner = await db.account.create({
            data: { publicKey: `pk-${encryptionMode}` },
            select: { id: true },
        });

        const session = await db.session.create({
            data: {
                accountId: owner.id,
                tag: `session-${encryptionMode}`,
                encryptionMode,
                metadata: JSON.stringify({ v: 1 }),
                agentState: null,
                dataEncryptionKey: encryptionMode === "plain" ? null : Buffer.from([1, 2, 3]),
            },
            select: { id: true },
        });

        return { owner, session };
    }

    it("POST create marks share+session and emits created update using latest cursor", async () => {
        const { owner, session } = await seedOwnerSession();

        await withAuthenticatedTestApp(
            (app) => publicShareRoutes(app as any),
            async (app) => {
                const res = await app.inject({
                    method: "POST",
                    url: `/v1/sessions/${session.id}/public-share`,
                    headers: { "x-test-user-id": owner.id, "content-type": "application/json" },
                    payload: {
                        token: "tok-create",
                        encryptedDataKey: validEncryptedDataKey,
                    },
                });

                expect(res.statusCode).toBe(200);
                expect(res.json()).toEqual({
                    publicShare: expect.objectContaining({
                        token: "tok-create",
                        useCount: 0,
                        isConsentRequired: false,
                    }),
                });
            },
        );

        const stored = await db.publicSessionShare.findUnique({
            where: { sessionId: session.id },
            select: { sessionId: true, encryptedDataKey: true },
        });
        expect(stored?.sessionId).toBe(session.id);
        expect(stored?.encryptedDataKey).toBeInstanceOf(Uint8Array);

        expect(markAccountChanged).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ accountId: owner.id, kind: "share", entityId: session.id }),
        );
        expect(markAccountChanged).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ accountId: owner.id, kind: "session", entityId: session.id }),
        );
        expect(emitUpdate).toHaveBeenCalledWith(
            expect.objectContaining({
                userId: owner.id,
                payload: expect.objectContaining({
                    seq: 51,
                    body: expect.objectContaining({ t: "public-share-created" }),
                }),
                recipientFilter: { type: "all-interested-in-session", sessionId: session.id },
            }),
        );
    });

    it("POST create rejects malformed E2EE encryptedDataKey envelopes before writing a share", async () => {
        const { owner, session } = await seedOwnerSession();

        await withAuthenticatedTestApp(
            (app) => publicShareRoutes(app as any),
            async (app) => {
                const res = await app.inject({
                    method: "POST",
                    url: `/v1/sessions/${session.id}/public-share`,
                    headers: { "x-test-user-id": owner.id, "content-type": "application/json" },
                    payload: {
                        token: "tok-malformed-create",
                        encryptedDataKey: Buffer.from([1, 2, 3]).toString("base64"),
                    },
                });

                expect(res.statusCode).toBe(400);
                expect(res.json()).toEqual({ error: "Invalid encryptedDataKey" });
            },
        );

        await expect(db.publicSessionShare.findUnique({
            where: { sessionId: session.id },
            select: { id: true },
        })).resolves.toBeNull();
        expect(emitUpdate).not.toHaveBeenCalled();
    });

    it("POST update marks share+session and emits updated update using latest cursor", async () => {
        const { owner, session } = await seedOwnerSession();
        await db.publicSessionShare.create({
            data: {
                sessionId: session.id,
                createdByUserId: owner.id,
                tokenHash: createHash("sha256").update("tok-existing", "utf8").digest(),
                encryptedDataKey: validEncryptedDataKeyBytes,
                maxUses: 2,
                isConsentRequired: false,
            },
        });

        await withAuthenticatedTestApp(
            (app) => publicShareRoutes(app as any),
            async (app) => {
                const res = await app.inject({
                    method: "POST",
                    url: `/v1/sessions/${session.id}/public-share`,
                    headers: { "x-test-user-id": owner.id, "content-type": "application/json" },
                    payload: {
                        expiresAt: 1_800_000_000_000,
                        isConsentRequired: true,
                    },
                });

                expect(res.statusCode).toBe(200);
                expect(res.json()).toEqual({
                    publicShare: expect.objectContaining({
                        token: null,
                        isConsentRequired: true,
                    }),
                });
            },
        );

        const stored = await db.publicSessionShare.findUnique({
            where: { sessionId: session.id },
            select: { isConsentRequired: true, expiresAt: true },
        });
        expect(stored?.isConsentRequired).toBe(true);
        expect(stored?.expiresAt?.getTime()).toBe(1_800_000_000_000);

        expect(emitUpdate).toHaveBeenCalledWith(
            expect.objectContaining({
                userId: owner.id,
                payload: expect.objectContaining({
                    seq: 51,
                    body: expect.objectContaining({ t: "public-share-updated" }),
                }),
            }),
        );
    });

    it("POST update rejects a malformed stored E2EE envelope before changes or events", async () => {
        const { owner, session } = await seedOwnerSession();
        await db.publicSessionShare.create({
            data: {
                sessionId: session.id,
                createdByUserId: owner.id,
                tokenHash: createHash("sha256").update("tok-malformed-existing", "utf8").digest(),
                encryptedDataKey: Buffer.from([1, 2, 3]),
                maxUses: 2,
                isConsentRequired: false,
            },
        });

        await withAuthenticatedTestApp(
            (app) => publicShareRoutes(app as any),
            async (app) => {
                const res = await app.inject({
                    method: "POST",
                    url: `/v1/sessions/${session.id}/public-share`,
                    headers: { "x-test-user-id": owner.id, "content-type": "application/json" },
                    payload: { maxUses: 3 },
                });

                expect(res.statusCode).toBe(400);
                expect(res.json()).toEqual({ error: "Invalid encryptedDataKey" });
            },
        );

        const stored = await db.publicSessionShare.findUnique({
            where: { sessionId: session.id },
            select: { maxUses: true, encryptedDataKey: true },
        });
        expect(stored?.maxUses).toBe(2);
        expect(stored?.encryptedDataKey).toEqual(new Uint8Array([1, 2, 3]));
        expect(markAccountChanged).not.toHaveBeenCalled();
        expect(emitUpdate).not.toHaveBeenCalled();
    });

    it("DELETE marks share+session and emits deleted update using latest cursor", async () => {
        const { owner, session } = await seedOwnerSession();
        await db.publicSessionShare.create({
            data: {
                sessionId: session.id,
                createdByUserId: owner.id,
                tokenHash: createHash("sha256").update("tok-delete", "utf8").digest(),
                encryptedDataKey: validEncryptedDataKeyBytes,
                isConsentRequired: false,
            },
        });

        await withAuthenticatedTestApp(
            (app) => publicShareRoutes(app as any),
            async (app) => {
                const res = await app.inject({
                    method: "DELETE",
                    url: `/v1/sessions/${session.id}/public-share`,
                    headers: { "x-test-user-id": owner.id },
                });

                expect(res.statusCode).toBe(200);
                expect(res.json()).toEqual({ success: true });
            },
        );

        const stored = await db.publicSessionShare.findUnique({
            where: { sessionId: session.id },
            select: { id: true },
        });
        expect(stored).toBeNull();
        expect(emitUpdate).toHaveBeenCalledWith(
            expect.objectContaining({
                userId: owner.id,
                payload: expect.objectContaining({
                    seq: 51,
                    body: expect.objectContaining({ t: "public-share-deleted" }),
                }),
            }),
        );
    });

    it("DELETE returns 404 when no public share exists", async () => {
        const { owner, session } = await seedOwnerSession();

        await withAuthenticatedTestApp(
            (app) => publicShareRoutes(app as any),
            async (app) => {
                const res = await app.inject({
                    method: "DELETE",
                    url: `/v1/sessions/${session.id}/public-share`,
                    headers: { "x-test-user-id": owner.id },
                });

                expect(res.statusCode).toBe(404);
                expect(res.json()).toEqual({ error: "Share not found" });
            },
        );

        expect(emitUpdate).not.toHaveBeenCalled();
    });
});
