import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "crypto";

import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { createAuthenticatedTestApp } from "../../testkit/sqliteFastify";
import { publicShareRoutes } from "./publicShareRoutes";

describe("publicShareRoutes plaintext sessions (integration)", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-public-share-plain-",
            initAuth: false,
            initEncrypt: false,
            initFiles: false,
        });
    });

    afterAll(async () => {
        await harness.close();
    });

    it("creates and accesses a public share for a plaintext session without encryptedDataKey", async () => {
        const owner = await db.account.create({ data: { publicKey: "pk_owner" }, select: { id: true } });
        const session = await db.session.create({
            data: {
                accountId: owner.id,
                tag: "s_plain",
                encryptionMode: "plain",
                metadata: JSON.stringify({ v: 1, flavor: "claude" }),
                agentState: null,
                dataEncryptionKey: null,
            },
            select: { id: true },
        });

        const app = createAuthenticatedTestApp();
        publicShareRoutes(app as any);
        await app.ready();
        try {
            const token = "tok_plain_1";
            const createRes = await app.inject({
                method: "POST",
                url: `/v1/sessions/${session.id}/public-share`,
                headers: { "x-test-user-id": owner.id, "content-type": "application/json" },
                payload: JSON.stringify({ token, isConsentRequired: false }),
            });
            expect(createRes.statusCode).toBe(200);

            const accessRes = await app.inject({
                method: "GET",
                url: `/v1/public-share/${encodeURIComponent(token)}`,
            });
            expect(accessRes.statusCode).toBe(200);
            const json = accessRes.json();
            expect(json.session?.id).toBe(session.id);
            expect(json.session?.encryptionMode).toBe("plain");
            expect(json.encryptedDataKey).toBe(null);
        } finally {
            await app.close();
        }
    });

    it("returns 404 for message reads when an E2EE session public share is missing encryptedDataKey", async () => {
        const owner = await db.account.create({ data: { publicKey: "pk_owner_2" }, select: { id: true } });
        const session = await db.session.create({
            data: {
                accountId: owner.id,
                tag: "s_e2ee",
                encryptionMode: "e2ee",
                metadata: "ciphertext",
                agentState: null,
                dataEncryptionKey: Buffer.from([1, 2, 3]),
            },
            select: { id: true },
        });

        const token = "tok_e2ee_missing_dek";
        const tokenHash = createHash("sha256").update(token, "utf8").digest();
        await db.publicSessionShare.create({
            data: {
                sessionId: session.id,
                createdByUserId: owner.id,
                tokenHash,
                encryptedDataKey: null,
                isConsentRequired: false,
            },
        });

        const app = createAuthenticatedTestApp();
        publicShareRoutes(app as any);
        await app.ready();
        try {
            const messagesRes = await app.inject({
                method: "GET",
                url: `/v1/public-share/${encodeURIComponent(token)}/messages`,
            });
            expect(messagesRes.statusCode).toBe(404);
        } finally {
            await app.close();
        }
    });

    it("rejects repeated direct message reads for a capped public share without consuming a use", async () => {
        const owner = await db.account.create({ data: { publicKey: "pk_owner_capped_direct" }, select: { id: true } });
        const session = await db.session.create({
            data: {
                accountId: owner.id,
                tag: "s_plain_capped_direct",
                encryptionMode: "plain",
                metadata: JSON.stringify({ v: 1, flavor: "codex" }),
                agentState: null,
                dataEncryptionKey: null,
            },
            select: { id: true },
        });
        await db.sessionMessage.create({
            data: {
                sessionId: session.id,
                seq: 1,
                messageRole: "user",
                content: { t: "plain", v: { role: "user", content: { type: "text", text: "hello" } } },
            },
        });

        const token = "tok_plain_capped_direct";
        const share = await db.publicSessionShare.create({
            data: {
                sessionId: session.id,
                createdByUserId: owner.id,
                tokenHash: createHash("sha256").update(token, "utf8").digest(),
                encryptedDataKey: null,
                isConsentRequired: false,
                maxUses: 1,
                useCount: 0,
            },
            select: { id: true },
        });

        const app = createAuthenticatedTestApp();
        publicShareRoutes(app as any);
        await app.ready();
        try {
            const first = await app.inject({
                method: "GET",
                url: `/v1/public-share/${encodeURIComponent(token)}/messages`,
            });
            const second = await app.inject({
                method: "GET",
                url: `/v1/public-share/${encodeURIComponent(token)}/messages`,
            });

            expect(first.statusCode).toBe(404);
            expect(second.statusCode).toBe(404);
        } finally {
            await app.close();
        }

        await expect(db.publicSessionShare.findUnique({
            where: { id: share.id },
            select: { useCount: true },
        })).resolves.toEqual({ useCount: 0 });
    });

    it("counts a capped public viewer open once and grants its paired message read", async () => {
        const owner = await db.account.create({ data: { publicKey: "pk_owner_capped_view" }, select: { id: true } });
        const session = await db.session.create({
            data: {
                accountId: owner.id,
                tag: "s_plain_capped_view",
                encryptionMode: "plain",
                metadata: JSON.stringify({ v: 1, flavor: "codex" }),
                agentState: null,
                dataEncryptionKey: null,
            },
            select: { id: true },
        });
        await db.sessionMessage.create({
            data: {
                sessionId: session.id,
                seq: 1,
                messageRole: "user",
                content: { t: "plain", v: { role: "user", content: { type: "text", text: "hello" } } },
            },
        });

        const token = "tok_plain_capped_view";
        const share = await db.publicSessionShare.create({
            data: {
                sessionId: session.id,
                createdByUserId: owner.id,
                tokenHash: createHash("sha256").update(token, "utf8").digest(),
                encryptedDataKey: null,
                isConsentRequired: false,
                maxUses: 1,
                useCount: 0,
            },
            select: { id: true },
        });

        const app = createAuthenticatedTestApp();
        publicShareRoutes(app as any);
        await app.ready();
        try {
            const metadata = await app.inject({
                method: "GET",
                url: `/v1/public-share/${encodeURIComponent(token)}`,
            });
            const messagesAccessToken = metadata.json().messagesAccessToken;
            const messages = await app.inject({
                method: "GET",
                url: `/v1/public-share/${encodeURIComponent(token)}/messages`,
                headers: { "x-public-share-messages-access-token": messagesAccessToken ?? "missing-grant" },
            });

            expect(metadata.statusCode).toBe(200);
            expect(messagesAccessToken).toEqual(expect.any(String));
            expect(messages.statusCode).toBe(200);
        } finally {
            await app.close();
        }

        await expect(db.publicSessionShare.findUnique({
            where: { id: share.id },
            select: { useCount: true },
        })).resolves.toEqual({ useCount: 1 });
    });

    it("allows exactly one concurrent metadata claim for a maxUses=1 public share", async () => {
        const owner = await db.account.create({ data: { publicKey: "pk_owner_concurrent_claim" }, select: { id: true } });
        const session = await db.session.create({
            data: {
                accountId: owner.id,
                tag: "s_plain_concurrent_claim",
                encryptionMode: "plain",
                metadata: JSON.stringify({ v: 1, flavor: "codex" }),
                agentState: null,
                dataEncryptionKey: null,
            },
            select: { id: true },
        });
        const token = "tok_plain_concurrent_claim";
        const share = await db.publicSessionShare.create({
            data: {
                sessionId: session.id,
                createdByUserId: owner.id,
                tokenHash: createHash("sha256").update(token, "utf8").digest(),
                encryptedDataKey: null,
                isConsentRequired: false,
                maxUses: 1,
                useCount: 0,
            },
            select: { id: true },
        });

        const app = createAuthenticatedTestApp();
        publicShareRoutes(app as any);
        await app.ready();
        try {
            const results = await Promise.all([
                app.inject({ method: "GET", url: `/v1/public-share/${encodeURIComponent(token)}` }),
                app.inject({ method: "GET", url: `/v1/public-share/${encodeURIComponent(token)}` }),
            ]);

            expect(results.map((result) => result.statusCode).sort()).toEqual([200, 404]);
        } finally {
            await app.close();
        }

        await expect(db.publicSessionShare.findUnique({
            where: { id: share.id },
            select: { useCount: true },
        })).resolves.toEqual({ useCount: 1 });
    });

    it("fails closed for malformed persisted use limits without consuming", async () => {
        const owner = await db.account.create({ data: { publicKey: "pk_owner_invalid_cap" }, select: { id: true } });
        const session = await db.session.create({
            data: {
                accountId: owner.id,
                tag: "s_plain_invalid_cap",
                encryptionMode: "plain",
                metadata: JSON.stringify({ v: 1, flavor: "codex" }),
                agentState: null,
                dataEncryptionKey: null,
            },
            select: { id: true },
        });
        const token = "tok_plain_invalid_cap";
        const share = await db.publicSessionShare.create({
            data: {
                sessionId: session.id,
                createdByUserId: owner.id,
                tokenHash: createHash("sha256").update(token, "utf8").digest(),
                encryptedDataKey: null,
                isConsentRequired: false,
                maxUses: -1,
                useCount: 0,
            },
            select: { id: true },
        });

        const app = createAuthenticatedTestApp();
        publicShareRoutes(app as any);
        await app.ready();
        try {
            const metadata = await app.inject({ method: "GET", url: `/v1/public-share/${encodeURIComponent(token)}` });
            const messages = await app.inject({ method: "GET", url: `/v1/public-share/${encodeURIComponent(token)}/messages` });
            expect(metadata.statusCode).toBe(404);
            expect(messages.statusCode).toBe(404);
        } finally {
            await app.close();
        }

        await expect(db.publicSessionShare.findUnique({
            where: { id: share.id },
            select: { useCount: true },
        })).resolves.toEqual({ useCount: 0 });
    });

    it("rolls back the final capped use when transactional access logging fails", async () => {
        const owner = await db.account.create({ data: { publicKey: "pk_owner_log_rollback" }, select: { id: true } });
        const session = await db.session.create({
            data: {
                accountId: owner.id,
                tag: "s_plain_log_rollback",
                encryptionMode: "plain",
                metadata: JSON.stringify({ v: 1, flavor: "codex" }),
                agentState: null,
                dataEncryptionKey: null,
            },
            select: { id: true },
        });
        const token = "tok_plain_log_rollback";
        const share = await db.publicSessionShare.create({
            data: {
                sessionId: session.id,
                createdByUserId: owner.id,
                tokenHash: createHash("sha256").update(token, "utf8").digest(),
                encryptedDataKey: null,
                isConsentRequired: false,
                maxUses: 1,
                useCount: 0,
            },
            select: { id: true },
        });

        await db.$executeRawUnsafe(`
            CREATE TRIGGER "force_public_share_access_log_failure"
            BEFORE INSERT ON "PublicShareAccessLog"
            BEGIN
                SELECT RAISE(ABORT, 'forced public share access-log failure');
            END
        `);

        const app = createAuthenticatedTestApp();
        publicShareRoutes(app as any);
        await app.ready();
        try {
            const metadata = await app.inject({ method: "GET", url: `/v1/public-share/${encodeURIComponent(token)}` });
            expect(metadata.statusCode).toBe(500);
        } finally {
            await app.close();
            await db.$executeRawUnsafe('DROP TRIGGER IF EXISTS "force_public_share_access_log_failure"');
        }

        await expect(db.publicSessionShare.findUnique({
            where: { id: share.id },
            select: { useCount: true },
        })).resolves.toEqual({ useCount: 0 });
    });

    it("rejects a malformed E2EE key envelope before consuming the final use", async () => {
        const owner = await db.account.create({ data: { publicKey: "pk_owner_malformed_envelope" }, select: { id: true } });
        const session = await db.session.create({
            data: {
                accountId: owner.id,
                tag: "s_e2ee_malformed_envelope",
                encryptionMode: "e2ee",
                metadata: "ciphertext",
                agentState: null,
                dataEncryptionKey: Buffer.from([1, 2, 3]),
            },
            select: { id: true },
        });

        const token = "tok_e2ee_malformed_envelope";
        const share = await db.publicSessionShare.create({
            data: {
                sessionId: session.id,
                createdByUserId: owner.id,
                tokenHash: createHash("sha256").update(token, "utf8").digest(),
                encryptedDataKey: Buffer.from([1, 2, 3]),
                isConsentRequired: false,
                maxUses: 1,
                useCount: 0,
            },
            select: { id: true },
        });

        const app = createAuthenticatedTestApp();
        publicShareRoutes(app as any);
        await app.ready();
        try {
            const access = await app.inject({
                method: "GET",
                url: `/v1/public-share/${encodeURIComponent(token)}`,
            });
            expect(access.statusCode).toBe(404);
        } finally {
            await app.close();
        }

        await expect(db.publicSessionShare.findUnique({
            where: { id: share.id },
            select: { useCount: true },
        })).resolves.toEqual({ useCount: 0 });
    });

    it("projects messageRole for public transcript normalization", async () => {
        const owner = await db.account.create({ data: { publicKey: "pk_owner_message_role" }, select: { id: true } });
        const session = await db.session.create({
            data: {
                accountId: owner.id,
                tag: "s_plain_message_role",
                encryptionMode: "plain",
                metadata: JSON.stringify({ v: 1, flavor: "codex" }),
                agentState: null,
                dataEncryptionKey: null,
            },
            select: { id: true },
        });
        await db.sessionMessage.create({
            data: {
                sessionId: session.id,
                seq: 1,
                messageRole: "event",
                content: { t: "plain", v: { role: "agent", content: { type: "output", data: { type: "assistant", message: { content: "status" } } } } },
            },
        });

        const token = "tok_plain_message_role";
        await db.publicSessionShare.create({
            data: {
                sessionId: session.id,
                createdByUserId: owner.id,
                tokenHash: createHash("sha256").update(token, "utf8").digest(),
                encryptedDataKey: null,
                isConsentRequired: false,
            },
        });

        const app = createAuthenticatedTestApp();
        publicShareRoutes(app as any);
        await app.ready();
        try {
            const messages = await app.inject({
                method: "GET",
                url: `/v1/public-share/${encodeURIComponent(token)}/messages`,
            });

            expect(messages.statusCode).toBe(200);
            expect(messages.json().messages).toEqual([
                expect.objectContaining({ seq: 1, messageRole: "event" }),
            ]);
        } finally {
            await app.close();
        }
    });
});
