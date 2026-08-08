import { isSessionUnread } from "@/app/session/attention/sessionAttentionFacts";
import { db } from "@/storage/db";
import {
    PrimaryTurnStatusV1Schema,
    SessionRuntimeIssueV1Schema,
    type PrimaryTurnStatusV1,
    type SessionRuntimeIssueV1,
} from "@happier-dev/protocol";

export type SessionActivityBadgeInputs = Readonly<{
    seq?: number | null;
    pendingCount?: number | null;
    pendingBlockedCount?: number | null;
    lastViewedSessionSeq?: number | null;
    pendingPermissionRequestCount?: number | null;
    pendingUserActionRequestCount?: number | null;
    latestTurnStatus?: PrimaryTurnStatusV1 | string | null;
    lastRuntimeIssue?: SessionRuntimeIssueV1 | string | null;
    active?: boolean | null;
    archivedAt?: Date | null;
}>;

type SessionActivityBadgeRow = Readonly<{
    accountId: string;
    seq: number | null;
    pendingCount: number | null;
    pendingBlockedCount: number | null;
    lastViewedSessionSeq: number | null;
    pendingPermissionRequestCount: number | null;
    pendingUserActionRequestCount: number | null;
    latestTurnStatus: string | null;
    lastRuntimeIssue: string | null;
    active: boolean;
    archivedAt: Date | null;
}>;

function parseStoredRuntimeIssue(value: SessionActivityBadgeInputs["lastRuntimeIssue"]): SessionRuntimeIssueV1 | null {
    if (!value) return null;
    if (typeof value === "string") {
        try {
            const parsed = JSON.parse(value);
            const result = SessionRuntimeIssueV1Schema.safeParse(parsed);
            return result.success ? result.data : null;
        } catch {
            return null;
        }
    }
    const result = SessionRuntimeIssueV1Schema.safeParse(value);
    return result.success ? result.data : null;
}

function parseStoredTurnStatus(value: SessionActivityBadgeInputs["latestTurnStatus"]): PrimaryTurnStatusV1 | null {
    const result = PrimaryTurnStatusV1Schema.safeParse(value);
    return result.success ? result.data : null;
}

export function computeSessionContributesToActivityBadge(session: SessionActivityBadgeInputs): boolean {
    if (session.active === false) return false;
    if (session.archivedAt) return false;

    const seq = typeof session.seq === "number" ? session.seq : 0;
    const lastViewedSessionSeq = typeof session.lastViewedSessionSeq === "number" ? session.lastViewedSessionSeq : null;
    const pendingPermissionRequestCount =
        typeof session.pendingPermissionRequestCount === "number" ? session.pendingPermissionRequestCount : 0;
    const pendingUserActionRequestCount =
        typeof session.pendingUserActionRequestCount === "number" ? session.pendingUserActionRequestCount : 0;
    const pendingBlockedCount =
        typeof session.pendingBlockedCount === "number" ? session.pendingBlockedCount : 0;
    const latestTurnStatus = parseStoredTurnStatus(session.latestTurnStatus);
    const lastRuntimeIssue = parseStoredRuntimeIssue(session.lastRuntimeIssue);

    const hasUnread = isSessionUnread({ seq, lastViewedSessionSeq });
    const hasFailedRuntimeIssue = latestTurnStatus === "failed" && lastRuntimeIssue !== null;
    return hasFailedRuntimeIssue
        || hasUnread
        || pendingPermissionRequestCount > 0
        || pendingUserActionRequestCount > 0
        || pendingBlockedCount > 0;
}

export function didSessionActivityBadgeContributionChange(
    before: SessionActivityBadgeInputs,
    after: SessionActivityBadgeInputs,
): boolean {
    return computeSessionContributesToActivityBadge(before) !== computeSessionContributesToActivityBadge(after);
}

export async function computeAccountActivityBadgeCounts(accountIds: ReadonlyArray<string>): Promise<Map<string, number>> {
    const normalizedAccountIds = [...new Set(accountIds.filter((accountId) => typeof accountId === "string" && accountId.trim().length > 0))];
    const counts = new Map<string, number>();
    for (const accountId of normalizedAccountIds) {
        counts.set(accountId, 0);
    }
    if (normalizedAccountIds.length === 0) return counts;

    const sessions = await db.session.findMany({
        where: {
            accountId: { in: normalizedAccountIds },
            active: true,
            archivedAt: null,
        },
        select: {
            accountId: true,
            seq: true,
            pendingCount: true,
            pendingBlockedCount: true,
            lastViewedSessionSeq: true,
            pendingPermissionRequestCount: true,
            pendingUserActionRequestCount: true,
            latestTurnStatus: true,
            lastRuntimeIssue: true,
            active: true,
            archivedAt: true,
        },
    });

    for (const session of sessions satisfies ReadonlyArray<SessionActivityBadgeRow>) {
        if (!computeSessionContributesToActivityBadge(session)) continue;
        counts.set(session.accountId, (counts.get(session.accountId) ?? 0) + 1);
    }

    return counts;
}
