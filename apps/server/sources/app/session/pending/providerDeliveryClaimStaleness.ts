import { applyPendingSessionStateChange } from "@/app/session/pending/applyPendingSessionStateChange";
import type { Tx } from "@/storage/inTx";
import { getDbProviderFromEnv } from "@/storage/prisma";
import {
    isPendingDeliveryStatusTransitionAllowedV1,
    pendingDeliveryStatusV1ToPersistedFields,
} from "@happier-dev/protocol";

export const STALE_PROVIDER_DELIVERY_BLOCK_AFTER_MS = 5 * 60_000;

export function getStaleProviderDeliveryClaimCutoff(now: Date = new Date()): Date {
    return new Date(now.getTime() - STALE_PROVIDER_DELIVERY_BLOCK_AFTER_MS);
}

export async function blockStaleProviderDeliveryClaims(params: {
    tx: Tx;
    sessionId: string;
    now?: Date;
}): Promise<{
    pendingCount: number;
    pendingBlockedCount: number;
    pendingVersion: number;
    participantCursors: Awaited<ReturnType<typeof applyPendingSessionStateChange>>["participantCursors"];
    badgeAttentionChanged: boolean;
    blockedCount: number;
} | null> {
    const deliveringStatus = pendingDeliveryStatusV1ToPersistedFields({ status: "delivering" });
    if (!isPendingDeliveryStatusTransitionAllowedV1(
        { status: "delivering" },
        { status: "blocked", reason: "provider_acceptance_timeout" },
    )) {
        throw new Error("Invalid stale provider delivery claim transition");
    }
    const blockedStatus = pendingDeliveryStatusV1ToPersistedFields({
        status: "blocked",
        reason: "provider_acceptance_timeout",
    });
    const cutoff = getStaleProviderDeliveryClaimCutoff(params.now);
    const updatedAt = params.now ?? new Date();
    const blockedCount = getDbProviderFromEnv(process.env, "postgres") === "mysql"
        ? await params.tx.$executeRaw`
            UPDATE \`SessionPendingMessage\` AS pending
            SET
                \`deliveryState\` = ${blockedStatus.deliveryState},
                \`deliveryBlockedReason\` = ${blockedStatus.deliveryBlockedReason},
                \`updatedAt\` = ${updatedAt}
            WHERE pending.\`sessionId\` = ${params.sessionId}
                AND pending.\`status\` = ${deliveringStatus.status}
                AND pending.\`deliveryState\` = ${deliveringStatus.deliveryState}
                AND pending.\`updatedAt\` < ${cutoff}
                AND NOT EXISTS (
                    SELECT 1
                    FROM \`SessionMessage\` AS message
                    WHERE message.\`sessionId\` = pending.\`sessionId\`
                        AND message.\`localId\` = pending.\`localId\`
                        AND (message.\`messageRole\` = 'user' OR message.\`messageRole\` IS NULL)
                )
        `
        : await params.tx.$executeRaw`
            UPDATE "SessionPendingMessage" AS pending
            SET
                "deliveryState" = ${blockedStatus.deliveryState},
                "deliveryBlockedReason" = ${blockedStatus.deliveryBlockedReason},
                "updatedAt" = ${updatedAt}
            WHERE pending."sessionId" = ${params.sessionId}
                AND pending."status" = ${deliveringStatus.status}
                AND pending."deliveryState" = ${deliveringStatus.deliveryState}
                AND pending."updatedAt" < ${cutoff}
                AND NOT EXISTS (
                    SELECT 1
                    FROM "SessionMessage" AS message
                    WHERE message."sessionId" = pending."sessionId"
                        AND message."localId" = pending."localId"
                        AND (message."messageRole" = 'user' OR message."messageRole" IS NULL)
                )
        `;
    const blocked = { count: Number(blockedCount) };

    if (blocked.count <= 0) return null;

    const state = await applyPendingSessionStateChange({
        tx: params.tx,
        sessionId: params.sessionId,
        pendingBlockedCountDelta: blocked.count,
    });
    return { ...state, blockedCount: blocked.count };
}
