import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createSessionPublisherPresence } from '@/app/presence/sessionPublisherPresence';
import { expireSessionPublisherCandidates } from '@/app/presence/sessionPublisherPresenceTimeout';
import { applySessionTurnMutation } from '@/app/session/sessionWriteService';
import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';

import { registerSessionRuntimeActivitySnapshotSocketEvent } from './socketEvents';

type Handler = (value: unknown, acknowledge?: (value: unknown) => void) => void | Promise<void>;

describe('Runtime Activity snapshot socket event on SQLite', () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: 'happier-runtime-activity-snapshot-socket-',
            initAuth: false,
            initEncrypt: false,
            initFiles: false,
        });
    });
    beforeEach(() => harness.resetEnv());
    afterAll(async () => await harness.close());

    async function seed() {
        const owner = await db.account.create({ data: { publicKey: `pk-${randomUUID()}` }, select: { id: true } });
        const participant = await db.account.create({ data: { publicKey: `pk-${randomUUID()}` }, select: { id: true } });
        const machineId = `machine-${randomUUID()}`;
        await db.machine.create({ data: { id: machineId, accountId: owner.id, metadata: '{}' } });
        const session = await db.session.create({
            data: {
                accountId: owner.id,
                tag: `session-${randomUUID()}`,
                metadata: '{}',
                active: false,
                lastActiveAt: new Date('2026-07-13T12:00:00.000Z'),
                runtimeActivityState: 'unknown',
                runtimeActivityActiveCount: 0,
                runtimeActivityRevision: 0n,
            },
            select: { id: true },
        });
        await db.accessKey.create({ data: { accountId: owner.id, machineId, sessionId: session.id, data: 'encrypted' } });
        await db.sessionShare.create({
            data: { sessionId: session.id, sharedByUserId: owner.id, sharedWithUserId: participant.id, accessLevel: 'view' },
        });
        return { ownerId: owner.id, participantId: participant.id, machineId, sessionId: session.id };
    }

    it('writes through the exact registered socket and emits every participant cursor once', async () => {
        const seeded = await seed();
        const handlers = new Map<string, Handler>();
        const socket = {
            on: vi.fn((event: string, handler: Handler) => { handlers.set(event, handler); }),
        };
        const presence = createSessionPublisherPresence();
        const publishedAccountIds: string[] = [];
        const publishedValues: unknown[] = [];
        const publish = async (published: Parameters<Parameters<typeof registerSessionRuntimeActivitySnapshotSocketEvent>[0]['publish']>[0]) => {
            publishedAccountIds.push(published.participantCursor.accountId);
            publishedValues.push(published);
        };
        registerSessionRuntimeActivitySnapshotSocketEvent({
            socket,
            presence,
            binding: { accountId: seeded.ownerId, machineId: seeded.machineId, sessionId: seeded.sessionId },
            publish,
        });

        const acknowledge = vi.fn();
        const request = {
            sessionId: seeded.sessionId,
            mutationId: `runtime-activity-snapshot:${seeded.sessionId}`,
            snapshot: { state: 'active', activeCount: 1 },
        } as const;
        await handlers.get('session-runtime-activity-snapshot')?.(request, acknowledge);

        expect(acknowledge).toHaveBeenCalledWith(expect.objectContaining({
            status: 'applied',
            sessionId: seeded.sessionId,
            mutationId: `runtime-activity-snapshot:${seeded.sessionId}`,
            projection: expect.objectContaining({ state: 'active', revision: 1 }),
        }));
        expect(publishedAccountIds.sort()).toEqual([
            seeded.ownerId,
            seeded.participantId,
        ].sort());
        expect(publishedValues).toEqual(expect.arrayContaining([
            expect.objectContaining({ active: true, activeAt: expect.any(Number) }),
        ]));

        const retryAcknowledge = vi.fn();
        await handlers.get('session-runtime-activity-snapshot')?.(request, retryAcknowledge);
        expect(retryAcknowledge).toHaveBeenCalledWith(expect.objectContaining({
            status: 'unchanged',
            sessionId: seeded.sessionId,
            mutationId: request.mutationId,
            projection: expect.objectContaining({ revision: 1 }),
        }));
        expect(publishedAccountIds).toHaveLength(2);

        const closeAcknowledge = vi.fn();
        await handlers.get('session-runtime-activity-close')?.({ sessionId: seeded.sessionId }, closeAcknowledge);
        expect(closeAcknowledge).toHaveBeenCalledWith({ status: 'closed', sessionId: seeded.sessionId });
        expect(publishedValues).toEqual(expect.arrayContaining([
            expect.objectContaining({
                active: false,
                activeAt: expect.any(Number),
                projection: expect.objectContaining({ state: 'unknown', activeCount: 0, revision: 2 }),
            }),
        ]));
        const publishedCountAfterClose = publishedValues.length;

        const duplicateCloseAcknowledge = vi.fn();
        await handlers.get('session-runtime-activity-close')?.(
            { sessionId: seeded.sessionId },
            duplicateCloseAcknowledge,
        );
        expect(duplicateCloseAcknowledge).toHaveBeenCalledWith({ status: 'closed', sessionId: seeded.sessionId });
        expect(publishedValues).toHaveLength(publishedCountAfterClose);

        await expect(db.session.findUniqueOrThrow({
            where: { id: seeded.sessionId },
            select: { active: true },
        })).resolves.toEqual({ active: false });
    });

    it('terminalizes the inherited latest open turn when the exact publisher close succeeds', async () => {
        const seeded = await seed();
        const turnId = `turn-${randomUUID()}`;
        const begunAt = Date.now() - 1_000;
        await expect(applySessionTurnMutation({
            actorUserId: seeded.ownerId,
            mutation: {
                v: 1,
                sessionId: seeded.sessionId,
                mutationId: `begin-${randomUUID()}`,
                action: 'begin',
                turnId,
                observedAt: begunAt,
            },
        })).resolves.toMatchObject({ ok: true, didApply: true });

        const handlers = new Map<string, Handler>();
        const socket = {
            on: vi.fn((event: string, handler: Handler) => { handlers.set(event, handler); }),
        };
        const publishedValues: unknown[] = [];
        registerSessionRuntimeActivitySnapshotSocketEvent({
            socket,
            presence: createSessionPublisherPresence(),
            binding: { accountId: seeded.ownerId, machineId: seeded.machineId, sessionId: seeded.sessionId },
            publish: async (published) => { publishedValues.push(published); },
        });
        await handlers.get('session-runtime-activity-snapshot')?.({
            sessionId: seeded.sessionId,
            mutationId: `runtime-activity-snapshot:${seeded.sessionId}`,
            snapshot: { state: 'active', activeCount: 1 },
        }, vi.fn());

        const closeAcknowledge = vi.fn();
        await handlers.get('session-runtime-activity-close')?.(
            { sessionId: seeded.sessionId },
            closeAcknowledge,
        );

        expect(closeAcknowledge).toHaveBeenCalledWith({
            status: 'closed',
            sessionId: seeded.sessionId,
        });
        await expect(db.sessionTurn.findUniqueOrThrow({
            where: { sessionId_turnId: { sessionId: seeded.sessionId, turnId } },
            select: { status: true },
        })).resolves.toEqual({ status: 'cancelled' });
        await expect(db.session.findUniqueOrThrow({
            where: { id: seeded.sessionId },
            select: {
                latestTurnId: true,
                latestTurnStatus: true,
                thinking: true,
            },
        })).resolves.toEqual({
            latestTurnId: turnId,
            latestTurnStatus: 'cancelled',
            thinking: false,
        });
        expect(publishedValues).toEqual(expect.arrayContaining([
            expect.objectContaining({
                latestTurnId: turnId,
                latestTurnStatus: 'cancelled',
                latestTurnStatusObservedAt: expect.any(Number),
            }),
        ]));
    });

    it('does not let a superseded publisher close terminalize the replacement publisher latest turn', async () => {
        const seeded = await seed();
        const turnId = `turn-${randomUUID()}`;
        await expect(applySessionTurnMutation({
            actorUserId: seeded.ownerId,
            mutation: {
                v: 1,
                sessionId: seeded.sessionId,
                mutationId: `begin-${randomUUID()}`,
                action: 'begin',
                turnId,
                observedAt: Date.now() - 1_000,
            },
        })).resolves.toMatchObject({ ok: true, didApply: true });

        const presence = createSessionPublisherPresence();
        const predecessorHandlers = new Map<string, Handler>();
        const successorHandlers = new Map<string, Handler>();
        const predecessor = {
            on: vi.fn((event: string, handler: Handler) => { predecessorHandlers.set(event, handler); }),
        };
        const successor = {
            on: vi.fn((event: string, handler: Handler) => { successorHandlers.set(event, handler); }),
        };
        const binding = { accountId: seeded.ownerId, machineId: seeded.machineId, sessionId: seeded.sessionId };
        registerSessionRuntimeActivitySnapshotSocketEvent({
            socket: predecessor,
            presence,
            binding,
            publish: vi.fn(async () => {}),
        });
        registerSessionRuntimeActivitySnapshotSocketEvent({
            socket: successor,
            presence,
            binding,
            publish: vi.fn(async () => {}),
        });
        const snapshot = {
            sessionId: seeded.sessionId,
            mutationId: `runtime-activity-snapshot:${seeded.sessionId}`,
            snapshot: { state: 'active', activeCount: 1 },
        } as const;
        await predecessorHandlers.get('session-runtime-activity-snapshot')?.(snapshot, vi.fn());
        await successorHandlers.get('session-runtime-activity-snapshot')?.(snapshot, vi.fn());

        const predecessorCloseAcknowledge = vi.fn();
        await predecessorHandlers.get('session-runtime-activity-close')?.(
            { sessionId: seeded.sessionId },
            predecessorCloseAcknowledge,
        );
        expect(predecessorCloseAcknowledge).toHaveBeenCalledWith({
            status: 'rejected',
            sessionId: seeded.sessionId,
            reason: 'superseded',
        });
        await expect(db.session.findUniqueOrThrow({
            where: { id: seeded.sessionId },
            select: { latestTurnStatus: true, thinking: true },
        })).resolves.toEqual({ latestTurnStatus: 'in_progress', thinking: true });

        const successorCloseAcknowledge = vi.fn();
        await successorHandlers.get('session-runtime-activity-close')?.(
            { sessionId: seeded.sessionId },
            successorCloseAcknowledge,
        );
        expect(successorCloseAcknowledge).toHaveBeenCalledWith({
            status: 'closed',
            sessionId: seeded.sessionId,
        });
        await expect(db.sessionTurn.findUniqueOrThrow({
            where: { sessionId_turnId: { sessionId: seeded.sessionId, turnId } },
            select: { status: true },
        })).resolves.toEqual({ status: 'cancelled' });
    });

    it('coalesces concurrent first-snapshot fanout with the registered publisher transition', async () => {
        const seeded = await seed();
        const handlers = new Map<string, Handler>();
        const socket = {
            on: vi.fn((event: string, handler: Handler) => { handlers.set(event, handler); }),
        };
        const publishedAccountIds: string[] = [];
        registerSessionRuntimeActivitySnapshotSocketEvent({
            socket,
            presence: createSessionPublisherPresence(),
            binding: { accountId: seeded.ownerId, machineId: seeded.machineId, sessionId: seeded.sessionId },
            publish: async ({ participantCursor }) => {
                publishedAccountIds.push(participantCursor.accountId);
            },
        });

        const request = {
            sessionId: seeded.sessionId,
            mutationId: `runtime-activity-snapshot:${seeded.sessionId}`,
            snapshot: { state: 'active', activeCount: 1 },
        } as const;
        const firstAcknowledge = vi.fn();
        const duplicateAcknowledge = vi.fn();
        await Promise.all([
            handlers.get('session-runtime-activity-snapshot')?.(request, firstAcknowledge),
            handlers.get('session-runtime-activity-snapshot')?.(request, duplicateAcknowledge),
        ]);

        expect(firstAcknowledge).toHaveBeenCalledWith(expect.objectContaining({ status: 'applied' }));
        expect(duplicateAcknowledge).toHaveBeenCalledWith(expect.objectContaining({ status: 'applied' }));
        expect(publishedAccountIds.sort()).toEqual([
            seeded.ownerId,
            seeded.participantId,
        ].sort());
    });

    it.each([
        { state: 'active', activeCount: 1 },
        { state: 'idle', activeCount: 0 },
    ] as const)('ACKs a concurrent legacy unknown registration followed by $state snapshot with that requested projection', async (snapshot) => {
        const seeded = await seed();
        const handlers = new Map<string, Handler>();
        const socket = { on: vi.fn((event: string, handler: Handler) => { handlers.set(event, handler); }) };
        const presence = createSessionPublisherPresence();
        registerSessionRuntimeActivitySnapshotSocketEvent({
            socket,
            presence,
            binding: { accountId: seeded.ownerId, machineId: seeded.machineId, sessionId: seeded.sessionId },
            publish: vi.fn(async () => {}),
        });
        const acknowledge = vi.fn();

        const legacyUnknownRegistration = presence.registerPublisher({
            socket,
            binding: { accountId: seeded.ownerId, machineId: seeded.machineId, sessionId: seeded.sessionId },
            completeActivitySnapshot: { state: 'unknown', activeCount: 0 },
        });
        await Promise.all([
            legacyUnknownRegistration,
            handlers.get('session-runtime-activity-snapshot')?.({
                sessionId: seeded.sessionId,
                mutationId: `runtime-activity-snapshot:${seeded.sessionId}`,
                snapshot,
            }, acknowledge),
        ]);

        expect(acknowledge).toHaveBeenCalledWith(expect.objectContaining({
            status: expect.stringMatching(/^(applied|unchanged)$/),
            projection: expect.objectContaining(snapshot),
        }));
        await expect(db.session.findUniqueOrThrow({
            where: { id: seeded.sessionId },
            select: {
                runtimeActivityState: true,
                runtimeActivityActiveCount: true,
            },
        })).resolves.toEqual({
            runtimeActivityState: snapshot.state,
            runtimeActivityActiveCount: snapshot.activeCount,
        });
    });

    it('adapts the released machine-bound alive/end vector through exact registration, fresh-heartbeat coalescing, and close', async () => {
        const seeded = await seed();
        const handlers = new Map<string, Handler>();
        const socket = {
            on: vi.fn((event: string, handler: Handler) => { handlers.set(event, handler); }),
        };
        const publishedValues: unknown[] = [];
        const presence = createSessionPublisherPresence();
        registerSessionRuntimeActivitySnapshotSocketEvent({
            socket,
            presence,
            binding: { accountId: seeded.ownerId, machineId: seeded.machineId, sessionId: seeded.sessionId },
            publish: async (published) => { publishedValues.push(published); },
        });

        const releasedAlive = {
            sid: seeded.sessionId,
            time: Date.now(),
            thinking: true,
            mode: 'remote',
        } as const;
        const aliveHandler = handlers.get('session-alive');
        expect(aliveHandler).toEqual(expect.any(Function));
        await aliveHandler?.(releasedAlive);
        const first = await db.session.findUniqueOrThrow({
            where: { id: seeded.sessionId },
            select: {
                active: true,
                lastActiveAt: true,
                runtimeActivityState: true,
                runtimeActivityRevision: true,
            },
        });
        expect(first).toMatchObject({
            active: true,
            runtimeActivityState: 'unknown',
            runtimeActivityRevision: 0n,
        });

        await handlers.get('session-runtime-activity-snapshot')?.({
            sessionId: seeded.sessionId,
            mutationId: `runtime-activity-snapshot:${seeded.sessionId}`,
            snapshot: { state: 'active', activeCount: 1 },
        }, vi.fn());
        const activityBeforeTouch = await db.session.findUniqueOrThrow({
            where: { id: seeded.sessionId },
            select: {
                runtimeActivityState: true,
                runtimeActivityActiveCount: true,
                runtimeActivityRevision: true,
            },
        });

        await handlers.get('session-alive')?.({
            ...releasedAlive,
            time: releasedAlive.time + 1,
            latestTurnStatus: 'running',
            latestTurnStatusObservedAt: releasedAlive.time + 1,
        });
        const touched = await db.session.findUniqueOrThrow({
            where: { id: seeded.sessionId },
            select: {
                active: true,
                lastActiveAt: true,
                runtimeActivityState: true,
                runtimeActivityActiveCount: true,
                runtimeActivityRevision: true,
            },
        });
        expect(touched.lastActiveAt).toEqual(first.lastActiveAt);
        expect(touched).toMatchObject({ active: true, ...activityBeforeTouch });

        await handlers.get('session-end')?.({ sid: seeded.sessionId, time: releasedAlive.time + 2 });
        await expect(db.session.findUniqueOrThrow({
            where: { id: seeded.sessionId },
            select: { active: true },
        })).resolves.toEqual({ active: false });
        expect(publishedValues).toEqual(expect.arrayContaining([
            expect.objectContaining({ active: true, activeAt: expect.any(Number) }),
            expect.objectContaining({
                projection: expect.objectContaining({ state: 'active', activeCount: 1 }),
            }),
            expect.objectContaining({
                active: false,
                activeAt: expect.any(Number),
                projection: expect.objectContaining({ state: 'unknown', activeCount: 0 }),
            }),
        ]));
    });

    it('coalesces successful released alive persistence while the committed reachability fence is fresh', async () => {
        const seeded = await seed();
        const handlers = new Map<string, Handler>();
        const socket = { on: vi.fn((event: string, handler: Handler) => { handlers.set(event, handler); }) };
        const publishedValues: unknown[] = [];
        registerSessionRuntimeActivitySnapshotSocketEvent({
            socket,
            presence: createSessionPublisherPresence(),
            binding: { accountId: seeded.ownerId, machineId: seeded.machineId, sessionId: seeded.sessionId },
            publish: async (published) => { publishedValues.push(published); },
        });
        const aliveHandler = handlers.get('session-alive');
        if (!aliveHandler) throw new Error('expected released alive handler');
        const observedAt = Date.parse('2026-07-22T08:00:00.000Z');
        const now = vi.spyOn(Date, 'now').mockReturnValue(observedAt);

        try {
            await aliveHandler({ sid: seeded.sessionId, time: observedAt, thinking: false, mode: 'remote' });
            const registered = await db.session.findUniqueOrThrow({
                where: { id: seeded.sessionId },
                select: { lastActiveAt: true },
            });
            expect(publishedValues).toHaveLength(2);

            now.mockReturnValue(observedAt + 1_000);
            await aliveHandler({ sid: seeded.sessionId, time: observedAt + 1_000, thinking: false, mode: 'remote' });
            await expect(db.session.findUniqueOrThrow({
                where: { id: seeded.sessionId },
                select: { lastActiveAt: true },
            })).resolves.toEqual(registered);
            expect(publishedValues).toHaveLength(2);

            now.mockReturnValue(observedAt + 60_000);
            await aliveHandler({ sid: seeded.sessionId, time: observedAt + 60_000, thinking: false, mode: 'remote' });
            const refreshed = await db.session.findUniqueOrThrow({
                where: { id: seeded.sessionId },
                select: { lastActiveAt: true },
            });
            expect(refreshed.lastActiveAt.getTime()).toBeGreaterThan(registered.lastActiveAt.getTime());
            expect(publishedValues).toHaveLength(4);
        } finally {
            now.mockRestore();
        }
    });

    it('drops overlapping released alive events while one touch is unresolved and accepts the next heartbeat after settlement', async () => {
        const seeded = await seed();
        const handlers = new Map<string, Handler>();
        const socket = { on: vi.fn((event: string, handler: Handler) => { handlers.set(event, handler); }) };
        const publishedValues: unknown[] = [];
        registerSessionRuntimeActivitySnapshotSocketEvent({
            socket,
            presence: createSessionPublisherPresence(),
            binding: { accountId: seeded.ownerId, machineId: seeded.machineId, sessionId: seeded.sessionId },
            publish: async (published) => { publishedValues.push(published); },
        });
        const aliveHandler = handlers.get('session-alive');
        if (!aliveHandler) throw new Error('expected released alive handler');
        const observedAt = Date.parse('2026-07-22T08:00:00.000Z');
        const now = vi.spyOn(Date, 'now').mockReturnValue(observedAt);
        const alive = { sid: seeded.sessionId, time: observedAt, thinking: false, mode: 'remote' } as const;

        try {
            await aliveHandler(alive);
            publishedValues.length = 0;
            now.mockReturnValue(observedAt + 60_000);

            let resolveHolderEntered!: () => void;
            const holderEntered = new Promise<void>((resolve) => { resolveHolderEntered = resolve; });
            let releaseHolder!: () => void;
            const holderRelease = new Promise<void>((resolve) => { releaseHolder = resolve; });
            const holder = inTx(async () => {
                resolveHolderEntered();
                await holderRelease;
            });
            await holderEntered;

            const overlappingHeartbeats = [1, 2, 3, 4].map((offset) => aliveHandler({
                ...alive,
                time: alive.time + offset,
            }));
            releaseHolder();
            await holder;
            await Promise.all(overlappingHeartbeats);

            expect(publishedValues).toHaveLength(2);

            await aliveHandler({ ...alive, time: alive.time + 5 });
            expect(publishedValues).toHaveLength(2);
            now.mockReturnValue(observedAt + 120_000);
            await aliveHandler({ ...alive, time: alive.time + 6 });
            expect(publishedValues).toHaveLength(4);
        } finally {
            now.mockRestore();
        }
    });

    it('recovers on the next released alive heartbeat after SQLite transaction acquisition is exhausted', async () => {
        process.env.HAPPIER_DB_TX_MAX_RETRIES = '0';
        process.env.HAPPIER_DB_TX_MAX_WAIT_MS = '1000';
        process.env.HAPPIER_DB_TX_TIMEOUT_MS = '2000';

        const seeded = await seed();
        const handlers = new Map<string, Handler>();
        const socket = { on: vi.fn((event: string, handler: Handler) => { handlers.set(event, handler); }) };
        registerSessionRuntimeActivitySnapshotSocketEvent({
            socket,
            presence: createSessionPublisherPresence(),
            binding: { accountId: seeded.ownerId, machineId: seeded.machineId, sessionId: seeded.sessionId },
            publish: vi.fn(async () => {}),
        });
        const alive = handlers.get('session-alive');
        if (!alive) throw new Error('expected released alive handler');
        const initial = await db.session.findUniqueOrThrow({
            where: { id: seeded.sessionId },
            select: { active: true, lastActiveAt: true },
        });

        let resolveHolderEntered!: () => void;
        const holderEntered = new Promise<void>((resolve) => { resolveHolderEntered = resolve; });
        let releaseHolder!: () => void;
        const holderRelease = new Promise<void>((resolve) => { releaseHolder = resolve; });
        const holderReleased = new Error('release acquisition holder');
        const holder = inTx(async () => {
            resolveHolderEntered();
            await holderRelease;
            throw holderReleased;
        });
        await holderEntered;

        try {
            await alive({
                sid: seeded.sessionId,
                time: Date.now(),
                thinking: false,
                mode: 'remote',
            });
            await expect(db.session.findUniqueOrThrow({
                where: { id: seeded.sessionId },
                select: { active: true, lastActiveAt: true },
            })).resolves.toEqual(initial);
        } finally {
            releaseHolder();
            await expect(holder).rejects.toBe(holderReleased);
        }

        await alive({
            sid: seeded.sessionId,
            time: Date.now(),
            thinking: false,
            mode: 'remote',
        });
        const recovered = await db.session.findUniqueOrThrow({
            where: { id: seeded.sessionId },
            select: { active: true, lastActiveAt: true },
        });
        expect(recovered.active).toBe(true);
        expect(recovered.lastActiveAt.getTime()).toBeGreaterThan(initial.lastActiveAt.getTime());

        const timeoutResult = await expireSessionPublisherCandidates({
            candidates: [{ sessionId: seeded.sessionId, observedFence: recovered.lastActiveAt }],
            observedBefore: new Date(recovered.lastActiveAt.getTime() - 1),
        });
        expect(timeoutResult).toEqual([{ status: 'stale', sessionId: seeded.sessionId }]);
        await expect(db.session.findUniqueOrThrow({
            where: { id: seeded.sessionId },
            select: { active: true, lastActiveAt: true },
        })).resolves.toEqual(recovered);
    });

    it('does not let concurrent released alive sockets exhaust the single SQLite transaction connection', async () => {
        process.env.HAPPIER_DB_TX_MAX_RETRIES = '0';
        process.env.HAPPIER_DB_TX_MAX_WAIT_MS = '1000';

        const presence = createSessionPublisherPresence();
        const sockets = [] as Array<Readonly<{
            seeded: Awaited<ReturnType<typeof seed>>;
            alive: Handler;
        }>>;
        for (let index = 0; index < 12; index += 1) {
            const seeded = await seed();
            const handlers = new Map<string, Handler>();
            const socket = { on: vi.fn((event: string, handler: Handler) => { handlers.set(event, handler); }) };
            registerSessionRuntimeActivitySnapshotSocketEvent({
                socket,
                presence,
                binding: { accountId: seeded.ownerId, machineId: seeded.machineId, sessionId: seeded.sessionId },
                publish: vi.fn(async () => {}),
            });
            const alive = handlers.get('session-alive');
            if (!alive) throw new Error('expected released alive handler');
            sockets.push({ seeded, alive });
        }

        let resolveHolderEntered!: () => void;
        const holderEntered = new Promise<void>((resolve) => { resolveHolderEntered = resolve; });
        let releaseHolder!: () => void;
        const holderRelease = new Promise<void>((resolve) => { releaseHolder = resolve; });
        const holder = inTx(async () => {
            resolveHolderEntered();
            await holderRelease;
        });
        await holderEntered;

        const releaseTimer = setTimeout(releaseHolder, 850);
        try {
            await Promise.all(sockets.map(({ seeded, alive }) => alive({
                sid: seeded.sessionId,
                time: Date.now(),
                thinking: false,
                mode: 'remote',
            })));
        } finally {
            clearTimeout(releaseTimer);
            releaseHolder();
            await holder;
        }

        await expect(db.session.count({
            where: {
                id: { in: sockets.map(({ seeded }) => seeded.sessionId) },
                active: true,
            },
        })).resolves.toBe(sockets.length);
    });

    it('orders exact close behind an already accepted released alive backlog', async () => {
        const blocker = await seed();
        const target = await seed();
        const presence = createSessionPublisherPresence();
        const blockerHandlers = new Map<string, Handler>();
        const targetHandlers = new Map<string, Handler>();
        const blockerSocket = {
            on: vi.fn((event: string, handler: Handler) => { blockerHandlers.set(event, handler); }),
        };
        const targetSocket = {
            on: vi.fn((event: string, handler: Handler) => { targetHandlers.set(event, handler); }),
        };
        registerSessionRuntimeActivitySnapshotSocketEvent({
            socket: blockerSocket,
            presence,
            binding: { accountId: blocker.ownerId, machineId: blocker.machineId, sessionId: blocker.sessionId },
            publish: vi.fn(async () => {}),
        });
        registerSessionRuntimeActivitySnapshotSocketEvent({
            socket: targetSocket,
            presence,
            binding: { accountId: target.ownerId, machineId: target.machineId, sessionId: target.sessionId },
            publish: vi.fn(async () => {}),
        });

        const blockerBinding = {
            accountId: blocker.ownerId,
            machineId: blocker.machineId,
            sessionId: blocker.sessionId,
        };
        await blockerHandlers.get('session-runtime-activity-snapshot')?.({
            sessionId: blocker.sessionId,
            mutationId: `runtime-activity-snapshot:${blocker.sessionId}`,
            snapshot: { state: 'active', activeCount: 1 },
        }, vi.fn());
        let resolveBlockerEntered!: () => void;
        const blockerEntered = new Promise<void>((resolve) => { resolveBlockerEntered = resolve; });
        let releaseBlocker!: () => void;
        const blockerRelease = new Promise<void>((resolve) => { releaseBlocker = resolve; });
        const heldBlockerOperation = presence.runAsCurrentPublisher({
            socket: blockerSocket,
            binding: blockerBinding,
            action: async () => {
                resolveBlockerEntered();
                await blockerRelease;
            },
        });
        await blockerEntered;

        const blockerAlive = blockerHandlers.get('session-alive')?.({
            sid: blocker.sessionId,
            time: Date.now(),
            thinking: false,
            mode: 'remote',
        });
        await Promise.resolve();
        const targetAlive = targetHandlers.get('session-alive')?.({
            sid: target.sessionId,
            time: Date.now(),
            thinking: false,
            mode: 'remote',
        });
        const closeAcknowledge = vi.fn();
        const targetClose = targetHandlers.get('session-runtime-activity-close')?.(
            { sessionId: target.sessionId },
            closeAcknowledge,
        );

        releaseBlocker();
        await Promise.all([heldBlockerOperation, blockerAlive, targetAlive, targetClose]);

        expect(closeAcknowledge).toHaveBeenCalledWith({
            status: 'closed',
            sessionId: target.sessionId,
        });
        await expect(db.session.findUniqueOrThrow({
            where: { id: target.sessionId },
            select: { active: true, runtimeActivityState: true },
        })).resolves.toEqual({
            active: false,
            runtimeActivityState: 'unknown',
        });
    });

    it.each(['exact close', 'legacy end'] as const)(
        'does not let released alive reactivate a socket after a successful %s',
        async (terminalEvent) => {
            const seeded = await seed();
            const handlers = new Map<string, Handler>();
            const socket = {
                on: vi.fn((event: string, handler: Handler) => { handlers.set(event, handler); }),
            };
            registerSessionRuntimeActivitySnapshotSocketEvent({
                socket,
                presence: createSessionPublisherPresence(),
                binding: { accountId: seeded.ownerId, machineId: seeded.machineId, sessionId: seeded.sessionId },
                publish: vi.fn(async () => {}),
            });

            await handlers.get('session-runtime-activity-snapshot')?.({
                sessionId: seeded.sessionId,
                mutationId: `runtime-activity-snapshot:${seeded.sessionId}`,
                snapshot: { state: 'active', activeCount: 1 },
            }, vi.fn());
            if (terminalEvent === 'exact close') {
                await handlers.get('session-runtime-activity-close')?.(
                    { sessionId: seeded.sessionId },
                    vi.fn(),
                );
            } else {
                await handlers.get('session-end')?.({
                    sid: seeded.sessionId,
                    time: Date.now(),
                });
            }

            await handlers.get('session-alive')?.({
                sid: seeded.sessionId,
                time: Date.now() + 1,
                thinking: false,
                mode: 'remote',
            });

            await expect(db.session.findUniqueOrThrow({
                where: { id: seeded.sessionId },
                select: { active: true, runtimeActivityState: true },
            })).resolves.toEqual({
                active: false,
                runtimeActivityState: 'unknown',
            });
        },
    );

    it('does not let an unregistered legacy end poison a later alive and exact-current end on the same socket', async () => {
        const seeded = await seed();
        const handlers = new Map<string, Handler>();
        const socket = { on: vi.fn((event: string, handler: Handler) => { handlers.set(event, handler); }) };
        registerSessionRuntimeActivitySnapshotSocketEvent({
            socket,
            presence: createSessionPublisherPresence(),
            binding: { accountId: seeded.ownerId, machineId: seeded.machineId, sessionId: seeded.sessionId },
            publish: vi.fn(async () => {}),
        });

        await handlers.get('session-end')?.({ sid: seeded.sessionId, time: Date.now() });
        await handlers.get('session-alive')?.({
            sid: seeded.sessionId,
            time: Date.now() + 1,
            thinking: false,
            mode: 'remote',
        });
        await handlers.get('session-end')?.({ sid: seeded.sessionId, time: Date.now() + 2 });

        await expect(db.session.findUniqueOrThrow({
            where: { id: seeded.sessionId },
            select: { active: true, runtimeActivityState: true, runtimeActivityRevision: true },
        })).resolves.toEqual({
            active: false,
            runtimeActivityState: 'unknown',
            runtimeActivityRevision: 0n,
        });
    });

    it('keeps replacement ordering exact for released alive/end sockets', async () => {
        const seeded = await seed();
        const presence = createSessionPublisherPresence();
        const predecessorHandlers = new Map<string, Handler>();
        const successorHandlers = new Map<string, Handler>();
        const predecessor = { on: vi.fn((event: string, handler: Handler) => { predecessorHandlers.set(event, handler); }) };
        const successor = { on: vi.fn((event: string, handler: Handler) => { successorHandlers.set(event, handler); }) };
        const binding = { accountId: seeded.ownerId, machineId: seeded.machineId, sessionId: seeded.sessionId };
        registerSessionRuntimeActivitySnapshotSocketEvent({
            socket: predecessor,
            presence,
            binding,
            publish: vi.fn(async () => {}),
        });
        registerSessionRuntimeActivitySnapshotSocketEvent({
            socket: successor,
            presence,
            binding,
            publish: vi.fn(async () => {}),
        });
        const alive = { sid: seeded.sessionId, time: Date.now(), thinking: true, mode: 'remote' } as const;

        await predecessorHandlers.get('session-alive')?.(alive);
        await predecessorHandlers.get('session-alive')?.({ ...alive, time: alive.time + 1 });
        const predecessorTouchedFence = (await db.session.findUniqueOrThrow({
            where: { id: seeded.sessionId },
            select: { lastActiveAt: true },
        })).lastActiveAt;
        await successorHandlers.get('session-alive')?.({ ...alive, time: alive.time + 2 });
        const replacement = await db.session.findUniqueOrThrow({
            where: { id: seeded.sessionId },
            select: { active: true, lastActiveAt: true, runtimeActivityState: true, runtimeActivityRevision: true },
        });
        expect(replacement.lastActiveAt.getTime()).toBeGreaterThan(predecessorTouchedFence.getTime());

        await predecessorHandlers.get('session-alive')?.({ ...alive, time: alive.time + 3 });
        await predecessorHandlers.get('session-end')?.({ sid: seeded.sessionId, time: alive.time + 4 });
        await expect(db.session.findUniqueOrThrow({
            where: { id: seeded.sessionId },
            select: { active: true, lastActiveAt: true, runtimeActivityState: true, runtimeActivityRevision: true },
        })).resolves.toEqual(replacement);

        await successorHandlers.get('session-end')?.({ sid: seeded.sessionId, time: alive.time + 5 });
        await expect(db.session.findUniqueOrThrow({
            where: { id: seeded.sessionId },
            select: { active: true, runtimeActivityState: true, runtimeActivityRevision: true },
        })).resolves.toEqual({
            active: false,
            runtimeActivityState: 'unknown',
            runtimeActivityRevision: 0n,
        });
    });

    it('rejects mismatched or malformed snapshot and released presence vectors without writing', async () => {
        const seeded = await seed();
        const handlers = new Map<string, Handler>();
        const socket = { on: vi.fn((event: string, handler: Handler) => { handlers.set(event, handler); }) };
        registerSessionRuntimeActivitySnapshotSocketEvent({
            socket,
            presence: createSessionPublisherPresence(),
            binding: { accountId: seeded.ownerId, machineId: seeded.machineId, sessionId: seeded.sessionId },
            publish: vi.fn(async () => {}),
        });
        const acknowledge = vi.fn();
        await handlers.get('session-runtime-activity-snapshot')?.({
            sessionId: 'different-session',
            mutationId: 'runtime-activity-snapshot:different-session',
            snapshot: { state: 'active', activeCount: 1 },
        }, acknowledge);
        expect(acknowledge).toHaveBeenCalledWith({
            status: 'rejected',
            reason: 'invalid_request',
        });
        await handlers.get('session-alive')?.({
            sid: 'different-session',
            time: Date.now(),
            thinking: false,
            mode: 'remote',
        });
        await handlers.get('session-alive')?.({
            sid: seeded.sessionId,
            time: Date.now(),
            mode: 'remote',
        });
        await handlers.get('session-end')?.({ sid: 'different-session', time: Date.now() });
        await expect(db.session.findUniqueOrThrow({
            where: { id: seeded.sessionId },
            select: { active: true, runtimeActivityState: true, runtimeActivityRevision: true },
        })).resolves.toEqual({ active: false, runtimeActivityState: 'unknown', runtimeActivityRevision: 0n });
    });
});
