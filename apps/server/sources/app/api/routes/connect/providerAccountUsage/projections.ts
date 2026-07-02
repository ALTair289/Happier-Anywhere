import { ConnectedServiceQuotaSnapshotV1Schema } from "@happier-dev/protocol";

import { readProviderAccountUsageRecord } from "./recordStorage";
import { readConnectedServiceUsageSource } from "./sourceStorage";
import { requestProviderAccountUsageRefresh } from "./recordStorage";
import type { ConnectedServiceQuotaView, ProviderAccountUsageStatus } from "./types";

function mapUsageSourceToQuotaSource(source: string) {
    switch (source) {
        case "runtimeSignal":
            return "in_band_provider_snapshot";
        case "providerHttp":
            return "provider_api";
        case "proxy":
            return "background_fetch";
        case "connectedServiceProbe":
            return "user_probe";
        case "cached":
            return "cached";
        case "manual":
            return "manual_refresh";
        default:
            return "unknown";
    }
}

function mapUsageConfidenceToQuotaConfidence(confidence: string) {
    switch (confidence) {
        case "confirmed":
            return "exact";
        case "estimated":
            return "estimated";
        default:
            return "unknown";
    }
}

function normalizeResponseStatus(status: ProviderAccountUsageStatus): Exclude<ProviderAccountUsageStatus, "refresh_requested"> {
    return status === "refresh_requested" ? "ok" : status;
}

export async function readConnectedServiceQuotaView(params: Readonly<{
    accountId: string;
    serviceId: string;
    profileId: string;
}>): Promise<ConnectedServiceQuotaView | null> {
    const source = await readConnectedServiceUsageSource(params);
    if (!source) return null;

    const record = await readProviderAccountUsageRecord({
        accountId: params.accountId,
        recordId: source.providerAccountUsageRecordId,
    });
    if (!record?.snapshot) return null;

    const projected = ConnectedServiceQuotaSnapshotV1Schema.parse({
        v: 1,
        serviceId: params.serviceId,
        profileId: params.profileId,
        fetchedAt: record.snapshot.fetchedAtMs,
        staleAfterMs: record.snapshot.staleAfterMs,
        planLabel: record.snapshot.planLabel ?? null,
        accountLabel: record.snapshot.accountLabel ?? null,
        providerId: record.snapshot.providerId,
        activeAccountId: record.snapshot.recordKey.accountSubjectId,
        fetchedAtMs: record.snapshot.fetchedAtMs,
        staleAtMs: record.snapshot.fetchedAtMs + record.snapshot.staleAfterMs,
        source: mapUsageSourceToQuotaSource(record.snapshot.source),
        confidence: mapUsageConfidenceToQuotaConfidence(record.snapshot.confidence),
        ...(record.snapshot.recoveryCredits ? { recoveryCredits: record.snapshot.recoveryCredits } : {}),
        meters: record.snapshot.meters,
    });

    return {
        recordId: record.recordId,
        snapshot: projected,
        metadata: {
            fetchedAt: record.fetchedAt ?? record.snapshot.fetchedAtMs,
            staleAfterMs: record.staleAfterMs ?? record.snapshot.staleAfterMs,
            status: normalizeResponseStatus(record.status),
            ...(record.refreshRequestedAt !== undefined ? { refreshRequestedAt: record.refreshRequestedAt } : {}),
        },
    };
}

export async function requestConnectedServiceQuotaRefresh(params: Readonly<{
    accountId: string;
    serviceId: string;
    profileId: string;
}>): Promise<"written" | "not_found"> {
    const source = await readConnectedServiceUsageSource(params);
    if (!source) return "not_found";
    return await requestProviderAccountUsageRefresh({
        accountId: params.accountId,
        recordId: source.providerAccountUsageRecordId,
    });
}
