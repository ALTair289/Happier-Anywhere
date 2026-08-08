import { beforeEach, describe, expect, it, vi } from 'vitest';

// Sync imports persistence, which instantiates MMKV. Mock it for deterministic tests.
const kvStore = vi.hoisted(() => new Map<string, string>());
vi.mock('react-native-mmkv', () => {
    class MMKV {
        getString(key: string) {
            return kvStore.get(key);
        }
        set(key: string, value: string) {
            kvStore.set(key, value);
        }
        delete(key: string) {
            kvStore.delete(key);
        }
        clearAll() {
            kvStore.clear();
        }
    }

    return { MMKV };
});

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Platform: { OS: 'ios' },
        AppState: {
            currentState: 'active',
            addEventListener: vi.fn(() => ({ remove: vi.fn() })),
        },
    });
});

vi.mock('expo-constants', () => ({
    default: {
        expoConfig: {
            version: '1.2.3',
            ios: { bundleIdentifier: 'dev.happier.app.test' },
        },
    },
}));

const serverFetchMock = vi.hoisted(() => vi.fn());
vi.mock('@/sync/http/client', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/sync/http/client')>();
    return { ...actual, serverFetch: serverFetchMock };
});

vi.mock('@/sync/api/session/apiSocket', () => ({
    apiSocket: {
        onMessage: vi.fn(),
        onError: vi.fn(),
        onReconnected: vi.fn(),
        onStatusChange: vi.fn(() => () => {}),
        onConnectionStateChange: vi.fn(() => () => {}),
        connect: vi.fn(),
        disconnect: vi.fn(),
        initialize: vi.fn(),
        request: vi.fn(async () => new Response('ok', { status: 200 })),
    },
}));

vi.mock('@/log', () => ({
    log: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

function versionResponse(): Response {
    return new Response(JSON.stringify({ v: 1, status: 'current' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
    });
}

function versionRequestPaths(): string[] {
    return serverFetchMock.mock.calls
        .map((call) => String(call[0]))
        .filter((path) => path === '/v1/version');
}

async function createSyncWithCredentials() {
    const { sync } = await import('./sync');
    (sync as any).credentials = { token: 'token-a', secret: new Uint8Array([1]) };
    return sync;
}

describe('native update check staleness gate', () => {
    // The gate lives on the `sync` singleton, so each case starts from a distinct day: that leaves
    // the previous case's success stamp unambiguously stale without re-importing the module graph.
    let testDayIndex = 0;

    beforeEach(() => {
        vi.useFakeTimers();
        testDayIndex += 1;
        vi.setSystemTime(new Date(Date.UTC(2026, 0, testDayIndex)));
        kvStore.clear();
        serverFetchMock.mockReset();
        serverFetchMock.mockImplementation(async () => versionResponse());
    });

    it('skips the version check while the last successful result is still fresh', async () => {
        const sync = await createSyncWithCredentials();
        const fetchNativeUpdate = (sync as any).fetchNativeUpdate as () => Promise<void>;

        await fetchNativeUpdate();
        // A background→foreground cycle re-invalidates the unit moments later.
        await vi.advanceTimersByTimeAsync(5_000);
        await fetchNativeUpdate();

        expect(versionRequestPaths()).toEqual(['/v1/version']);
    });

    it('checks again once the last successful result is stale', async () => {
        const sync = await createSyncWithCredentials();
        const fetchNativeUpdate = (sync as any).fetchNativeUpdate as () => Promise<void>;

        await fetchNativeUpdate();
        await vi.advanceTimersByTimeAsync(15 * 60_000);
        await fetchNativeUpdate();

        expect(versionRequestPaths()).toEqual(['/v1/version', '/v1/version']);
    });

    it('retries on the next invalidation when the check failed', async () => {
        const sync = await createSyncWithCredentials();
        const fetchNativeUpdate = (sync as any).fetchNativeUpdate as () => Promise<void>;

        serverFetchMock.mockImplementationOnce(async () => new Response('boom', { status: 503 }));

        await fetchNativeUpdate();
        await fetchNativeUpdate();

        expect(versionRequestPaths()).toEqual(['/v1/version', '/v1/version']);
    });
});
