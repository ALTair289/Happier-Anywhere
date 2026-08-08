import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

import { findV2SessionListRows, V2_SESSION_LIST_ORDER_BY } from "./v2SessionListPage";
import type { V2SessionListRowCompat } from "./v2SessionListRows";

/**
 * The session-list visibility predicate used to reach the database as one disjunction
 * (`accountId = ? OR EXISTS(shares…)`). A disjunction over two different access paths cannot bind
 * `accountId` as an index key, so every `[accountId, …]` index on `Session` was unusable and all
 * three engines answered the list and attention reads with a table-wide scan or a bitmap over the
 * whole table, filtering the account membership afterwards. Measured on SQLite 3.x, PostgreSQL 17
 * and MySQL 8.0 — see the lane report.
 *
 * The fix is to ask each visibility arm separately and merge in memory. These tests pin both halves
 * of that: the query *shape* that lets the index bind, and the result identity that makes merging
 * safe (the merged top-N must remain exactly the global top-N, because the attention page's
 * skew-repair reasoning depends on "did the read fill its limit").
 *
 * Splitting the disjunction fixed the *owned* arm only. The shared arm still reached the database as
 * `EXISTS (SELECT … FROM SessionShare WHERE sessionId = Session.id AND sharedWithUserId = ?)`, which
 * binds no `Session` key at all: SQLite flattens it to a correlated subquery and answers it with
 * `SCAN Session` plus `USE TEMP B-TREE FOR ORDER BY`, i.e. it reads and sorts every session on the
 * server to find the handful shared with one viewer. So these tests also pin that the shared arm is
 * driven *from the share table* — the small, selective side — and reaches `Session` as a keyed read.
 */

const OTHER_ACCOUNT_SESSION_COUNT = 6;

type CapturedQuery = Readonly<{ where: unknown; take: unknown }>;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

/** Every branch of a Prisma where-input tree, including nested `AND`/`OR`/`NOT` members. */
function collectWhereNodes(node: unknown, out: Record<string, unknown>[] = []): Record<string, unknown>[] {
    if (Array.isArray(node)) {
        for (const member of node) collectWhereNodes(member, out);
        return out;
    }
    if (!isRecord(node)) return out;
    out.push(node);
    for (const key of ["AND", "OR", "NOT"]) {
        if (key in node) collectWhereNodes(node[key], out);
    }
    return out;
}

/** True when one disjunction mixes account ownership with share membership — the defeating shape. */
function hasAccountOrShareDisjunction(where: unknown): boolean {
    return collectWhereNodes(where).some((node) => {
        const or = node.OR;
        if (!Array.isArray(or)) return false;
        const branches = or.flatMap((branch) => collectWhereNodes(branch));
        return branches.some((branch) => "accountId" in branch) && branches.some((branch) => "shares" in branch);
    });
}

function bindsViewerAccount(where: unknown, userId: string): boolean {
    return collectWhereNodes(where).some((node) => node.accountId === userId);
}

function filtersShareMembership(where: unknown): boolean {
    return collectWhereNodes(where).some((node) => "shares" in node);
}

/** True when the statement is bounded by an explicit set of session ids rather than a relation test. */
function readsSessionsByKey(where: unknown): boolean {
    return collectWhereNodes(where).some((node) => {
        const id = node.id;
        return isRecord(id) && Array.isArray(id.in);
    });
}

function effectiveActivityAt(row: V2SessionListRowCompat): number {
    return (row.meaningfulActivityAt ?? row.createdAt).getTime();
}

function sortByListOrder(rows: V2SessionListRowCompat[]): V2SessionListRowCompat[] {
    return [...rows].sort((a, b) => {
        const diff = effectiveActivityAt(b) - effectiveActivityAt(a);
        return diff !== 0 ? diff : b.id.localeCompare(a.id);
    });
}

