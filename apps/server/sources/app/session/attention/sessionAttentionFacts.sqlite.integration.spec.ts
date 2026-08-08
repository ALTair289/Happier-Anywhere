import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

import {
    applySessionReadCursorOperation,
    createSessionMessage,
    reassertSessionLatestTurnStatus,
    updateSessionAgentState,
} from "@/app/session/sessionWriteService";
import {
    createV2SessionListAttentionRowsWhere,
    createV2SessionListInitialPage,
} from "@/app/api/routes/session/v2SessionListInitialPage";

/**
 * `Session.needsAttention` is the materialized replacement for the 4-way attention disjunction
 * (`seq > COALESCE(lastViewedSessionSeq, 0) OR latestTurnStatus = 'failed' OR
 * pendingPermissionRequestCount > 0 OR pendingUserActionRequestCount > 0`). No index on any engine
 * can serve that OR, so the attention read scanned the account. These tests pin the product
 * invariant end to end through the canonical writers of all four reasons: the flag is true while
 * *any* reason holds and false once none do.
 *
 * It is a **database-generated column**, not a writer-maintained one, because every arm is a column
 * of the same row. That is what makes the materialized answer version-independent: no writer — old,
 * new, rolled back, or hand-run SQL — can leave it disagreeing with the row it summarizes. The
 * writers exercised below therefore assert an invariant they do not implement, which is the point:
 * the same assertions hold for writers that have never heard of the column.
 *
 * The fact is a boolean rather than an edge timestamp on purpose. `[accountId, needsAttention,
 * meaningfulActivityAt desc, id desc]` binds the two equality columns and then walks the read's own
 * `ORDER BY meaningfulActivityAt DESC, id DESC` in index order, so the `LIMIT 101` stops the scan;
 * a timestamp fact cannot serve that ordering, so the engine had to sort every matched row — which
 * costs more than the filter saves as soon as an account has more attention rows than the limit.
 */
