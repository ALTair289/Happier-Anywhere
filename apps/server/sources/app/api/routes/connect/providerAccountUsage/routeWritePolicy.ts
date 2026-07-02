import type {
    ProviderAccountUsageRecordId,
    ProviderAccountUsageRecordKeyV1,
    ProviderAccountUsageSnapshotV1,
    SealedProviderAccountUsageSnapshotV1,
} from "@happier-dev/protocol";
import type { TransactionClient } from "@/storage/prisma";

import {
    readProviderAccountUsageRecord,
    writeProviderAccountUsageRecord,
} from "./recordStorage";
import type { ProviderAccountUsagePayloadMode, ProviderAccountUsageStatus } from "./types";

type ProviderAccountUsagePolicyClient = Pick<typeof import("@/storage/db").db, "providerAccountUsageRecord">
    | Pick<TransactionClient, "providerAccountUsageRecord">;

export type ProviderAccountUsageWritePolicyParams = Readonly<{
    accountId: string;
    recordId: ProviderAccountUsageRecordId;
    recordKey: ProviderAccountUsageRecordKeyV1;
    payloadMode: ProviderAccountUsagePayloadMode;
    status: Exclude<ProviderAccountUsageStatus, "refresh_requested">;
    fetchedAt: number;
    staleAfterMs: number;
    materialFingerprint?: string;
    snapshot?: ProviderAccountUsageSnapshotV1;
    sealedPayload?: SealedProviderAccountUsageSnapshotV1;
    client?: ProviderAccountUsagePolicyClient;
}>;

function normalizeFingerprint(value: string | undefined): string | undefined {
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function shouldClearRefreshRequest(refreshRequestedAt: number | undefined, fetchedAt: number): boolean {
    return refreshRequestedAt !== undefined && fetchedAt >= refreshRequestedAt;
}

function shouldPreserveRefreshRequest(refreshRequestedAt: number | undefined, fetchedAt: number): boolean {
    return refreshRequestedAt !== undefined && fetchedAt < refreshRequestedAt;
}

export async function writeProviderAccountUsageRecordWithPolicy(
    params: ProviderAccountUsageWritePolicyParams,
): Promise<"written" | "noop" | "stale"> {
    const incomingFingerprint = normalizeFingerprint(params.materialFingerprint);
    const existing = await readProviderAccountUsageRecord({
        accountId: params.accountId,
        recordId: params.recordId,
    }, params.client);

    if (!existing) {
        await writeProviderAccountUsageRecord({
            accountId: params.accountId,
            recordId: params.recordId,
            recordKey: params.recordKey,
            payloadMode: params.payloadMode,
            status: params.status,
            fetchedAt: params.fetchedAt,
            staleAfterMs: params.staleAfterMs,
            ...(params.snapshot ? { snapshot: params.snapshot } : {}),
            ...(params.sealedPayload ? { sealedPayload: params.sealedPayload } : {}),
            ...(incomingFingerprint ? { metadata: { materialFingerprint: incomingFingerprint } } : {}),
        }, params.client);
        return "written";
    }

    const existingFingerprint = normalizeFingerprint(existing.metadata?.materialFingerprint);
    const existingFetchedAt = existing.fetchedAt ?? null;
    const isNewer = existingFetchedAt === null || params.fetchedAt > existingFetchedAt;
    const clearsRefreshRequest = shouldClearRefreshRequest(existing.refreshRequestedAt, params.fetchedAt);
    const preservesRefreshRequest = shouldPreserveRefreshRequest(existing.refreshRequestedAt, params.fetchedAt);
    if (!incomingFingerprint) {
        if (!isNewer) return "stale";
        await writeProviderAccountUsageRecord({
            accountId: params.accountId,
            recordId: params.recordId,
            recordKey: params.recordKey,
            payloadMode: params.payloadMode,
            status: params.status,
            fetchedAt: params.fetchedAt,
            staleAfterMs: params.staleAfterMs,
            ...(params.snapshot ? { snapshot: params.snapshot } : {}),
            ...(params.sealedPayload ? { sealedPayload: params.sealedPayload } : {}),
            ...(preservesRefreshRequest ? { refreshRequestedAt: existing.refreshRequestedAt } : {}),
        }, params.client);
        return "written";
    }

    if (existingFingerprint === incomingFingerprint) {
        if (!isNewer && !clearsRefreshRequest) return "noop";

        await writeProviderAccountUsageRecord({
            accountId: params.accountId,
            recordId: params.recordId,
            recordKey: params.recordKey,
            payloadMode: params.payloadMode,
            status: isNewer ? params.status : existing.status,
            fetchedAt: isNewer ? params.fetchedAt : (existing.fetchedAt ?? params.fetchedAt),
            staleAfterMs: isNewer ? params.staleAfterMs : (existing.staleAfterMs ?? params.staleAfterMs),
            snapshot: params.payloadMode === "plain_json_v1"
                ? (isNewer ? params.snapshot : existing.snapshot)
                : undefined,
            sealedPayload: params.payloadMode === "sealed_account_scoped_v1"
                ? (isNewer ? params.sealedPayload : existing.sealedPayload)
                : undefined,
            metadata: { materialFingerprint: incomingFingerprint },
            ...(preservesRefreshRequest ? { refreshRequestedAt: existing.refreshRequestedAt } : {}),
        }, params.client);
        return "written";
    }

    if (!isNewer) return "stale";

    await writeProviderAccountUsageRecord({
        accountId: params.accountId,
        recordId: params.recordId,
        recordKey: params.recordKey,
        payloadMode: params.payloadMode,
        status: params.status,
        fetchedAt: params.fetchedAt,
        staleAfterMs: params.staleAfterMs,
        ...(params.snapshot ? { snapshot: params.snapshot } : {}),
        ...(params.sealedPayload ? { sealedPayload: params.sealedPayload } : {}),
        metadata: { materialFingerprint: incomingFingerprint },
        ...(preservesRefreshRequest ? { refreshRequestedAt: existing.refreshRequestedAt } : {}),
    }, params.client);
    return "written";
}
