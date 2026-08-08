import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

import { createSessionMessageFromPending } from "./pendingMessageTranscriptCommit";

/**
 * Materializing a pending message is a `seq` writer: it advances the session's sequence without
 * moving the read cursor, so the session is unread — and in attention — the moment the row lands.
 * `Session.unreadSince` is the edge instant the unread lane orders by, and a `seq` writer that does
 * not stamp it leaves a session the client cannot place. This commit path is the one `seq` writer
 * that had no coverage of that obligation. `Session.needsAttention` is asserted alongside it as the
 * control: the database generates it from `seq` and the read cursor, so it must already agree with
 * every step here without this path writing it.
 *
 * The negative case is the discriminating half: the same call for an already-committed localId must
 * not stamp, because it does not advance `seq`.
 */
describe("pending transcript commit stamps session attention facts (SQLite integration)", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-pending-transcript-attention-sqlite-",
            initAuth: false,
            initEncrypt: false,
            initFiles: false,
        });
    }, 180_000);

    afterEach(async () => {
        harness.resetEnv();
        await db.sessionMessage.deleteMany();
        await db.session.deleteMany();
        await db.account.deleteMany();
    });

    afterAll(async () => await harness.close());

    async function seed(overrides: Readonly<{ unreadSince?: Date }> = {}) {
        const account = await db.account.create({
            data: { publicKey: `pk-${randomUUID()}` },
            select: { id: true },
        });
        const session = await db.session.create({
            data: {
                accountId: account.id,
                tag: `tag-${randomUUID()}`,
                metadata: "{}",
                unreadSince: overrides.unreadSince ?? null,
            },
            select: { id: true },
        });
        return { sessionId: session.id };
    }

    async function commitPending(sessionId: string, localId: string) {
        return await inTx(async (tx) => await createSessionMessageFromPending(tx, {
            sessionId,
            localId,
            content: { t: "encrypted", c: `cipher-${localId}` },
            messageRole: "user",
        }));
    }

    async function readAttentionFacts(sessionId: string) {
        return await db.session.findUniqueOrThrow({
            where: { id: sessionId },
            select: { seq: true, unreadSince: true, needsAttention: true },
        });
    }

    it("records both attention facts when the commit advances seq", async () => {
        const { sessionId } = await seed();
        expect(await readAttentionFacts(sessionId)).toMatchObject({
            seq: 0,
            unreadSince: null,
            needsAttention: false,
        });

        const result = await commitPending(sessionId, `pending-${randomUUID()}`);
        expect(result).toMatchObject({ ok: true, didWrite: true });

        const facts = await readAttentionFacts(sessionId);
        expect(facts.seq).toBe(1);
        expect(facts.needsAttention).toBe(true);
        expect(facts.unreadSince).toBeInstanceOf(Date);
    });

    it("keeps the original unread edge instant when a later commit finds the session already unread", async () => {
        const originalEdge = new Date(1_700_000_000_000);
        const { sessionId } = await seed({ unreadSince: originalEdge });

        await commitPending(sessionId, `pending-${randomUUID()}`);

        // The edge instant orders the attention page, so a session that merely *stays* unread must
        // keep the moment it first became unread rather than jumping to the newest message.
        const facts = await readAttentionFacts(sessionId);
        expect(facts.unreadSince?.getTime()).toBe(originalEdge.getTime());
        expect(facts.needsAttention).toBe(true);
    });

    it("does not stamp when the localId is already committed and seq does not move", async () => {
        const { sessionId } = await seed();
        const localId = `pending-${randomUUID()}`;
        await commitPending(sessionId, localId);
        await db.session.update({
            where: { id: sessionId },
            data: { unreadSince: null },
        });

        const replay = await commitPending(sessionId, localId);
        expect(replay).toMatchObject({ ok: true, didWrite: false });

        const facts = await readAttentionFacts(sessionId);
        expect(facts.seq).toBe(1);
        expect(facts.unreadSince).toBeNull();
        // The row is still unread, so the generated fact still says so — a replay that writes
        // nothing cannot change it, and equally cannot leave it disagreeing with `seq`.
        expect(facts.needsAttention).toBe(true);
    });
});
