import { beforeEach, describe, expect, it, vi } from 'vitest';

const appStateAddListener = vi.hoisted(() => vi.fn(() => ({ remove: vi.fn() })));
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                        Platform: { OS: 'web' },
                        AppState: {
                            currentState: 'active',
                            addEventListener: appStateAddListener as any,
                        },
                    }
    );
});

const socketStatusHandlers = vi.hoisted(() => new Set<(status: string) => void>());
const apiSocketDisconnect = vi.hoisted(() => vi.fn());
const apiSocketConnect = vi.hoisted(() => vi.fn());

vi.mock('@/sync/api/session/apiSocket', () => ({
    apiSocket: {
        onMessage: vi.fn(),
        onError: vi.fn(),
        onReconnected: vi.fn(),
        onStatusChange: vi.fn((handler: (status: string) => void) => {
            socketStatusHandlers.add(handler);
            return () => socketStatusHandlers.delete(handler);
        }),
        onConnectionStateChange: vi.fn(() => () => {}),
        connect: apiSocketConnect,
        disconnect: apiSocketDisconnect,
        initialize: vi.fn(),
        request: vi.fn(async () => new Response('ok', { status: 200 })),
    },
}));

vi.mock('@/log', () => ({
    log: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

describe('sync socket offline duration tracking', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
        vi.resetModules();
        socketStatusHandlers.clear();
        apiSocketDisconnect.mockClear();
        apiSocketConnect.mockClear();
    });

    it('captures the last offline duration across disconnected→connected transition', async () => {
        const { sync } = await import('./sync');

        // Wire the socket listeners without forcing a full sync init sequence.
        (sync as unknown as { subscribeToUpdates: () => void }).subscribeToUpdates();

        expect(socketStatusHandlers.size).toBeGreaterThan(0);
        const handler = Array.from(socketStatusHandlers)[0]!;

        handler('disconnected');
        await vi.advanceTimersByTimeAsync(2500);
        handler('connected');

        const state = sync as unknown as {
            lastSocketOfflineDurationMs?: number;
        };
        expect(typeof state.lastSocketOfflineDurationMs).toBe('number');
        expect(state.lastSocketOfflineDurationMs).toBeGreaterThanOrEqual(2500);
    });
});
