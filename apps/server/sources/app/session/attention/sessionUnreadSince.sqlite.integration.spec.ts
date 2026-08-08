import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { SESSION_MESSAGE_NO_USER_ATTENTION_IMPACT } from "@happier-dev/protocol";

import { applySessionReadCursorOperation, createSessionMessage } from "@/app/session/sessionWriteService";
import { createV2SessionListInitialPage } from "@/app/api/routes/session/v2SessionListInitialPage";

/**
 * `Session.unreadSince` is the materialized replacement for the unindexable
 * `seq > lastViewedSessionSeq` comparison. These tests pin the product invariant end to end through
 * the canonical writers: the fact is stamped at the read -> unread edge, cleared at the
 * unread -> read edge, and never advanced while a session merely stays unread.
 */
describe("Session.unreadSince on SQLite", () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-session-unread-since-sqlite-",
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

    async function readUnreadFact(sessionId: string) {
        const row = await db.session.findUniqueOrThrow({
            where: { id: sessionId },
            select: { seq: true, lastViewedSessionSeq: true, unreadSince: true },
        });
        return row;
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

    it("stamps unreadSince at the read -> unread edge and never advances it while the session stays unread", async () => {
        const seeded = await seed();
        expect((await readUnreadFact(seeded.sessionId)).unreadSince).toBeNull();

        await appendUnreadAffectingMessage({ ...seeded, localId: "first" });
        const afterFirst = await readUnreadFact(seeded.sessionId);
        expect(afterFirst.seq).toBeGreaterThan(afterFirst.lastViewedSessionSeq ?? 0);
        expect(afterFirst.unreadSince).toBeInstanceOf(Date);

        await new Promise((resolve) => setTimeout(resolve, 5));
        await appendUnreadAffectingMessage({ ...seeded, localId: "second" });
        const afterSecond = await readUnreadFact(seeded.sessionId);
        expect(afterSecond.seq).toBeGreaterThan(afterFirst.seq);
        // The product invariant: staying unread must not move the edge instant.
        expect(afterSecond.unreadSince?.getTime()).toBe(afterFirst.unreadSince?.getTime());
    });

    it("clears unreadSince when the read cursor catches up and re-stamps it on mark-unread", async () => {
        const seeded = await seed();
        await appendUnreadAffectingMessage({ ...seeded, localId: "first" });
        const unread = await readUnreadFact(seeded.sessionId);
        expect(unread.unreadSince).toBeInstanceOf(Date);

        const markedRead = await applySessionReadCursorOperation({
            actorUserId: seeded.ownerId,
            sessionId: seeded.sessionId,
            operation: { kind: "mark-read" },
        });
        expect(markedRead.ok).toBe(true);
        expect((await readUnreadFact(seeded.sessionId)).unreadSince).toBeNull();

        const markedUnread = await applySessionReadCursorOperation({
            actorUserId: seeded.ownerId,
            sessionId: seeded.sessionId,
            operation: { kind: "mark-unread" },
        });
        expect(markedUnread.ok).toBe(true);
        const reUnread = await readUnreadFact(seeded.sessionId);
        expect(reUnread.seq).toBeGreaterThan(reUnread.lastViewedSessionSeq ?? 0);
        expect(reUnread.unreadSince).toBeInstanceOf(Date);
    });

    it("keeps unreadSince null when the writer's own message auto-advances the read cursor", async () => {
        const seeded = await seed();
        const result = await createSessionMessage({
            actorUserId: seeded.ownerId,
            sessionId: seeded.sessionId,
            ciphertext: "cipher-quiet",
            trustedAttentionImpact: SESSION_MESSAGE_NO_USER_ATTENTION_IMPACT,
        });
        expect(result.ok).toBe(true);
        const row = await readUnreadFact(seeded.sessionId);
        expect(row.seq).toBe(row.lastViewedSessionSeq);
        expect(row.unreadSince).toBeNull();
    });

    it("answers the attention predicate with an indexable unreadSince seek that matches the derived predicate", async () => {
        const seeded = await seed();
        await appendUnreadAffectingMessage({ ...seeded, localId: "first" });

        const byMaterializedFact = await db.session.findMany({
            where: { accountId: seeded.ownerId, archivedAt: null, unreadSince: { not: null } },
            select: { id: true },
        });
        const byDerivedPredicate = (await db.session.findMany({
            where: { accountId: seeded.ownerId, archivedAt: null },
            select: { id: true, seq: true, lastViewedSessionSeq: true },
        })).filter((row) => row.seq > (row.lastViewedSessionSeq ?? 0));

        expect(byMaterializedFact.map((row) => row.id).sort())
            .toEqual(byDerivedPredicate.map((row) => row.id).sort());
        expect(byMaterializedFact.map((row) => row.id)).toContain(seeded.sessionId);
    });

    /**
     * Rollout / rollback contract.
     *
     * `unreadSince` is maintained by the writer, so a writer running pre-`unreadSince` code — a
     * rolling deploy still draining old instances, or a rolled-back binary against the migrated
     * schema — advances `seq` past `lastViewedSessionSeq` without stamping. The row is then unread
     * but unstamped, and the indexed reader cannot see it.
     *
     * We do not answer that with a dual read: `unreadSince IS NULL OR seq > lastViewedSessionSeq`
     * puts the unindexable column-to-column comparison back on the hot path, and its `unreadSince IS
     * NULL` arm covers every *read* session of the account, so it is not bounded by anything small.
     * Instead the fact self-heals at the seam that owns it — on the next write that touches the
     * session, and on the reader's own observation of a detectably unstamped row.
     */
    describe("old-writer skew", () => {
        /** Reproduce a pre-`unreadSince` writer: `seq` advances, the stamp does not. */
        async function makeUnreadWithoutStamping(sessionId: string) {
            await db.session.update({
                where: { id: sessionId },
                data: { seq: { increment: 1 }, unreadSince: null },
            });
            const row = await readUnreadFact(sessionId);
            expect(row.seq).toBeGreaterThan(row.lastViewedSessionSeq ?? 0);
            expect(row.unreadSince).toBeNull();
        }

        it("re-stamps an unread-but-unstamped row on the next write by a current writer", async () => {
            const seeded = await seed();
            await makeUnreadWithoutStamping(seeded.sessionId);

            // The session is already unread before and after this write, so the read -> unread edge
            // never fires. A writer that only watches the edge leaves the row unstamped forever.
            await appendUnreadAffectingMessage({ ...seeded, localId: "after-skew" });

            expect((await readUnreadFact(seeded.sessionId)).unreadSince).toBeInstanceOf(Date);
        });

        it("still never advances the stamp of a session that was already correctly stamped", async () => {
            const seeded = await seed();
            await appendUnreadAffectingMessage({ ...seeded, localId: "first" });
            const stamped = await readUnreadFact(seeded.sessionId);

            await new Promise((resolve) => setTimeout(resolve, 5));
            await appendUnreadAffectingMessage({ ...seeded, localId: "second" });

            expect((await readUnreadFact(seeded.sessionId)).unreadSince?.getTime())
                .toBe(stamped.unreadSince?.getTime());
        });

        it("clears a stale stamp left behind when the read cursor catches up", async () => {
            const seeded = await seed();
            await appendUnreadAffectingMessage({ ...seeded, localId: "first" });
            const marked = await applySessionReadCursorOperation({
                actorUserId: seeded.ownerId,
                sessionId: seeded.sessionId,
                operation: { kind: "mark-read" },
            });
            expect(marked.ok).toBe(true);
            expect((await readUnreadFact(seeded.sessionId)).unreadSince).toBeNull();
        });

        it("stamps an unread-but-unstamped session the reader observes, without pinning it", async () => {
            const seeded = await seed();
            await makeUnreadWithoutStamping(seeded.sessionId);

            // Visibility was never at stake: `needsAttention` is generated from `seq` and the read
            // cursor, so the indexed attention seek already carries this row. What is missing is the
            // instant the unread lane orders by — and the reader that can see the row repairs it.
            const observed = await createV2SessionListInitialPage({
                userId: seeded.ownerId,
                pageRows: [],
                limit: 20,
                pinnedSessionIds: [],
                includeAttentionRows: true,
            });
            expect(observed.sessions.map((session) => session.id)).toContain(seeded.sessionId);
            expect((await readUnreadFact(seeded.sessionId)).unreadSince).toBeInstanceOf(Date);
        });

        /**
         * The repair claims a row from the row's own columns — unread by `seq` /
         * `lastViewedSessionSeq`, with `unreadSince` fetched and null — so it needs no inference from
         * how full some other read came back. This pins both halves at once: the unstamped row is
         * stamped and the stamped row's original edge instant is left exactly where it was.
         */
        it("stamps every observed unstamped row and never advances one that is already stamped", async () => {
            const owner = await db.account.create({ data: { publicKey: `pk-${randomUUID()}` }, select: { id: true } });
            const create = async (stampedAt: Date | null) => (await db.session.create({
                data: {
                    accountId: owner.id,
                    tag: `session-${randomUUID()}`,
                    metadata: "{}",
                    seq: 5,
                    lastViewedSessionSeq: 1,
                    unreadSince: stampedAt,
                },
                select: { id: true },
            })).id;
            const stampedId = await create(new Date(1_700_000_000_000));
            const unstampedId = await create(null);

            await createV2SessionListInitialPage({
                userId: owner.id,
                pageRows: [],
                limit: 20,
                pinnedSessionIds: [],
                includeAttentionRows: true,
            });

            expect((await readUnreadFact(unstampedId)).unreadSince).toBeInstanceOf(Date);
            expect((await readUnreadFact(stampedId)).unreadSince?.getTime()).toBe(1_700_000_000_000);
        });

        it("leaves a correctly-read session unstamped when the reader observes it", async () => {
            const seeded = await seed();
            await createSessionMessage({
                actorUserId: seeded.ownerId,
                sessionId: seeded.sessionId,
                ciphertext: "cipher-quiet",
                trustedAttentionImpact: SESSION_MESSAGE_NO_USER_ATTENTION_IMPACT,
            });

            await createV2SessionListInitialPage({
                userId: seeded.ownerId,
                pageRows: [],
                limit: 20,
                pinnedSessionIds: [seeded.sessionId],
                includeAttentionRows: true,
            });

            expect((await readUnreadFact(seeded.sessionId)).unreadSince).toBeNull();
        });
    });
});
