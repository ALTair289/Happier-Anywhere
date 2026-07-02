import { afterEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import { configuration } from '@/configuration';
import { createMockSession } from '@/testkit/backends/sessionFixtures';
import { bindApiSessionSocketPairMock, createApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';

const { mockIo } = vi.hoisted(() => ({
    mockIo: vi.fn(),
}));

vi.mock('socket.io-client', () => ({
    io: mockIo,
}));

vi.mock('@/persistence', () => ({
    readCredentials: vi.fn(async () => null),
    readAccountChangesCursor: vi.fn(async () => 0),
    writeAccountChangesCursor: vi.fn(async () => {}),
}));

vi.mock('axios');

describe('ApiSessionClient stale socket safety', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('runs stale safety through /v2/changes without forcing a session detail snapshot', async () => {
        const { ApiSessionClient } = await import('./session/sessionClient');
        const { writeAccountChangesCursor } = await import('@/persistence');
        (writeAccountChangesCursor as any).mockClear?.();

        const sessionSocket = createApiSessionSocketStub();
        const userSocket = createApiSessionSocketStub({ connected: true });
        bindApiSessionSocketPairMock(mockIo, { sessionSocket, userSocket });

        const sessionId = 'test-session-id';
        (axios.get as any).mockImplementation(async (url: string, config?: any) => {
            if (url.endsWith('/v1/account/profile')) {
                return { status: 200, data: { id: 'account-1' } };
            }

            if (url.includes('/v2/changes')) {
                return {
                    status: 200,
                    data: {
                        changes: [{
                            cursor: 2,
                            kind: 'session',
                            entityId: sessionId,
                            changedAt: Date.now(),
                            hint: { pendingCount: 3, pendingVersion: 7 },
                        }],
                        nextCursor: 2,
                    },
                };
            }

            throw new Error(`Unexpected axios.get: ${url}`);
        });

        const client = new ApiSessionClient(
            'fake-token',
            createMockSession({
                id: sessionId,
                encryptionKey: new Uint8Array(32).fill(7),
                encryptionVariant: 'legacy',
            }),
        );

        const snapshotSpy = vi.fn(async () => {});
        (client as any).syncSessionSnapshotFromServer = snapshotSpy;

        try {
            await (client as any).runSocketStaleSafetyTick();

            expect(snapshotSpy).not.toHaveBeenCalled();
            expect((client as any).pendingQueueState).toEqual({
                known: true,
                pendingCount: 3,
                pendingBlockedCount: 0,
                pendingVersion: 7,
            });
            expect(writeAccountChangesCursor).not.toHaveBeenCalled();
        } finally {
            await client.close();
        }
    });

    it('starts the stale-safety scheduler after startup catch-up and ticks while the session socket stays connected', async () => {
        vi.useFakeTimers();
        const originalIntervalMs = configuration.sessionSocketStaleSafetyIntervalMs;
        (configuration as { sessionSocketStaleSafetyIntervalMs: number }).sessionSocketStaleSafetyIntervalMs = 100;
        const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);

        const { ApiSessionClient } = await import('./session/sessionClient');

        const sessionSocket = createApiSessionSocketStub({ id: 'session-socket' });
        const userSocket = createApiSessionSocketStub({ id: 'user-socket' });
        bindApiSessionSocketPairMock(mockIo, { sessionSocket, userSocket });

        const sessionId = 'test-session-id';
        const changesAfter: number[] = [];
        const sessionDetailReads: string[] = [];
        (axios.get as any).mockImplementation(async (url: string, config?: any) => {
            if (url.endsWith('/v1/account/profile')) {
                return { status: 200, data: { id: 'account-1' } };
            }

            if (url.includes('/v2/changes')) {
                changesAfter.push(Number(config?.params?.after ?? 0));
                return {
                    status: 200,
                    data: {
                        changes: [],
                        nextCursor: changesAfter.length,
                    },
                };
            }

            if (url.includes(`/v2/sessions/${sessionId}`)) {
                sessionDetailReads.push(url);
                return { status: 200, data: { session: null } };
            }

            throw new Error(`Unexpected axios.get: ${url}`);
        });

        const client = new ApiSessionClient(
            'fake-token',
            createMockSession({
                id: sessionId,
                encryptionKey: new Uint8Array(32).fill(7),
                encryptionVariant: 'legacy',
            }),
        );

        try {
            await vi.waitFor(() => {
                expect(changesAfter).toEqual([0]);
            });

            await vi.advanceTimersByTimeAsync(80);
            sessionSocket.trigger('update', {
                id: 'session-update-1',
                seq: 1,
                createdAt: Date.now(),
                body: { t: 'noop', sid: sessionId },
            });
            await vi.advanceTimersByTimeAsync(19);
            userSocket.trigger('update', {
                id: 'user-update-1',
                seq: 2,
                createdAt: Date.now(),
                body: { t: 'noop', sid: sessionId },
            });
            expect(changesAfter[0]).toBe(0);

            await vi.advanceTimersByTimeAsync(1);
            for (let index = 0; index < 8; index += 1) {
                await Promise.resolve();
            }
            await vi.waitFor(() => {
                expect(changesAfter).toEqual([0, 1]);
            });
            expect(sessionDetailReads).toEqual([]);
            expect(sessionSocket.connected).toBe(true);
        } finally {
            randomSpy.mockRestore();
            (configuration as { sessionSocketStaleSafetyIntervalMs: number }).sessionSocketStaleSafetyIntervalMs = originalIntervalMs;
            await client.close();
        }
    });
});
