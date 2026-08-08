import type { Prisma } from "@prisma/client";

import { db } from "@/storage/db";
import {
    isSessionUnread,
    reconcileObservedSessionUnreadSince,
} from "@/app/session/attention/sessionAttentionFacts";
import {
    createV2ActiveSessionListRowsWhere,
    createV2SessionListCursorWhere,
    findV2SessionListRows,
    mapV2SessionListRows,
    mergeSessionWhereInputs,
    resolveV2SessionListPageBounds,
    V2_ACTIVE_SESSION_LIST_ORDER_BY,
    V2_ACTIVE_SESSION_LIST_ROW_LIMIT,
    V2_SESSION_LIST_ORDER_BY,
    type V2SessionListVisibilityArmsReader,
} from "./v2SessionListPage";
import {
    getV2SessionListEffectiveActivityAt,
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
    includeActiveRows?: boolean;
    activeRowsLimit?: number;
    visibilityArms?: V2SessionListVisibilityArmsReader;
    timing?: V2SessionListInitialPageTiming;
}>;

/**
 * How many attention rows the initial page carries.
 *
 * Unlike the active family's bound, this one *binds*: the reference account has 938 sessions with an
 * attention reason against ~2,900 sessions. It is nonetheless a bound and not a truncation, and the
 * difference is the ordering. The attention family is read with `V2_SESSION_LIST_ORDER_BY` — the
 * list page's own key — so it is a filtered subsequence of the list itself, and the rows above the
 * cap are exactly the rows the cursor page reaches at a later position. Ordinary pagination
 * backfills every one of them, which is why the family needs no cursor and no has-next of its own.
 *
 * The active family has no such property (`lastActiveAt` orders it, and a session can be live with
 * its last meaningful activity weeks old), so a row *it* omits has no other path into the list and
 * its limit is set above any plausible count instead. Pinned by
 * `v2SessionListInitialPage.attentionRows.sqlite.integration.spec.ts`, which fails if the attention
 * read ever stops sharing the page's ordering — at which point this cap becomes silent data loss.
 *
 * The cap counts the rows the *response* carries as attention rows, so attention rows the page
 * already holds spend it too: it bounds the family, not the number of statements' worth of rows read.
 */
export const DEFAULT_V2_SESSION_LIST_INITIAL_ATTENTION_ROW_LIMIT = 100;

