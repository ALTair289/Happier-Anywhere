import { randomUUID } from "node:crypto";

import Fastify from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from "fastify-type-provider-zod";

import { auth } from "@/app/auth/auth";
import { enableAuthentication } from "@/app/api/utils/enableAuthentication";
import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

import { createAppCloseTracker } from "../../testkit/appLifecycle";
import { sessionRoutes } from "./sessionRoutes";
import { DEFAULT_V2_SESSION_LIST_INITIAL_ATTENTION_ROW_LIMIT } from "./v2SessionListInitialPage";

const { trackApp, closeTrackedApps } = createAppCloseTracker();

const PAGE_LIMIT = 50;
const SESSION_COUNT = 300;
/** Every second session needs attention, so the family is larger than its cap and overlaps the page. */
const ATTENTION_EVERY = 2;

function createTestApp() {
    const app = Fastify({ logger: false });
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    // Test-boundary bridge: route helpers use the app-local Fastify alias with auth decorations.
    const typed = app.withTypeProvider<ZodTypeProvider>() as any;
    enableAuthentication(typed);
    sessionRoutes(typed);
    return trackApp(typed);
}

type SessionListBody = Readonly<{
    sessions: Array<{ id: string }>;
    hasNext: boolean;
    nextCursor: string | null;
}>;

type ReadCounts = Readonly<{
    /** Every session row the request deserialized, one entry per read, duplicates included. */
    rowIdReads: string[];
    /** How many statements resolved the viewer's shared-session ids for this one request. */
    shareReads: number;
    sessionReads: number;
}>;

/**
 * Count the rows a request actually reads.
 *
 * The counter wraps the Prisma delegate rather than mocking it: every statement still runs against
 * the real SQLite database and returns real rows, which is the whole point — the claim under test is
 * about *how many rows the server deserializes*, and a mock cannot answer that. It is measured in
 * rows and statements, never in wall clock, which on a loaded machine is not comparable between runs.
 */
async function measureReads<T>(run: () => Promise<T>): Promise<Readonly<{ result: T; counts: ReadCounts }>> {
    const sessionDelegate = db.session as unknown as Record<string, (args: unknown) => Promise<unknown>>;
    const shareDelegate = db.sessionShare as unknown as Record<string, (args: unknown) => Promise<unknown>>;
    const originalSessionFindMany = sessionDelegate.findMany;
    const originalShareFindMany = shareDelegate.findMany;
    const rowIdReads: string[] = [];
    let shareReads = 0;
    let sessionReads = 0;

    sessionDelegate.findMany = async function countedSessionFindMany(this: unknown, args: unknown) {
        sessionReads += 1;
        const rows = await originalSessionFindMany.call(this ?? sessionDelegate, args) as Array<{ id?: unknown }>;
        for (const row of rows) {
            if (typeof row.id === "string") rowIdReads.push(row.id);
        }
        return rows;
    };
    shareDelegate.findMany = async function countedShareFindMany(this: unknown, args: unknown) {
        shareReads += 1;
        return await originalShareFindMany.call(this ?? shareDelegate, args);
    };

    try {
        const result = await run();
        return { result, counts: { rowIdReads, shareReads, sessionReads } };
    } finally {
        sessionDelegate.findMany = originalSessionFindMany;
        shareDelegate.findMany = originalShareFindMany;
    }
}

