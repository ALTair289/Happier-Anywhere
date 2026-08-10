import Fastify from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from "fastify-type-provider-zod";
import tweetnacl from "tweetnacl";
import * as privacyKit from "privacy-kit";

import { db } from "@/storage/db";
import { auth } from "@/app/auth/auth";
import { authRoutes } from "./authRoutes";
import { enableAuthentication } from "../../utils/enableAuthentication";
import { createAppCloseTracker } from "../../testkit/appLifecycle";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

const { trackApp, closeTrackedApps } = createAppCloseTracker();

function createTestApp() {
    const app = Fastify({ logger: false });
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>() as any;
    enableAuthentication(typed);
    return trackApp(typed);
}

function createPhoneEphemeralKeypair() {
    const kp = tweetnacl.box.keyPair();
    return {
        publicKeyRaw: new Uint8Array(kp.publicKey),
        publicKeyBase64: privacyKit.encodeBase64(new Uint8Array(kp.publicKey)),
    };
}

describe("authRoutes (pairing auth) (integration)", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-auth-pairing-",
            initAuth: true,
            initEncrypt: true,
            env: {
                HAPPIER_FEATURE_AUTH_PAIRING__DESKTOP_QR_MOBILE_SCAN_ENABLED: "1",
            },
        });
    }, 120_000);

    afterEach(async () => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
        await closeTrackedApps();
        harness.resetEnv();
        await (db as any).authPairingSession?.deleteMany?.().catch(() => {});
        await db.accountAuthRequest.deleteMany();
        await db.account.deleteMany();
    });

    afterAll(async () => {
        await harness.close();
    });

    it("requires auth for /v1/auth/pairing/start", async () => {
        const app = createTestApp();
        authRoutes(app as any);
        await app.ready();

        const res = await app.inject({
            method: "POST",
            url: "/v1/auth/pairing/start",
            payload: { secretHash: "xxxxxxxx" },
        });
        expect(res.statusCode).toBe(401);

        const claimRes = await app.inject({
            method: "POST",
            url: "/v1/auth/pairing/claim/start",
            payload: { origin: "https://relay.example.test" },
        });
        expect(claimRes.statusCode).toBe(401);

        await app.close();
    });

    it("creates an origin-bound claim and atomically accepts exactly one phone request", async () => {
        const account = await db.account.create({
            data: { publicKey: `pk-${Date.now()}-claim` },
            select: { id: true },
        });
        const token = await auth.createToken(account.id);

        const app = createTestApp();
        authRoutes(app as any);
        await app.ready();

        const startedAt = Date.now();
        const startRes = await app.inject({
            method: "POST",
            url: "/v1/auth/pairing/claim/start",
            headers: { authorization: `Bearer ${token}` },
            payload: { origin: "https://Relay.Example.test/" },
        });
        expect(startRes.statusCode).toBe(200);
        const startJson = startRes.json() as any;
        expect(startJson).toEqual({
            protocol: "claim-v1",
            claimId: expect.stringMatching(/^claim_[A-Za-z0-9_-]{43}$/),
            origin: "https://relay.example.test",
            expiresAt: expect.any(String),
        });
        expect(new Date(startJson.expiresAt).getTime() - startedAt).toBeLessThanOrEqual(600_000);

        const stored = await db.authPairingSession.findUniqueOrThrow({ where: { id: startJson.claimId } });
        expect(stored.secretHash).not.toContain(startJson.claimId);
        expect(stored.secretHash).not.toContain("relay.example.test");

        const mismatchKey = createPhoneEphemeralKeypair().publicKeyBase64;
        const mismatch = await app.inject({
            method: "POST",
            url: "/v1/auth/pairing/claim/consume",
            payload: {
                claimId: startJson.claimId,
                origin: "https://other.example.test",
                publicKey: mismatchKey,
                deviceLabel: "Wrong origin",
            },
        });
        expect(mismatch.statusCode).toBe(404);
        expect((await db.authPairingSession.findUniqueOrThrow({ where: { id: startJson.claimId } })).requestedPublicKey).toBeNull();

        const first = createPhoneEphemeralKeypair().publicKeyBase64;
        const second = createPhoneEphemeralKeypair().publicKeyBase64;
        const attempts = await Promise.all([
            app.inject({
                method: "POST",
                url: "/v1/auth/pairing/claim/consume",
                payload: { claimId: startJson.claimId, origin: startJson.origin, publicKey: first, deviceLabel: "Phone A" },
            }),
            app.inject({
                method: "POST",
                url: "/v1/auth/pairing/claim/consume",
                payload: { claimId: startJson.claimId, origin: startJson.origin, publicKey: second, deviceLabel: "Phone B" },
            }),
        ]);
        expect(attempts.map((response) => response.statusCode).sort()).toEqual([200, 404]);

        const winner = attempts[0]!.statusCode === 200 ? first : second;
        const winningConfirmCode = attempts.find((response) => response.statusCode === 200)!.json().confirmCode;
        const statusRes = await app.inject({
            method: "GET",
            url: `/v1/auth/pairing/status?pairId=${encodeURIComponent(startJson.claimId)}`,
            headers: { authorization: `Bearer ${token}` },
        });
        expect(statusRes.statusCode).toBe(200);
        expect(statusRes.json()).toEqual(expect.objectContaining({
            state: "requested",
            requestedPublicKey: winner,
            confirmCode: winningConfirmCode,
        }));

        const repeat = await app.inject({
            method: "POST",
            url: "/v1/auth/pairing/claim/consume",
            payload: { claimId: startJson.claimId, origin: startJson.origin, publicKey: winner },
        });
        expect(repeat.statusCode).toBe(200);
        expect(repeat.json()).toEqual({ state: "requested", confirmCode: winningConfirmCode });

        const differentKeyReplay = await app.inject({
            method: "POST",
            url: "/v1/auth/pairing/claim/consume",
            payload: {
                claimId: startJson.claimId,
                origin: startJson.origin,
                publicKey: createPhoneEphemeralKeypair().publicKeyBase64,
            },
        });
        expect(differentKeyReplay.statusCode).toBe(404);

        const desktopConsume = await app.inject({
            method: "POST",
            url: "/v1/auth/pairing/consume",
            headers: { authorization: `Bearer ${token}` },
            payload: { pairId: startJson.claimId },
        });
        expect(desktopConsume.statusCode).toBe(200);

        const consumedStatus = await app.inject({
            method: "GET",
            url: `/v1/auth/pairing/status?pairId=${encodeURIComponent(startJson.claimId)}`,
            headers: { authorization: `Bearer ${token}` },
        });
        expect(consumedStatus.statusCode).toBe(404);

        await app.close();
    });

    it("fails closed for claim consume and status at the exact expiry boundary", async () => {
        const account = await db.account.create({
            data: { publicKey: `pk-${Date.now()}-expired-claim` },
            select: { id: true },
        });
        const token = await auth.createToken(account.id);
        const app = createTestApp();
        authRoutes(app as any);
        await app.ready();

        const startRes = await app.inject({
            method: "POST",
            url: "/v1/auth/pairing/claim/start",
            headers: { authorization: `Bearer ${token}` },
            payload: { origin: "https://relay.example.test" },
        });
        expect(startRes.statusCode).toBe(200);
        const claimId = String((startRes.json() as any).claimId);
        const exactExpiry = new Date(Date.now() + 5_000);
        await db.authPairingSession.update({ where: { id: claimId }, data: { expiresAt: exactExpiry } });

        const realDate = globalThis.Date;
        const exactExpiryMs = exactExpiry.getTime();
        vi.stubGlobal("Date", new Proxy(realDate, {
            construct(target, args, newTarget) {
                return Reflect.construct(target, args.length === 0 ? [exactExpiryMs] : args, newTarget);
            },
            get(target, property, receiver) {
                if (property === "now") return () => exactExpiryMs;
                return Reflect.get(target, property, receiver);
            },
        }));

        try {
            const expired = await app.inject({
                method: "POST",
                url: "/v1/auth/pairing/claim/consume",
                payload: {
                    claimId,
                    origin: "https://relay.example.test",
                    publicKey: createPhoneEphemeralKeypair().publicKeyBase64,
                },
            });
            expect(expired.statusCode).toBe(404);

            const expiredStatus = await app.inject({
                method: "GET",
                url: `/v1/auth/pairing/status?pairId=${encodeURIComponent(claimId)}`,
                headers: { authorization: `Bearer ${token}` },
            });
            expect(expiredStatus.statusCode).toBe(404);
        } finally {
            vi.unstubAllGlobals();
        }

        await app.close();
    });

    it("creates a pairing session, allows phone request, and exposes status to the owning account", async () => {
        const account = await db.account.create({
            data: { publicKey: `pk-${Date.now()}` },
            select: { id: true },
        });
        const token = await auth.createToken(account.id);

        const app = createTestApp();
        authRoutes(app as any);
        await app.ready();

        const secret = "secret-hash-123";
        const secretHash = createHash("sha256").update(secret, "utf8").digest("base64url");
        const startRes = await app.inject({
            method: "POST",
            url: "/v1/auth/pairing/start",
            headers: { authorization: `Bearer ${token}` },
            payload: { secretHash },
        });
        expect(startRes.statusCode).toBe(200);
        const startJson = startRes.json() as any;
        expect(typeof startJson.pairId).toBe("string");
        expect(typeof startJson.expiresAt).toBe("string");

        const pairId = String(startJson.pairId);
        const { publicKeyBase64 } = createPhoneEphemeralKeypair();

        const invalidKeyRes = await app.inject({
            method: "POST",
            url: "/v1/auth/pairing/request",
            payload: { pairId, secret, publicKey: "not-base64!!", deviceLabel: "iPhone" },
        });
        expect(invalidKeyRes.statusCode).toBe(401);
        expect(invalidKeyRes.json()).toEqual({ error: "Invalid public key" });

        const badRes = await app.inject({
            method: "POST",
            url: "/v1/auth/pairing/request",
            payload: { pairId, secret: "wrong", publicKey: publicKeyBase64, deviceLabel: "iPhone" },
        });
        expect(badRes.statusCode).toBe(404);

        const tooLongSecretRes = await app.inject({
            method: "POST",
            url: "/v1/auth/pairing/request",
            payload: { pairId, secret: "x".repeat(1_000), publicKey: publicKeyBase64, deviceLabel: "iPhone" },
        });
        expect(tooLongSecretRes.statusCode).toBe(400);

        const requestRes = await app.inject({
            method: "POST",
            url: "/v1/auth/pairing/request",
            payload: { pairId, secret, publicKey: publicKeyBase64, deviceLabel: "iPhone" },
        });
        expect(requestRes.statusCode).toBe(200);
        expect(requestRes.json()).toEqual({ state: "requested", confirmCode: expect.any(String) });

        const tooLongDeviceLabelRes = await app.inject({
            method: "POST",
            url: "/v1/auth/pairing/request",
            payload: { pairId, secret, publicKey: publicKeyBase64, deviceLabel: "x".repeat(1_000) },
        });
        expect(tooLongDeviceLabelRes.statusCode).toBe(400);

        const otherKey = createPhoneEphemeralKeypair();
        const secondRes = await app.inject({
            method: "POST",
            url: "/v1/auth/pairing/request",
            payload: { pairId, secret, publicKey: otherKey.publicKeyBase64, deviceLabel: "Other iPhone" },
        });
        expect(secondRes.statusCode).toBe(401);
        expect(secondRes.json()).toEqual({ error: "already_requested" });

        const statusRes = await app.inject({
            method: "GET",
            url: `/v1/auth/pairing/status?pairId=${encodeURIComponent(pairId)}`,
            headers: { authorization: `Bearer ${token}` },
        });
        expect(statusRes.statusCode).toBe(200);
        expect(statusRes.json()).toEqual({
            state: "requested",
            pairId,
            expiresAt: expect.any(String),
            requestedPublicKey: publicKeyBase64,
            requestedDeviceLabel: "iPhone",
            confirmCode: expect.any(String),
        });

        await app.close();
    });

    it("allows only one legacy phone key to claim a pairing session concurrently", async () => {
        const account = await db.account.create({
            data: { publicKey: `pk-${Date.now()}` },
            select: { id: true },
        });
        const token = await auth.createToken(account.id);

        const app = createTestApp();
        authRoutes(app as any);
        await app.ready();

        const secret = "legacy-concurrency-secret";
        const secretHash = createHash("sha256").update(secret, "utf8").digest("base64url");
        const startRes = await app.inject({
            method: "POST",
            url: "/v1/auth/pairing/start",
            headers: { authorization: `Bearer ${token}` },
            payload: { secretHash },
        });
        expect(startRes.statusCode).toBe(200);
        const pairId = String((startRes.json() as any).pairId);

        const firstKey = createPhoneEphemeralKeypair().publicKeyBase64;
        const secondKey = createPhoneEphemeralKeypair().publicKeyBase64;

        try {
            const [first, second] = await Promise.all([
                app.inject({
                    method: "POST",
                    url: "/v1/auth/pairing/request",
                    payload: { pairId, secret, publicKey: firstKey, deviceLabel: "First phone" },
                }),
                app.inject({
                    method: "POST",
                    url: "/v1/auth/pairing/request",
                    payload: { pairId, secret, publicKey: secondKey, deviceLabel: "Second phone" },
                }),
            ]);

            const statuses = [first.statusCode, second.statusCode].sort((a, b) => a - b);
            expect(statuses).toEqual([200, 401]);
            const winner = first.statusCode === 200 ? firstKey : secondKey;
            expect((await db.authPairingSession.findUnique({ where: { id: pairId } }))?.requestedPublicKey).toBe(winner);
        } finally {
            await app.close();
        }
    });

    it("invalidates previous pairing sessions for the same account on start", async () => {
        const account = await db.account.create({
            data: { publicKey: `pk-${Date.now()}` },
            select: { id: true },
        });
        const token = await auth.createToken(account.id);

        const app = createTestApp();
        authRoutes(app as any);
        await app.ready();

        const secret1 = "secret-1";
        const secretHash1 = createHash("sha256").update(secret1, "utf8").digest("base64url");
        const start1 = await app.inject({
            method: "POST",
            url: "/v1/auth/pairing/start",
            headers: { authorization: `Bearer ${token}` },
            payload: { secretHash: secretHash1 },
        });
        expect(start1.statusCode).toBe(200);
        const pairId1 = String((start1.json() as any).pairId);

        const secret2 = "secret-2";
        const secretHash2 = createHash("sha256").update(secret2, "utf8").digest("base64url");
        const start2 = await app.inject({
            method: "POST",
            url: "/v1/auth/pairing/start",
            headers: { authorization: `Bearer ${token}` },
            payload: { secretHash: secretHash2 },
        });
        expect(start2.statusCode).toBe(200);
        const pairId2 = String((start2.json() as any).pairId);
        expect(pairId2).not.toBe(pairId1);

        const oldStatus = await app.inject({
            method: "GET",
            url: `/v1/auth/pairing/status?pairId=${encodeURIComponent(pairId1)}`,
            headers: { authorization: `Bearer ${token}` },
        });
        expect(oldStatus.statusCode).toBe(404);

        const nextStatus = await app.inject({
            method: "GET",
            url: `/v1/auth/pairing/status?pairId=${encodeURIComponent(pairId2)}`,
            headers: { authorization: `Bearer ${token}` },
        });
        expect(nextStatus.statusCode).toBe(200);
        expect(nextStatus.json()).toEqual({ state: "pending", pairId: pairId2, expiresAt: expect.any(String) });

        await app.close();
    });

    it("best-effort cleans up expired pairing sessions on start", async () => {
        const accountA = await db.account.create({
            data: { publicKey: `pk-${Date.now()}-a` },
            select: { id: true },
        });
        const token = await auth.createToken(accountA.id);

        const accountB = await db.account.create({
            data: { publicKey: `pk-${Date.now()}-b` },
            select: { id: true },
        });

        await db.authPairingSession.create({
            data: {
                accountId: accountB.id,
                secretHash: "expired-secret-hash",
                requestedPublicKey: null,
                expiresAt: new Date(Date.now() - 60_000),
            },
        });

        expect(await db.authPairingSession.count({ where: { accountId: accountB.id } })).toBe(1);

        const app = createTestApp();
        authRoutes(app as any);
        await app.ready();

        const secret = "cleanup-secret";
        const secretHash = createHash("sha256").update(secret, "utf8").digest("base64url");
        const startRes = await app.inject({
            method: "POST",
            url: "/v1/auth/pairing/start",
            headers: { authorization: `Bearer ${token}` },
            payload: { secretHash },
        });
        expect(startRes.statusCode).toBe(200);

        expect(await db.authPairingSession.count({ where: { accountId: accountB.id } })).toBe(0);

        await app.close();
    });
});
