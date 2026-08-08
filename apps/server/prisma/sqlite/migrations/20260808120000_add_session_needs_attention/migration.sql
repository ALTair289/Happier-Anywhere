-- AlterTable
-- The materialized attention fact, maintained by the database rather than by application writers.
-- See the PostgreSQL migration of the same name for why it is a generated column: every arm is a
-- column of this same row, so no writer — old, new, rolled back or hand-run — can leave it stale,
-- and the fact therefore needs no writer wiring and no reader repair.
--
-- Cost on SQLite: `VIRTUAL` is the only kind `ALTER TABLE ADD COLUMN` accepts (a `STORED` addition
-- needs a full table rebuild), and it is a schema-only change — O(1) regardless of table size, unlike
-- the plain-column form this replaces, which added a column and then UPDATEd every attention row.
-- SQLite indexes virtual generated columns, so the index below is unaffected.
ALTER TABLE "Session" ADD COLUMN "needsAttention" BOOLEAN NOT NULL GENERATED ALWAYS AS (
    "seq" > COALESCE("lastViewedSessionSeq", 0)
    OR COALESCE("latestTurnStatus", '') = 'failed'
    OR "pendingPermissionRequestCount" > 0
    OR "pendingUserActionRequestCount" > 0
) VIRTUAL;

-- CreateIndex
-- Serves the attention read whole: equality on `accountId` and `needsAttention`, then the read's own
-- `ORDER BY "meaningfulActivityAt" DESC, "id" DESC`, which SQLite walks as a reverse index scan — so
-- `LIMIT` bounds the work and no temp b-tree sort is required at any attention selectivity.
CREATE INDEX "Session_accountId_needsAttention_meaningfulActivityAt_id_idx" ON "Session"("accountId", "needsAttention", "meaningfulActivityAt", "id");
