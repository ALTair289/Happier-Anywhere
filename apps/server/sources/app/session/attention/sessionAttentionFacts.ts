import { db } from "@/storage/db";
import type { Tx } from "@/storage/inTx";
import { describeLoggableError } from "@/utils/logging/describeLoggableError";
import { warn } from "@/utils/logging/log";

/**
 * Canonical owner of the session-attention facts that application code maintains — which, since
 * `Session.needsAttention` became a generated column, is exactly one: `Session.unreadSince`.
 *
 * ## The two facts, and why only one is written here
 *
 * The attention page asks one question: which of this account's sessions need the user. Expressed
 * from raw columns that is
 *
 * ```
 * seq > COALESCE(lastViewedSessionSeq, 0)
 *   OR latestTurnStatus = 'failed'
 *   OR pendingPermissionRequestCount > 0
 *   OR pendingUserActionRequestCount > 0
 * ```
 *
 * — a column-to-column comparison OR'd with three more columns. No index on any engine can serve
 * it: a row can qualify through four different columns, so the planner drops the whole disjunction
 * into a residual filter and reads every session of the account. `Session.needsAttention`
 * materializes that answer as a single equality key, collapsing the predicate to
 * `accountId = ? AND needsAttention = true`.
 *
 * Every arm of that predicate is a column of the **same row**, so the fact is a pure function of the
 * row — and it is therefore maintained by the *database*, as a generated column
 * (`20260808120000_add_session_needs_attention`: PostgreSQL `STORED`, MySQL/SQLite `VIRTUAL`). That
 * is not an optimization, it is the correctness property. A materialized fact maintained by
 * application writers is only as correct as the version of the writer that last touched the row, so
 * a rolling deploy still draining old instances — or a binary rolled back onto the migrated schema —
 * could set `pendingPermissionRequestCount = 1` without setting the flag, and the indexed reader
 * could not see the session at all. A generated column cannot be written by anyone, so old writers,
 * new writers, rolled-back writers and hand-run SQL all keep it correct by construction. That is why
 * there is no `needsAttention` writer wiring in this file and no reader repair for it anywhere:
 * both existed only to chase a skew that no longer has a source.
 *
 * `unreadSince` is **not** a candidate for the same treatment, and that asymmetry is the point.
 * It records *when* a session crossed into unread — state, not a function of the current row — so
 * only a writer that observes the crossing can produce it. It stays edge-triggered here.
 *
 * ## Why both facts exist
 *
 * They are different facts. A session enters attention through a permission request while staying
 * read, and becomes unread later; `unreadSince` is the instant the *client* orders the unread lane
 * by (`sessionListPlacementProjection.ts`), so it is a timestamp and cannot be replaced by the
 * coarser attention flag. `needsAttention` is never read as an ordering key — it exists purely so
 * the WHERE can be sought.
 *
 * ## The invariant (product requirement)
 *
 * `unreadSince` is **edge-triggered**: stamped when the session crosses into unread, cleared when it
 * leaves, and never advanced while it merely stays unread, so it is a stable instant rather than a
 * second `updatedAt`.
 *
 * ## Rollout and rollback contract
 *
 * `unreadSince` is writer-maintained, so a writer running older code can leave a session unread with
 * no instant recorded. It self-heals from two directions, and neither costs an extra statement:
 *
 * 1. **Writers** (`resolveSessionUnreadSinceWrite`) decide from the row's **post-write** unread
 *    answer rather than from the transition, so they converge the fact whenever the session is
 *    unread afterwards — not only at the edge.
 * 2. **Readers** (`reconcileObservedSessionUnreadSince`) repair rows they can already prove are
 *    stale — unread by the raw columns they fetched anyway, with no instant stored.
 *
 * The unrecorded row is never *hidden* while it waits: its visibility is decided by
 * `needsAttention`, which the database has already computed. Only the unread lane's ordering key is
 * missing, and the reader that can see the row is the reader that repairs it.
 */

export type SessionUnreadInputs = Readonly<{
    seq?: number | null;
    lastViewedSessionSeq?: number | null;
}>;

