import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

import { writeAuthorizedSessionRuntimeActivityProjection } from "./writeAuthorizedProjection";

describe("authorized Runtime Activity projection on SQLite", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-authorized-runtime-activity-sqlite-",
            initAuth: false,
            initEncrypt: false,
            initFiles: false,
        });
    });
    beforeEach(() => {
        harness.resetEnv();
        vi.restoreAllMocks();
    });
    afterAll(async () => await harness.close());

    async function seed() {
        const owner = await db.account.create({ data: { publicKey: `pk-${randomUUID()}` }, select: { id: true } });
        const participant = await db.account.create({ data: { publicKey: `pk-${randomUUID()}` }, select: { id: true } });
        const machineId = `machine-${randomUUID()}`;
        await db.machine.create({ data: { id: machineId, accountId: owner.id, metadata: "{}" } });
        const fence = new Date("2026-07-13T12:00:00.000Z");
        const session = await db.session.create({
            data: {
                accountId: owner.id,
                tag: `session-${randomUUID()}`,
                metadata: "{}",
                active: true,
                lastActiveAt: fence,
                runtimeActivityState: "unknown",
                runtimeActivityActiveCount: 0,
                runtimeActivityRevision: 0n,
            },
            select: { id: true },
        });
        await db.accessKey.create({ data: { accountId: owner.id, machineId, sessionId: session.id, data: "encrypted" } });
        await db.sessionShare.create({
            data: { sessionId: session.id, sharedByUserId: owner.id, sharedWithUserId: participant.id, accessLevel: "view" },
        });
        return { ownerId: owner.id, participantId: participant.id, machineId, sessionId: session.id, fence };
    }

    it("applies only for the current authorized active fence and returns every participant cursor", async () => {
        const seeded = await seed();
        vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
        const applied = await writeAuthorizedSessionRuntimeActivityProjection({
            accountId: seeded.ownerId,
            machineId: seeded.machineId,
            sessionId: seeded.sessionId,
            boundCommittedFence: seeded.fence,
            completeSnapshot: { state: "active", activeCount: 1 },
        });
        expect(applied.status).toBe("applied");
        if (applied.status !== "applied") throw new Error("expected applied");
        expect(applied.participantCursors.map(({ accountId }) => accountId).sort()).toEqual([
            seeded.ownerId,
            seeded.participantId,
        ].sort());

        const duplicate = await writeAuthorizedSessionRuntimeActivityProjection({
            accountId: seeded.ownerId,
            machineId: seeded.machineId,
            sessionId: seeded.sessionId,
            boundCommittedFence: seeded.fence,
            completeSnapshot: { state: "active", activeCount: 1 },
        });
        expect(duplicate).toMatchObject({ status: "unchanged", participantCursors: [] });
    });

    it("fails closed for malformed, stale-fence, revoked, and archived writes", async () => {
        const seeded = await seed();
        const base = {
            accountId: seeded.ownerId,
            machineId: seeded.machineId,
            sessionId: seeded.sessionId,
            completeSnapshot: { state: "idle", activeCount: 0 },
        };
        await expect(writeAuthorizedSessionRuntimeActivityProjection({
            ...base,
            boundCommittedFence: new Date(seeded.fence.getTime() - 1),
        })).resolves.toEqual({ status: "rejected", reason: "superseded" });
        await db.machine.update({ where: { id: seeded.machineId }, data: { revokedAt: new Date() } });
        await expect(writeAuthorizedSessionRuntimeActivityProjection({ ...base, boundCommittedFence: seeded.fence }))
            .resolves.toEqual({ status: "rejected", reason: "unauthorized" });
        await db.machine.update({ where: { id: seeded.machineId }, data: { revokedAt: null } });
        await db.session.update({ where: { id: seeded.sessionId }, data: { archivedAt: new Date() } });
        await expect(writeAuthorizedSessionRuntimeActivityProjection({ ...base, boundCommittedFence: seeded.fence }))
            .resolves.toEqual({ status: "rejected", reason: "archived" });
        await expect(writeAuthorizedSessionRuntimeActivityProjection({
            ...base,
            boundCommittedFence: seeded.fence,
            completeSnapshot: { state: "idle", activeCount: 0, revision: 1 },
        })).rejects.toThrow();
    });
});
