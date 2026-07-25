import Fastify, { type FastifyRequest } from "fastify";
import { describe, expect, it, vi } from "vitest";
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from "fastify-type-provider-zod";
import type { Fastify as HappierFastify } from "../../types";

const {
    startOpenAiCodexDeviceAuthTransaction,
    pollOpenAiCodexDeviceAuthTransaction,
} = vi.hoisted(() => ({
    startOpenAiCodexDeviceAuthTransaction: vi.fn(async () => ({
        transactionId: "csda_released_alias",
        userCode: "ABCD-EFGH",
        intervalMs: 5_000,
        verificationUrl: "https://auth.openai.com/codex/device",
    })),
    pollOpenAiCodexDeviceAuthTransaction: vi.fn(async () => ({
        status: "pending" as const,
        retryAfterMs: 5_000,
    })),
}));

vi.mock("./connectedServicesV2/openaiCodex/openAiCodexDeviceAuthTransaction", () => ({
    startOpenAiCodexDeviceAuthTransaction,
    pollOpenAiCodexDeviceAuthTransaction,
}));

vi.mock("./connectedServicesV2/openaiCodex/openaiCodexDeviceAuth", () => ({
    isValidOpenAiCodexDeviceAuthRecipientPublicKey: () => true,
}));

import { registerConnectedServiceOpenAiCodexDeviceAuthRoutes } from "./connectedServicesV2/registerConnectedServiceOpenAiCodexDeviceAuthRoutes";

function createTestApp() {
    const app = Fastify({ logger: false });
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>() as unknown as HappierFastify;
    typed.decorate("authenticate", async (request: FastifyRequest) => {
        request.userId = "account-1";
    });
    registerConnectedServiceOpenAiCodexDeviceAuthRoutes(typed);
    return typed;
}

describe("OpenAI Codex exact 0.2.1 device-auth compatibility", () => {
    it("returns the released deviceAuthId alias alongside the current transactionId", async () => {
        const app = createTestApp();
        const response = await app.inject({
            method: "POST",
            url: "/v2/connect/openai-codex/oauth/device/start",
            payload: { publicKey: "released-public-key" },
        });
        await app.close();

        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({
            transactionId: "csda_released_alias",
            deviceAuthId: "csda_released_alias",
            userCode: "ABCD-EFGH",
            intervalMs: 5_000,
            verificationUrl: "https://auth.openai.com/codex/device",
        });
    });

    it("translates the released poll body to the current transaction owner", async () => {
        const app = createTestApp();
        const response = await app.inject({
            method: "POST",
            url: "/v2/connect/openai-codex/oauth/device/poll",
            payload: {
                publicKey: "released-public-key",
                deviceAuthId: "csda_released_alias",
                userCode: "ABCD-EFGH",
                intervalMs: 5_000,
            },
        });
        await app.close();

        expect(response.statusCode).toBe(200);
        expect(pollOpenAiCodexDeviceAuthTransaction).toHaveBeenCalledWith({
            accountId: "account-1",
            transactionId: "csda_released_alias",
            now: expect.any(Number),
        });
    });
});
