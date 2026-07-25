import type {
    SessionRuntimeActivityProjection,
    SessionRuntimeActivitySnapshot,
} from "@happier-dev/protocol";

import type { Tx } from "@/storage/inTx";

import { parseSessionRuntimeActivitySnapshot } from "./projection";
import { readStoredSessionRuntimeActivityProjection } from "./projection";

export type ActivityInTxResult =
    | { status: "applied"; projection: SessionRuntimeActivityProjection }
    | { status: "unchanged"; projection: SessionRuntimeActivityProjection }
    | { status: "rejected"; reason: "not_found" | "archived" | "revision_overflow" };

/**
 * Applies one complete Runtime Activity snapshot inside the caller's transaction.
 * This primitive owns semantic comparison, revision, and server observation time only;
 * authorization, participant cursors, and post-commit fanout remain caller concerns.
 */
export async function writeSessionRuntimeActivityProjectionInTx(params: Readonly<{
    tx: Tx;
    sessionId: string;
    completeSnapshot: SessionRuntimeActivitySnapshot | unknown;
}>): Promise<ActivityInTxResult> {
    const completeSnapshot = parseSessionRuntimeActivitySnapshot(params.completeSnapshot);
    const session = await params.tx.session.findUnique({
        where: { id: params.sessionId },
        select: {
            archivedAt: true,
            runtimeActivityState: true,
            runtimeActivityActiveCount: true,
            runtimeActivityObservedAt: true,
            runtimeActivityRevision: true,
        },
    });
    if (!session) {
        return { status: "rejected", reason: "not_found" };
    }
    if (session.archivedAt !== null) {
        return { status: "rejected", reason: "archived" };
    }

    const currentProjection = readStoredSessionRuntimeActivityProjection(session);
    // A semantic duplicate never rewrites already-valid storage bytes. Revision overflow is
    // therefore relevant only when a new semantic revision must be written.
    if (
        currentProjection.state === completeSnapshot.state
        && currentProjection.activeCount === completeSnapshot.activeCount
    ) {
        return { status: "unchanged", projection: currentProjection };
    }
    if (session.runtimeActivityRevision >= BigInt(Number.MAX_SAFE_INTEGER)) {
        return { status: "rejected", reason: "revision_overflow" };
    }

    const revision = currentProjection.revision + 1;
    const observedAt = Date.now();
    const updated = await params.tx.session.updateMany({
        where: {
            id: params.sessionId,
            archivedAt: null,
            runtimeActivityRevision: session.runtimeActivityRevision,
        },
        data: {
            runtimeActivityState: completeSnapshot.state,
            runtimeActivityActiveCount: completeSnapshot.activeCount,
            runtimeActivityObservedAt: BigInt(observedAt),
            runtimeActivityRevision: BigInt(revision),
        },
    });
    if (updated.count === 0) {
        const currentLifecycle = await params.tx.session.findUnique({
            where: { id: params.sessionId },
            select: { archivedAt: true },
        });
        if (!currentLifecycle) {
            return { status: "rejected", reason: "not_found" };
        }
        if (currentLifecycle.archivedAt !== null) {
            return { status: "rejected", reason: "archived" };
        }
        throw new Error("Session Runtime Activity projection changed concurrently");
    }

    return {
        status: "applied",
        projection: {
            ...completeSnapshot,
            observedAt,
            revision,
        },
    };
}

/**
 * Records loss of the publisher observer while preserving an explicitly published idle
 * snapshot. Presence owns when observer loss occurs; this Activity owner owns which
 * projection can survive it.
 */
export async function writeSessionRuntimeActivityObserverLossInTx(params: Readonly<{
    tx: Tx;
    sessionId: string;
}>): Promise<ActivityInTxResult> {
    const session = await params.tx.session.findUnique({
        where: { id: params.sessionId },
        select: {
            archivedAt: true,
            runtimeActivityState: true,
            runtimeActivityActiveCount: true,
            runtimeActivityObservedAt: true,
            runtimeActivityRevision: true,
        },
    });
    if (!session) return { status: "rejected", reason: "not_found" };
    if (session.archivedAt !== null) return { status: "rejected", reason: "archived" };

    const current = readStoredSessionRuntimeActivityProjection(session);
    if (current.state === "idle") return { status: "unchanged", projection: current };
    return await writeSessionRuntimeActivityProjectionInTx({
        ...params,
        completeSnapshot: { state: "unknown", activeCount: 0 },
    });
}
