import { hasCurrentSessionScopedMachineAccessInTx } from "@/app/api/socket/sessionScopedBinding";
import type { Tx } from "@/storage/inTx";
import { isPrismaErrorCode } from "@/storage/prisma";

export type TrustedPendingPublisherFence = Readonly<{
    accountId: string;
    machineId: string;
    sessionId: string;
    committedFence: Date;
}>;

function isTrustedPendingPublisherFenceShapeCurrent(params: Readonly<{
    actorUserId: string;
    sessionId: string;
    fence: TrustedPendingPublisherFence;
}>): boolean {
    return params.actorUserId === params.fence.accountId
        && params.sessionId === params.fence.sessionId
        && params.fence.committedFence instanceof Date
        && Number.isFinite(params.fence.committedFence.getTime());
}

export async function isTrustedPendingPublisherFenceCurrent(params: Readonly<{
    tx: Tx;
    actorUserId: string;
    sessionId: string;
    fence: TrustedPendingPublisherFence;
}>): Promise<boolean> {
    if (!isTrustedPendingPublisherFenceShapeCurrent(params)) return false;
    if (!await hasCurrentSessionScopedMachineAccessInTx({
        tx: params.tx,
        accountId: params.fence.accountId,
        machineId: params.fence.machineId,
        sessionId: params.fence.sessionId,
    })) return false;
    const session = await params.tx.session.findUnique({
        where: { id: params.sessionId },
        select: { accountId: true, active: true, archivedAt: true, lastActiveAt: true },
    });
    return session !== null
        && session.accountId === params.actorUserId
        && session.active
        && session.archivedAt === null
        && session.lastActiveAt.getTime() === params.fence.committedFence.getTime();
}

/**
 * Revalidates publisher authority and acquires the Session-row serialization point inside the
 * caller's transaction. The same-value write preserves application timestamps while preventing
 * a replacement registration from committing between this check and the caller's mutation.
 */
export async function acquireTrustedPendingPublisherAuthority(params: Readonly<{
    tx: Tx;
    actorUserId: string;
    sessionId: string;
    fence: TrustedPendingPublisherFence;
}>): Promise<boolean> {
    if (!isTrustedPendingPublisherFenceShapeCurrent(params)) return false;
    if (!await hasCurrentSessionScopedMachineAccessInTx({
        tx: params.tx,
        accountId: params.fence.accountId,
        machineId: params.fence.machineId,
        sessionId: params.fence.sessionId,
    })) return false;

    const session = await params.tx.session.findUnique({
        where: { id: params.sessionId },
        select: { accountId: true, active: true, archivedAt: true, lastActiveAt: true, updatedAt: true },
    });
    if (
        session === null
        || session.accountId !== params.actorUserId
        || !session.active
        || session.archivedAt !== null
        || session.lastActiveAt.getTime() !== params.fence.committedFence.getTime()
    ) return false;

    try {
        await params.tx.session.update({
            where: {
                id: params.sessionId,
                accountId: params.actorUserId,
                active: true,
                archivedAt: null,
                lastActiveAt: params.fence.committedFence,
                updatedAt: session.updatedAt,
            },
            data: {
                lastActiveAt: params.fence.committedFence,
                updatedAt: session.updatedAt,
            },
            select: { id: true },
        });
        return true;
    } catch (error) {
        if (isPrismaErrorCode(error, "P2025")) return false;
        throw error;
    }
}
