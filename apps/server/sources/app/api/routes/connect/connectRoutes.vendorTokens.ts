import { z } from "zod";

import { type Fastify } from "../../types";
import { encryptString } from "@/modules/encrypt";
import { db } from "@/storage/db";
import { parseIntEnv } from "@/config/env";
import {
    deleteLegacyConnectedServiceVendorToken,
    mutateLegacyConnectedServiceVendorToken,
} from "./credentials/mutation";

function resolveVendorTokenMaxLen(env: NodeJS.ProcessEnv): number {
    return parseIntEnv(env.VENDOR_TOKEN_MAX_LEN, 4096, { min: 256, max: 65536 });
}

export function connectVendorTokenRoutes(app: Fastify) {
    const maxTokenLen = resolveVendorTokenMaxLen(process.env);

    //
    // Inference vendor token endpoints (existing)
    //

    app.post("/v1/connect/:vendor/register", {
        preHandler: app.authenticate,
        schema: {
            body: z.object({ token: z.string().min(1).max(maxTokenLen) }),
            params: z.object({ vendor: z.enum(["openai", "anthropic", "gemini"]) }),
            response: {
                200: z.object({ success: z.literal(true) }),
                409: z.object({ error: z.literal("connect_credential_conflict") }),
            },
        },
    }, async (request, reply) => {
        const userId = request.userId;

        const encrypted = encryptString(["user", userId, "vendors", request.params.vendor, "token"], request.body.token);
        const result = await mutateLegacyConnectedServiceVendorToken({
            accountId: userId,
            vendor: request.params.vendor,
            token: encrypted,
        });
        if (result.status === "connected_credential_conflict") {
            return reply.code(409).send({ error: "connect_credential_conflict" });
        }
        reply.send({ success: true });
    });

    app.get("/v1/connect/:vendor/token", {
        preHandler: app.authenticate,
        schema: {
            params: z.object({ vendor: z.enum(["openai", "anthropic", "gemini"]) }),
            response: { 200: z.object({ hasToken: z.boolean() }) },
        },
    }, async (request, reply) => {
        const userId = request.userId;
        const token = await db.serviceAccountToken.findUnique({
            where: { accountId_vendor_profileId: { accountId: userId, vendor: request.params.vendor, profileId: "default" } },
            select: { id: true },
        });
        return reply.send({ hasToken: Boolean(token) });
    });

    app.delete("/v1/connect/:vendor", {
        preHandler: app.authenticate,
        schema: {
            params: z.object({ vendor: z.enum(["openai", "anthropic", "gemini"]) }),
            response: {
                200: z.object({ success: z.literal(true) }),
                409: z.object({ error: z.literal("connect_credential_conflict") }),
            },
        },
    }, async (request, reply) => {
        const userId = request.userId;

        const result = await deleteLegacyConnectedServiceVendorToken({
            accountId: userId,
            vendor: request.params.vendor,
        });
        if (result.status === "connected_credential_conflict") {
            return reply.code(409).send({ error: "connect_credential_conflict" });
        }
        reply.send({ success: true });
    });

    app.get("/v1/connect/tokens", {
        preHandler: app.authenticate,
        schema: {
            response: {
                200: z.object({
                    tokens: z.array(
                        z.object({
                            vendor: z.enum(["openai", "anthropic", "gemini"]),
                            hasToken: z.boolean(),
                        }),
                    ),
                }),
            },
        },
    }, async (request, reply) => {
        const userId = request.userId;
        const tokens = await db.serviceAccountToken.findMany({
            where: { accountId: userId, profileId: "default", vendor: { in: ["openai", "anthropic", "gemini"] } },
            select: { vendor: true },
        });
        return reply.send({
            tokens: tokens.flatMap((t) => {
                const vendor = t.vendor;
                if (vendor !== "openai" && vendor !== "anthropic" && vendor !== "gemini") return [];
                return [{ vendor, hasToken: true } satisfies { vendor: "openai" | "anthropic" | "gemini"; hasToken: true }];
            }),
        });
    });
}
