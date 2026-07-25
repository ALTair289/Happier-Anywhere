import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

import {
    hasCurrentSessionScopedMachineAccess,
    hasCurrentSessionScopedMachineAccessInTx,
} from "./sessionScopedBinding";

describe("session-scoped machine access on SQLite", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-session-scoped-machine-access-sqlite-",
            initAuth: false,
            initEncrypt: false,
            initFiles: false,
        });
    });

    beforeEach(() => {
        harness.resetEnv();
    });

    afterAll(async () => {
        await harness.close();
    });

    async function seedAccess() {
        const account = await db.account.create({
            data: { publicKey: `pk-${randomUUID()}` },
            select: { id: true },
        });
        const machineId = `machine-${randomUUID()}`;
        await db.machine.create({
            data: { id: machineId, accountId: account.id, metadata: "{}" },
        });
        const session = await db.session.create({
            data: { accountId: account.id, tag: `session-${randomUUID()}`, metadata: "{}" },
            select: { id: true },
        });
        await db.accessKey.create({
            data: {
                accountId: account.id,
                machineId,
                sessionId: session.id,
                data: "encrypted-access",
            },
        });
        return { accountId: account.id, machineId, sessionId: session.id };
    }

    it("shares the exact AccessKey, session-owner, and current-machine predicate with caller transactions", async () => {
        const access = await seedAccess();

        await expect(inTx(async (tx) => await hasCurrentSessionScopedMachineAccessInTx({
            tx,
            ...access,
        }))).resolves.toBe(true);
        await expect(hasCurrentSessionScopedMachineAccess(access)).resolves.toBe(true);

        await db.machine.update({
            where: { id: access.machineId },
            data: { revokedAt: new Date() },
        });
        await expect(inTx(async (tx) => await hasCurrentSessionScopedMachineAccessInTx({
            tx,
            ...access,
        }))).resolves.toBe(false);
        await expect(hasCurrentSessionScopedMachineAccess(access)).resolves.toBe(false);
    });
});
