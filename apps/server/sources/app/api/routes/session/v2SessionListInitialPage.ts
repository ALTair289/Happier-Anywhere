import type { Prisma } from "@prisma/client";

import { db } from "@/storage/db";
import {
    createV2SessionListPage,
    findV2SessionListRows,
    mapV2SessionListRows,
    V2_SESSION_LIST_ORDER_BY,
} from "./v2SessionListPage";
import {
    parseStoredSessionLatestTurnStatus,
    parseStoredSessionRuntimeIssue,
    type V2SessionListRowCompat,
} from "./v2SessionListRows";
import type { V2SessionListInitialPageTiming } from "./v2SessionListServerTiming";

type V2SessionListInitialPageParams = Readonly<{
    userId: string;
    pageRows: ReadonlyArray<V2SessionListRowCompat>;
    limit: number;
    pinnedSessionIds: readonly string[];
    includeAttentionRows: boolean;
    attentionRowsLimit?: number;
    timing?: V2SessionListInitialPageTiming;
}>;

export const DEFAULT_V2_SESSION_LIST_INITIAL_ATTENTION_ROW_LIMIT = 100;

function readNumberField(row: V2SessionListRowCompat, field: string): number | null {
    const value = (row as Record<string, unknown>)[field];
    if (typeof value === "bigint") return Number(value);
    return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function hasUnreadSessionActivity(row: V2SessionListRowCompat): boolean {
    const sessionSeq = readNumberField(row, "seq");
    if (sessionSeq === null) return false;
    return sessionSeq > (readNumberField(row, "lastViewedSessionSeq") ?? 0);
}

function hasPrimarySessionFailure(row: V2SessionListRowCompat): boolean {
    if (parseStoredSessionLatestTurnStatus(row.latestTurnStatus) !== "failed") return false;
    const issue = parseStoredSessionRuntimeIssue(row.lastRuntimeIssue);
    return issue?.v === 1
        && issue.scope === "primary_session"
        && issue.status === "failed";
}

function isDurableAttentionRow(row: V2SessionListRowCompat): boolean {
    return row.pendingPermissionRequestCount > 0
        || row.pendingUserActionRequestCount > 0
        || hasPrimarySessionFailure(row)
        || hasUnreadSessionActivity(row);
}

function createUnreadSessionActivityWhereBranches(): Prisma.SessionWhereInput[] {
    return [
        { lastViewedSessionSeq: null, seq: { gt: 0 } },
        { seq: { gt: db.session.fields.lastViewedSessionSeq } },
    ];
}

function createAttentionRowsWhere(): Prisma.SessionWhereInput {
    return {
        archivedAt: null,
        AND: [{
            OR: [
                ...createUnreadSessionActivityWhereBranches(),
                { latestTurnStatus: "failed" },
                { pendingPermissionRequestCount: { gt: 0 } },
                { pendingUserActionRequestCount: { gt: 0 } },
            ],
        }],
    };
}

function mergeInitialRows(params: Readonly<{
    pinnedSessionIds: readonly string[];
    pinnedRows: ReadonlyArray<V2SessionListRowCompat>;
    attentionRows: ReadonlyArray<V2SessionListRowCompat>;
    pageRows: ReadonlyArray<V2SessionListRowCompat>;
}>): V2SessionListRowCompat[] {
    const pinnedRowsById = new Map(params.pinnedRows.map((row) => [row.id, row]));
    const seen = new Set<string>();
    const rows: V2SessionListRowCompat[] = [];
    const appendRow = (row: V2SessionListRowCompat | undefined): void => {
        if (!row || seen.has(row.id)) return;
        seen.add(row.id);
        rows.push(row);
    };

    for (const sessionId of params.pinnedSessionIds) {
        appendRow(pinnedRowsById.get(sessionId));
    }
    for (const row of params.attentionRows) {
        if (isDurableAttentionRow(row)) appendRow(row);
    }
    for (const row of params.pageRows) {
        appendRow(row);
    }
    return rows;
}

export async function createV2SessionListInitialPage(params: V2SessionListInitialPageParams) {
    const attentionRowsLimit = params.attentionRowsLimit ?? DEFAULT_V2_SESSION_LIST_INITIAL_ATTENTION_ROW_LIMIT;
    const pinnedSessionIds = params.pinnedSessionIds;
    const measureQuery = params.timing?.measureQuery ?? (<T>(fn: () => Promise<T>) => fn());
    const measurePage = params.timing?.measurePage ?? (<T>(fn: () => T) => fn());
    const [pinnedRows, attentionRows] = await Promise.all([
        pinnedSessionIds.length > 0
            ? measureQuery(() => findV2SessionListRows({
                userId: params.userId,
                where: { archivedAt: null, id: { in: [...pinnedSessionIds] } },
                orderBy: { id: "desc" },
                take: pinnedSessionIds.length,
            }))
            : Promise.resolve([]),
        params.includeAttentionRows
            ? measureQuery(() => findV2SessionListRows({
                userId: params.userId,
                where: createAttentionRowsWhere(),
                orderBy: V2_SESSION_LIST_ORDER_BY,
                take: attentionRowsLimit,
            }))
            : Promise.resolve([]),
    ]);
    const page = measurePage(() => createV2SessionListPage({
        rows: params.pageRows,
        userId: params.userId,
        limit: params.limit,
    }));
    const pageRows = params.pageRows.slice(0, params.limit);
    const mergedRows = measurePage(() => mergeInitialRows({
        pinnedSessionIds,
        pinnedRows,
        attentionRows,
        pageRows,
    }));

    return measurePage(() => ({
        ...page,
        sessions: mapV2SessionListRows({ rows: mergedRows, userId: params.userId }),
    }));
}
