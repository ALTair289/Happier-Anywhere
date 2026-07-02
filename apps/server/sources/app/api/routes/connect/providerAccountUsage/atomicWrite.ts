import { inTx } from "@/storage/inTx";
import type { ConnectedServiceUsageSourceV1 } from "@happier-dev/protocol";

import { readProviderAccountUsageRecord } from "./recordStorage";
import {
    writeProviderAccountUsageRecordWithPolicy,
    type ProviderAccountUsageWritePolicyParams,
} from "./routeWritePolicy";
import {
    assertProviderUsageRecordCompatibleWithConnectedServiceSource,
    linkConnectedServiceUsageSource,
} from "./sourceStorage";
import {
    ConnectedServiceUsageSourceBindingError,
} from "./types";
import type {
    StoredConnectedServiceUsageSource,
    StoredProviderAccountUsageRecord,
} from "./types";

export async function writeProviderAccountUsageRecordAndLinkConnectedServiceUsageSource(
    params: ProviderAccountUsageWritePolicyParams & Readonly<{
        source: ConnectedServiceUsageSourceV1;
    }>,
): Promise<Readonly<{
    record: StoredProviderAccountUsageRecord;
    source: StoredConnectedServiceUsageSource | null;
}>> {
    assertProviderUsageRecordCompatibleWithConnectedServiceSource({
        providerId: params.recordKey.providerId,
        serviceId: params.source.serviceId,
    });

    return await inTx(async (tx) => {
        await writeProviderAccountUsageRecordWithPolicy({
            accountId: params.accountId,
            recordId: params.recordId,
            recordKey: params.recordKey,
            payloadMode: params.payloadMode,
            status: params.status,
            ...(params.snapshot ? { snapshot: params.snapshot } : {}),
            ...(params.sealedPayload ? { sealedPayload: params.sealedPayload } : {}),
            fetchedAt: params.fetchedAt,
            staleAfterMs: params.staleAfterMs,
            ...(params.materialFingerprint !== undefined ? { materialFingerprint: params.materialFingerprint } : {}),
            client: tx,
        });

        let source: StoredConnectedServiceUsageSource | null;
        try {
            source = await linkConnectedServiceUsageSource({
                accountId: params.accountId,
                providerAccountUsageRecordId: params.recordId,
                source: params.source,
            }, tx);
        } catch (error) {
            if (error instanceof ConnectedServiceUsageSourceBindingError && error.kind === "unavailable") {
                source = null;
            } else {
                throw error;
            }
        }

        const stored = await readProviderAccountUsageRecord({
            accountId: params.accountId,
            recordId: params.recordId,
        }, tx);
        if (!stored) {
            throw new Error("Provider account usage record disappeared during source link");
        }

        return {
            record: stored,
            source,
        };
    });
}