describe("session list visibility arms (SQLite integration)", () => {
    let harness: LightSqliteHarness;
    let captured: CapturedQuery[] = [];
    let restoreFindMany: (() => void) | null = null;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-session-list-visibility-arms-sqlite-",
            initAuth: false,
            initEncrypt: false,
            initFiles: false,
        });
    }, 180_000);

    afterEach(async () => {
        restoreFindMany?.();
        restoreFindMany = null;
        captured = [];
        harness.resetEnv();
        await db.sessionShare.deleteMany();
        await db.session.deleteMany();
        await db.account.deleteMany();
    });

    afterAll(async () => {
        await harness.close();
    });

    function captureSessionQueries(): void {
        // Boundary observation, not a mock: the real query still runs and its rows are returned.
        const model = db.session as unknown as { findMany: (args: unknown) => Promise<unknown> };
        const original = model.findMany.bind(model);
        model.findMany = async (args: unknown) => {
            const record = isRecord(args) ? args : {};
            captured.push({ where: record.where, take: record.take });
            return await original(args);
        };
        restoreFindMany = () => {
            model.findMany = original;
        };
    }

    async function createAccount(): Promise<string> {
        const account = await db.account.create({ data: { publicKey: `pk-${randomUUID()}` }, select: { id: true } });
        return account.id;
    }

    async function createSession(params: Readonly<{
        accountId: string;
        id: string;
        activityAt: number | null;
        createdAt: number;
        unread?: boolean;
    }>): Promise<string> {
        const created = await db.session.create({
            data: {
                id: params.id,
                accountId: params.accountId,
                tag: `tag-${params.id}`,
                metadata: "{}",
                seq: params.unread ? 5 : 1,
                lastViewedSessionSeq: 1,
                unreadSince: params.unread ? new Date(params.createdAt) : null,
                meaningfulActivityAt: params.activityAt === null ? null : new Date(params.activityAt),
                createdAt: new Date(params.createdAt),
            },
            select: { id: true },
        });
        return created.id;
    }

    /**
     * Viewer-owned rows, rows shared with the viewer, a row that is *both* owned and shared (so the
     * arms overlap), rows with no `meaningfulActivityAt` (the createdAt-ordered branch) and rows
     * belonging to a third account that must never appear.
     */
    async function seedVisibilityFixture(): Promise<Readonly<{ viewerId: string; visibleIds: string[] }>> {
        const viewerId = await createAccount();
        const ownerId = await createAccount();
        const strangerId = await createAccount();
        const base = 1_700_000_000_000;
        const visibleIds: string[] = [];

        for (let i = 0; i < 8; i++) {
            visibleIds.push(await createSession({
                accountId: viewerId,
                id: `owned-${String(i).padStart(2, "0")}`,
                activityAt: i % 3 === 0 ? null : base + i * 1000,
                createdAt: base + i * 1000,
                unread: i % 2 === 0,
            }));
        }
        for (let i = 0; i < 5; i++) {
            const id = await createSession({
                accountId: ownerId,
                id: `shared-${String(i).padStart(2, "0")}`,
                activityAt: i % 2 === 0 ? null : base + 500 + i * 1000,
                createdAt: base + 500 + i * 1000,
                unread: true,
            });
            await db.sessionShare.create({ data: { sessionId: id, sharedByUserId: ownerId, sharedWithUserId: viewerId } });
            visibleIds.push(id);
        }
        // Overlapping row: owned by the viewer *and* shared with the viewer. It must be returned once.
        const overlapping = await createSession({
            accountId: viewerId,
            id: "owned-and-shared",
            activityAt: base + 9000,
            createdAt: base + 9000,
            unread: true,
        });
        await db.sessionShare.create({
            data: { sessionId: overlapping, sharedByUserId: viewerId, sharedWithUserId: viewerId },
        });
        visibleIds.push(overlapping);

        for (let i = 0; i < OTHER_ACCOUNT_SESSION_COUNT; i++) {
            await createSession({
                accountId: strangerId,
                id: `stranger-${String(i).padStart(2, "0")}`,
                activityAt: base + 20_000 + i * 1000,
                createdAt: base + 20_000 + i * 1000,
                unread: true,
            });
        }

        return { viewerId, visibleIds };
    }

    it("never asks the database for account ownership OR share membership in one disjunction", async () => {
        const { viewerId } = await seedVisibilityFixture();
        captureSessionQueries();

        await findV2SessionListRows({
            userId: viewerId,
            where: { archivedAt: null },
            orderBy: V2_SESSION_LIST_ORDER_BY,
            take: 5,
        });

        expect(captured.length).toBeGreaterThan(0);
        for (const query of captured) {
            expect(hasAccountOrShareDisjunction(query.where)).toBe(false);
            // Anti-vacuity: dropping the OR is only useful if each statement still scopes visibility.
            expect(bindsViewerAccount(query.where, viewerId) || readsSessionsByKey(query.where)).toBe(true);
        }
        // Both arms must actually be asked, or shared sessions would silently disappear.
        expect(captured.some((query) => bindsViewerAccount(query.where, viewerId))).toBe(true);
        expect(captured.some((query) => readsSessionsByKey(query.where))).toBe(true);
    });

    it("reaches Session by key for the shared arm instead of testing share membership per row", async () => {
        const { viewerId } = await seedVisibilityFixture();
        captureSessionQueries();

        await findV2SessionListRows({
            userId: viewerId,
            where: { archivedAt: null },
            orderBy: V2_SESSION_LIST_ORDER_BY,
            take: 5,
        });

        // A `shares` relation filter binds no `Session` key, so the engine has to read every row of
        // the table and test each one. Every statement must instead be seekable: bound either by the
        // viewer's account or by the session ids the share table already resolved.
        for (const query of captured) {
            expect(filtersShareMembership(query.where)).toBe(false);
            expect(bindsViewerAccount(query.where, viewerId) || readsSessionsByKey(query.where)).toBe(true);
        }
    });

    it("asks for no shared-session statement at all when nothing is shared with the viewer", async () => {
        const viewerId = await createAccount();
        const base = 1_700_000_000_000;
        for (let i = 0; i < 4; i++) {
            await createSession({
                accountId: viewerId,
                id: `solo-${String(i).padStart(2, "0")}`,
                activityAt: base + i * 1000,
                createdAt: base + i * 1000,
                unread: true,
            });
        }
        captureSessionQueries();

        const rows = await findV2SessionListRows({
            userId: viewerId,
            where: { archivedAt: null },
            orderBy: V2_SESSION_LIST_ORDER_BY,
            take: 5,
        });

        expect(rows.map((row) => row.id)).toEqual(["solo-03", "solo-02", "solo-01", "solo-00"]);
        // The share table already proves there is nothing to find, so the shared arm must not be
        // issued at all — an unbounded statement that can only return zero rows is pure scan.
        expect(captured.length).toBeGreaterThan(0);
        for (const query of captured) {
            expect(bindsViewerAccount(query.where, viewerId)).toBe(true);
        }
    });

    it("returns exactly the globally ordered top-N over owned and shared sessions, deduplicated", async () => {
        const { viewerId, visibleIds } = await seedVisibilityFixture();

        const all = await findV2SessionListRows({
            userId: viewerId,
            where: { archivedAt: null },
            orderBy: V2_SESSION_LIST_ORDER_BY,
        });
        const expectedOrder = sortByListOrder(all).map((row) => row.id);

        expect(new Set(expectedOrder).size).toBe(expectedOrder.length);
        expect(new Set(expectedOrder)).toEqual(new Set(visibleIds));

        for (const take of [1, 3, 7, visibleIds.length - 1, visibleIds.length, visibleIds.length + 5]) {
            const rows = await findV2SessionListRows({
                userId: viewerId,
                where: { archivedAt: null },
                orderBy: V2_SESSION_LIST_ORDER_BY,
                take,
            });
            expect(rows.map((row) => row.id)).toEqual(expectedOrder.slice(0, take));
        }
    });

    /**
     * A keyed shared arm binds one parameter per shared session, and every engine caps how many one
     * statement may carry (Prisma's SQLite budget, the tightest, is 999 — and the session-list
     * branches carry `meaningfulActivityAt: { not: null }`, a negation filter that stops Prisma
     * splitting an oversized `IN` itself, so the read fails outright rather than degrading).
     *
     * Sharing more sessions than one statement can bind is therefore a hard failure unless the ids
     * are spread over several arms. The fixture is deliberately larger than that budget, and the
     * expected page is drawn from across the whole set, so an implementation that binds them all at
     * once fails and one that splits them but forgets to merge globally returns the wrong page.
     */
    it("returns the correct page when more sessions are shared than one statement can bind", async () => {
        const viewerId = await createAccount();
        const ownerId = await createAccount();
        const base = 1_700_000_000_000;
        const sharedCount = 1_100;

        const sessionRows = [];
        const shareRows = [];
        for (let i = 0; i < sharedCount; i++) {
            const id = `bulk-${String(i).padStart(4, "0")}`;
            // Scatter activity across the set so the global top rows do not sit in one contiguous run.
            const activityAt = base + ((i * 7919) % sharedCount) * 1000;
            sessionRows.push({
                id,
                accountId: ownerId,
                tag: `tag-${id}`,
                metadata: "{}",
                seq: 5,
                lastViewedSessionSeq: 1,
                meaningfulActivityAt: new Date(activityAt),
                createdAt: new Date(activityAt),
            });
            shareRows.push({ sessionId: id, sharedByUserId: ownerId, sharedWithUserId: viewerId });
        }
        await db.session.createMany({ data: sessionRows });
        await db.sessionShare.createMany({ data: shareRows });

        const expectedOrder = [...sessionRows]
            .sort((a, b) => {
                const diff = b.meaningfulActivityAt.getTime() - a.meaningfulActivityAt.getTime();
                return diff !== 0 ? diff : b.id.localeCompare(a.id);
            })
            .map((row) => row.id);

        for (const take of [1, 10, 101]) {
            const rows = await findV2SessionListRows({
                userId: viewerId,
                where: { archivedAt: null },
                orderBy: V2_SESSION_LIST_ORDER_BY,
                take,
            });
            expect(rows.map((row) => row.id)).toEqual(expectedOrder.slice(0, take));
        }
    });

    it("keeps an under-filled read a proof of absence: fewer rows than the limit means nothing matched", async () => {
        const { viewerId, visibleIds } = await seedVisibilityFixture();

        const generous = await findV2SessionListRows({
            userId: viewerId,
            where: { archivedAt: null },
            orderBy: V2_SESSION_LIST_ORDER_BY,
            take: visibleIds.length + 25,
        });

        // The attention page's skew repair only writes when the read came back under its limit, so a
        // short result must mean the predicate is exhausted — never that a branch ran out of budget.
        expect(generous.length).toBeLessThan(visibleIds.length + 25);
        expect(generous.length).toBe(visibleIds.length);
    });
});
