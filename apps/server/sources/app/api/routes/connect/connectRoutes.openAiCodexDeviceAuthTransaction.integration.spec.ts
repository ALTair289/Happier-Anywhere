import Fastify from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from "fastify-type-provider-zod";
import tweetnacl from "tweetnacl";

import { encodeBase64 } from "@happier-dev/protocol";

import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

import { createAppCloseTracker } from "../../testkit/appLifecycle";
import { registerConnectedServiceOpenAiCodexDeviceAuthRoutes } from "./connectedServicesV2/registerConnectedServiceOpenAiCodexDeviceAuthRoutes";

const { trackApp, closeTrackedApps } = createAppCloseTracker();

function createTestApp() {
    const app = Fastify({ logger: false });
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>() as any;
    typed.decorate("authenticate", async (request: any, reply: any) => {
        const userId = request.headers["x-test-user-id"];
        if (typeof userId !== "string" || !userId) {
            return reply.code(401).send({ error: "Unauthorized" });
        }
        request.userId = userId;
    });
    registerConnectedServiceOpenAiCodexDeviceAuthRoutes(typed);
    return trackApp(typed);
}

function jsonResponse(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
    });
}

function createRecipientPublicKey(): string {
    return encodeBase64(tweetnacl.box.keyPair().publicKey, "base64url");
}

