import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

import { publishMachinePresenceSnapshot } from "./publishMachinePresenceSnapshot";

describe("machine presence snapshot on SQLite", () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-machine-presence-snapshot-sqlite-",
            initAuth: false,
            initEncrypt: false,
            initFiles: false,
        });
    });
    beforeEach(() => harness.resetEnv());
    afterAll(async () => await harness.close());

    it("settles machine readiness on a resuming socket from persisted presence, excluding retired machines", async () => {
        const account = await db.account.create({ data: { publicKey: `pk-${randomUUID()}` }, select: { id: true } });
        const other = await db.account.create({ data: { publicKey: `pk-${randomUUID()}` }, select: { id: true } });
        const liveAt = new Date("2026-07-13T12:00:00.000Z");
        const staleAt = new Date("2026-07-13T11:00:00.000Z");
        const live = `machine-live-${randomUUID()}`;
        const offline = `machine-offline-${randomUUID()}`;
        await db.machine.create({ data: { id: live, accountId: account.id, metadata: "{}", active: true, lastActiveAt: liveAt } });
        await db.machine.create({ data: { id: offline, accountId: account.id, metadata: "{}", active: false, lastActiveAt: staleAt } });
        await db.machine.create({
            data: {
                id: `machine-revoked-${randomUUID()}`,
                accountId: account.id,
                metadata: "{}",
                active: true,
                lastActiveAt: liveAt,
                revokedAt: liveAt,
            },
        });
        await db.machine.create({
            data: {
                id: `machine-replaced-${randomUUID()}`,
                accountId: account.id,
                metadata: "{}",
                active: true,
                lastActiveAt: liveAt,
                replacedByMachineId: live,
            },
        });
        await db.machine.create({
            data: { id: `machine-other-${randomUUID()}`, accountId: other.id, metadata: "{}", active: true, lastActiveAt: liveAt },
        });

        const emit = vi.fn();
        await publishMachinePresenceSnapshot({ accountId: account.id, socket: { emit } });

        // `machine-activity` is ephemeral, so a client that reconnects after being backgrounded has
        // missed every one already emitted. The snapshot must settle both directions of readiness
        // from the presence the server already persists.
        expect(emit.mock.calls.map(([event, payload]) => [event, payload])).toEqual([
            ["ephemeral", expect.objectContaining({ id: live, active: true, activeAt: liveAt.getTime() })],
            ["ephemeral", expect.objectContaining({ id: offline, active: false, activeAt: staleAt.getTime() })],
        ]);
    });
});
