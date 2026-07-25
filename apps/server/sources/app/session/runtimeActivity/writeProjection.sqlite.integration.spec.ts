import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

import { writeSessionRuntimeActivityProjectionInTx } from "./writeProjection";

const projectionSelect = {
    runtimeActivityState: true,
    runtimeActivityActiveCount: true,
    runtimeActivityObservedAt: true,
    runtimeActivityRevision: true,
} as const;

interface SessionProjectionOverrides {
    archivedAt?: Date;
    runtimeActivityState?: string;
    runtimeActivityActiveCount?: number;
    runtimeActivityObservedAt?: bigint | null;
    runtimeActivityRevision?: bigint;
}

describe("session Runtime Activity projection writer on SQLite", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-runtime-activity-projection-sqlite-",
            initAuth: false,
            initEncrypt: false,
            initFiles: false,
        });
    });

    beforeEach(() => {
        harness.resetEnv();
        vi.restoreAllMocks();
    });

    afterAll(async () => {
        await harness.close();
    });

    async function createSession(overrides: SessionProjectionOverrides = {}) {
        const account = await db.account.create({
            data: { publicKey: `pk-${randomUUID()}` },
            select: { id: true },
        });
        return await db.session.create({
            data: {
                accountId: account.id,
                tag: `session-${randomUUID()}`,
                metadata: "{}",
                ...overrides,
            },
            select: { id: true },
        });
    }

    it("applies semantic changes atomically with one revision and server-observed time", async () => {
        const session = await createSession({
            runtimeActivityState: "unknown",
            runtimeActivityActiveCount: 0,
            runtimeActivityObservedAt: null,
            runtimeActivityRevision: 4n,
        });
        const clock = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_123);

        await expect(inTx(async (tx) => await writeSessionRuntimeActivityProjectionInTx({
            tx,
            sessionId: session.id,
            completeSnapshot: {
                state: "active",
                activeCount: 2,
            },
        }))).resolves.toEqual({
            status: "applied",
            projection: {
                state: "active",
                activeCount: 2,
                observedAt: 1_700_000_000_123,
                revision: 5,
            },
        });

        await expect(db.session.findUniqueOrThrow({
            where: { id: session.id },
            select: projectionSelect,
        })).resolves.toEqual({
            runtimeActivityState: "active",
            runtimeActivityActiveCount: 2,
            runtimeActivityObservedAt: 1_700_000_000_123n,
            runtimeActivityRevision: 5n,
        });

        clock.mockReturnValue(1_700_000_000_456);
        await expect(inTx(async (tx) => await writeSessionRuntimeActivityProjectionInTx({
            tx,
            sessionId: session.id,
            completeSnapshot: {
                state: "active",
                activeCount: 1,
            },
        }))).resolves.toEqual({
            status: "applied",
            projection: {
                state: "active",
                activeCount: 1,
                observedAt: 1_700_000_000_456,
                revision: 6,
            },
        });
    });

    it("returns an exact unchanged projection without touching any stored byte", async () => {
        const session = await createSession({
            runtimeActivityState: "idle",
            runtimeActivityActiveCount: 0,
            runtimeActivityObservedAt: 555n,
            runtimeActivityRevision: 8n,
        });
        const before = await db.session.findUniqueOrThrow({
            where: { id: session.id },
            select: projectionSelect,
        });

        await expect(inTx(async (tx) => await writeSessionRuntimeActivityProjectionInTx({
            tx,
            sessionId: session.id,
            completeSnapshot: { state: "idle", activeCount: 0 },
        }))).resolves.toEqual({
            status: "unchanged",
            projection: {
                state: "idle",
                activeCount: 0,
                observedAt: 555,
                revision: 8,
            },
        });
        expect(await db.session.findUniqueOrThrow({
            where: { id: session.id },
            select: projectionSelect,
        })).toEqual(before);
    });

    it("rejects malformed final storage before duplicate comparison and does not rewrite it", async () => {
        const session = await createSession({
            runtimeActivityState: "active",
            runtimeActivityActiveCount: 0,
            runtimeActivityObservedAt: 555n,
            runtimeActivityRevision: 8n,
        });
        const before = await db.session.findUniqueOrThrow({
            where: { id: session.id },
            select: projectionSelect,
        });

        await expect(inTx(async (tx) => await writeSessionRuntimeActivityProjectionInTx({
            tx,
            sessionId: session.id,
            completeSnapshot: { state: "unknown", activeCount: 0 },
        }))).rejects.toThrow("Invalid stored Session Runtime Activity projection");
        expect(await db.session.findUniqueOrThrow({
            where: { id: session.id },
            select: projectionSelect,
        })).toEqual(before);
    });

    it("rejects an invalid negative final revision rather than treating it as baseline", async () => {
        const session = await createSession({
            runtimeActivityState: "broken",
            runtimeActivityActiveCount: 0,
            runtimeActivityObservedAt: null,
            runtimeActivityRevision: -2n,
        });
        vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_789);

        const malformedBefore = await db.session.findUniqueOrThrow({
            where: { id: session.id },
            select: projectionSelect,
        });
        await expect(inTx(async (tx) => await writeSessionRuntimeActivityProjectionInTx({
            tx,
            sessionId: session.id,
            completeSnapshot: { state: "unknown", activeCount: 0 },
        }))).rejects.toThrow("Invalid stored Session Runtime Activity projection");
        expect(await db.session.findUniqueOrThrow({
            where: { id: session.id },
            select: projectionSelect,
        })).toEqual(malformedBefore);

        await expect(inTx(async (tx) => await writeSessionRuntimeActivityProjectionInTx({
            tx,
            sessionId: session.id,
            completeSnapshot: { state: "idle", activeCount: 0 },
        }))).rejects.toThrow("Invalid stored Session Runtime Activity projection");
        expect(await db.session.findUniqueOrThrow({
            where: { id: session.id },
            select: projectionSelect,
        })).toEqual(malformedBefore);
    });

    it("rejects malformed new snapshots before reading or writing the row", async () => {
        const session = await createSession({
            runtimeActivityState: "idle",
            runtimeActivityActiveCount: 0,
            runtimeActivityObservedAt: 555n,
            runtimeActivityRevision: 8n,
        });
        const before = await db.session.findUniqueOrThrow({
            where: { id: session.id },
            select: projectionSelect,
        });

        await expect(inTx(async (tx) => await writeSessionRuntimeActivityProjectionInTx({
            tx,
            sessionId: session.id,
            completeSnapshot: {
                state: "idle",
                activeCount: 0,
                observedAt: 123,
            },
        }))).rejects.toThrow();
        expect(await db.session.findUniqueOrThrow({
            where: { id: session.id },
            select: projectionSelect,
        })).toEqual(before);
    });

    it("fails closed for missing, archived, and overflowing sessions", async () => {
        await expect(inTx(async (tx) => await writeSessionRuntimeActivityProjectionInTx({
            tx,
            sessionId: "missing-session",
            completeSnapshot: { state: "idle", activeCount: 0 },
        }))).resolves.toEqual({ status: "rejected", reason: "not_found" });

        const archived = await createSession({ archivedAt: new Date() });
        await expect(inTx(async (tx) => await writeSessionRuntimeActivityProjectionInTx({
            tx,
            sessionId: archived.id,
            completeSnapshot: { state: "idle", activeCount: 0 },
        }))).resolves.toEqual({ status: "rejected", reason: "archived" });

        const overflowing = await createSession({
            runtimeActivityState: "idle",
            runtimeActivityActiveCount: 0,
            runtimeActivityObservedAt: 123n,
            runtimeActivityRevision: BigInt(Number.MAX_SAFE_INTEGER),
        });
        const before = await db.session.findUniqueOrThrow({
            where: { id: overflowing.id },
            select: projectionSelect,
        });
        await expect(inTx(async (tx) => await writeSessionRuntimeActivityProjectionInTx({
            tx,
            sessionId: overflowing.id,
            completeSnapshot: { state: "idle", activeCount: 0 },
        }))).resolves.toEqual({
            status: "unchanged",
            projection: {
                state: "idle",
                activeCount: 0,
                observedAt: 123,
                revision: Number.MAX_SAFE_INTEGER,
            },
        });
        await expect(inTx(async (tx) => await writeSessionRuntimeActivityProjectionInTx({
            tx,
            sessionId: overflowing.id,
            completeSnapshot: { state: "active", activeCount: 1 },
        }))).resolves.toEqual({ status: "rejected", reason: "revision_overflow" });
        expect(await db.session.findUniqueOrThrow({
            where: { id: overflowing.id },
            select: projectionSelect,
        })).toEqual(before);
    });

    it("participates in the caller transaction instead of committing independently", async () => {
        const session = await createSession({
            runtimeActivityState: "unknown",
            runtimeActivityActiveCount: 0,
            runtimeActivityObservedAt: null,
            runtimeActivityRevision: 2n,
        });
        const before = await db.session.findUniqueOrThrow({
            where: { id: session.id },
            select: projectionSelect,
        });

        await expect(inTx(async (tx) => {
            const result = await writeSessionRuntimeActivityProjectionInTx({
                tx,
                sessionId: session.id,
                completeSnapshot: { state: "idle", activeCount: 0 },
            });
            expect(result.status).toBe("applied");
            throw new Error("rollback caller transaction");
        })).rejects.toThrow("rollback caller transaction");

        expect(await db.session.findUniqueOrThrow({
            where: { id: session.id },
            select: projectionSelect,
        })).toEqual(before);
    });
});