function readNumberField(row: V2SessionListRowCompat, field: string): number | null {
    const value = (row as Record<string, unknown>)[field];
    if (typeof value === "bigint") return Number(value);
    return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function hasUnreadSessionActivity(row: V2SessionListRowCompat): boolean {
    const sessionSeq = readNumberField(row, "seq");
    if (sessionSeq === null) return false;
    return isSessionUnread({ seq: sessionSeq, lastViewedSessionSeq: readNumberField(row, "lastViewedSessionSeq") });
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

/**
 * Which shape of the attention predicate the database is asked for.
 *
 * - `materialized` — the indexed `Session.needsAttention` fact. The only shape a current schema is
 *   ever asked for.
 * - `derived` — the predicate this column replaced, used *only* by the projection fallback when the
 *   connected schema predates the `needsAttention` migration
 *   (`20260808120000_add_session_needs_attention`). It names neither materialized column, so it also
 *   answers a schema predating `20260807120000_add_session_unread_since`. Remove it once neither
 *   schema is supported.
 */
type SessionAttentionPredicateSource = "materialized" | "derived";

/**
 * The attention predicate.
 *
 * `materialized` is one indexable conjunct. The predicate it replaces is a four-way disjunction over
 * four different columns — an unread comparison, a turn status and two counters — and a row can
 * qualify through any of them, so no index on any engine can serve it: every engine drops the whole
 * OR into a residual filter and reads the account's sessions. `Session.needsAttention` materializes
 * the same answer as a single **equality** key, so
 * `[accountId, needsAttention, meaningfulActivityAt desc, id desc]` serves this predicate *and* the
 * `V2_SESSION_LIST_ORDER_BY` this read is issued with, leaving the `take` to bound the work. Serving
 * the ordering is the load-bearing half: a filter-only fact makes the engine sort every matched row,
 * which costs more than the filter saves for an account with more attention rows than the limit.
 *
 * The column is **database-generated** from the four raw columns, so no writer of any version can
 * leave it stale and this seek is complete on its own: it needs no dual read and no reader repair.
 * `isDurableAttentionRow` still narrows the result in memory (the failed-turn arm additionally
 * requires a primary-session runtime issue), which is a stricter product rule layered on top of the
 * predicate, not a second answer to it.
 *
 * `archivedAt IS NULL` deliberately stays its own conjunct rather than becoming a fifth arm of the
 * generation expression: it filters an already-tiny matched set, and folding it in would make every
 * archive/unarchive rewrite the generated value and, on PostgreSQL, the row.
 *
 * `derived` is that predecessor predicate, kept for exactly one reader: a binary that is ahead of
 * `prisma migrate deploy` and whose primary read already failed because the column does not exist.
 * Its unindexable scan is not a regression there — it is what that schema's own binary did, and no
 * `[accountId, needsAttention, …]` index exists on it to lose. This is not a dual read: the hot path
 * never issues it, and it answers a *missing column*, never a stale one. It must name no column the
 * legacy projection had to drop, which `v2SessionListPage.projectionFallback.spec.ts` pins against
 * the fallback column list itself.
 *
 * The two unread branches are the two halves of `seq > COALESCE(lastViewedSessionSeq, 0)`: SQL
 * compares a never-viewed session against NULL, which is not true, so it needs its own branch.
 */
export function createV2SessionListAttentionRowsWhere(
    source: SessionAttentionPredicateSource,
): Prisma.SessionWhereInput {
    if (source === "materialized") {
        return { archivedAt: null, needsAttention: true };
    }
    return {
        archivedAt: null,
        AND: [{
            OR: [
                { lastViewedSessionSeq: null, seq: { gt: 0 } },
                { seq: { gt: db.session.fields.lastViewedSessionSeq } },
                { latestTurnStatus: "failed" },
                { pendingPermissionRequestCount: { gt: 0 } },
                { pendingUserActionRequestCount: { gt: 0 } },
            ],
        }],
    };
}

/**
 * Rows this request already holds that are unread but carry no `unreadSince` edge instant — the
 * old-writer skew described in `sessionAttentionFacts.ts`, which only `unreadSince` still has,
 * because `needsAttention` is generated by the database.
 *
 * The claim is read straight off the row: unread by its own raw columns, with the instant column
 * fetched and null. It needs no query and no inference from the shape of some other result, so the
 * attention read's own completeness is irrelevant here.
 *
 * A legacy-projection row does not carry `unreadSince` at all — that is a schema on which the column
 * does not exist — so it is never a candidate. Pinned by
 * `sessionUnreadSince.sqlite.integration.spec.ts`.
 */
function collectUnstampedUnreadSessionIds(
    observedRows: ReadonlyArray<V2SessionListRowCompat>,
): string[] {
    const unreadSessionIds = new Set<string>();
    for (const row of observedRows) {
        if (row.archivedAt !== null) continue;
        if (!("unreadSince" in row) || row.unreadSince !== null) continue;
        if (hasUnreadSessionActivity(row)) unreadSessionIds.add(row.id);
    }
    return [...unreadSessionIds];
}

/**
 * The initial page is the union of the row families the client would otherwise have asked for
 * separately, in a fixed precedence: explicitly pinned rows, then rows in a condition, then rows
 * live on a machine, then the page itself. De-duplication is by session id and first occurrence
 * wins, so a row belonging to several families appears once, at its strongest family's position.
 */
function mergeInitialRows(params: Readonly<{
    pinnedSessionIds: readonly string[];
    pinnedRows: ReadonlyArray<V2SessionListRowCompat>;
    attentionRows: ReadonlyArray<V2SessionListRowCompat>;
    activeRows: ReadonlyArray<V2SessionListRowCompat>;
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
    for (const row of params.activeRows) {
        appendRow(row);
    }
    for (const row of params.pageRows) {
        appendRow(row);
    }
    return rows;
}

type V2SessionListAttentionRowsPlan = Readonly<{
    /** Attention rows the page read already returned, in the family's own order. */
    rowsInPage: ReadonlyArray<V2SessionListRowCompat>;
    /** The predicate that starts the family strictly after the last row of the page. */
    beyondPageWhere: Prisma.SessionWhereInput;
    beyondPageLimit: number;
}>;

/**
 * Split the attention family into the part this request already holds and the part it must read.
 *
 * The family is read with the page's own ordering key, so the two reads overlapped by construction:
 * every attention row inside the page window was fetched, deserialized and mapped **twice** on the
 * request the client's first paint waits for — and each row carries the session's e2ee metadata blob
 * (~35.8 KB on the reference account), which the server cannot project away. Measured on the
 * integration fixture: 153 rows read for a 125-row response.
 *
 * Re-using the page's own rows for the overlap and starting the read after the page's last row makes
 * the union identical. Both halves are ordered by effective activity descending; every row of the
 * first half sorts at or above the boundary and every row of the second sorts strictly below it, so
 * concatenating them reproduces the exact sequence the single read returned — the response is the
 * same rows in the same order, which is what the merge's family precedence depends on.
 *
 * The budget is spent on the whole family, so the rows already in the page count against it; that
 * keeps the cap a bound on what the *response* carries rather than on what one statement returned.
 * When a non-empty page has no next page it is the entire visible list, so no attention row can exist
 * beyond it and the read is skipped outright. An empty supplied page is different: it gives this
 * merger no rows to reuse and can be produced by compatibility callers that still expect the
 * attention family to establish visibility, so that case reads the bounded family from its start.
 */
function planAttentionRowsRead(params: Readonly<{
    includeAttentionRows: boolean;
    /**
     * The rows the page read returned, including the extra row it takes to decide `hasNext`. That
     * probe row is not part of the page, but it is part of the family when it needs attention — and
     * counting it here is what keeps it from being the one row still read twice.
     */
    pageRows: ReadonlyArray<V2SessionListRowCompat>;
    pageHasNext: boolean;
    attentionRowsLimit: number;
}>): V2SessionListAttentionRowsPlan | null {
    if (!params.includeAttentionRows) return null;

    const rowsInPage = params.pageRows.filter(isDurableAttentionRow);
    if (params.pageRows.length === 0) {
        return {
            rowsInPage,
            beyondPageWhere: {},
            beyondPageLimit: params.attentionRowsLimit,
        };
    }
    const boundaryRow = params.pageHasNext ? params.pageRows[params.pageRows.length - 1] : undefined;
    const beyondPageLimit = Math.max(0, params.attentionRowsLimit - rowsInPage.length);
    if (!boundaryRow || beyondPageLimit === 0) {
        return rowsInPage.length > 0
            ? { rowsInPage, beyondPageWhere: {}, beyondPageLimit: 0 }
            : null;
    }

    return {
        rowsInPage,
        beyondPageWhere: createV2SessionListCursorWhere({
            sessionId: boundaryRow.id,
            meaningfulActivityAt: getV2SessionListEffectiveActivityAt(boundaryRow).getTime(),
        }),
        beyondPageLimit,
    };
}

export async function createV2SessionListInitialPage(params: V2SessionListInitialPageParams) {
    const attentionRowsLimit = params.attentionRowsLimit ?? DEFAULT_V2_SESSION_LIST_INITIAL_ATTENTION_ROW_LIMIT;
    const activeRowsLimit = params.activeRowsLimit ?? V2_ACTIVE_SESSION_LIST_ROW_LIMIT;
    const pinnedSessionIds = params.pinnedSessionIds;
    const includeActiveRows = params.includeActiveRows === true;
    const measureQuery = params.timing?.measureQuery ?? (<T>(fn: () => Promise<T>) => fn());
    const measurePage = params.timing?.measurePage ?? (<T>(fn: () => T) => fn());

    // Resolve where the page ends *before* the family reads are issued: the page rows are already in
    // hand, so this costs nothing, and the attention read below is defined relative to that boundary.
    // Only the cursor half of the page is wanted here. Asking `createV2SessionListPage` for it would
    // also map its rows into wire records — every one of which this branch then discards, because the
    // response's `sessions` is the merged set. On the initial page that is `limit` rows mapped twice
    // and thrown away once, on the request the client's first paint waits for.
    const { resultRows: pageRows, ...page } = measurePage(() => resolveV2SessionListPageBounds({
        rows: params.pageRows,
        limit: params.limit,
    }));

    const attentionPlan = measurePage(() => planAttentionRowsRead({
        includeAttentionRows: params.includeAttentionRows,
        pageRows: params.pageRows,
        pageHasNext: page.hasNext,
        attentionRowsLimit,
    }));

    const [pinnedRows, attentionRowsBeyondPage, activeRows] = await Promise.all([
        pinnedSessionIds.length > 0
            ? measureQuery(() => findV2SessionListRows({
                userId: params.userId,
                where: { archivedAt: null, id: { in: [...pinnedSessionIds] } },
                orderBy: { id: "desc" },
                take: pinnedSessionIds.length,
            }))
            : Promise.resolve([]),
        attentionPlan && attentionPlan.beyondPageLimit > 0
            ? measureQuery(() => findV2SessionListRows({
                userId: params.userId,
                where: mergeSessionWhereInputs(
                    createV2SessionListAttentionRowsWhere("materialized"),
                    attentionPlan.beyondPageWhere,
                ),
                legacyWhere: () => mergeSessionWhereInputs(
                    createV2SessionListAttentionRowsWhere("derived"),
                    attentionPlan.beyondPageWhere,
                ),
                orderBy: V2_SESSION_LIST_ORDER_BY,
                take: attentionPlan.beyondPageLimit,
                visibilityArms: params.visibilityArms,
            }))
            : Promise.resolve([]),
        includeActiveRows
            ? measureQuery(() => findV2SessionListRows({
                userId: params.userId,
                where: createV2ActiveSessionListRowsWhere(),
                orderBy: V2_ACTIVE_SESSION_LIST_ORDER_BY,
                take: activeRowsLimit,
                visibilityArms: params.visibilityArms,
            }))
            : Promise.resolve([]),
    ]);
    const mergedRows = measurePage(() => mergeInitialRows({
        pinnedSessionIds,
        pinnedRows,
        // The rows the page already holds come first — they *are* the top of the family, in the same
        // order the one-query shape returned them — and the read above supplies only the tail.
        attentionRows: [...(attentionPlan?.rowsInPage ?? []), ...attentionRowsBeyondPage],
        activeRows,
        pageRows,
    }));

    // Repair, from what this response already proves, the unread instants an older writer left
    // unrecorded. Visibility never depended on this — `needsAttention` is generated, so the indexed
    // seek already carried these rows — only the unread lane's ordering key was missing. In the
    // steady state the candidate set is empty and no statement is issued.
    await reconcileObservedSessionUnreadSince({
        unreadSessionIds: collectUnstampedUnreadSessionIds(mergedRows),
        now: new Date(),
    });

    return measurePage(() => ({
        ...page,
        sessions: mapV2SessionListRows({ rows: mergedRows, userId: params.userId }),
        // Advertise the merge to the client that asked for it. `includeActive` is negotiable only
        // because of this marker: an older server drops the unknown query key in its zod querystring
        // schema and answers with a valid page, and an account with no live session yields no extra
        // rows either way, so the rows themselves can never tell the client whether the flag was
        // honoured — it would keep issuing the separate `GET /v2/sessions/active` call forever.
        // It is emitted from the same `includeActiveRows` that gates the query above, and from
        // nowhere else, so it cannot claim a merge that did not happen. `V2SessionListResponseSchema`
        // is `.passthrough()`, so it rides the existing response with no format change and an older
        // client, which never reads the key, sees the response it always saw.
        ...(includeActiveRows ? { includedActive: true } : {}),
    }));
}
