import { parseSessionMessageRole } from "@/app/session/messageRole/resolveSessionMessageRole";
import {
    normalizePendingDeliveryStatusV1,
    type PendingDeliveryStatusV1,
} from "@happier-dev/protocol";

export type PendingMessageRow = {
    localId: string;
    messageRole: import("@happier-dev/protocol").SessionMessageRole | null;
    content: PrismaJson.SessionPendingMessageContent;
    status: "queued" | "discarded";
    deliveryState: string | null;
    deliveryBlockedReason: string | null;
    deliveryStatus: PendingDeliveryStatusV1;
    position: number;
    createdAt: Date;
    updatedAt: Date;
    discardedAt: Date | null;
    discardedReason: string | null;
    authorAccountId: string | null;
};

export type PendingMessageRowRaw = {
    localId: string;
    messageRole?: unknown;
    content: PrismaJson.SessionPendingMessageContent;
    status: "queued" | "discarded";
    deliveryState?: string | null;
    deliveryBlockedReason?: string | null;
    position: number;
    createdAt: Date;
    updatedAt: Date;
    discardedAt: Date | null;
    discardedReason: string | null;
    authorAccountId: string | null;
};

export function mapPendingMessageRow(row: PendingMessageRowRaw): PendingMessageRow {
    return {
        localId: row.localId,
        messageRole: parseSessionMessageRole(row.messageRole),
        content: row.content,
        status: row.status,
        deliveryState: typeof row.deliveryState === "string" && row.deliveryState.length > 0 ? row.deliveryState : null,
        deliveryBlockedReason: typeof row.deliveryBlockedReason === "string" && row.deliveryBlockedReason.length > 0 ? row.deliveryBlockedReason : null,
        deliveryStatus: normalizePendingDeliveryStatusV1({
            status: row.status,
            deliveryState: row.deliveryState,
            deliveryBlockedReason: row.deliveryBlockedReason,
            discardedReason: row.discardedReason,
        }),
        position: row.position,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        discardedAt: row.discardedAt,
        discardedReason: row.discardedReason,
        authorAccountId: row.authorAccountId,
    };
}
