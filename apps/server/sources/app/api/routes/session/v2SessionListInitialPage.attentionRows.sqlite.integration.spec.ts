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

    /**
     * **The failed arm is scoped to failures the user has not already dealt with.**
     *
     * `needsAttention` is generated from `latestTurnStatus = 'failed'`, which is a permanent property
     * of the row: a session that failed once keeps the flag until it runs again. Measured on the
     * reference account (2,352 non-archived sessions): 583 attention rows, of which the failed arm
     * contributed 261 — and 257 of those were already read and not active, 254 of them qualifying
     * through the failed arm and nothing else. Forty-four percent of everything the product called
     * "needs attention" was a dead failure the user had already looked at.
     *
     * The product rule is the same one the client already applies
     * (`sessionListPlacementProjection.ts#shouldPromoteFailedSessionAttention`) and the same one
     * `../dev` ships: a failure needs the user while the session is still live, or while its output
     * is still unread. Once it is read and idle it is history, not attention. The unread arm is
     * untouched — an unread session stays in attention whatever its turn status.
     *
     * The rule cannot live in the generated column: it needs a JSON scope test on `lastRuntimeIssue`,
     * which no expression is portable across PostgreSQL, MySQL and SQLite. So the column stays the
     * cheap indexable **candidate superset** and `isDurableAttentionRow` is the confirmation — the
     * candidate + confirm shape `../dev` already runs. The first assertion below pins exactly that:
     * the database still hands these rows over, and the confirmation is what drops them.
     */
    describe("failed arm", () => {
        const FAILED_PAGE_LIMIT = 2;

        function primarySessionFailure(occurredAt: number): string {
            return JSON.stringify({
                v: 1,
                scope: "primary_session",
                status: "failed",
                code: "provider_process_exit",
                source: "provider_process_exit",
                occurredAt,
            });
        }

        /**
         * Four failed sessions, all past the page window so the attention family is the only thing
         * that can bring them into the response, plus enough read/idle rows to fill the page itself.
         */
        async function seedFailed(): Promise<string> {
            const account = await db.account.create({ data: { publicKey: `pk-${randomUUID()}` }, select: { id: true } });
            const now = Date.now();
            const base = (id: string, index: number) => ({
                id,
                accountId: account.id,
                tag: `tag-${id}`,
                metadata: "{}",
                seq: 4,
                lastViewedSessionSeq: 4,
                latestTurnStatus: null as string | null,
                lastRuntimeIssue: null as string | null,
                meaningfulActivityAt: new Date(now - index * 1_000),
                createdAt: new Date(now - index * 1_000),
                active: false,
                lastActiveAt: new Date(now - index * 1_000),
            });
            await db.session.createMany({
                data: [
                    base("page-0", 0),
                    base("page-1", 1),
                    base("page-2", 2),
                    // Read, idle, failed: the 254-row class. A candidate, and not attention.
                    { ...base("failed-read-idle", 3), latestTurnStatus: "failed", lastRuntimeIssue: primarySessionFailure(now) },
                    // Still live on a machine: the user can still act on it.
                    { ...base("failed-active", 4), active: true, latestTurnStatus: "failed", lastRuntimeIssue: primarySessionFailure(now) },
                    // Read cursor behind the session: the failure's output is still unread.
                    { ...base("failed-unread", 5), seq: 5, latestTurnStatus: "failed", lastRuntimeIssue: primarySessionFailure(now) },
                    // Failed turn with no primary-session runtime issue: never attention, either way.
                    { ...base("failed-no-issue", 6), latestTurnStatus: "failed" },
                ],
            });
            return account.id;
        }

        it("keeps a failed session in attention only while it is active or unread", async () => {
            const userId = await seedFailed();

            // The database's candidate predicate is a superset: it offers all four failed rows.
            const candidateIds = (await db.session.findMany({
                where: { accountId: userId, archivedAt: null, needsAttention: true },
                select: { id: true },
            })).map((row) => row.id).sort();
            expect(candidateIds).toEqual(["failed-active", "failed-no-issue", "failed-read-idle", "failed-unread"]);

            const body = await fetchSessionList({
                userId,
                query: `limit=${FAILED_PAGE_LIMIT}&includeAttention=true`,
            });
            const ids = body.sessions.map((session) => session.id);

            // Only the attention family can reach past the page, so membership is unambiguous.
            expect(ids).toContain("failed-active");
            expect(ids).toContain("failed-unread");
            expect(ids).not.toContain("failed-read-idle");
            expect(ids).not.toContain("failed-no-issue");
            // Anti-vacuity: the page itself still answered, and it did not reach these rows on its own.
            expect(ids).toEqual(expect.arrayContaining(["page-0", "page-1"]));
            expect(ids).not.toContain("page-2");
        });

        it("refills the attention family after rejected failure candidates consume a query batch", async () => {
            const account = await db.account.create({
                data: { publicKey: `pk-${randomUUID()}` },
                select: { id: true },
            });
            const now = Date.now();
            const base = (id: string, activityOffset: number) => ({
                id,
                accountId: account.id,
                tag: `tag-${id}`,
                metadata: "{}",
                seq: 4,
                lastViewedSessionSeq: 4,
                meaningfulActivityAt: new Date(now - activityOffset),
                createdAt: new Date(now - activityOffset),
                active: false,
                lastActiveAt: new Date(now - activityOffset),
            });
            await db.session.createMany({
                data: [
                    base("page-0", 0),
                    base("page-1", 1),
                    base("page-2", 2),
                    ...Array.from(
                        { length: DEFAULT_V2_SESSION_LIST_INITIAL_ATTENTION_ROW_LIMIT + 1 },
                        (_unused, index) => ({
                            ...base(`rejected-${String(index).padStart(3, "0")}`, 3 + index),
                            latestTurnStatus: "failed",
                            lastRuntimeIssue: primarySessionFailure(now - index),
                        }),
                    ),
                    {
                        ...base("actionable-permission", DEFAULT_V2_SESSION_LIST_INITIAL_ATTENTION_ROW_LIMIT + 4),
                        pendingPermissionRequestCount: 1,
                    },
                ],
            });

            const body = await fetchSessionList({
                userId: account.id,
                query: `limit=${FAILED_PAGE_LIMIT}&includeAttention=true`,
            });

            expect(body.sessions.map((session) => session.id)).toContain("actionable-permission");
        });
    });

    /**
     * **The zero-duplicate claim, on a fixture that can actually see it.**
     *
     * The test above measures a fixture with `active: false` on every row and no pins, so the only
     * overlap it can express is the attention family's — and that one was already fixed. It certified
     * "each row read once" while the *active* and *pinned* families were still re-reading rows the
     * page had already returned, which is the false-green class this program keeps being bitten by.
     *
     * What that blindness was hiding, measured against the reference account's own database
     * (2,876 sessions, one `limit=50&includeAttention=true&includeActive=true` request):
     *
     * | | rows | `metadata`+`agentState` bytes |
     * |---|---|---|
     * | session rows read | 549 | |
     * | distinct rows in the response | 439 | |
     * | **re-read** | **110** | **2,521,268** |
     * | └ active row already in the page | 42 | |
     * | └ pinned row already in the page | 33 | 854,732 |
     * | └ active row already read as pinned | 48 | |
     * | └ attention row already read as pinned | 18 | 452,380 |
     *
     * This fixture reproduces every one of those four overlaps at fixture scale, so it fails if any
     * of them comes back.
     */
    describe("families overlapping the page window", () => {
        /** Live rows inside the page window — the `page ∩ active` overlap, 42 rows on the account. */
        const ACTIVE_IN_PAGE = 40;
        /** Live rows the page cannot reach: activity too old, heartbeat current. */
        const ACTIVE_BEYOND_PAGE_START = 210;
        const ACTIVE_BEYOND_PAGE_COUNT = 26;
        /**
         * A live row that is also an attention row beyond the page — the `active ∩ attention` overlap,
         * 1 row on the reference account. It is the one overlap that *cannot* be removed for free:
         * the two reads are issued in parallel and neither knows the other's ids until it returns, so
         * excluding either from the other would serialise two statements to save one row. The
         * assertion below names it rather than letting a fixture that avoids it claim more than it
         * proved.
         */
        const ACTIVE_ATTENTION_BEYOND_PAGE = "s-0100";

        /**
         * Pins chosen so each is a different overlap, and each has a different correct outcome:
         *
         * - `s-0001`, `s-0003` — pinned rows inside the page window, not attention rows: the page read
         *   already returned them, so the pinned read must not ask for them again.
         * - `s-0002` — pinned *and* an attention row inside the page: two families now reuse the same
         *   page row, and reusing it twice must still be reading it once.
         * - `s-0102`, `s-0104` — pinned attention rows *beyond* the page. These are an overlap
         *   deliberately left in place, and the assertion below names them: excluding pinned ids from
         *   the attention read would free that many slots in the attention budget, so the response
         *   would grow by up to that many rows — trading ~450 KB of server-side re-read on the
         *   reference account for ~450 KB more shipped to the client. That is a worse trade, so the
         *   duplicate stays and this test pins the choice rather than hiding it.
         * - `s-0211` — a pinned row that is live but not an attention row and not in the page. The
         *   pinned read must fetch it (nothing else holds it) and the active read must not fetch it
         *   again, which it cannot know without excluding the pinned ids by id.
         */
        const PINNED_SESSION_IDS: readonly string[] = ["s-0001", "s-0002", "s-0003", "s-0102", "s-0104", "s-0211"];
        const PINNED_IN_PAGE = ["s-0001", "s-0002", "s-0003"];
        /** The overlaps that are deliberately still read twice, and nothing else. */
        const EXPECTED_DUPLICATE_READ_IDS = [ACTIVE_ATTENTION_BEYOND_PAGE, "s-0102", "s-0104"];

        function isActiveIndex(index: number): boolean {
            return index < ACTIVE_IN_PAGE
                || index === Number(ACTIVE_ATTENTION_BEYOND_PAGE.slice(2))
                || (index >= ACTIVE_BEYOND_PAGE_START && index < ACTIVE_BEYOND_PAGE_START + ACTIVE_BEYOND_PAGE_COUNT);
        }

        /**
         * The same 300-session ordering as `seed`, with the two families the other fixture cannot
         * express layered on: live sessions on both sides of the page boundary, and pins on both
         * sides of it. `lastActiveAt` runs on a much finer scale than `meaningfulActivityAt` so every
         * live row stays inside `ACTIVE_SESSION_WINDOW_MS` while still ordering strictly.
         */
        async function seedOverlappingFamilies(): Promise<string> {
            const account = await db.account.create({ data: { publicKey: `pk-${randomUUID()}` }, select: { id: true } });
            const now = Date.now();
            const rows = [];
            for (let index = 0; index < SESSION_COUNT; index++) {
                const needsAttention = index % ATTENTION_EVERY === 0;
                rows.push({
                    id: `s-${String(index).padStart(4, "0")}`,
                    accountId: account.id,
                    tag: `tag-${index}`,
                    metadata: "{}",
                    seq: needsAttention ? 1 : 0,
                    lastViewedSessionSeq: null,
                    meaningfulActivityAt: new Date(now - index * 1_000),
                    createdAt: new Date(now - index * 1_000),
                    active: isActiveIndex(index),
                    lastActiveAt: new Date(now - index),
                });
            }
            await db.session.createMany({ data: rows });
            await db.sessionPin.createMany({
                data: PINNED_SESSION_IDS.map((sessionId, order) => ({
                    id: `pin-${sessionId}`,
                    accountId: account.id,
                    sessionId,
                    sortKey: String(order).padStart(4, "0"),
                    updatedAt: new Date(now),
                })),
            });
            return account.id;
        }

        it("reads each row inside the page window once, whichever family also claims it", async () => {
            const userId = await seedOverlappingFamilies();

            const { result: body, counts } = await measureReads(async () =>
                await fetchSessionList({ userId, query: INITIAL_QUERY }));

            const readCountById = new Map<string, number>();
            for (const id of counts.rowIdReads) readCountById.set(id, (readCountById.get(id) ?? 0) + 1);
            const duplicateIds = [...readCountById].filter(([, n]) => n > 1).map(([id]) => id).sort();

            // Every overlap is gone except the ones deliberately kept, which are named, not tolerated.
            expect(duplicateIds).toEqual(EXPECTED_DUPLICATE_READ_IDS);
            expect(counts.shareReads).toBe(1);

            // Anti-vacuity — the whole point of this fixture is the overlap, so prove it is there.
            // Without it, "no duplicates" is the vacuous claim the fixture above was making.
            const responseIds = body.sessions.map((session) => session.id);
            const pageWindowIds = new Set(responseIds.filter((id) => id <= `s-${String(PAGE_LIMIT).padStart(4, "0")}`));
            const activeIdsInPage = [...pageWindowIds].filter((id) => isActiveIndex(Number(id.slice(2))));
            expect(activeIdsInPage.length).toBe(ACTIVE_IN_PAGE);
            expect(PINNED_IN_PAGE.every((id) => pageWindowIds.has(id))).toBe(true);
            // And the rows only the other families can reach are really beyond the page.
            expect(responseIds).toContain(`s-${String(ACTIVE_BEYOND_PAGE_START).padStart(4, "0")}`);
            expect(responseIds).toContain("s-0211");
            expect(new Set(responseIds).size).toBe(responseIds.length);
        });

        /**
         * The response the reduced reads produce must be the response the overlapping shape produced.
         *
         * The active family is the one at risk: it is ordered by `lastActiveAt` while the page is
         * ordered by effective activity, so its rows cannot be recovered by reading past a boundary
         * row — the halves interleave and are re-joined in memory. If that join were dropped, the live
         * rows the page already held would silently fall to their page position instead of the
         * family's, which is a wire-order change on the response first paint consumes.
         */
        it("keeps the merged order the single-read shape produced", async () => {
            const userId = await seedOverlappingFamilies();

            const body = await fetchSessionList({ userId, query: INITIAL_QUERY });
            const responseIds = body.sessions.map((session) => session.id);

            // Pinned rows first, in pin order — including the three the page read already held.
            expect(responseIds.slice(0, PINNED_SESSION_IDS.length)).toEqual([...PINNED_SESSION_IDS]);

            // Then the active family, in `lastActiveAt` descending order — which this fixture makes
            // ascending session index. Restricting to live rows that no stronger family claimed
            // isolates the block the merge actually emits from this family: the live rows that are
            // also attention rows arrive in the attention block above, and the pinned ones above that.
            const isSurvivingActiveId = (id: string): boolean => {
                const index = Number(id.slice(2));
                return isActiveIndex(index)
                    && index % ATTENTION_EVERY !== 0
                    && !PINNED_SESSION_IDS.includes(id);
            };
            const expectedActiveOrder = [
                ...Array.from({ length: ACTIVE_IN_PAGE }, (_unused, index) => index),
                Number(ACTIVE_ATTENTION_BEYOND_PAGE.slice(2)),
                ...Array.from(
                    { length: ACTIVE_BEYOND_PAGE_COUNT },
                    (_unused, offset) => ACTIVE_BEYOND_PAGE_START + offset,
                ),
            ]
                .map((index) => `s-${String(index).padStart(4, "0")}`)
                .filter(isSurvivingActiveId);

            // Anti-vacuity: the block spans both sides of the page boundary, so the in-memory join of
            // the two halves is really what produced it. Drop the join and the in-page rows fall to
            // their page position, which lands them *after* the rows beyond the page.
            expect(expectedActiveOrder[0]).toBe("s-0005");
            expect(expectedActiveOrder).toContain(`s-${String(ACTIVE_BEYOND_PAGE_START + 3).padStart(4, "0")}`);
            expect(responseIds.filter(isSurvivingActiveId)).toEqual(expectedActiveOrder);
        });
    });
});
