import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

import { reconcileSessionPendingQueueState } from "./reconcileSessionPendingQueueState";

describe("reconcileSessionPendingQueueState", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-reconcile-pending-",
            initAuth: true,
        });
    }, 120_000);

    afterAll(async () => {
        await harness.close();
    });

    beforeEach(() => {
        harness.resetEnv();
    });

    const createAccount = async () => {
        return await db.account.create({
            data: { publicKey: `pk-${randomUUID()}` },
            select: { id: true },
        });
    };

    const createSession = async (accountId: string) => {
        return await db.session.create({
            data: {
                tag: `tag-${randomUUID()}`,
                accountId,
                metadata: "meta",
                metadataVersion: 0,
                agentState: null,
                agentStateVersion: 0,
            },
            select: { id: true, pendingCount: true, pendingBlockedCount: true, pendingVersion: true },
        });
    };

    const createQueuedPendingMessage = async (params: Readonly<{
        accountId: string;
        sessionId: string;
        position: number;
    }>) => {
        await db.sessionPendingMessage.create({
            data: {
                sessionId: params.sessionId,
                authorAccountId: params.accountId,
                localId: `pending-${randomUUID()}`,
                content: { t: "encrypted", c: "ciphertext" },
                status: "queued",
                position: params.position,
            },
        });
    };

    it("repairs stale pending count when only the caller version is stale", async () => {
        const account = await createAccount();
        const session = await createSession(account.id);
        await createQueuedPendingMessage({ accountId: account.id, sessionId: session.id, position: 1 });
        await createQueuedPendingMessage({ accountId: account.id, sessionId: session.id, position: 2 });

        const advanced = await db.session.update({
            where: { id: session.id },
            data: { pendingVersion: { increment: 1 } },
            select: { pendingCount: true, pendingBlockedCount: true, pendingVersion: true },
        });
        expect(advanced.pendingCount).toBe(session.pendingCount);
        expect(advanced.pendingBlockedCount).toBe(0);
        expect(advanced.pendingVersion).toBe(session.pendingVersion + 1);

        const result = await reconcileSessionPendingQueueState({
            sessionId: session.id,
            pendingCount: session.pendingCount,
            pendingVersion: session.pendingVersion,
        });

        expect(result).toEqual({
            pendingCount: 2,
            pendingBlockedCount: 0,
            pendingVersion: advanced.pendingVersion + 1,
            didRepair: true,
        });

        const after = await db.session.findUniqueOrThrow({
            where: { id: session.id },
            select: { pendingCount: true, pendingBlockedCount: true, pendingVersion: true },
        });
        expect(after).toEqual({
            pendingCount: result.pendingCount,
            pendingBlockedCount: result.pendingBlockedCount,
            pendingVersion: result.pendingVersion,
        });
    });

    it("repairs stale pending count from current DB state when the caller count is stale", async () => {
        const account = await createAccount();
        const session = await createSession(account.id);
        await createQueuedPendingMessage({ accountId: account.id, sessionId: session.id, position: 1 });
        await createQueuedPendingMessage({ accountId: account.id, sessionId: session.id, position: 2 });
        await createQueuedPendingMessage({ accountId: account.id, sessionId: session.id, position: 3 });

        const current = await db.session.update({
            where: { id: session.id },
            data: { pendingCount: 1, pendingVersion: 7 },
            select: { pendingCount: true, pendingBlockedCount: true, pendingVersion: true },
        });

        const result = await reconcileSessionPendingQueueState({
            sessionId: session.id,
            pendingCount: session.pendingCount,
            pendingVersion: session.pendingVersion,
        });

        expect(result).toEqual({
            pendingCount: 3,
            pendingBlockedCount: 0,
            pendingVersion: current.pendingVersion + 1,
            didRepair: true,
        });

        const after = await db.session.findUniqueOrThrow({
            where: { id: session.id },
            select: { pendingCount: true, pendingBlockedCount: true, pendingVersion: true },
        });
        expect(after).toEqual({
            pendingCount: result.pendingCount,
            pendingBlockedCount: result.pendingBlockedCount,
            pendingVersion: result.pendingVersion,
        });
    });

    it("keeps current state when queued rows match current pending count", async () => {
        const account = await createAccount();
        const session = await createSession(account.id);
        await createQueuedPendingMessage({ accountId: account.id, sessionId: session.id, position: 1 });
        await createQueuedPendingMessage({ accountId: account.id, sessionId: session.id, position: 2 });

        const current = await db.session.update({
            where: { id: session.id },
            data: { pendingCount: 2, pendingVersion: 9 },
            select: { pendingCount: true, pendingBlockedCount: true, pendingVersion: true },
        });

        const result = await reconcileSessionPendingQueueState({
            sessionId: session.id,
            pendingCount: session.pendingCount,
            pendingVersion: session.pendingVersion,
        });

        expect(result).toEqual({
            pendingCount: current.pendingCount,
            pendingBlockedCount: current.pendingBlockedCount,
            pendingVersion: current.pendingVersion,
            didRepair: false,
        });

        const after = await db.session.findUniqueOrThrow({
            where: { id: session.id },
            select: { pendingCount: true, pendingBlockedCount: true, pendingVersion: true },
        });
        expect(after).toEqual(current);
    });
});
