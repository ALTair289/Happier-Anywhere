import { applyPendingSessionStateChange } from "@/app/session/pending/applyPendingSessionStateChange";
import type { Tx } from "@/storage/inTx";

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
    const blocked = await params.tx.sessionPendingMessage.updateMany({
        where: {
            sessionId: params.sessionId,
            status: "queued",
            deliveryState: "delivering",
            updatedAt: { lt: getStaleProviderDeliveryClaimCutoff(params.now) },
        },
        data: {
            deliveryState: "blocked",
            deliveryBlockedReason: "provider_acceptance_timeout",
        },
    });

    if (blocked.count <= 0) return null;

    const state = await applyPendingSessionStateChange({
        tx: params.tx,
        sessionId: params.sessionId,
        pendingBlockedCountDelta: blocked.count,
    });
    return { ...state, blockedCount: blocked.count };
}
