import type { SessionRuntimeActivityProjection } from "@happier-dev/protocol";

import type { SessionParticipantCursor } from "@/app/session/changeTracking/markSessionParticipantsChanged";
import { markSessionParticipantsChanged } from "@/app/session/changeTracking/markSessionParticipantsChanged";
import { hasCurrentSessionScopedMachineAccessInTx } from "@/app/api/socket/sessionScopedBinding";
import { inTx } from "@/storage/inTx";

import { parseSessionRuntimeActivitySnapshot } from "./projection";
import { writeSessionRuntimeActivityProjectionInTx } from "./writeProjection";

export type AuthorizedActivityWriteResult =
    | { status: "applied"; projection: SessionRuntimeActivityProjection; participantCursors: readonly SessionParticipantCursor[] }
    | { status: "unchanged"; projection: SessionRuntimeActivityProjection; participantCursors: readonly [] }
    | { status: "rejected"; reason: "not_found" | "unauthorized" | "archived" | "superseded" | "revision_overflow" };

/** Applies a complete Activity snapshot only for the exact current authorized publisher fence. */
export async function writeAuthorizedSessionRuntimeActivityProjection(params: Readonly<{
    accountId: string;
    machineId: string;
    sessionId: string;
    boundCommittedFence: Date;
    completeSnapshot: unknown;
}>): Promise<AuthorizedActivityWriteResult> {
    const completeSnapshot = parseSessionRuntimeActivitySnapshot(params.completeSnapshot);
    return await inTx(async (tx): Promise<AuthorizedActivityWriteResult> => {
        const session = await tx.session.findUnique({
            where: { id: params.sessionId },
            select: { active: true, archivedAt: true, lastActiveAt: true },
        });
        if (!session) return { status: "rejected", reason: "not_found" };
        if (!await hasCurrentSessionScopedMachineAccessInTx({ tx, ...params })) {
            return { status: "rejected", reason: "unauthorized" };
        }
        if (session.archivedAt !== null) return { status: "rejected", reason: "archived" };
        if (!session.active || session.lastActiveAt.getTime() !== params.boundCommittedFence.getTime()) {
            return { status: "rejected", reason: "superseded" };
        }

        const activity = await writeSessionRuntimeActivityProjectionInTx({
            tx,
            sessionId: params.sessionId,
            completeSnapshot,
        });
        if (activity.status === "rejected") return activity;
        if (activity.status === "unchanged") {
            return { ...activity, participantCursors: [] };
        }
        const participantCursors = await markSessionParticipantsChanged({ tx, sessionId: params.sessionId });
        return { ...activity, participantCursors };
    });
}
