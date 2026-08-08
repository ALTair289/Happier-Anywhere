-- AlterTable
-- The materialized attention fact, maintained by the database rather than by application writers.
-- See the PostgreSQL migration of the same name for why it is a generated column: every arm is a
-- column of this same row, so no writer — old, new, rolled back or hand-run — can leave it stale,
-- and the fact therefore needs no writer wiring and no reader repair.
--
-- Cost on MySQL: `VIRTUAL` is chosen over `STORED` because adding a virtual generated column is an
-- INPLACE, no-rebuild, concurrent-DML-permitting operation, while a stored one rebuilds the table.
-- InnoDB materializes a virtual column's value into any secondary index built over it, so the index
-- below is a normal index build and the read seeks it exactly as it would a stored column.
ALTER TABLE `Session` ADD COLUMN `needsAttention` BOOLEAN GENERATED ALWAYS AS (
    `seq` > COALESCE(`lastViewedSessionSeq`, 0)
    OR COALESCE(`latestTurnStatus`, '') = 'failed'
    OR `pendingPermissionRequestCount` > 0
    OR `pendingUserActionRequestCount` > 0
) VIRTUAL NOT NULL;

-- CreateIndex
-- Serves the attention read whole: equality on `accountId` and `needsAttention`, then the read's own
-- `ORDER BY meaningfulActivityAt DESC, id DESC` — which InnoDB walks as a reverse index range scan,
-- exactly as it already does for `Session_accountId_meaningfulActivityAt_id_idx` — so `LIMIT` bounds
-- the work and no sort is required at any attention selectivity.
CREATE INDEX `Session_accountId_needsAttention_meaningfulActivityAt_id_idx` ON `Session`(`accountId`, `needsAttention`, `meaningfulActivityAt`, `id`);
