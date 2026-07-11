import { createHash, randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { SessionRuntimeActivityMutationV2 } from "@happier-dev/protocol";

import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

import {
    acknowledgeSessionRuntimeActivityReceiptsV2,
    applySessionRuntimeActivityMutationV2,
    initializeSessionRuntimeActivityGenerationV2,
} from "./runtimeActivityStorage";

function canonical32(value: string): string {
    return createHash("sha256").update(value).digest("base64url");
}

function mutation(input: Readonly<{
    sessionId: string;
    writerGeneration?: string;
    mutationId: string;
    ownerScope: string;
    ownerSequence: number;
    operation: SessionRuntimeActivityMutationV2["operation"];
}>): SessionRuntimeActivityMutationV2 {
    return {
        v: 2,
        sessionId: input.sessionId,
        writerGeneration: input.writerGeneration ?? "generation-1",
        mutationId: input.mutationId,
        ownerScope: input.ownerScope,
        ownerSequence: input.ownerSequence,
        operation: input.operation,
    };
}

describe("runtime activity v2 storage on SQLite", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-runtime-activity-v2-sqlite-",
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

    async function createSession(): Promise<string> {
        const account = await db.account.create({
            data: { publicKey: `pk-${randomUUID()}` },
            select: { id: true },
        });
        const session = await db.session.create({
            data: { accountId: account.id, tag: `session-${randomUUID()}`, metadata: "{}" },
            select: { id: true },
        });
        return session.id;
    }

    it("persists generation owners, ordered mutations, exact receipts, and semantic revisions", async () => {
        const sessionId = await createSession();
        const initialized = await initializeSessionRuntimeActivityGenerationV2({
            sessionId,
            expectedCurrentGeneration: null,
            writerGeneration: "generation-1",
            writerCredentialHash: new Uint8Array(32).fill(7),
            expectedOwnerScopes: ["tasks", "workflow"],
        });
        expect(initialized).toMatchObject({ status: "initialized", projection: { state: "unknown", revision: 1 } });

        const start = mutation({
            sessionId,
            mutationId: "start-a",
            ownerScope: "tasks",
            ownerSequence: 1,
            operation: {
                type: "source-upsert",
                sourceKey: canonical32("source-a"),
                occurrenceId: canonical32("occurrence-a"),
                sourceKind: "provider_detached_task",
                lifecycleState: "running",
            },
        });
        const first = await applySessionRuntimeActivityMutationV2({
            mutation: start,
            requestDigest: canonical32("start-a-request"),
            observedAtMs: 10_000,
        });
        expect(first.ack).toMatchObject({ status: "applied", projection: { state: "active", activeCount: 1, revision: 2 } });

        const duplicate = await applySessionRuntimeActivityMutationV2({
            mutation: start,
            requestDigest: canonical32("start-a-request"),
            observedAtMs: 20_000,
        });
        expect(duplicate.ack).toEqual(first.ack);

        const conflict = await applySessionRuntimeActivityMutationV2({
            mutation: start,
            requestDigest: canonical32("different-request"),
            observedAtMs: 20_000,
        });
        expect(conflict.ack.status).toBe("mutation-id-conflict");

        const progress = await applySessionRuntimeActivityMutationV2({
            mutation: mutation({
                sessionId,
                mutationId: "progress-a",
                ownerScope: "tasks",
                ownerSequence: 2,
                operation: {
                    type: "source-upsert",
                    sourceKey: canonical32("source-a"),
                    occurrenceId: canonical32("occurrence-a"),
                    sourceKind: "provider_detached_task",
                    lifecycleState: "waiting",
                },
            }),
            requestDigest: canonical32("progress-a-request"),
            observedAtMs: 30_000,
        });
        expect(progress.ack.projection.revision).toBe(2);

        await expect(db.sessionRuntimeActivityOwner.findMany({
            where: { sessionId, writerGeneration: "generation-1" },
            orderBy: { ownerScope: "asc" },
            select: { ownerScope: true, state: true, ownerSequence: true },
        })).resolves.toEqual([
            { ownerScope: "tasks", state: "unknown", ownerSequence: 2n },
            { ownerScope: "workflow", state: "unknown", ownerSequence: 0n },
        ]);
        await expect(db.sessionRuntimeActivityMutationReceipt.count({ where: { sessionId } })).resolves.toBe(2);
    });

    it("fences old generations while returning their exact committed receipts first", async () => {
        const sessionId = await createSession();
        await initializeSessionRuntimeActivityGenerationV2({
            sessionId,
            expectedCurrentGeneration: null,
            writerGeneration: "generation-1",
            writerCredentialHash: new Uint8Array(32).fill(1),
            expectedOwnerScopes: ["tasks"],
        });
        const firstMutation = mutation({
            sessionId,
            mutationId: "old-idle",
            ownerScope: "tasks",
            ownerSequence: 1,
            operation: { type: "owner-reconcile", activeSources: [] },
        });
        const first = await applySessionRuntimeActivityMutationV2({
            mutation: firstMutation,
            requestDigest: canonical32("old-idle-request"),
        });
        await initializeSessionRuntimeActivityGenerationV2({
            sessionId,
            expectedCurrentGeneration: "generation-1",
            writerGeneration: "generation-2",
            writerCredentialHash: new Uint8Array(32).fill(2),
            expectedOwnerScopes: ["tasks"],
        });

        const retry = await applySessionRuntimeActivityMutationV2({
            mutation: firstMutation,
            requestDigest: canonical32("old-idle-request"),
        });
        expect(retry.ack).toEqual(first.ack);

        const uncommittedOld = await applySessionRuntimeActivityMutationV2({
            mutation: mutation({
                sessionId,
                writerGeneration: "generation-1",
                mutationId: "old-late",
                ownerScope: "tasks",
                ownerSequence: 2,
                operation: { type: "owner-unknown", reasonCode: "late-old-writer" },
            }),
            requestDigest: canonical32("old-late-request"),
        });
        expect(uncommittedOld.ack.status).toBe("stale-generation");
        await expect(db.session.findUniqueOrThrow({
            where: { id: sessionId },
            select: { runtimeActivityWriterGeneration: true, runtimeActivityState: true },
        })).resolves.toEqual({ runtimeActivityWriterGeneration: "generation-2", runtimeActivityState: "unknown" });
    });

    it("retains prior occurrence tombstones and consumes resurrection into unknown", async () => {
        const sessionId = await createSession();
        await initializeSessionRuntimeActivityGenerationV2({
            sessionId,
            expectedCurrentGeneration: null,
            writerGeneration: "generation-1",
            writerCredentialHash: new Uint8Array(32).fill(3),
            expectedOwnerScopes: ["tasks"],
        });
        const sourceKey = canonical32("reused-source");
        const firstOccurrence = canonical32("first-occurrence");
        const secondOccurrence = canonical32("second-occurrence");
        await applySessionRuntimeActivityMutationV2({
            mutation: mutation({
                sessionId, mutationId: "first", ownerScope: "tasks", ownerSequence: 1,
                operation: {
                    type: "owner-reconcile",
                    activeSources: [{
                        sourceKey, occurrenceId: firstOccurrence,
                        sourceKind: "provider_detached_task", lifecycleState: "running",
                    }],
                },
            }),
            requestDigest: canonical32("first-request"),
        });
        await applySessionRuntimeActivityMutationV2({
            mutation: mutation({
                sessionId, mutationId: "second", ownerScope: "tasks", ownerSequence: 2,
                operation: {
                    type: "owner-reconcile",
                    activeSources: [{
                        sourceKey, occurrenceId: secondOccurrence,
                        sourceKind: "provider_detached_task", lifecycleState: "running",
                    }],
                },
            }),
            requestDigest: canonical32("second-request"),
        });
        const resurrection = await applySessionRuntimeActivityMutationV2({
            mutation: mutation({
                sessionId, mutationId: "late-first", ownerScope: "tasks", ownerSequence: 3,
                operation: {
                    type: "source-upsert", sourceKey, occurrenceId: firstOccurrence,
                    sourceKind: "provider_detached_task", lifecycleState: "running",
                },
            }),
            requestDigest: canonical32("late-first-request"),
        });
        expect(resurrection.ack).toMatchObject({ status: "reconciliation-required", projection: { state: "unknown" } });
        await expect(db.sessionRuntimeActivitySource.findMany({
            where: { owner: { sessionId, writerGeneration: "generation-1", ownerScope: "tasks" }, sourceKey },
            orderBy: { lastOwnerSequence: "asc" },
            select: { occurrenceId: true, lifecycleState: true, certainty: true },
        })).resolves.toEqual([
            { occurrenceId: firstOccurrence, lifecycleState: "interrupted", certainty: "authoritative" },
            { occurrenceId: secondOccurrence, lifecycleState: "running", certainty: "last-known" },
        ]);
    });

    it("does not fabricate a provider source kind for terminal-before-start tombstones", async () => {
        const sessionId = await createSession();
        await initializeSessionRuntimeActivityGenerationV2({
            sessionId,
            expectedCurrentGeneration: null,
            writerGeneration: "generation-1",
            writerCredentialHash: new Uint8Array(32).fill(5),
            expectedOwnerScopes: ["tasks"],
        });
        const sourceKey = canonical32("terminal-only-source");
        const occurrenceId = canonical32("terminal-only-occurrence");
        await applySessionRuntimeActivityMutationV2({
            mutation: mutation({
                sessionId,
                mutationId: "terminal-before-start",
                ownerScope: "tasks",
                ownerSequence: 1,
                operation: {
                    type: "source-terminal",
                    sourceKey,
                    occurrenceId,
                    terminalState: "completed",
                    reasonCode: "provider-terminal-event",
                },
            }),
            requestDigest: canonical32("terminal-before-start-request"),
        });
        await expect(db.sessionRuntimeActivitySource.findUniqueOrThrow({
            where: { ownerId_sourceKey_occurrenceId: {
                ownerId: (await db.sessionRuntimeActivityOwner.findFirstOrThrow({
                    where: { sessionId, writerGeneration: "generation-1", ownerScope: "tasks" },
                    select: { id: true },
                })).id,
                sourceKey,
                occurrenceId,
            } },
            select: { sourceKind: true, lifecycleState: true, terminalReasonCode: true },
        })).resolves.toEqual({
            sourceKind: null,
            lifecycleState: "completed",
            terminalReasonCode: "provider-terminal-event",
        });
    });

    it("serializes concurrent exact retries without duplicate state or receipts", async () => {
        const sessionId = await createSession();
        await initializeSessionRuntimeActivityGenerationV2({
            sessionId,
            expectedCurrentGeneration: null,
            writerGeneration: "generation-1",
            writerCredentialHash: new Uint8Array(32).fill(4),
            expectedOwnerScopes: ["tasks"],
        });
        const value = mutation({
            sessionId,
            mutationId: "concurrent-start",
            ownerScope: "tasks",
            ownerSequence: 1,
            operation: {
                type: "source-upsert",
                sourceKey: canonical32("concurrent-source"),
                occurrenceId: canonical32("concurrent-occurrence"),
                sourceKind: "execution_run",
                lifecycleState: "running",
            },
        });
        const [left, right] = await Promise.all([
            applySessionRuntimeActivityMutationV2({ mutation: value, requestDigest: canonical32("concurrent-request") }),
            applySessionRuntimeActivityMutationV2({ mutation: value, requestDigest: canonical32("concurrent-request") }),
        ]);
        expect(left.ack).toEqual(right.ack);
        await expect(db.sessionRuntimeActivityMutationReceipt.count({ where: { sessionId } })).resolves.toBe(1);
        await expect(db.sessionRuntimeActivitySource.count({ where: { owner: { sessionId } } })).resolves.toBe(1);
    });

    it("compacts receipts only after explicit client acknowledgement while preserving occurrence fencing", async () => {
        const sessionId = await createSession();
        await initializeSessionRuntimeActivityGenerationV2({
            sessionId,
            expectedCurrentGeneration: null,
            writerGeneration: "generation-1",
            writerCredentialHash: new Uint8Array(32).fill(6),
            expectedOwnerScopes: ["tasks"],
        });
        const sourceKey = canonical32("compacted-source");
        const occurrenceId = canonical32("compacted-occurrence");
        await applySessionRuntimeActivityMutationV2({
            mutation: mutation({
                sessionId,
                mutationId: "compaction-start",
                ownerScope: "tasks",
                ownerSequence: 1,
                operation: {
                    type: "source-upsert",
                    sourceKey,
                    occurrenceId,
                    sourceKind: "provider_detached_task",
                    lifecycleState: "running",
                },
            }),
            requestDigest: canonical32("compaction-start-request"),
        });
        const terminalMutation = mutation({
            sessionId,
            mutationId: "compaction-terminal",
            ownerScope: "tasks",
            ownerSequence: 2,
            operation: {
                type: "source-terminal",
                sourceKey,
                occurrenceId,
                terminalState: "completed",
            },
        });
        await applySessionRuntimeActivityMutationV2({
            mutation: terminalMutation,
            requestDigest: canonical32("compaction-terminal-request"),
        });

        await expect(db.sessionRuntimeActivityMutationReceipt.count({ where: { sessionId } })).resolves.toBe(2);
        const compacted = await acknowledgeSessionRuntimeActivityReceiptsV2({
            acknowledgement: {
                v: 2,
                sessionId,
                writerGeneration: "generation-1",
                ownerScope: "tasks",
                acknowledgedThroughSequence: 2,
            },
        });
        expect(compacted.ack).toEqual({
            v: 2,
            status: "compacted",
            writerGeneration: "generation-1",
            ownerScope: "tasks",
            ownerSequence: 2,
            lowWatermark: 2,
        });
        await expect(db.sessionRuntimeActivityMutationReceipt.count({ where: { sessionId } })).resolves.toBe(0);
        await expect(db.sessionRuntimeActivitySource.findFirstOrThrow({
            where: { owner: { sessionId }, sourceKey, occurrenceId },
            select: { lifecycleState: true, lastOwnerSequence: true },
        })).resolves.toEqual({ lifecycleState: "completed", lastOwnerSequence: 2n });

        const retryAfterAcknowledgedCompaction = await applySessionRuntimeActivityMutationV2({
            mutation: terminalMutation,
            requestDigest: canonical32("compaction-terminal-request"),
        });
        expect(retryAfterAcknowledgedCompaction.ack.status).toBe("stale-sequence");
        const delayedResurrection = await applySessionRuntimeActivityMutationV2({
            mutation: mutation({
                sessionId,
                mutationId: "delayed-after-compaction",
                ownerScope: "tasks",
                ownerSequence: 2,
                operation: {
                    type: "source-upsert",
                    sourceKey,
                    occurrenceId,
                    sourceKind: "provider_detached_task",
                    lifecycleState: "running",
                },
            }),
            requestDigest: canonical32("delayed-after-compaction-request"),
        });
        expect(delayedResurrection.ack.status).toBe("stale-sequence");

        const duplicateAcknowledgement = await acknowledgeSessionRuntimeActivityReceiptsV2({
            acknowledgement: {
                v: 2,
                sessionId,
                writerGeneration: "generation-1",
                ownerScope: "tasks",
                acknowledgedThroughSequence: 2,
            },
        });
        expect(duplicateAcknowledgement.ack).toMatchObject({
            status: "already-compacted",
            ownerSequence: 2,
            lowWatermark: 2,
        });
        const ahead = await acknowledgeSessionRuntimeActivityReceiptsV2({
            acknowledgement: {
                v: 2,
                sessionId,
                writerGeneration: "generation-1",
                ownerScope: "tasks",
                acknowledgedThroughSequence: 3,
            },
        });
        expect(ahead.ack).toMatchObject({
            status: "acknowledgement-ahead",
            ownerSequence: 2,
            lowWatermark: 2,
        });
        const unexpectedOwner = await acknowledgeSessionRuntimeActivityReceiptsV2({
            acknowledgement: {
                v: 2,
                sessionId,
                writerGeneration: "generation-1",
                ownerScope: "workflow",
                acknowledgedThroughSequence: 0,
            },
        });
        expect(unexpectedOwner.ack).toMatchObject({ status: "owner-not-expected", lowWatermark: 0 });

        await initializeSessionRuntimeActivityGenerationV2({
            sessionId,
            expectedCurrentGeneration: "generation-1",
            writerGeneration: "generation-2",
            writerCredentialHash: new Uint8Array(32).fill(10),
            expectedOwnerScopes: ["tasks"],
        });
        const staleGeneration = await acknowledgeSessionRuntimeActivityReceiptsV2({
            acknowledgement: {
                v: 2,
                sessionId,
                writerGeneration: "generation-1",
                ownerScope: "tasks",
                acknowledgedThroughSequence: 2,
            },
        });
        expect(staleGeneration.ack).toMatchObject({ status: "stale-generation", lowWatermark: 0 });
    });

    it("fails closed when the acknowledged receipt interval is not durably contiguous", async () => {
        const sessionId = await createSession();
        await initializeSessionRuntimeActivityGenerationV2({
            sessionId,
            expectedCurrentGeneration: null,
            writerGeneration: "generation-1",
            writerCredentialHash: new Uint8Array(32).fill(8),
            expectedOwnerScopes: ["tasks"],
        });
        for (let ownerSequence = 1; ownerSequence <= 2; ownerSequence += 1) {
            await applySessionRuntimeActivityMutationV2({
                mutation: mutation({
                    sessionId,
                    mutationId: `receipt-${ownerSequence}`,
                    ownerScope: "tasks",
                    ownerSequence,
                    operation: { type: "owner-reconcile", activeSources: [] },
                }),
                requestDigest: canonical32(`receipt-${ownerSequence}-request`),
            });
        }
        await db.sessionRuntimeActivityMutationReceipt.deleteMany({
            where: { sessionId, ownerSequence: 1n },
        });

        const result = await acknowledgeSessionRuntimeActivityReceiptsV2({
            acknowledgement: {
                v: 2,
                sessionId,
                writerGeneration: "generation-1",
                ownerScope: "tasks",
                acknowledgedThroughSequence: 2,
            },
        });
        expect(result.ack).toMatchObject({ status: "receipt-gap", lowWatermark: 0, ownerSequence: 2 });
        await expect(db.sessionRuntimeActivityMutationReceipt.count({ where: { sessionId } })).resolves.toBe(1);
    });

    it("never regresses a compaction watermark when the next lifecycle mutation races its acknowledgement", async () => {
        const sessionId = await createSession();
        await initializeSessionRuntimeActivityGenerationV2({
            sessionId,
            expectedCurrentGeneration: null,
            writerGeneration: "generation-1",
            writerCredentialHash: new Uint8Array(32).fill(9),
            expectedOwnerScopes: ["tasks"],
        });
        await applySessionRuntimeActivityMutationV2({
            mutation: mutation({
                sessionId,
                mutationId: "race-sequence-1",
                ownerScope: "tasks",
                ownerSequence: 1,
                operation: { type: "owner-reconcile", activeSources: [] },
            }),
            requestDigest: canonical32("race-sequence-1-request"),
        });

        const [mutationResult, compactionResult] = await Promise.all([
            applySessionRuntimeActivityMutationV2({
                mutation: mutation({
                    sessionId,
                    mutationId: "race-sequence-2",
                    ownerScope: "tasks",
                    ownerSequence: 2,
                    operation: { type: "owner-unknown", reasonCode: "reconcile-required" },
                }),
                requestDigest: canonical32("race-sequence-2-request"),
            }),
            acknowledgeSessionRuntimeActivityReceiptsV2({
                acknowledgement: {
                    v: 2,
                    sessionId,
                    writerGeneration: "generation-1",
                    ownerScope: "tasks",
                    acknowledgedThroughSequence: 1,
                },
            }),
        ]);
        expect(mutationResult.ack.status).toBe("applied");
        expect(compactionResult.ack.status).toMatch(/compacted/);
        await expect(db.sessionRuntimeActivityOwner.findFirstOrThrow({
            where: { sessionId, writerGeneration: "generation-1", ownerScope: "tasks" },
            select: { ownerSequence: true, lowWatermark: true },
        })).resolves.toEqual({ ownerSequence: 2n, lowWatermark: 1n });
    });
});