/** Only the stored edge instant is needed to decide whether a write must move it. */
export type StoredSessionUnreadSince = Readonly<{
    unreadSince?: Date | null;
}>;

/**
 * The fragment a writer merges into a Prisma `data` payload. `unreadSince` is present only when the
 * edge instant must change, so an unchanged one is never rewritten.
 */
export type SessionUnreadSinceWrite = Readonly<{ unreadSince: Date | null }> | Readonly<Record<string, never>>;

function normalizeSeq(value: number | null | undefined): number {
    return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

/**
 * The unread predicate. This is the single definition every reader and writer must agree on, and it
 * is the same comparison the `needsAttention` generation expression spells in SQL.
 */
export function isSessionUnread(inputs: SessionUnreadInputs): boolean {
    return normalizeSeq(inputs.seq) > normalizeSeq(inputs.lastViewedSessionSeq);
}

/**
 * Resolve the fragment to merge into a Prisma `data` payload a writer is already issuing, so
 * maintaining the fact costs no extra statement.
 *
 * `after` must describe the **post-write** value of both unread inputs, including the one this
 * particular writer does not touch — pass the stored value for that one.
 *
 * - unread afterwards, nothing stored: stamp `now`. This is the read -> unread edge *and* the repair
 *   of a row an older writer left unstamped.
 * - unread afterwards, already stamped: write no field at all, so the original edge instant survives.
 * - read afterwards: clear. Written unconditionally, so a stale stamp self-heals.
 *
 * Only a writer that moves `seq` or `lastViewedSessionSeq` needs this. The other attention arms —
 * `latestTurnStatus` and the two pending counters — move `needsAttention`, which the database owns,
 * so those writers issue their own statement and nothing else.
 */
export function resolveSessionUnreadSinceWrite(params: Readonly<{
    stored: StoredSessionUnreadSince;
    after: SessionUnreadInputs;
    now: Date;
}>): SessionUnreadSinceWrite {
    const storedUnreadSince = params.stored.unreadSince ?? null;
    if (!isSessionUnread(params.after)) return { unreadSince: null };
    return storedUnreadSince === null ? { unreadSince: params.now } : {};
}

/**
 * Record sessions the caller has already established are unread but carry no edge instant.
 *
 * The `where: { unreadSince: null }` clause is the whole safety of this write: a session that
 * already carries an instant is not matched, so an original edge can never be advanced no matter
 * what the caller passes. Callers are responsible only for the unread half of the claim.
 *
 * No statement is issued for an empty set, which is the steady state.
 *
 * Used by a writer that changed `seq` in a separate statement. Failures propagate, because the
 * caller's transaction owns them.
 */
export async function stampMissingSessionUnreadSince(params: Readonly<{
    client?: Tx;
    unreadSessionIds: readonly string[];
    now: Date;
}>): Promise<number> {
    if (params.unreadSessionIds.length === 0) return 0;
    const client = params.client ?? db;
    const { count } = await client.session.updateMany({
        where: { id: { in: [...params.unreadSessionIds] }, unreadSince: null },
        data: { unreadSince: params.now },
    });
    return count;
}

/**
 * Repair sessions a reader observed to be unread with no edge instant stored — the old-writer skew
 * path described at the top of this file.
 *
 * The caller supplies only sessions it has already derived from raw columns it fetched anyway;
 * `stampMissingSessionUnreadSince` refuses to touch a row that already carries an instant, so a
 * mistaken candidate costs a no-op rather than a moved edge.
 *
 * Repair is maintenance, never the reader's purpose, so a failure is reported and swallowed instead
 * of failing the page that happened to notice it.
 */
export async function reconcileObservedSessionUnreadSince(params: Readonly<{
    unreadSessionIds: readonly string[];
    now: Date;
}>): Promise<number> {
    if (params.unreadSessionIds.length === 0) return 0;
    try {
        return await stampMissingSessionUnreadSince(params);
    } catch (error) {
        warn(
            {
                module: "session-attention",
                event: "unread-since-repair-failed",
                unreadSessionCount: params.unreadSessionIds.length,
                error: describeLoggableError(error),
            },
            "Failed to repair missing Session.unreadSince",
        );
        return 0;
    }
}
