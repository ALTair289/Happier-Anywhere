import type { Prisma } from '@prisma/client';

import { activityCache } from '@/app/presence/sessionCache';
import { db } from '@/storage/db';

const DEFAULT_MIN_TAIL_MESSAGES = 500;

type RetentionSessionMessageSession = Readonly<{
    id: string;
    seq: number | null;
    lastViewedSessionSeq: number | null;
    latestReadyEventSeq: number | null;
}>;

function positiveIntOrDefault(value: number | undefined, fallback: number): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
    return Math.max(1, Math.floor(value));
}

function positiveFloor(value: number | null | undefined): number | null {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) return null;
    return Math.floor(value);
}

export function resolveSessionMessagePreserveFromSeq(
    session: RetentionSessionMessageSession,
    minTailMessages: number,
): number {
    const floors: number[] = [];
    const seq = positiveFloor(session.seq);
    if (seq !== null) {
        floors.push(Math.max(1, seq - minTailMessages + 1));
    }
    const lastViewedSessionSeq = positiveFloor(session.lastViewedSessionSeq);
    if (lastViewedSessionSeq !== null) {
        floors.push(lastViewedSessionSeq);
    }
    const latestReadyEventSeq = positiveFloor(session.latestReadyEventSeq);
    if (latestReadyEventSeq !== null) {
        floors.push(latestReadyEventSeq);
    }
    return floors.length > 0 ? Math.min(...floors) : 1;
}

function staleInactiveSessionWhere(cutoff: Date): Prisma.SessionWhereInput {
    return {
        active: false,
        updatedAt: { lt: cutoff },
        lastActiveAt: { lt: cutoff },
    };
}

export async function pruneSessionMessagesOnce(params: {
    cutoff: Date;
    batchSize: number;
    dryRun: boolean;
    minTailMessages?: number;
}): Promise<{ deleted: number }> {
    const limit = positiveIntOrDefault(params.batchSize, 1);
    const minTailMessages = positiveIntOrDefault(params.minTailMessages, DEFAULT_MIN_TAIL_MESSAGES);
    const sessionWhere = staleInactiveSessionWhere(params.cutoff);
    const sessions = await db.session.findMany({
        where: sessionWhere,
        orderBy: [
            { lastActiveAt: 'asc' },
            { updatedAt: 'asc' },
        ],
        take: limit,
        select: {
            id: true,
            seq: true,
            lastViewedSessionSeq: true,
            latestReadyEventSeq: true,
        },
    });

    let deleted = 0;
    for (const session of sessions) {
        if (deleted >= limit) break;
        if (activityCache.isSessionObservedActive(session.id)) {
            continue;
        }

        const preserveFromSeq = resolveSessionMessagePreserveFromSeq(session, minTailMessages);
        if (preserveFromSeq <= 1) {
            continue;
        }

        const remaining = limit - deleted;
        const rows = await db.sessionMessage.findMany({
            where: {
                sessionId: session.id,
                seq: { lt: preserveFromSeq },
                createdAt: { lt: params.cutoff },
            },
            orderBy: { seq: 'asc' },
            take: remaining,
            select: { id: true },
        });
        if (rows.length === 0) {
            continue;
        }
        if (params.dryRun) {
            deleted += rows.length;
            continue;
        }

        const result = await db.sessionMessage.deleteMany({
            where: {
                id: { in: rows.map((row) => row.id) },
                sessionId: session.id,
                seq: { lt: preserveFromSeq },
                createdAt: { lt: params.cutoff },
                session: { is: staleInactiveSessionWhere(params.cutoff) },
            },
        });
        deleted += result.count;
    }

    return { deleted };
}

export async function runSessionMessageRetentionRule(params: {
    cutoff: Date;
    batchSize: number;
    dryRun: boolean;
    maxDeletesPerRulePerRun: number;
}): Promise<{ deleted: number }> {
    const limit = Math.max(1, Math.min(params.batchSize, params.maxDeletesPerRulePerRun));
    return await pruneSessionMessagesOnce({
        cutoff: params.cutoff,
        batchSize: limit,
        dryRun: params.dryRun,
    });
}
