import { z } from "zod";
import type { FastifyReply } from "fastify";

import type { Fastify } from "../../types";
import { resolveApiHotEndpointRateLimit } from "@/app/api/utils/apiRateLimitCatalog";
import { resolveEffectiveAccountEncryptionModeFromAccountRow } from "@/app/encryption/accountEncryptionMode";
import { db } from "@/storage/db";
import {
    ConnectedServiceUsageSourceV1Schema,
    ProviderAccountUsageRecordIdSchema,
    ProviderAccountUsageSnapshotV1Schema,
    StoredJsonContentEnvelopeSchema,
} from "@happier-dev/protocol";
import { NotFoundSchema } from "../../schemas/notFoundSchema";
import {
    ProviderAccountUsageInvalidParamsResponseSchema,
    type ProviderAccountUsageInvalidParamsReason,
} from "./providerAccountUsage/schemas";
import {
    ConnectedServiceUsageSourceBindingError,
    ConnectedServiceUsageSourceOwnershipError,
    deleteProviderAccountUsageRecord,
    listConnectedServiceUsageSourcesForProviderAccountUsageRecord,
    readProviderAccountUsageRecord,
    requestProviderAccountUsageRefresh,
    toConnectedServiceUsageSourceV1,
    writeProviderAccountUsageRecordAndLinkConnectedServiceUsageSource,
} from "./providerAccountUsage";
import { ProviderAccountUsagePayloadInvariantError } from "./providerAccountUsage";
import { writeProviderAccountUsageRecordWithPolicy } from "./providerAccountUsage/routeWritePolicy";

function providerAccountUsageWriteMetadataMatchesSnapshotClock(
    metadata: Readonly<{ fetchedAt: number; staleAfterMs: number }>,
    snapshot: Readonly<{ fetchedAtMs: number; staleAfterMs: number }>,
): boolean {
    return metadata.fetchedAt === snapshot.fetchedAtMs
        && metadata.staleAfterMs === snapshot.staleAfterMs;
}

function normalizeResponseStatus(status: string): "ok" | "unavailable" | "estimated" | "error" {
    return status === "unavailable" || status === "estimated" || status === "error" ? status : "ok";
}

function sendProviderAccountUsageInvalidParams(
    reply: FastifyReply,
    reason: ProviderAccountUsageInvalidParamsReason,
) {
    return reply.code(400).send({ error: "invalid-params" as const, reason });
}

async function readPlainAccount(accountId: string) {
    const account = await db.account.findUnique({
        where: { id: accountId },
        select: { publicKey: true, encryptionMode: true },
    });
    return account && resolveEffectiveAccountEncryptionModeFromAccountRow(account) === "plain" ? account : null;
}

