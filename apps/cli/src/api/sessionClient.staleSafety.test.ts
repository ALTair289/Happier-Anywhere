import { afterEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
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

describe('ApiSessionClient event-driven changes catch-up', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('runs one connect catch-up and performs no periodic changes requests while the session socket stays connected', async () => {
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
            const supervisedClient = client as unknown as {
                sessionConnectionSupervisor: { start: () => Promise<void> };
            };
            await supervisedClient.sessionConnectionSupervisor.start();
            await vi.waitFor(() => {
                expect(changesAfter).toEqual([0]);
            });

            vi.useFakeTimers();
            await vi.advanceTimersByTimeAsync(120_000);
            sessionSocket.trigger('update', {
                id: 'session-update-1',
                seq: 1,
                createdAt: Date.now(),
                body: { t: 'noop', sid: sessionId },
            });
            userSocket.trigger('update', {
                id: 'user-update-1',
                seq: 2,
                createdAt: Date.now(),
                body: { t: 'noop', sid: sessionId },
            });
            for (let index = 0; index < 8; index += 1) {
                await Promise.resolve();
            }
            expect(changesAfter).toEqual([0]);
            expect(sessionDetailReads).toEqual([]);
            expect(sessionSocket.connected).toBe(true);
        } finally {
            vi.useRealTimers();
            await client.close();
        }
    });
});
