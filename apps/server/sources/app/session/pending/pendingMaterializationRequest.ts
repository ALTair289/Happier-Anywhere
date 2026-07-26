import type { SessionPendingQueueDeliveryTiming } from "@happier-dev/protocol";

export function resolvePendingMaterializeDeliveryStateOptIn(value: unknown): "provider" | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const deliveryState = (value as { deliveryState?: unknown }).deliveryState;
    return deliveryState === "provider" ? "provider" : undefined;
}

export type PendingMaterializeDeliveryTimingParseResult =
    | { status: "absent" }
    | { status: "valid"; value: SessionPendingQueueDeliveryTiming }
    | { status: "invalid" };

export function parsePendingMaterializeDeliveryTiming(
    value: unknown,
): PendingMaterializeDeliveryTimingParseResult {
    if (
        !value
        || typeof value !== "object"
        || Array.isArray(value)
        || !Object.prototype.hasOwnProperty.call(value, "deliveryTiming")
    ) {
        return { status: "absent" };
    }
    const deliveryTiming = (value as { deliveryTiming?: unknown }).deliveryTiming;
    return deliveryTiming === "after_foreground_ready" || deliveryTiming === "after_runtime_idle"
        ? { status: "valid", value: deliveryTiming }
        : { status: "invalid" };
}