describe("Session.needsAttention on SQLite", () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-session-needs-attention-sqlite-",
            initAuth: false,
            initEncrypt: false,
            initFiles: false,
        });
    });
    beforeEach(() => harness.resetEnv());
    afterAll(async () => await harness.close());

    async function seed() {
        const owner = await db.account.create({ data: { publicKey: `pk-${randomUUID()}` }, select: { id: true } });
        const session = await db.session.create({
            data: {
                accountId: owner.id,
                tag: `session-${randomUUID()}`,
                metadata: "{}",
            },
            select: { id: true },
        });
        return { ownerId: owner.id, sessionId: session.id };
    }

    async function readAttentionFacts(sessionId: string) {
        return await db.session.findUniqueOrThrow({
            where: { id: sessionId },
            select: {
                seq: true,
                lastViewedSessionSeq: true,
                unreadSince: true,
                needsAttention: true,
                latestTurnStatus: true,
                pendingPermissionRequestCount: true,
                pendingUserActionRequestCount: true,
            },
        });
    }

    async function appendUnreadAffectingMessage(params: { ownerId: string; sessionId: string; localId: string }) {
        const result = await createSessionMessage({
            actorUserId: params.ownerId,
            sessionId: params.sessionId,
            localId: params.localId,
            ciphertext: `cipher-${params.localId}`,
        });
        if (!result.ok) throw new Error(`createSessionMessage failed: ${result.error}`);
        return result;
    }

    async function setPendingPermissionRequestCount(params: {
        ownerId: string;
        sessionId: string;
        expectedVersion: number;
        count: number;
    }) {
        const result = await updateSessionAgentState({
            actorUserId: params.ownerId,
            sessionId: params.sessionId,
            expectedVersion: params.expectedVersion,
            agentStateCiphertext: null,
            pendingPermissionRequestCount: params.count,
        });
        if (!result.ok) throw new Error(`updateSessionAgentState failed: ${result.error}`);
        return result;
    }

    /**
     * The keystone. It walks a session through every kind of attention transition in one pass, so it
     * fails for a writer that misses the entry edge, for a writer that clears while another reason
     * still holds, and for a writer that never clears. The reason-change steps are the ones that
     * matter: the flag is a property of the *set* of live reasons, not of the reason that last moved.
     */
    it("holds needsAttention while any reason holds and clears it only when the last one goes", async () => {
        const seeded = await seed();
        expect((await readAttentionFacts(seeded.sessionId)).needsAttention).toBe(false);

        // Enter attention through the unread arm.
        await appendUnreadAffectingMessage({ ...seeded, localId: "first" });
        expect((await readAttentionFacts(seeded.sessionId)).needsAttention).toBe(true);

        // More of the same reason keeps it set.
        await appendUnreadAffectingMessage({ ...seeded, localId: "second" });
        expect((await readAttentionFacts(seeded.sessionId)).needsAttention).toBe(true);

        // Gaining a *second*, different reason keeps it set.
        await setPendingPermissionRequestCount({ ...seeded, expectedVersion: 0, count: 1 });
        expect((await readAttentionFacts(seeded.sessionId)).needsAttention).toBe(true);

        // Losing the *original* reason while another still holds must not clear it.
        const marked = await applySessionReadCursorOperation({
            actorUserId: seeded.ownerId,
            sessionId: seeded.sessionId,
            operation: { kind: "mark-read" },
        });
        expect(marked.ok).toBe(true);
        const afterRead = await readAttentionFacts(seeded.sessionId);
        expect(afterRead.unreadSince).toBeNull();
        expect(afterRead.pendingPermissionRequestCount).toBe(1);
        expect(afterRead.needsAttention).toBe(true);

        // Only losing the last reason clears it.
        await setPendingPermissionRequestCount({ ...seeded, expectedVersion: 1, count: 0 });
        expect((await readAttentionFacts(seeded.sessionId)).needsAttention).toBe(false);
    });

    it("sets needsAttention for a read session that gains a pending permission request", async () => {
        const seeded = await seed();
        await setPendingPermissionRequestCount({ ...seeded, expectedVersion: 0, count: 2 });

        const row = await readAttentionFacts(seeded.sessionId);
        // The two facts are genuinely different: this session needs attention and is not unread.
        expect(row.unreadSince).toBeNull();
        expect(row.needsAttention).toBe(true);
    });

    it("sets needsAttention for a read session that gains a pending user-action request", async () => {
        const seeded = await seed();
        const result = await updateSessionAgentState({
            actorUserId: seeded.ownerId,
            sessionId: seeded.sessionId,
            expectedVersion: 0,
            agentStateCiphertext: null,
            pendingUserActionRequestCount: 1,
        });
        expect(result.ok).toBe(true);

        const row = await readAttentionFacts(seeded.sessionId);
        expect(row.unreadSince).toBeNull();
        expect(row.needsAttention).toBe(true);
    });

    it("sets needsAttention when the latest turn transitions to failed and clears it when it recovers", async () => {
        const seeded = await seed();
        const failed = await reassertSessionLatestTurnStatus({
            actorUserId: seeded.ownerId,
            sessionId: seeded.sessionId,
            latestTurnStatus: "failed",
            latestTurnStatusObservedAt: 1_000,
        });
        expect(failed.ok).toBe(true);
        expect((await readAttentionFacts(seeded.sessionId)).needsAttention).toBe(true);

        const recovered = await reassertSessionLatestTurnStatus({
            actorUserId: seeded.ownerId,
            sessionId: seeded.sessionId,
            latestTurnStatus: "completed",
            latestTurnStatusObservedAt: 2_000,
        });
        expect(recovered.ok).toBe(true);
        const row = await readAttentionFacts(seeded.sessionId);
        expect(row.latestTurnStatus).toBe("completed");
        expect(row.needsAttention).toBe(false);
    });

    it("answers the attention predicate with an indexable needsAttention seek that matches the derived predicate", async () => {
        const owner = await db.account.create({ data: { publicKey: `pk-${randomUUID()}` }, select: { id: true } });
        const create = async (data: Record<string, unknown>) => (await db.session.create({
            data: { accountId: owner.id, tag: `session-${randomUUID()}`, metadata: "{}", ...data },
            select: { id: true },
        })).id;

        // Written straight to the columns, with no attention-aware writer anywhere in the loop —
        // which is what a pre-`needsAttention` binary does, and what the generated column has to
        // survive.
        const quietId = await create({});
        const unreadId = await create({ seq: 3, lastViewedSessionSeq: 1 });
        const neverViewedId = await create({ seq: 1 });
        const failedId = await create({ latestTurnStatus: "failed" });
        const permissionId = await create({ pendingPermissionRequestCount: 1 });
        const userActionId = await create({ pendingUserActionRequestCount: 1 });

        const byMaterializedFact = await db.session.findMany({
            where: { accountId: owner.id, ...createV2SessionListAttentionRowsWhere("materialized") },
            select: { id: true },
        });
        // The exact predicate the column replaces, taken from the reader's own fallback rather than
        // restated here, so the two shapes cannot drift apart unnoticed.
        const byDerivedPredicate = await db.session.findMany({
            where: { accountId: owner.id, ...createV2SessionListAttentionRowsWhere("derived") },
            select: { id: true },
        });

        expect(byMaterializedFact.map((row) => row.id).sort())
            .toEqual(byDerivedPredicate.map((row) => row.id).sort());
        // Anti-vacuity: every arm is represented and the quiet session is in neither.
        expect(byMaterializedFact.map((row) => row.id).sort())
            .toEqual([unreadId, neverViewedId, failedId, permissionId, userActionId].sort());
        expect(byMaterializedFact.map((row) => row.id)).not.toContain(quietId);
    });

    /**
     * Rollout / rollback contract.
     *
     * `needsAttention` used to be writer-maintained, and that was a correctness bug: a writer
     * running pre-`needsAttention` code — a rolling deploy still draining old instances, or a
     * rolled-back binary against the migrated schema — could give a session a reason while leaving
     * the flag false, and the row was then invisible to the indexed reader until something else
     * happened to touch it.
     *
     * The column is now generated by the database from the same four raw columns the predicate
     * names, so the skew has no source: no writer of any version can produce a row whose flag
     * disagrees with its reasons, and neither writer wiring nor reader repair exists for it.
     */
    describe("old-writer skew", () => {
        /** Exactly a pre-`needsAttention` writer: it sets a reason column and nothing else. */
        async function giveReasonAsAnOldWriter(sessionId: string, count: number) {
            await db.session.update({
                where: { id: sessionId },
                data: { pendingPermissionRequestCount: count },
            });
        }

        it("surfaces a row a pre-migration writer gave a reason to, with no pin, page or later write", async () => {
            const seeded = await seed();
            await giveReasonAsAnOldWriter(seeded.sessionId, 1);

            const page = await createV2SessionListInitialPage({
                userId: seeded.ownerId,
                pageRows: [],
                limit: 20,
                pinnedSessionIds: [],
                includeAttentionRows: true,
            });
            expect(page.sessions.map((session) => session.id)).toContain(seeded.sessionId);
        });

        it("drops a row whose last reason a pre-migration writer removed, with no later write", async () => {
            const seeded = await seed();
            await giveReasonAsAnOldWriter(seeded.sessionId, 1);
            expect((await readAttentionFacts(seeded.sessionId)).needsAttention).toBe(true);

            await giveReasonAsAnOldWriter(seeded.sessionId, 0);

            expect((await readAttentionFacts(seeded.sessionId)).needsAttention).toBe(false);
            const page = await createV2SessionListInitialPage({
                userId: seeded.ownerId,
                pageRows: [],
                limit: 20,
                pinnedSessionIds: [],
                includeAttentionRows: true,
            });
            expect(page.sessions.map((session) => session.id)).not.toContain(seeded.sessionId);
        });

        /**
         * The property the two tests above rest on, asserted directly: the skew class is closed
         * because the column is unwritable, not because every writer is careful. A future writer
         * that tried to maintain it — the mistake this design exists to prevent — fails loudly here
         * rather than silently reintroducing a second owner of the answer.
         */
        it("refuses any attempt to write the generated column", async () => {
            const seeded = await seed();
            await expect(db.session.update({
                where: { id: seeded.sessionId },
                data: { needsAttention: true },
            })).rejects.toThrow(/generated column/i);
        });
    });
});
