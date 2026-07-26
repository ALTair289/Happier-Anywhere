import type { MaterializeNextPendingMessageResult } from "@/app/session/pending/materializeNextPendingMessage";
import type { SessionMessageDeliveryResolutionV1 } from "@happier-dev/protocol";

type MaterializedPendingMessage = Extract<
    MaterializeNextPendingMessageResult,
    { ok: true; didMaterialize: true }
>["message"];

export function serializePendingMaterializedMessage(
    message: Omit<MaterializedPendingMessage, "requestedAction" | "providerAction">
        & Partial<Pick<MaterializedPendingMessage, "requestedAction" | "providerAction">>
        & { deliveryResolution?: SessionMessageDeliveryResolutionV1 | null },
) {
    return {
        id: message.id,
        seq: message.seq,
        localId: message.localId,
        ...(typeof message.messageRole === "string" ? { messageRole: message.messageRole } : {}),
        content: message.content,
        ...(message.requestedAction ? { requestedAction: message.requestedAction } : {}),
        ...(message.providerAction ? { providerAction: message.providerAction } : {}),
        ...(message.deliveryResolution ? { deliveryResolution: message.deliveryResolution } : {}),
        createdAt: message.createdAt.getTime(),
        updatedAt: message.updatedAt.getTime(),
    };
}
