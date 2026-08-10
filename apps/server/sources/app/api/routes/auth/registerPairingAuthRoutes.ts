import { z } from "zod";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import tweetnacl from "tweetnacl";
import * as privacyKit from "privacy-kit";
import {
    PAIRING_CLAIM_V1_MAX_TTL_MS,
    PairingClaimConsumeRequestV1Schema,
    PairingClaimConsumeResponseV1Schema,
    PairingClaimInvalidPublicKeyResponseV1Schema,
    PairingClaimNotFoundResponseV1Schema,
    PairingClaimStartRequestV1Schema,
    PairingClaimStartResponseV1Schema,
} from "@happier-dev/protocol";

import { db } from "@/storage/db";
import { type Fastify } from "../../types";
import { createServerFeatureGatedRouteApp } from "@/app/features/catalog/serverFeatureGate";
import { resolvePairingAuthPolicyFromEnv } from "./pairingAuthPolicy";
import {
    pairingAuthRateLimitConsumePerUser,
    pairingAuthRateLimitRequestPerIp,
    pairingAuthRateLimitStartPerUser,
    pairingAuthRateLimitStatusPerUser,
} from "./pairingAuthRateLimits";

function computeSecretHash(secret: string): string {
    return createHash("sha256").update(secret, "utf8").digest("base64url");
}

function computeClaimOriginMarker(claimId: string, origin: string): string {
    return `claim-v1:${createHash("sha256").update(`claim-v1\0${claimId}\0${origin}`, "utf8").digest("base64url")}`;
}