describe("OpenAI Codex device-auth durable transaction routes", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-connected-service-device-auth-",
            initAuth: true,
            initEncrypt: true,
        });
    }, 120_000);

    afterEach(async () => {
        await closeTrackedApps();
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        harness.resetEnv();
        await db.repeatKey.deleteMany();
        await db.account.deleteMany();
    });

    afterAll(async () => {
        await harness.close();
    });

    it("stores an opaque account/key-bound transaction without plaintext provider device secrets", async () => {
        const account = await db.account.create({ data: { publicKey: "account-pk-a" }, select: { id: true } });
        const recipientPublicKey = createRecipientPublicKey();
        const fetcher = vi.fn(async () => jsonResponse(200, {
            device_auth_id: "provider-device-secret-a",
            user_code: "provider-user-secret-a",
            interval: 5,
        }));
        vi.stubGlobal("fetch", fetcher);

        const app = createTestApp();
        await app.ready();
        const start = await app.inject({
            method: "POST",
            url: "/v2/connect/openai-codex/oauth/device/start",
            headers: { "content-type": "application/json", "x-test-user-id": account.id },
            payload: { publicKey: recipientPublicKey },
        });

        expect(start.statusCode).toBe(200);
        expect(start.json()).toEqual({
            transactionId: expect.stringMatching(/^csda_[A-Za-z0-9]+$/),
            deviceAuthId: expect.stringMatching(/^csda_[A-Za-z0-9]+$/),
            userCode: "provider-user-secret-a",
            intervalMs: 5_000,
            verificationUrl: "https://auth.openai.com/codex/device",
        });
        expect(start.json().deviceAuthId).toBe(start.json().transactionId);

        const row = await db.repeatKey.findUniqueOrThrow({
            where: { key: start.json().transactionId },
            select: { value: true },
        });
        expect(row.value).not.toContain("provider-device-secret-a");
        expect(row.value).not.toContain("provider-user-secret-a");
        expect(row.value).not.toContain(recipientPublicKey);
    });

    it("rejects an invalid recipient key before starting provider device auth", async () => {
        const account = await db.account.create({ data: { publicKey: "account-pk-invalid" }, select: { id: true } });
        const fetcher = vi.fn(async () => jsonResponse(200, {
            device_auth_id: "must-not-be-created",
            user_code: "must-not-be-created",
            interval: 5,
        }));
        vi.stubGlobal("fetch", fetcher);
        const app = createTestApp();
        await app.ready();

        const start = await app.inject({
            method: "POST",
            url: "/v2/connect/openai-codex/oauth/device/start",
            headers: { "content-type": "application/json", "x-test-user-id": account.id },
            payload: { publicKey: "not-a-valid-box-key" },
        });

        expect(start.statusCode).toBe(400);
        expect(fetcher).not.toHaveBeenCalled();
        expect(await db.repeatKey.count()).toBe(0);
    });

    it("polls by transaction id only and hides another account's transaction", async () => {
        const [accountA, accountB] = await Promise.all([
            db.account.create({ data: { publicKey: "account-pk-a" }, select: { id: true } }),
            db.account.create({ data: { publicKey: "account-pk-b" }, select: { id: true } }),
        ]);
        const fetcher = vi.fn(async () => jsonResponse(200, {
            device_auth_id: "provider-device-b",
            user_code: "provider-user-b",
            interval: 5,
        }));
        vi.stubGlobal("fetch", fetcher);
        const app = createTestApp();
        await app.ready();

        const start = await app.inject({
            method: "POST",
            url: "/v2/connect/openai-codex/oauth/device/start",
            headers: { "content-type": "application/json", "x-test-user-id": accountA.id },
            payload: { publicKey: createRecipientPublicKey() },
        });
        const transactionId = start.json().transactionId as string;

        const crossAccountPoll = await app.inject({
            method: "POST",
            url: "/v2/connect/openai-codex/oauth/device/poll",
            headers: { "content-type": "application/json", "x-test-user-id": accountB.id },
            payload: { transactionId },
        });

        expect(crossAccountPoll.statusCode).toBe(404);
        expect(fetcher).toHaveBeenCalledTimes(1);
    });

    it("does not contact the provider before the server-owned polling cadence is due", async () => {
        const now = 10_000;
        vi.spyOn(Date, "now").mockReturnValue(now);
        const account = await db.account.create({ data: { publicKey: "account-pk-c" }, select: { id: true } });
        const fetcher = vi.fn(async () => jsonResponse(200, {
            device_auth_id: "provider-device-c",
            user_code: "provider-user-c",
            interval: 5,
        }));
        vi.stubGlobal("fetch", fetcher);
        const app = createTestApp();
        await app.ready();

        const start = await app.inject({
            method: "POST",
            url: "/v2/connect/openai-codex/oauth/device/start",
            headers: { "content-type": "application/json", "x-test-user-id": account.id },
            payload: { publicKey: createRecipientPublicKey() },
        });
        const poll = await app.inject({
            method: "POST",
            url: "/v2/connect/openai-codex/oauth/device/poll",
            headers: { "content-type": "application/json", "x-test-user-id": account.id },
            payload: { transactionId: start.json().transactionId },
        });

        expect(poll.statusCode).toBe(200);
        expect(poll.json()).toEqual({ status: "pending", retryAfterMs: 5_000 });
        expect(fetcher).toHaveBeenCalledTimes(1);
    });

    it("claims a due provider poll once across concurrent requests", async () => {
        let now = 20_000;
        vi.spyOn(Date, "now").mockImplementation(() => now);
        const account = await db.account.create({ data: { publicKey: "account-pk-d" }, select: { id: true } });
        let resolveProviderPoll!: (response: Response) => void;
        const providerPoll = new Promise<Response>((resolve) => {
            resolveProviderPoll = resolve;
        });
        const fetcher = vi.fn(async () => {
            if (fetcher.mock.calls.length === 1) {
                return jsonResponse(200, {
                    device_auth_id: "provider-device-d",
                    user_code: "provider-user-d",
                    interval: 5,
                });
            }
            return await providerPoll;
        });
        vi.stubGlobal("fetch", fetcher);
        const app = createTestApp();
        await app.ready();

        const start = await app.inject({
            method: "POST",
            url: "/v2/connect/openai-codex/oauth/device/start",
            headers: { "content-type": "application/json", "x-test-user-id": account.id },
            payload: { publicKey: createRecipientPublicKey() },
        });
        now += 5_000;
        const payload = { transactionId: start.json().transactionId };
        const first = app.inject({
            method: "POST",
            url: "/v2/connect/openai-codex/oauth/device/poll",
            headers: { "content-type": "application/json", "x-test-user-id": account.id },
            payload,
        });
        await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
        const second = await app.inject({
            method: "POST",
            url: "/v2/connect/openai-codex/oauth/device/poll",
            headers: { "content-type": "application/json", "x-test-user-id": account.id },
            payload,
        });
        resolveProviderPoll(jsonResponse(403, {}));

        expect(second.statusCode).toBe(200);
        expect(second.json()).toEqual(expect.objectContaining({ status: "pending" }));
        expect((await first).json()).toEqual(expect.objectContaining({ status: "pending" }));
        expect(fetcher).toHaveBeenCalledTimes(2);
    });

    it("replays the same retained bundle after a successful response is lost", async () => {
        let now = 30_000;
        vi.spyOn(Date, "now").mockImplementation(() => now);
        const account = await db.account.create({ data: { publicKey: "account-pk-e" }, select: { id: true } });
        const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
            const body = typeof init?.body === "string" ? init.body : String(init?.body ?? "");
            if (fetcher.mock.calls.length === 1) {
                return jsonResponse(200, {
                    device_auth_id: "provider-device-e",
                    user_code: "provider-user-e",
                    interval: 1,
                });
            }
            if (body.includes("device_auth_id")) {
                return jsonResponse(200, {
                    authorization_code: "provider-authorization-secret-e",
                    code_verifier: "provider-verifier-secret-e",
                });
            }
            return jsonResponse(200, {
                access_token: "provider-access-secret-e",
                refresh_token: "provider-refresh-secret-e",
                expires_in: 3600,
            });
        });
        vi.stubGlobal("fetch", fetcher);
        const app = createTestApp();
        await app.ready();

        const start = await app.inject({
            method: "POST",
            url: "/v2/connect/openai-codex/oauth/device/start",
            headers: { "content-type": "application/json", "x-test-user-id": account.id },
            payload: { publicKey: createRecipientPublicKey() },
        });
        const transactionId = start.json().transactionId as string;
        now += 1_000;
        const success = await app.inject({
            method: "POST",
            url: "/v2/connect/openai-codex/oauth/device/poll",
            headers: { "content-type": "application/json", "x-test-user-id": account.id },
            payload: { transactionId },
        });
        const replay = await app.inject({
            method: "POST",
            url: "/v2/connect/openai-codex/oauth/device/poll",
            headers: { "content-type": "application/json", "x-test-user-id": account.id },
            payload: { transactionId },
        });

        expect(success.statusCode).toBe(200);
        expect(success.json()).toEqual({ status: "success", bundle: expect.any(String) });
        expect(replay.statusCode).toBe(200);
        expect(replay.json()).toEqual(success.json());
        expect(fetcher).toHaveBeenCalledTimes(3);
        const row = await db.repeatKey.findUniqueOrThrow({ where: { key: transactionId }, select: { value: true } });
        for (const secret of [
            "provider-device-e",
            "provider-user-e",
            "provider-authorization-secret-e",
            "provider-verifier-secret-e",
            "provider-access-secret-e",
            "provider-refresh-secret-e",
        ]) {
            expect(row.value).not.toContain(secret);
        }
    });

    it("prevents an expired polling claimant from exchanging or settling over its successor", async () => {
        let now = 40_000;
        vi.spyOn(Date, "now").mockImplementation(() => now);
        const account = await db.account.create({ data: { publicKey: "account-pk-f" }, select: { id: true } });
        let resolveStaleProviderPoll!: (response: Response) => void;
        const staleProviderPoll = new Promise<Response>((resolve) => {
            resolveStaleProviderPoll = resolve;
        });
        const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
            if (fetcher.mock.calls.length === 1) {
                return jsonResponse(200, {
                    device_auth_id: "provider-device-f",
                    user_code: "provider-user-f",
                    interval: 1,
                });
            }
            if (fetcher.mock.calls.length === 2) return await staleProviderPoll;
            const body = typeof init?.body === "string" ? init.body : String(init?.body ?? "");
            if (body.includes("device_auth_id")) return jsonResponse(403, {});
            throw new Error("a stale claimant must not reach token exchange");
        });
        vi.stubGlobal("fetch", fetcher);
        const app = createTestApp();
        await app.ready();

        const start = await app.inject({
            method: "POST",
            url: "/v2/connect/openai-codex/oauth/device/start",
            headers: { "content-type": "application/json", "x-test-user-id": account.id },
            payload: { publicKey: createRecipientPublicKey() },
        });
        const payload = { transactionId: start.json().transactionId };
        now += 1_000;
        const stale = app.inject({
            method: "POST",
            url: "/v2/connect/openai-codex/oauth/device/poll",
            headers: { "content-type": "application/json", "x-test-user-id": account.id },
            payload,
        });
        await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
        now += 31_000;
        const successor = await app.inject({
            method: "POST",
            url: "/v2/connect/openai-codex/oauth/device/poll",
            headers: { "content-type": "application/json", "x-test-user-id": account.id },
            payload,
        });
        resolveStaleProviderPoll(jsonResponse(200, {
            authorization_code: "stale-authorization-code",
            code_verifier: "stale-verifier",
        }));

        expect(successor.statusCode).toBe(200);
        expect(successor.json()).toEqual(expect.objectContaining({ status: "pending" }));
        expect((await stale).json()).toEqual(expect.objectContaining({ status: "pending" }));
        expect(fetcher).toHaveBeenCalledTimes(3);
    });
});
