import { parseSessionMessageRole } from "@/app/session/messageRole/resolveSessionMessageRole";
import type { Tx } from "@/storage/inTx";
import type { SessionMessageRole } from "@happier-dev/protocol";
import { isDeepStrictEqual } from "node:util";

export type PendingTranscriptMessage = {
    id: string;
    seq: number;
    localId: string;
    messageRole: SessionMessageRole | null;
    content: PrismaJson.SessionMessageContent;
    createdAt: Date;
    updatedAt: Date;
};

export function resolvePendingTranscriptCompatibility(params: {
    existing: {
        content: unknown;
        messageRole: unknown;
    };
    pending: {
        content: PrismaJson.SessionMessageContent;
        messageRole: SessionMessageRole | null;
    };
}): {
    ok: true;
    existingMessageRole: SessionMessageRole | null;
} | {
    ok: false;
    conflict: "content" | "message-role";
} {
    if (!isDeepStrictEqual(params.existing.content, params.pending.content)) {
        return { ok: false, conflict: "content" };
    }

    const existingMessageRole = parseSessionMessageRole(params.existing.messageRole);
    if (
        existingMessageRole !== null
        && params.pending.messageRole !== null
        && existingMessageRole !== params.pending.messageRole
    ) {
        return { ok: false, conflict: "message-role" };
    }

    return { ok: true, existingMessageRole };
}

export async function createSessionMessageFromPending(tx: Tx, params: {
    sessionId: string;
    localId: string;
    content: PrismaJson.SessionMessageContent;
    messageRole: SessionMessageRole | null;
}): Promise<{
    ok: true;
    didWrite: boolean;
    didUpdate: boolean;
    message: PendingTranscriptMessage;
} | {
    ok: false;
    error: "transcript-conflict";
    conflict: "content" | "message-role";
}> {
    const { sessionId, localId, content, messageRole } = params;

    const existing = await tx.sessionMessage.findFirst({
        where: { sessionId, localId },
        select: { id: true, seq: true, localId: true, messageRole: true, content: true, createdAt: true, updatedAt: true },
    });
    if (existing && existing.localId) {
        const compatibility = resolvePendingTranscriptCompatibility({
            existing,
            pending: { content, messageRole },
        });
        if (!compatibility.ok) return { ok: false, error: "transcript-conflict", conflict: compatibility.conflict };

        const needsRoleUpdate = existing.messageRole === null && messageRole !== null;
        const row = needsRoleUpdate
            ? await tx.sessionMessage.update({
                where: { id: existing.id },
                data: {
                    messageRole,
                },
                select: { id: true, seq: true, localId: true, messageRole: true, content: true, createdAt: true, updatedAt: true },
            })
            : existing;
        return {
            ok: true,
            didWrite: false,
            didUpdate: needsRoleUpdate,
            message: {
                id: row.id,
                seq: row.seq,
                localId: row.localId ?? localId,
                messageRole: parseSessionMessageRole(row.messageRole),
                content: row.content as PrismaJson.SessionMessageContent,
                createdAt: row.createdAt,
                updatedAt: row.updatedAt,
            },
        };
    }

    const messageCreatedAt = new Date();
    const next = await tx.session.update({
        where: { id: sessionId },
        select: { seq: true },
        data: {
            seq: { increment: 1 },
        },
    });

    const created = await tx.sessionMessage.create({
        data: {
            sessionId,
            seq: next.seq,
            content,
            localId,
            messageRole,
            createdAt: messageCreatedAt,
        },
        select: { id: true, seq: true, localId: true, messageRole: true, content: true, createdAt: true, updatedAt: true },
    });

    return {
        ok: true,
        didWrite: true,
        didUpdate: false,
        message: {
            id: created.id,
            seq: created.seq,
            localId: created.localId!,
            messageRole: parseSessionMessageRole(created.messageRole),
            content: created.content as PrismaJson.SessionMessageContent,
            createdAt: created.createdAt,
            updatedAt: created.updatedAt,
        },
    };
}
