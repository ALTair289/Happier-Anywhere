import { applyPendingSessionStateChange } from "@/app/session/pending/applyPendingSessionStateChange";
import type { Tx } from "@/storage/inTx";

/**
 * Replacement/reconnect contraction. Presence invokes this in the same transaction before it
 * commits a successor publisher fence, so every matching row is inherited by definition. Time
 * is deliberately absent: possible provider effect becomes durable uncertainty immediately.
 */
export async function blockInheritedProviderDeliveryClaims(params: Readonly<{
    tx: Tx;
    sessionId: string;
}>): Promise<{
    blockedCount: number;
    pendingVersion: number;
    pendingCount: number;
    pendingBlockedCount: number;
} | null> {
    const blocked = await params.tx.sessionPendingMessage.updateMany({
        where: {
            sessionId: params.sessionId,
            status: "queued",
            deliveryState: "delivering",
        },
        data: {
            deliveryState: "blocked",
            deliveryBlockedReason: "delivery_outcome_uncertain",
        },
    });
    if (blocked.count === 0) return null;
    const state = await applyPendingSessionStateChange({
        tx: params.tx,
        sessionId: params.sessionId,
        pendingBlockedCountDelta: blocked.count,
    });
    return {
        blockedCount: blocked.count,
        pendingVersion: state.pendingVersion,
        pendingCount: state.pendingCount,
        pendingBlockedCount: state.pendingBlockedCount,
    };
}