export function registerProviderAccountUsageRoutesV3(app: Fastify): void {
    app.post("/v3/connect/provider-account-usage/:recordId", {
        config: { rateLimit: resolveApiHotEndpointRateLimit(process.env, "connectedServices.quotas.write") },
        preHandler: app.authenticate,
        schema: {
            params: z.object({ recordId: ProviderAccountUsageRecordIdSchema }),
            body: z.object({
                content: StoredJsonContentEnvelopeSchema,
                metadata: z.object({
                    fetchedAt: z.number().int().nonnegative(),
                    staleAfterMs: z.number().int().min(1),
                    status: z.enum(["ok", "unavailable", "estimated", "error"]),
                    materialFingerprint: z.string().min(1).max(256).optional(),
                }).strict(),
                source: ConnectedServiceUsageSourceV1Schema.optional(),
            }).strict(),
            response: {
                200: z.object({ success: z.literal(true) }),
                400: ProviderAccountUsageInvalidParamsResponseSchema,
            },
        },
    }, async (request, reply) => {
        const account = await readPlainAccount(request.userId);
        if (!account || request.body.content.t !== "plain") {
            return sendProviderAccountUsageInvalidParams(reply, "provider_account_usage_plaintext_required");
        }

        const parsed = ProviderAccountUsageSnapshotV1Schema.safeParse(request.body.content.v);
        if (!parsed.success) {
            return sendProviderAccountUsageInvalidParams(reply, "provider_account_usage_payload_invalid");
        }
        if (parsed.data.recordId !== request.params.recordId) {
            return sendProviderAccountUsageInvalidParams(reply, "provider_account_usage_record_id_mismatch");
        }
        if (!providerAccountUsageWriteMetadataMatchesSnapshotClock(request.body.metadata, parsed.data)) {
            return sendProviderAccountUsageInvalidParams(reply, "provider_account_usage_payload_invalid");
        }

        try {
            const writeParams = {
                accountId: request.userId,
                recordId: parsed.data.recordId,
                recordKey: parsed.data.recordKey,
                payloadMode: "plain_json_v1" as const,
                status: request.body.metadata.status,
                fetchedAt: request.body.metadata.fetchedAt,
                staleAfterMs: request.body.metadata.staleAfterMs,
                materialFingerprint: request.body.metadata.materialFingerprint,
                snapshot: parsed.data,
            };
            if (request.body.source) {
                await writeProviderAccountUsageRecordAndLinkConnectedServiceUsageSource({
                    ...writeParams,
                    source: request.body.source,
                });
            } else {
                await writeProviderAccountUsageRecordWithPolicy(writeParams);
            }
        } catch (error) {
            if (error instanceof ConnectedServiceUsageSourceOwnershipError) {
                return sendProviderAccountUsageInvalidParams(reply, "connected_service_usage_source_incompatible");
            }
            if (error instanceof ConnectedServiceUsageSourceBindingError) {
                return sendProviderAccountUsageInvalidParams(reply, "connected_service_usage_source_invalid");
            }
            if (error instanceof ProviderAccountUsagePayloadInvariantError) {
                return sendProviderAccountUsageInvalidParams(reply, "provider_account_usage_payload_invalid");
            }
            throw error;
        }

        return reply.send({ success: true });
    });

    app.get("/v3/connect/provider-account-usage/:recordId", {
        config: { rateLimit: resolveApiHotEndpointRateLimit(process.env, "connectedServices.quotas.read") },
        preHandler: app.authenticate,
        schema: {
            params: z.object({ recordId: ProviderAccountUsageRecordIdSchema }),
            response: {
                200: z.object({
                    content: StoredJsonContentEnvelopeSchema,
                    metadata: z.object({
                        fetchedAt: z.number().int().nonnegative(),
                        staleAfterMs: z.number().int().nonnegative(),
                        status: z.enum(["ok", "unavailable", "estimated", "error"]),
                        refreshRequestedAt: z.number().int().nonnegative().optional(),
                    }),
                    sources: z.array(ConnectedServiceUsageSourceV1Schema),
                }),
                404: z.union([NotFoundSchema, z.object({ error: z.literal("provider_account_usage_not_found") })]),
            },
        },
    }, async (request, reply) => {
        const account = await readPlainAccount(request.userId);
        if (!account) return reply.code(404).send({ error: "provider_account_usage_not_found" });

        const record = await readProviderAccountUsageRecord({
            accountId: request.userId,
            recordId: request.params.recordId,
        });
        if (!record?.snapshot || record.payloadMode !== "plain_json_v1") {
            return reply.code(404).send({ error: "provider_account_usage_not_found" });
        }
        const sources = await listConnectedServiceUsageSourcesForProviderAccountUsageRecord({
            accountId: request.userId,
            providerAccountUsageRecordId: record.recordId,
        });

        return reply.send({
            content: { t: "plain", v: record.snapshot },
            metadata: {
                fetchedAt: record.fetchedAt ?? record.snapshot.fetchedAtMs,
                staleAfterMs: record.staleAfterMs ?? record.snapshot.staleAfterMs,
                status: normalizeResponseStatus(record.status),
                ...(record.refreshRequestedAt !== undefined ? { refreshRequestedAt: record.refreshRequestedAt } : {}),
            },
            sources: sources.map(toConnectedServiceUsageSourceV1),
        });
    });

    app.post("/v3/connect/provider-account-usage/:recordId/refresh", {
        config: { rateLimit: resolveApiHotEndpointRateLimit(process.env, "connectedServices.quotas.refresh") },
        preHandler: app.authenticate,
        schema: {
            params: z.object({ recordId: ProviderAccountUsageRecordIdSchema }),
            response: {
                200: z.object({ success: z.literal(true) }),
                404: z.union([NotFoundSchema, z.object({ error: z.literal("provider_account_usage_not_found") })]),
            },
        },
    }, async (request, reply) => {
        const account = await readPlainAccount(request.userId);
        if (!account) return reply.code(404).send({ error: "provider_account_usage_not_found" });

        const refreshResult = await requestProviderAccountUsageRefresh({
            accountId: request.userId,
            recordId: request.params.recordId,
        });
        if (refreshResult === "not_found") {
            return reply.code(404).send({ error: "provider_account_usage_not_found" });
        }
        return reply.send({ success: true });
    });

    app.delete("/v3/connect/provider-account-usage/:recordId", {
        config: { rateLimit: resolveApiHotEndpointRateLimit(process.env, "connectedServices.quotas.write") },
        preHandler: app.authenticate,
        schema: {
            params: z.object({ recordId: ProviderAccountUsageRecordIdSchema }),
            response: {
                200: z.object({ success: z.literal(true) }),
                404: z.union([NotFoundSchema, z.object({ error: z.literal("provider_account_usage_not_found") })]),
            },
        },
    }, async (request, reply) => {
        const account = await readPlainAccount(request.userId);
        if (!account) return reply.code(404).send({ error: "provider_account_usage_not_found" });

        const deleted = await deleteProviderAccountUsageRecord({
            accountId: request.userId,
            recordId: request.params.recordId,
        });
        if (deleted === "not_found") {
            return reply.code(404).send({ error: "provider_account_usage_not_found" });
        }
        return reply.send({ success: true });
    });
}
