-- AlterTable
-- The materialized attention fact, maintained by the database rather than by application writers.
--
-- Every arm of the attention predicate is a column of this same row, so the fact is a pure function
-- of the row and a generated column expresses it exactly. That is what makes it version-independent:
-- a writer running older code, a rolled-back binary, a `psql` session or a future writer that has
-- never heard of this column all keep it correct, because none of them can write it. The materialized
-- and derived answers cannot diverge, so no writer wiring and no reader repair exist for this fact.
--
-- The unread arm is spelled from the raw columns, not from `unreadSince`: `unreadSince` is itself
-- writer-maintained, and a fact derived from a maintained fact would inherit its skew.
--
-- No arm can be NULL — `seq` and both counters are NOT NULL, `lastViewedSessionSeq` is COALESCEd, and
-- the nullable `latestTurnStatus` is COALESCEd before comparison — so the column is NOT NULL by
-- construction.
--
-- Cost on PostgreSQL: `STORED` is the only kind PostgreSQL supports through 17 (18 adds `VIRTUAL`,
-- which cannot be indexed), and adding a stored generated column rewrites the table under
-- ACCESS EXCLUSIVE. That is strictly more than the plain-column form this replaces (instant ADD with
-- a non-volatile default, then an UPDATE over the attention rows), and it is in the same lock class
-- as the non-concurrent CREATE INDEX below, which this migration already takes for the length of a
-- full index build.
ALTER TABLE "Session" ADD COLUMN "needsAttention" BOOLEAN NOT NULL GENERATED ALWAYS AS (
    "seq" > COALESCE("lastViewedSessionSeq", 0)
    OR COALESCE("latestTurnStatus", '') = 'failed'
    OR "pendingPermissionRequestCount" > 0
    OR "pendingUserActionRequestCount" > 0
) STORED;

-- CreateIndex
-- Serves the attention read whole: equality on `accountId` and `needsAttention`, then the read's own
-- `ORDER BY "meaningfulActivityAt" DESC, "id" DESC` walked in index order, so `LIMIT` bounds the work
-- and no sort is required at any attention selectivity.
CREATE INDEX "Session_accountId_needsAttention_meaningfulActivityAt_id_idx" ON "Session"("accountId", "needsAttention", "meaningfulActivityAt" DESC, "id" DESC);
