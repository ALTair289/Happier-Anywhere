import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";

import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import {
    enqueuePendingMessage as enqueuePendingMessageOwner,
    materializeNextPendingMessageForCurrentPublisher,
    resolveAcceptedPendingDelivery,
} from "./pendingMessageService";
import type { PendingRequestedActionV1 } from "@happier-dev/protocol";
import { createSessionPublisherPresence } from "@/app/presence/sessionPublisherPresence";

type EnqueuePendingTestParams = Parameters<typeof enqueuePendingMessageOwner>[0] extends infer T
    ? T extends unknown
        ? Omit<T, "requestedAction"> & { requestedAction?: PendingRequestedActionV1 }
        : never
    : never;
const enqueuePendingMessage = (params: EnqueuePendingTestParams) => enqueuePendingMessageOwner({
    ...params,
    requestedAction: params.requestedAction ?? { v: 1, kind: "enqueue" },
} as Parameters<typeof enqueuePendingMessageOwner>[0]);

type InteractiveTransactionBoundary = <T>(
    operation: (tx: Prisma.TransactionClient) => Promise<T>,
    options?: unknown,
) => Promise<T>;

function installSingleAcquisitionFailure(): Readonly<{
    attempts: () => number;
    callbackEntries: () => number;
    restore: () => void;
}> {
    // Test-only fault injection at the real database boundary; inTx and its classifier stay real.
    const mutableDb = db as unknown as { $transaction: InteractiveTransactionBoundary };
    const originalTransaction = mutableDb.$transaction;
    let attempts = 0;
    let callbackEntries = 0;
    let failNextAcquisition = true;

    mutableDb.$transaction = async <T>(operation: (tx: Prisma.TransactionClient) => Promise<T>, options?: unknown) => {
        attempts += 1;
        if (failNextAcquisition) {
            failNextAcquisition = false;
            throw new Prisma.PrismaClientKnownRequestError(
                "Transaction API error: Unable to start a transaction in the given time.",
                {
                    code: "P2028",
                    clientVersion: Prisma.prismaVersion.client,
                    meta: { error: "Unable to start a transaction in the given time." },
                },
            );
        }
        return originalTransaction(async (tx) => {
            callbackEntries += 1;
            return operation(tx);
        }, options);
    };

    return {
        attempts: () => attempts,
        callbackEntries: () => callbackEntries,
        restore: () => {
            mutableDb.$transaction = originalTransaction;
        },
    };
}

describe("pendingMessageService transaction acquisition", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-pending-tx-acquisition-",
            initAuth: true,
        });
    }, 120_000);

    afterAll(async () => {
        await harness.close();
    });

    beforeEach(() => {
        harness.resetEnv();
    });

    const createTrustedPublisherFence = async (params: { accountId: string; sessionId: string }) => {
        const machineId = `machine-${randomUUID()}`;
        await db.machine.create({ data: { id: machineId, accountId: params.accountId, metadata: "{}" } });
        await db.accessKey.create({
            data: { accountId: params.accountId, machineId, sessionId: params.sessionId, data: "encrypted" },
        });
        const presence = createSessionPublisherPresence();
        const binding = { accountId: params.accountId, machineId, sessionId: params.sessionId };
        const registered = await presence.registerPublisher({
            socket: {},
            binding,
            completeActivitySnapshot: { state: "idle", activeCount: 0 },
        });
        if (registered.status !== "registered") throw new Error(`publisher registration failed: ${registered.status}`);
        return { ...binding, committedFence: registered.committedFence };
    };

    it("recovers one acquisition P2028 locally and keeps exact settlement idempotent", async () => {
        const owner = await db.account.create({
            data: { publicKey: `pk-pending-tx-${randomUUID()}` },
            select: { id: true },
        });
        const session = await db.session.create({
            data: {
                tag: `tag-pending-tx-${randomUUID()}`,
                accountId: owner.id,
                metadata: "meta",
                metadataVersion: 0,
                agentState: null,
                agentStateVersion: 0,
            },
            select: { id: true },
        });
        const localId = `pending-tx-${randomUUID()}`;

        await expect(enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            ciphertext: "cipher-pending-tx",
        })).resolves.toMatchObject({ ok: true });
        const trustedPublisherFence = await createTrustedPublisherFence({
            accountId: owner.id,
            sessionId: session.id,
        });
        await expect(materializeNextPendingMessageForCurrentPublisher({
            actorUserId: owner.id,
            sessionId: session.id,
            trustedPublisherFence,
        })).resolves.toMatchObject({ ok: true, didMaterialize: true });

        process.env.HAPPIER_DB_PROVIDER = "sqlite";
        const transactionBoundary = installSingleAcquisitionFailure();
        try {
            await expect(resolveAcceptedPendingDelivery({
                actorUserId: owner.id,
                sessionId: session.id,
                localId,
                trustedPublisherFence,
                diagnosticCorrelationId: "req-pending-tx",
            })).resolves.toMatchObject({
                ok: true,
                didResolve: true,
                pendingCount: 0,
            });
            expect(transactionBoundary.attempts()).toBe(2);
            expect(transactionBoundary.callbackEntries()).toBe(1);

            await expect(resolveAcceptedPendingDelivery({
                actorUserId: owner.id,
                sessionId: session.id,
                localId,
                trustedPublisherFence,
                diagnosticCorrelationId: "req-pending-tx-retry",
            })).resolves.toMatchObject({
                ok: true,
                didResolve: false,
                pendingCount: 0,
            });
            expect(transactionBoundary.attempts()).toBe(3);
            expect(transactionBoundary.callbackEntries()).toBe(2);
        } finally {
            transactionBoundary.restore();
        }
        await expect(db.sessionPendingMessage.count({ where: { sessionId: session.id, localId } })).resolves.toBe(0);
        await expect(db.sessionMessage.count({ where: { sessionId: session.id, localId } })).resolves.toBe(1);
    });

});
