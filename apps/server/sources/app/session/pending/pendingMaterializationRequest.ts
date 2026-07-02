import type { SessionPendingQueueDeliveryTiming } from "@happier-dev/protocol";

export function resolvePendingMaterializeDeliveryStateOptIn(value: unknown): "provider" | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const deliveryState = (value as { deliveryState?: unknown }).deliveryState;
    return deliveryState === "provider" ? "provider" : undefined;
}

export function resolvePendingMaterializeDeliveryTimingOptIn(
    value: unknown,
): SessionPendingQueueDeliveryTiming | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const deliveryTiming = (value as { deliveryTiming?: unknown }).deliveryTiming;
    return deliveryTiming === "after_foreground_ready" || deliveryTiming === "after_runtime_idle"
        ? deliveryTiming
        : undefined;
}
