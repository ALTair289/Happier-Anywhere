import { parseSessionMessageRole } from "@/app/session/messageRole/resolveSessionMessageRole";

export type PendingMessageRow = {
    localId: string;
    messageRole: import("@happier-dev/protocol").SessionMessageRole | null;
    content: PrismaJson.SessionPendingMessageContent;
    status: "queued" | "discarded";
    deliveryState: string | null;
    deliveryBlockedReason: string | null;
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
        position: row.position,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        discardedAt: row.discardedAt,
        discardedReason: row.discardedReason,
        authorAccountId: row.authorAccountId,
    };
}