describe("v2 session list initial page: attention rows (SQLite integration)", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-session-list-attention-rows-sqlite-",
            initAuth: true,
            initEncrypt: false,
            initFiles: false,
        });
    }, 180_000);

    afterEach(async () => {
        await closeTrackedApps();
        harness.resetEnv();
        await db.accessKey.deleteMany();
        await db.sessionShare.deleteMany();
        await db.session.deleteMany();
        await db.account.deleteMany();
    });

    afterAll(async () => await harness.close());

    /**
     * `SESSION_COUNT` sessions in a strict activity order, every `ATTENTION_EVERY`-th of them unread
     * and therefore an attention row. Unread is the arm the reference account reaches the cap
     * through (938 of ~2,900 sessions), and it is the one arm on which the database's generated
     * `needsAttention` column and the stricter in-memory `isDurableAttentionRow` rule agree, so the
     * fixture measures the cap and not the disagreement between the two predicates.
     */
    async function seed(): Promise<Readonly<{ userId: string; sessionIds: string[]; attentionSessionIds: string[] }>> {
        const account = await db.account.create({ data: { publicKey: `pk-${randomUUID()}` }, select: { id: true } });
        const now = Date.now();
        const sessionIds: string[] = [];
        const attentionSessionIds: string[] = [];
        const rows = [];
        for (let index = 0; index < SESSION_COUNT; index++) {
            const id = `s-${String(index).padStart(4, "0")}`;
            const needsAttention = index % ATTENTION_EVERY === 0;
            sessionIds.push(id);
            if (needsAttention) attentionSessionIds.push(id);
            rows.push({
                id,
                accountId: account.id,
                tag: `tag-${index}`,
                metadata: "{}",
                seq: needsAttention ? 1 : 0,
                lastViewedSessionSeq: null,
                meaningfulActivityAt: new Date(now - index * 1_000),
                createdAt: new Date(now - index * 1_000),
                active: false,
                lastActiveAt: new Date(now - index * 1_000),
            });
        }
        await db.session.createMany({ data: rows });
        return { userId: account.id, sessionIds, attentionSessionIds };
    }

    async function fetchSessionList(params: Readonly<{ userId: string; query: string }>): Promise<SessionListBody> {
        const app = createTestApp();
        const token = await auth.createToken(params.userId);
        const response = await app.inject({
            method: "GET",
            url: `/v2/sessions?${params.query}`,
            headers: { authorization: `Bearer ${token}` },
        });
        expect(response.statusCode).toBe(200);
        return response.json() as SessionListBody;
    }

    const INITIAL_QUERY = `limit=${PAGE_LIMIT}&includeAttention=true&includeActive=true`;

    /**
     * **The attention cap is a bound, not a truncation.**
     *
     * `DEFAULT_V2_SESSION_LIST_INITIAL_ATTENTION_ROW_LIMIT` binds on any account with more attention
     * rows than the cap (938 on the reference account), and nothing in the response says so: the
     * family has no cursor and no has-next of its own, and none was ever added
     * (no `attentionCursor`/`attentionNextCursor` exists on either side of the wire).
     *
     * That is safe only because of one property, which is what this pins: the attention family is
     * read with `V2_SESSION_LIST_ORDER_BY` — the *same* ordering key as the list page itself — so it
     * is a filtered subsequence of the list, and the rows the cap omits are exactly the rows the
     * cursor page reaches later. Ordinary pagination backfills every one of them.
     *
     * This is the property the active-session family does **not** have: it is ordered by
     * `lastActiveAt`, so a row it omits has no other path into the list at all, which is why
     * `V2_ACTIVE_SESSION_LIST_ROW_LIMIT` is set far above any plausible active count instead.
     * If the attention read ever stops sharing the page's ordering, this test fails and the cap
     * becomes a silent data loss of the same kind.
     */
    it("bounds the attention family, and ordinary paging still reaches every row it omitted", async () => {
        const { userId, sessionIds, attentionSessionIds } = await seed();
        expect(attentionSessionIds.length).toBeGreaterThan(DEFAULT_V2_SESSION_LIST_INITIAL_ATTENTION_ROW_LIMIT);

        const initial = await fetchSessionList({ userId, query: INITIAL_QUERY });

        // The cap binds: the initial page ships neither every attention row nor every session.
        const initialAttentionIds = initial.sessions.map((session) => session.id).filter((id) => attentionSessionIds.includes(id));
        expect(initialAttentionIds.length).toBe(DEFAULT_V2_SESSION_LIST_INITIAL_ATTENTION_ROW_LIMIT);
        expect(initial.sessions.length).toBeLessThan(sessionIds.length);
        expect(initial.hasNext).toBe(true);

        // And paging from the page's own cursor covers the remainder, attention rows included.
        const seen = new Set(initial.sessions.map((session) => session.id));
        let cursor = initial.nextCursor;
        let pages = 0;
        while (cursor && pages < 20) {
            pages += 1;
            const page: SessionListBody = await fetchSessionList({
                userId,
                query: `limit=${PAGE_LIMIT}&cursor=${encodeURIComponent(cursor)}`,
            });
            for (const session of page.sessions) seen.add(session.id);
            cursor = page.hasNext ? page.nextCursor : null;
        }

        expect([...seen].sort()).toEqual([...sessionIds].sort());
        const missedAttentionIds = attentionSessionIds.filter((id) => !seen.has(id));
        expect(missedAttentionIds).toEqual([]);
    });

    /**
     * **The merged page must not read the same row twice.**
     *
     * The response de-duplicates by session id, but the reads behind it did not: the page read takes
     * the top `limit` rows by effective activity and the attention read takes the top
     * `attentionRowsLimit` rows *of the same ordering*, so every attention row inside the page window
     * was fetched, deserialized and mapped twice on the request the client's first paint waits for.
     * Measured on this fixture before the fix: 153 rows read for a 125-row response, 26 of them
     * duplicates — and each row carries the session's e2ee metadata blob (~35.8 KB on the reference
     * account), which the server cannot project away.
     *
     * The second duplicate is the viewer's shared-session id resolution: it is per-read, so the page
     * read and the attention read each issued their own `SessionShare` statement for one request.
     */
    it("reads each session row once and resolves the viewer's shares once", async () => {
        const { userId } = await seed();

        const { result: body, counts } = await measureReads(async () =>
            await fetchSessionList({ userId, query: INITIAL_QUERY }));

        expect(counts.rowIdReads.length).toBe(new Set(counts.rowIdReads).size);
        expect(counts.shareReads).toBe(1);
        // Anti-vacuity: the counts above must describe a request that really merged the families, and
        // the response must be the one the overlapping shape produced — 100 attention rows plus the
        // 25 page rows that are not attention rows. Fewer reads, same answer.
        expect(counts.sessionReads).toBeGreaterThan(1);
        expect(body.sessions.length).toBe(DEFAULT_V2_SESSION_LIST_INITIAL_ATTENTION_ROW_LIMIT + PAGE_LIMIT / ATTENTION_EVERY);
        expect(counts.rowIdReads.length).toBeLessThan(153);
    });

    /**
     * The fix reduces reads, so it must be shown not to change the answer: the merged response is the
     * same session ids in the same order as the single-query shape produced, because the attention
     * rows the page already holds are re-used in place instead of re-read.
     */
    it("keeps the merged response identical to the unbounded-overlap shape", async () => {
        const { userId, attentionSessionIds } = await seed();

        const body = await fetchSessionList({ userId, query: INITIAL_QUERY });

        // Attention rows first, in activity order, then the page rows the merge did not already hold.
        const expectedAttention = attentionSessionIds.slice(0, DEFAULT_V2_SESSION_LIST_INITIAL_ATTENTION_ROW_LIMIT);
        expect(body.sessions.slice(0, expectedAttention.length).map((session) => session.id)).toEqual(expectedAttention);
        const remaining = body.sessions.slice(expectedAttention.length).map((session) => session.id);
        expect(remaining).toEqual(remaining.filter((id) => !attentionSessionIds.includes(id)));
        expect(remaining.every((id) => id < `s-${String(PAGE_LIMIT).padStart(4, "0")}`)).toBe(true);
    });
});
