import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

import { applySessionTurnMutation } from "./sessionWriteService";

describe("exact session turn end ordering on SQLite", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-exact-turn-end-",
            initAuth: false,
            initEncrypt: false,
            initFiles: false,
        });
    }, 120_000);

    beforeEach(() => harness.resetEnv());
    afterAll(async () => harness.close());

    it("re-evaluates the same exact end identity after its delayed begin commits", async () => {
        const account = await db.account.create({ data: { publicKey: `pk-${randomUUID()}` } });
        const session = await db.session.create({
            data: {
                accountId: account.id,
                tag: `tag-${randomUUID()}`,
                metadata: "{}",
            },
        });
        const turnId = `turn-${randomUUID()}`;
        const exactMutation = {
            v: 1,
            sessionId: session.id,
            mutationId: `exact-end-${randomUUID()}`,
            action: "end_session",
            turnId,
            observedAt: 200,
        } as const;

        await expect(applySessionTurnMutation({
            actorUserId: account.id,
            mutation: exactMutation,
        })).resolves.toMatchObject({
            ok: true,
            didApply: false,
            reason: "missing-turn",
            receipt: { decision: "missing-turn" },
        });
        await expect(db.sessionTurnMutationReceipt.findUnique({
            where: {
                sessionId_mutationId: {
                    sessionId: session.id,
                    mutationId: exactMutation.mutationId,
                },
            },
        })).resolves.toBeNull();

        await expect(applySessionTurnMutation({
            actorUserId: account.id,
            mutation: {
                v: 1,
                sessionId: session.id,
                mutationId: `begin-${randomUUID()}`,
                action: "begin",
                turnId,
                observedAt: 100,
            },
        })).resolves.toMatchObject({ ok: true, didApply: true });

        await expect(applySessionTurnMutation({
            actorUserId: account.id,
            mutation: exactMutation,
        })).resolves.toMatchObject({
            ok: true,
            didApply: true,
            receipt: {
                v: 1,
                sessionId: session.id,
                mutationId: exactMutation.mutationId,
                action: "end_session",
                turnId,
                observedAt: exactMutation.observedAt,
                decision: "applied",
            },
        });

        await expect(db.sessionTurn.findUniqueOrThrow({
            where: { sessionId_turnId: { sessionId: session.id, turnId } },
            select: { status: true },
        })).resolves.toEqual({ status: "cancelled" });
        await expect(db.sessionTurnMutationReceipt.findUniqueOrThrow({
            where: {
                sessionId_mutationId: {
                    sessionId: session.id,
                    mutationId: exactMutation.mutationId,
                },
            },
            select: {
                action: true,
                turnId: true,
                observedAt: true,
                decision: true,
            },
        })).resolves.toEqual({
            action: "end_session",
            turnId,
            observedAt: BigInt(exactMutation.observedAt),
            decision: "applied",
        });
    });
});
