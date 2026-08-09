import { beforeEach, describe, expect, it, vi } from 'vitest';

const appStateHandlers = vi.hoisted(() => new Set<(state: string) => void>());
const appStateAddListener = vi.hoisted(() => vi.fn((_event: string, handler: (state: string) => void) => {
    appStateHandlers.add(handler);
    return { remove: vi.fn(() => appStateHandlers.delete(handler)) };
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Platform: { OS: 'ios' },
        AppState: {
            currentState: 'active',
            addEventListener: appStateAddListener as any,
        },
    });
});

const socketStatusHandlers = vi.hoisted(() => new Set<(status: string) => void>());
const apiSocketConnect = vi.hoisted(() => vi.fn());
// Mirrors the real apiSocket: an intentional disconnect publishes 'disconnected' to status listeners
// (apiSocket.disconnect() → updateStatus('disconnected')).
const apiSocketDisconnect = vi.hoisted(() => vi.fn(() => {
    for (const handler of socketStatusHandlers) {
        handler('disconnected');
    }
}));

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

type SyncUnitStub = Readonly<{
    invalidateCoalesced: ReturnType<typeof vi.fn>;
    awaitQueue: ReturnType<typeof vi.fn>;
    invalidate: ReturnType<typeof vi.fn>;
}>;

function createSyncUnitStub(): SyncUnitStub {
    return {
        invalidateCoalesced: vi.fn(),
        awaitQueue: vi.fn(async () => {}),
        invalidate: vi.fn(),
    };
}

/**
 * Wires a real `sync` singleton with stubbed InvalidateSync units so `resumeSync` runs its real
 * decision logic while the network-bound fetchers stay out of the way.
 *
 * `refreshedByCatchUp` mirrors what the changes catch-up reports it already refreshed during this
 * resume, which is what the resume tail uses to avoid repeating the same full refresh.
 */
async function createResumableSync(
    refreshedByCatchUp: Readonly<{ sessions: boolean; machines: boolean }> = { sessions: false, machines: false },
) {
    const { sync } = await import('./sync');

    // Register the socket status listener that owns the offline-duration bookkeeping.
    (sync as unknown as { subscribeToUpdates: () => void }).subscribeToUpdates();

    const units = {
        sessionsSync: createSyncUnitStub(),
        machinesSync: createSyncUnitStub(),
        purchasesSync: createSyncUnitStub(),
        pushTokenSync: createSyncUnitStub(),
        nativeUpdateSync: createSyncUnitStub(),
    };
    for (const [field, unit] of Object.entries(units)) {
        (sync as any)[field] = unit;
    }

    (sync as any).credentials = { token: 'token-a', secret: new Uint8Array([1]) };
    (sync as any).serverID = 'account-a';
    vi.spyOn(sync as any, 'rearmPendingOutboxForActiveScope').mockResolvedValue(undefined);
    vi.spyOn(sync as any, 'resumeViaChanges').mockResolvedValue({ status: 'ok', refreshedByCatchUp });
    vi.spyOn(sync as any, 'catchUpLoadedDirectSessionsOnResume').mockResolvedValue(undefined);

    return { sync, units };
}

describe('sync foreground ephemeral recovery', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
        vi.resetModules();
        vi.restoreAllMocks();
        appStateHandlers.clear();
        socketStatusHandlers.clear();
        appStateAddListener.mockClear();
        apiSocketConnect.mockClear();
        apiSocketDisconnect.mockClear();
    });

    it('refreshes sessions and machines exactly once when foregrounding after a socket outage', async () => {
        const { sync, units } = await createResumableSync();

        const appStateHandler = Array.from(appStateHandlers)[0];
        expect(appStateHandler).toBeTruthy();

        // Background tears the socket down intentionally: ephemerals (session.active, machine
        // presence) stop being delivered from here on.
        appStateHandler!('background');
        await vi.advanceTimersByTimeAsync(30_000);

        expect(units.sessionsSync.invalidateCoalesced).not.toHaveBeenCalled();
        expect(units.machinesSync.invalidateCoalesced).not.toHaveBeenCalled();

        // Foreground: the resume pipeline must settle machine readiness itself instead of waiting
        // for the next 20s machine keep-alive ephemeral.
        appStateHandler!('active');
        await (sync as unknown as { resumeInFlight: Promise<void> | null }).resumeInFlight;
        await vi.advanceTimersByTimeAsync(0);

        expect(units.sessionsSync.invalidateCoalesced).toHaveBeenCalledTimes(1);
        expect(units.machinesSync.invalidateCoalesced).toHaveBeenCalledTimes(1);
    });

    it('does not repeat a sessions or machines refresh the changes catch-up already performed', async () => {
        // The changes catch-up (applyPlannedChangeActions → invalidate.sessions/invalidate.machines)
        // already ran a full session-list + machines refresh for this resume. Repeating it in the
        // resume tail issued a second complete catch-up wave (session-organization + sessions/active
        // + /v1/machines + /v2/sessions?includeAttention) once the catch-up's awaited hydration
        // finished — measured at +12.4s on device.
        const { sync, units } = await createResumableSync({ sessions: true, machines: true });

        const appStateHandler = Array.from(appStateHandlers)[0];
        expect(appStateHandler).toBeTruthy();

        appStateHandler!('background');
        await vi.advanceTimersByTimeAsync(30_000);

        appStateHandler!('active');
        await (sync as unknown as { resumeInFlight: Promise<void> | null }).resumeInFlight;
        await vi.advanceTimersByTimeAsync(0);

        expect(units.sessionsSync.invalidateCoalesced).not.toHaveBeenCalled();
        expect(units.machinesSync.invalidateCoalesced).not.toHaveBeenCalled();
        // The unconditional tail of the resume pipeline still runs.
        expect(units.pushTokenSync.invalidateCoalesced).toHaveBeenCalledTimes(1);
    });

    it('still refreshes the unit the changes catch-up did not cover', async () => {
        // Partial coverage must stay precise: the catch-up refreshed machines only, so sessions
        // still needs the offline-recovery refresh.
        const { sync, units } = await createResumableSync({ sessions: false, machines: true });

        const appStateHandler = Array.from(appStateHandlers)[0];
        appStateHandler!('background');
        await vi.advanceTimersByTimeAsync(30_000);

        appStateHandler!('active');
        await (sync as unknown as { resumeInFlight: Promise<void> | null }).resumeInFlight;
        await vi.advanceTimersByTimeAsync(0);

        expect(units.sessionsSync.invalidateCoalesced).toHaveBeenCalledTimes(1);
        expect(units.machinesSync.invalidateCoalesced).not.toHaveBeenCalled();
    });

    it('does not refresh sessions and machines when the socket never went offline', async () => {
        const { sync, units } = await createResumableSync();

        await sync.resumeSync('manual');

        expect(units.sessionsSync.invalidateCoalesced).not.toHaveBeenCalled();
        expect(units.machinesSync.invalidateCoalesced).not.toHaveBeenCalled();
        // The unconditional tail of the resume pipeline still runs.
        expect(units.pushTokenSync.invalidateCoalesced).toHaveBeenCalledTimes(1);
    });
});