function createClaimId(): string {
    const random = privacyKit.encodeBase64(new Uint8Array(randomBytes(32)));
    return `claim_${random.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
}

function safeEqualString(a: string, b: string): boolean {
    const aBuf = Buffer.from(a, "utf8");
    const bBuf = Buffer.from(b, "utf8");
    if (aBuf.length !== bBuf.length) return false;
    return timingSafeEqual(aBuf, bBuf);
}

function sanitizeDeviceLabel(raw: unknown): string | null {
    if (typeof raw !== "string") return null;
    const trimmed = raw.trim().replace(/\s+/g, " ");
    if (!trimmed) return null;
    return trimmed.slice(0, 120);
}

function computeConfirmCode(secretHash: string, publicKeyBase64: string): string {
    const digest = createHash("sha256").update(`${secretHash}.${publicKeyBase64}`, "utf8").digest();
    const n = digest.readUInt32BE(0) % 1_000_000;
    const code = String(n).padStart(6, "0");
    return `${code.slice(0, 3)} ${code.slice(3)}`;
}

export function registerPairingAuthRoutes(app: Fastify): void {
    const gated = createServerFeatureGatedRouteApp(app as any, "auth.pairing.desktopQrMobileScan");
    const policy = resolvePairingAuthPolicyFromEnv(process.env);

    const startBody = z.object({
        secretHash: z.string().min(8).max(128),
    });
    const startResponse = z.object({
        pairId: z.string(),
        expiresAt: z.string(),
    });

    gated.post(
        "/v1/auth/pairing/start",
        {
            config: { rateLimit: pairingAuthRateLimitStartPerUser() },
            preHandler: app.authenticate,
            schema: {
                body: startBody,
                response: {
                    200: startResponse,
                },
            },
        },
        async (request: any, reply: any) => {
            const now = new Date();
            await db.authPairingSession
                .deleteMany({
                    where: {
                        OR: [{ accountId: request.userId }, { expiresAt: { lt: now } }],
                    },
                })
                .catch(() => {});

            const expiresAt = new Date(now.getTime() + policy.ttlMs);
            const row = await db.authPairingSession.create({
                data: {
                    accountId: request.userId,
                    secretHash: String(request.body.secretHash),
                    expiresAt,
                },
                select: { id: true, expiresAt: true },
            });
            return reply.send({ pairId: row.id, expiresAt: row.expiresAt.toISOString() });
        },
    );

    gated.post(
        "/v1/auth/pairing/claim/start",
        {
            config: { rateLimit: pairingAuthRateLimitStartPerUser() },
            preHandler: app.authenticate,
            schema: {
                body: PairingClaimStartRequestV1Schema,
                response: {
                    200: PairingClaimStartResponseV1Schema,
                },
            },
        },
        async (request: any, reply: any) => {
            const now = new Date();
            const origin = String(request.body.origin);
            await db.authPairingSession
                .deleteMany({
                    where: {
                        OR: [{ accountId: request.userId }, { expiresAt: { lt: now } }],
                    },
                })
                .catch(() => {});

            const expiresAt = new Date(now.getTime() + Math.min(policy.ttlMs, PAIRING_CLAIM_V1_MAX_TTL_MS));
            const claimId = createClaimId();
            const row = await db.authPairingSession.create({
                data: {
                    id: claimId,
                    accountId: request.userId,
                    secretHash: computeClaimOriginMarker(claimId, origin),
                    expiresAt,
                },
                select: { id: true, expiresAt: true },
            });
            return reply.send({
                protocol: "claim-v1",
                claimId: row.id,
                origin,
                expiresAt: row.expiresAt.toISOString(),
            });
        },
    );

    gated.post(
        "/v1/auth/pairing/claim/consume",
        {
            config: { rateLimit: pairingAuthRateLimitRequestPerIp() },
            schema: {
                body: PairingClaimConsumeRequestV1Schema,
                response: {
                    200: PairingClaimConsumeResponseV1Schema,
                    401: PairingClaimInvalidPublicKeyResponseV1Schema,
                    404: PairingClaimNotFoundResponseV1Schema,
                },
            },
        },
        async (request: any, reply: any) => {
            const publicKeyRaw = String(request.body.publicKey);
            let publicKeyBytes: Uint8Array;
            try {
                publicKeyBytes = privacyKit.decodeBase64(publicKeyRaw);
            } catch {
                return reply.code(401).send({ error: "Invalid public key" });
            }
            if (publicKeyBytes.length !== tweetnacl.box.publicKeyLength) {
                return reply.code(401).send({ error: "Invalid public key" });
            }

            const now = new Date();
            const claimId = String(request.body.claimId);
            const originMarker = computeClaimOriginMarker(claimId, String(request.body.origin));
            const updated = await db.authPairingSession.updateMany({
                where: {
                    id: claimId,
                    secretHash: originMarker,
                    requestedPublicKey: null,
                    expiresAt: { gt: now },
                },
                data: {
                    requestedPublicKey: publicKeyRaw,
                    requestedDeviceLabel: sanitizeDeviceLabel(request.body.deviceLabel),
                    requestedAt: now,
                },
            });
            if (updated.count !== 1) {
                const existingWinner = await db.authPairingSession.findFirst({
                    where: {
                        id: claimId,
                        secretHash: originMarker,
                        requestedPublicKey: publicKeyRaw,
                        expiresAt: { gt: now },
                    },
                    select: { id: true },
                });
                if (!existingWinner) {
                    return reply.code(404).send({ error: "not_found" });
                }
            }

            return reply.send({
                state: "requested",
                confirmCode: computeConfirmCode(originMarker, publicKeyRaw),
            });
        },
    );

    const requestBody = z.object({
        pairId: z.string().min(1).max(128),
        secret: z.string().min(1).max(256),
        publicKey: z.string().min(1).max(256),
        deviceLabel: z.string().max(256).optional(),
    });
    const requestOk = z.object({
        state: z.literal("requested"),
        confirmCode: z.string(),
    });
    const notFound = z.object({ error: z.literal("not_found") });
    const invalidKey = z.object({ error: z.literal("Invalid public key") });
    const alreadyRequested = z.object({ error: z.literal("already_requested") });

    gated.post(
        "/v1/auth/pairing/request",
        {
            config: { rateLimit: pairingAuthRateLimitRequestPerIp() },
            schema: {
                body: requestBody,
                response: {
                    200: requestOk,
                    401: z.union([invalidKey, alreadyRequested]),
                    404: notFound,
                },
            },
        },
        async (request: any, reply: any) => {
            const pairId = String(request.body.pairId);
            const secret = String(request.body.secret);
            const publicKeyRaw = String(request.body.publicKey);

            let publicKeyBytes: Uint8Array;
            try {
                publicKeyBytes = privacyKit.decodeBase64(publicKeyRaw);
            } catch {
                return reply.code(401).send({ error: "Invalid public key" });
            }
            if (publicKeyBytes.length !== tweetnacl.box.publicKeyLength) {
                return reply.code(401).send({ error: "Invalid public key" });
            }

            const session = await db.authPairingSession.findUnique({ where: { id: pairId } });
            if (!session) {
                return reply.code(404).send({ error: "not_found" });
            }
            const now = new Date();
            if (session.expiresAt.getTime() < now.getTime()) {
                await db.authPairingSession.delete({ where: { id: session.id } }).catch(() => {});
                return reply.code(404).send({ error: "not_found" });
            }
            if (!safeEqualString(computeSecretHash(secret), session.secretHash)) {
                return reply.code(404).send({ error: "not_found" });
            }

            if (session.requestedPublicKey && session.requestedPublicKey !== publicKeyRaw) {
                return reply.code(401).send({ error: "already_requested" });
            }

            const deviceLabel = sanitizeDeviceLabel(request.body.deviceLabel);

            if (session.requestedPublicKey === publicKeyRaw) {
                const refreshed = await db.authPairingSession.updateMany({
                    where: {
                        id: session.id,
                        requestedPublicKey: publicKeyRaw,
                        expiresAt: { gt: now },
                    },
                    data: {
                        requestedDeviceLabel: deviceLabel,
                        requestedAt: session.requestedAt ?? now,
                    },
                });
                if (refreshed.count !== 1) {
                    return reply.code(404).send({ error: "not_found" });
                }
            } else {
                const claimed = await db.authPairingSession.updateMany({
                    where: {
                        id: session.id,
                        requestedPublicKey: null,
                        expiresAt: { gt: now },
                    },
                    data: {
                        requestedPublicKey: publicKeyRaw,
                        requestedDeviceLabel: deviceLabel,
                        requestedAt: now,
                    },
                });
                if (claimed.count !== 1) {
                    const current = await db.authPairingSession.findUnique({
                        where: { id: session.id },
                        select: { requestedPublicKey: true, expiresAt: true },
                    });
                    if (!current || current.expiresAt.getTime() <= Date.now()) {
                        return reply.code(404).send({ error: "not_found" });
                    }
                    if (current.requestedPublicKey !== publicKeyRaw) {
                        return reply.code(401).send({ error: "already_requested" });
                    }
                }
            }

            return reply.send({ state: "requested", confirmCode: computeConfirmCode(session.secretHash, publicKeyRaw) });
        },
    );

    const statusQuery = z.object({
        pairId: z.string().min(1).max(128),
    });

    const statusPending = z.object({
        state: z.literal("pending"),
        pairId: z.string(),
        expiresAt: z.string(),
    });
    const statusRequested = z.object({
        state: z.literal("requested"),
        pairId: z.string(),
        expiresAt: z.string(),
        requestedPublicKey: z.string(),
        requestedDeviceLabel: z.string().nullable(),
        confirmCode: z.string(),
    });

    gated.get(
        "/v1/auth/pairing/status",
        {
            config: { rateLimit: pairingAuthRateLimitStatusPerUser() },
            preHandler: app.authenticate,
            schema: {
                querystring: statusQuery,
                response: {
                    200: z.union([statusPending, statusRequested]),
                    404: notFound,
                },
            },
        },
        async (request: any, reply: any) => {
            const pairId = String((request.query as any).pairId);
            const session = await db.authPairingSession.findUnique({ where: { id: pairId } });
            if (!session) return reply.code(404).send({ error: "not_found" });
            if (session.accountId !== request.userId) return reply.code(404).send({ error: "not_found" });

            const now = new Date();
            if (session.expiresAt.getTime() <= now.getTime()) {
                await db.authPairingSession.delete({ where: { id: session.id } }).catch(() => {});
                return reply.code(404).send({ error: "not_found" });
            }

            if (!session.requestedPublicKey) {
                return reply.send({ state: "pending", pairId: session.id, expiresAt: session.expiresAt.toISOString() });
            }

            return reply.send({
                state: "requested",
                pairId: session.id,
                expiresAt: session.expiresAt.toISOString(),
                requestedPublicKey: session.requestedPublicKey,
                requestedDeviceLabel: session.requestedDeviceLabel ?? null,
                confirmCode: computeConfirmCode(session.secretHash, session.requestedPublicKey),
            });
        },
    );

    const consumeBody = z.object({ pairId: z.string().min(1).max(128) });
    const consumeOk = z.object({ success: z.literal(true) });
    gated.post(
        "/v1/auth/pairing/consume",
        {
            config: { rateLimit: pairingAuthRateLimitConsumePerUser() },
            preHandler: app.authenticate,
            schema: {
                body: consumeBody,
                response: {
                    200: consumeOk,
                    404: notFound,
                },
            },
        },
        async (request: any, reply: any) => {
            const pairId = String(request.body.pairId);
            const session = await db.authPairingSession.findUnique({ where: { id: pairId } });
            if (!session) return reply.code(404).send({ error: "not_found" });
            if (session.accountId !== request.userId) return reply.code(404).send({ error: "not_found" });
            await db.authPairingSession.delete({ where: { id: pairId } }).catch(() => {});
            return reply.send({ success: true });
        },
    );
}
