import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';

const appState = vi.hoisted(() => ({ currentState: 'active' as string }));

// Contract pinned to the legacy phone parser at 4b76fc8c60fffeb1c08a26ef05d0ffe22684168e.
function parseWithFixedLegacyPhoneParser(deepLink: string) {
    const url = new URL(deepLink);
    const normalizedPathname = url.pathname === 'pair' ? '/pair' : url.pathname;
    if (normalizedPathname !== '/pair' && !(url.hostname === 'pair' && (normalizedPathname === '' || normalizedPathname === '/'))) {
        return null;
    }
    const version = url.searchParams.get('v');
    if (version !== null && version !== '1') return null;
    const pairId = url.searchParams.get('pairId');
    const secret = url.searchParams.get('secret');
    if (!pairId || !secret) return null;
    const server = url.searchParams.get('server');
    let serverUrl: string | null = null;
    if (server) {
        const parsedServer = new URL(server);
        if (!['http:', 'https:'].includes(parsedServer.protocol) || parsedServer.username || parsedServer.password) return null;
        serverUrl = `${parsedServer.origin}${parsedServer.pathname === '/' ? '' : parsedServer.pathname}${parsedServer.search}`;
    }
    return { pairId, secret, serverUrl };
}

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                Platform: { OS: 'web' },
                AppState: {
                    get currentState() {
                        return appState.currentState;
                    },
                },
            }
    );
});

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const createPairingSecretMock = vi.fn(async () => ({ secret: 'sec_test', secretHash: 'hash_test' }));
vi.mock('@/auth/pairing/pairingSecret', () => ({ createPairingSecret: createPairingSecretMock }));

const pairingStartMock = vi.fn(async () => ({ ok: true, data: { pairId: 'pair_123', expiresAt: Date.now() + 60_000 } }));
const pairingClaimStartMock = vi.fn(async (params: { origin: string }) => ({
    ok: true,
    data: {
        protocol: 'claim-v1',
        claimId: `claim_${'a'.repeat(43)}`,
        origin: params.origin,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
    },
}));
const pairingStatusMock = vi.fn(async () => ({ ok: true, data: { state: 'pending', pairId: 'pair_123', expiresAt: Date.now() + 60_000 } }));
vi.mock('@/sync/api/account/apiPairingAuth', () => ({
    pairingClaimStart: pairingClaimStartMock,
    pairingStart: pairingStartMock,
    pairingStatus: pairingStatusMock,
}));

let activeServerUrl = 'http://localhost:53288';
let activeShareableServerUrl: string | null = null;
let activeServerId = 'srv-a';
let activeServerGeneration = 0;
vi.mock('@/sync/domains/server/serverProfiles', () => ({
    getActiveServerUrl: () => activeServerUrl,
    getActiveServerSnapshot: () => ({
        serverId: activeServerId,
        serverUrl: activeServerUrl,
        activeShareableServerUrl,
        generation: activeServerGeneration,
    }),
}));

let cachedCanonicalServerUrl: string | null = null;
vi.mock('@/sync/api/capabilities/serverFeaturesClient', () => ({
    getCachedServerFeaturesSnapshot: () =>
        cachedCanonicalServerUrl
            ? { status: 'ready', features: { capabilities: { server: { canonicalServerUrl: cachedCanonicalServerUrl } } } }
            : null,
}));

describe('usePairingSession (pairing deep link server URL)', () => {
    beforeEach(() => {
        vi.resetModules();
        pairingStartMock.mockClear();
        pairingClaimStartMock.mockClear();
        pairingStatusMock.mockClear();
        createPairingSecretMock.mockClear();
        cachedCanonicalServerUrl = null;
        activeServerUrl = 'http://localhost:53288';
        activeShareableServerUrl = null;
        activeServerId = 'srv-a';
        activeServerGeneration = 0;
        appState.currentState = 'active';
    });

    it('does not embed a loopback server URL in the deep link', async () => {
        const { usePairingSession } = await import('./usePairingSession');

        let hookApi: ReturnType<typeof usePairingSession> | null = null;
        function Probe() {
            hookApi = usePairingSession({ enabled: true, isAuthenticated: true });
            return null;
        }

        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(<Probe />)).tree;
        try {
            await act(async () => {
                const res = await hookApi!.startPairing();
                expect(res.ok).toBe(true);
            });

            const deepLink = hookApi!.deepLink;
            expect(deepLink).toBeTruthy();
            const url = new URL(deepLink!);
            expect(url.searchParams.get('server')).toBeNull();
            expect(url.searchParams.get('v')).toBe('1');
            expect(pairingClaimStartMock).not.toHaveBeenCalled();
            expect(createPairingSecretMock).toHaveBeenCalledTimes(1);

            await act(async () => {
                hookApi!.clearSession();
            });
        } finally {
            act(() => {
                tree?.unmount();
            });
        }
    });

    it('keeps the default issuer output consumable by the fixed legacy phone parser', async () => {
        cachedCanonicalServerUrl = 'https://api.example.test';

        const { usePairingSession } = await import('./usePairingSession');

        let hookApi: ReturnType<typeof usePairingSession> | null = null;
        function Probe() {
            hookApi = usePairingSession({ enabled: true, isAuthenticated: true });
            return null;
        }

        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(<Probe />)).tree;
        try {
            await act(async () => {
                const res = await hookApi!.startPairing();
                expect(res.ok).toBe(true);
            });

            const deepLink = hookApi!.deepLink;
            expect(deepLink).toBeTruthy();
            expect(parseWithFixedLegacyPhoneParser(deepLink!)).toEqual({
                pairId: 'pair_123',
                secret: 'sec_test',
                serverUrl: 'https://api.example.test',
            });
            expect(pairingClaimStartMock).not.toHaveBeenCalled();
            expect(pairingStartMock).toHaveBeenCalledTimes(1);

            await act(async () => {
                hookApi!.clearSession();
            });
        } finally {
            act(() => {
                tree?.unmount();
            });
        }
    });

    it('sanitizes credentials out of canonical server URLs before embedding', async () => {
        cachedCanonicalServerUrl = 'https://user:pass@api.example.test';
        activeServerUrl = 'https://active.example.test';

        const { usePairingSession } = await import('./usePairingSession');

        let hookApi: ReturnType<typeof usePairingSession> | null = null;
        function Probe() {
            hookApi = usePairingSession({ enabled: true, isAuthenticated: true });
            return null;
        }

        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(<Probe />)).tree;
        try {
            await act(async () => {
                const res = await hookApi!.startPairing({ protocol: 'claim-v1' });
                expect(res.ok).toBe(true);
            });

            const deepLink = hookApi!.deepLink;
            expect(deepLink).toBeTruthy();
            const url = new URL(deepLink!);
            expect(url.searchParams.get('origin')).toBe('https://api.example.test');
        } finally {
            act(() => {
                tree?.unmount();
            });
        }
    });

    it('prefers an active shareable relay URL over the canonical server URL', async () => {
        cachedCanonicalServerUrl = 'https://api.example.test';
        activeServerUrl = 'https://active.example.test';
        activeShareableServerUrl = 'https://relay.example.ts.net';

        const { usePairingSession } = await import('./usePairingSession');

        let hookApi: ReturnType<typeof usePairingSession> | null = null;
        function Probe() {
            hookApi = usePairingSession({ enabled: true, isAuthenticated: true });
            return null;
        }

        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(<Probe />)).tree;
        try {
            await act(async () => {
                const res = await hookApi!.startPairing({ protocol: 'claim-v1' });
                expect(res.ok).toBe(true);
            });

            const deepLink = hookApi!.deepLink;
            expect(deepLink).toBeTruthy();
            const url = new URL(deepLink!);
            expect(url.searchParams.get('origin')).toBe('https://relay.example.ts.net');
        } finally {
            act(() => {
                tree?.unmount();
            });
        }
    });

    it('issues claim-v1 only when explicitly requested', async () => {
        cachedCanonicalServerUrl = 'https://api.example.test';
        const { usePairingSession } = await import('./usePairingSession');
        let hookApi: ReturnType<typeof usePairingSession> | null = null;
        function Probe() {
            hookApi = usePairingSession({ enabled: true, isAuthenticated: true });
            return null;
        }

        const tree = (await renderScreen(<Probe />)).tree;
        try {
            await act(async () => {
                expect((await hookApi!.startPairing({ protocol: 'claim-v1' })).ok).toBe(true);
            });
            const url = new URL(hookApi!.deepLink!);
            expect(url.searchParams.get('v')).toBe('claim-v1');
            expect(url.searchParams.get('origin')).toBe('https://api.example.test');
            expect(hookApi!.protocol).toBe('claim-v1');
            expect(pairingStartMock).not.toHaveBeenCalled();
            expect(createPairingSecretMock).not.toHaveBeenCalled();
        } finally {
            act(() => tree.unmount());
        }
    });

    it('does not silently downgrade an explicit claim-v1 request', async () => {
        cachedCanonicalServerUrl = 'https://api.example.test';
        pairingClaimStartMock.mockResolvedValueOnce({ ok: false, reason: 'unsupported', status: 404 } as any);

        const { usePairingSession } = await import('./usePairingSession');

        let hookApi: ReturnType<typeof usePairingSession> | null = null;
        function Probe() {
            hookApi = usePairingSession({ enabled: true, isAuthenticated: true });
            return null;
        }

        const tree = (await renderScreen(<Probe />)).tree;
        try {
            await act(async () => {
                expect(await hookApi!.startPairing({ protocol: 'claim-v1' })).toEqual({ ok: false, status: 404 });
            });

            expect(hookApi!.deepLink).toBeNull();
            expect(pairingClaimStartMock).toHaveBeenCalledTimes(1);
            expect(pairingStartMock).not.toHaveBeenCalled();
            expect(createPairingSecretMock).not.toHaveBeenCalled();
        } finally {
            act(() => tree.unmount());
        }
    });

    it('pauses pairing status polling while backgrounded', async () => {
        vi.useFakeTimers();
        appState.currentState = 'active';
        const globalWithDocument = globalThis as unknown as { document?: { visibilityState?: string } };
        const previousDocument = globalWithDocument.document;
        const documentStub: { visibilityState: DocumentVisibilityState } = { visibilityState: 'hidden' };
        globalWithDocument.document = documentStub;

        const { usePairingSession } = await import('./usePairingSession');

        let hookApi: ReturnType<typeof usePairingSession> | null = null;
        function Probe() {
            hookApi = usePairingSession({ enabled: true, isAuthenticated: true });
            return null;
        }

        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(<Probe />)).tree;
        try {
            await act(async () => {
                const res = await hookApi!.startPairing();
                expect(res.ok).toBe(true);
            });

            await act(async () => {
                await vi.advanceTimersByTimeAsync(1_100);
            });

            expect(pairingStatusMock).toHaveBeenCalledTimes(0);

            documentStub.visibilityState = 'visible';
            await act(async () => {
                await vi.advanceTimersByTimeAsync(1_100);
            });

            expect(pairingStatusMock).toHaveBeenCalled();
        } finally {
            act(() => {
                tree?.unmount();
            });
            vi.useRealTimers();
            globalWithDocument.document = previousDocument;
        }
    });

    it('does not publish a stale start result after clearSession invalidates the operation', async () => {
        cachedCanonicalServerUrl = 'https://api.example.test';
        let resolveClaim!: (value: any) => void;
        pairingClaimStartMock.mockImplementationOnce(async () => await new Promise((resolve) => {
            resolveClaim = resolve;
        }));

        const { usePairingSession } = await import('./usePairingSession');
        let hookApi: ReturnType<typeof usePairingSession> | null = null;
        function Probe() {
            hookApi = usePairingSession({ enabled: true, isAuthenticated: true });
            return null;
        }

        const tree = (await renderScreen(<Probe />)).tree;
        try {
            let startPromise!: Promise<{ ok: boolean; status?: number }>;
            await act(async () => {
                startPromise = hookApi!.startPairing({ protocol: 'claim-v1' });
                await Promise.resolve();
            });
            expect(hookApi!.isStarting).toBe(true);

            await act(async () => {
                hookApi!.clearSession();
            });
            resolveClaim({
                ok: true,
                data: {
                    protocol: 'claim-v1',
                    claimId: `claim_${'z'.repeat(43)}`,
                    origin: 'https://api.example.test',
                    expiresAt: new Date(Date.now() + 60_000).toISOString(),
                },
            });
            await act(async () => {
                await startPromise;
            });

            expect(hookApi!.deepLink).toBeNull();
            expect(hookApi!.status).toBeNull();
            expect(hookApi!.isStarting).toBe(false);
        } finally {
            act(() => tree.unmount());
        }
    });

    it('does not publish an in-flight status response after clearSession releases its owner', async () => {
        cachedCanonicalServerUrl = 'https://api.example.test';
        let resolvePoll!: (value: any) => void;
        pairingStatusMock.mockImplementationOnce(async () => await new Promise((resolve) => {
            resolvePoll = resolve;
        }));

        const { usePairingSession } = await import('./usePairingSession');
        let hookApi: ReturnType<typeof usePairingSession> | null = null;
        function Probe() {
            hookApi = usePairingSession({ enabled: true, isAuthenticated: true });
            return null;
        }

        const tree = (await renderScreen(<Probe />)).tree;
        try {
            await act(async () => {
                expect((await hookApi!.startPairing()).ok).toBe(true);
                await Promise.resolve();
            });
            expect(pairingStatusMock).toHaveBeenCalledTimes(1);

            await act(async () => {
                hookApi!.clearSession();
                resolvePoll({
                    ok: true,
                    data: {
                        state: 'requested',
                        pairId: `claim_${'a'.repeat(43)}`,
                        expiresAt: Date.now() + 60_000,
                        requestedPublicKey: 'pk-stale',
                        requestedDeviceLabel: null,
                        confirmCode: '123456',
                    },
                });
                await Promise.resolve();
            });

            expect(hookApi!.deepLink).toBeNull();
            expect(hookApi!.status).toBeNull();
        } finally {
            act(() => tree.unmount());
        }
    });

    it('never overlaps pairing status polls', async () => {
        vi.useFakeTimers();
        cachedCanonicalServerUrl = 'https://api.example.test';
        let resolveFirstPoll!: (value: any) => void;
        pairingStatusMock.mockImplementationOnce(async () => await new Promise((resolve) => {
            resolveFirstPoll = resolve;
        }));

        const { usePairingSession } = await import('./usePairingSession');
        let hookApi: ReturnType<typeof usePairingSession> | null = null;
        function Probe() {
            hookApi = usePairingSession({ enabled: true, isAuthenticated: true });
            return null;
        }

        const tree = (await renderScreen(<Probe />)).tree;
        try {
            await act(async () => {
                expect((await hookApi!.startPairing()).ok).toBe(true);
            });
            await act(async () => {
                await Promise.resolve();
            });
            expect(pairingStatusMock).toHaveBeenCalledTimes(1);

            await act(async () => {
                await vi.advanceTimersByTimeAsync(3_100);
            });
            expect(pairingStatusMock).toHaveBeenCalledTimes(1);

            resolveFirstPoll({
                ok: true,
                data: { state: 'pending', pairId: `claim_${'a'.repeat(43)}`, expiresAt: Date.now() + 60_000 },
            });
            await act(async () => {
                await Promise.resolve();
                await vi.advanceTimersByTimeAsync(1_100);
            });
            expect(pairingStatusMock).toHaveBeenCalledTimes(2);
        } finally {
            act(() => tree.unmount());
            vi.useRealTimers();
        }
    });

    it('cancels the session without polling a different active server', async () => {
        vi.useFakeTimers();
        cachedCanonicalServerUrl = 'https://api.example.test';

        const { usePairingSession } = await import('./usePairingSession');
        let hookApi: ReturnType<typeof usePairingSession> | null = null;
        function Probe() {
            hookApi = usePairingSession({ enabled: true, isAuthenticated: true });
            return null;
        }

        const tree = (await renderScreen(<Probe />)).tree;
        try {
            await act(async () => {
                expect((await hookApi!.startPairing()).ok).toBe(true);
                await Promise.resolve();
            });
            expect(pairingStatusMock).toHaveBeenCalledTimes(1);

            activeServerId = 'srv-b';
            activeServerUrl = 'https://other.example.test';
            activeServerGeneration += 1;
            await act(async () => {
                await vi.advanceTimersByTimeAsync(1_100);
            });

            expect(pairingStatusMock).toHaveBeenCalledTimes(1);
            expect(hookApi!.deepLink).toBeNull();
            expect(hookApi!.status).toBeNull();
        } finally {
            act(() => tree.unmount());
            vi.useRealTimers();
        }
    });

    it('does not publish a status response after the active server changes in flight', async () => {
        cachedCanonicalServerUrl = 'https://api.example.test';
        let resolvePoll!: (value: any) => void;
        pairingStatusMock.mockImplementationOnce(async () => await new Promise((resolve) => {
            resolvePoll = resolve;
        }));

        const { usePairingSession } = await import('./usePairingSession');
        let hookApi: ReturnType<typeof usePairingSession> | null = null;
        function Probe() {
            hookApi = usePairingSession({ enabled: true, isAuthenticated: true });
            return null;
        }

        const tree = (await renderScreen(<Probe />)).tree;
        try {
            await act(async () => {
                expect((await hookApi!.startPairing()).ok).toBe(true);
                await Promise.resolve();
            });
            expect(pairingStatusMock).toHaveBeenCalledTimes(1);

            activeServerId = 'srv-b';
            activeServerUrl = 'https://other.example.test';
            activeServerGeneration += 1;
            resolvePoll({
                ok: true,
                data: {
                    state: 'requested',
                    pairId: `claim_${'a'.repeat(43)}`,
                    expiresAt: Date.now() + 60_000,
                    requestedPublicKey: 'pk-other',
                    requestedDeviceLabel: null,
                    confirmCode: '999999',
                },
            });
            await act(async () => {
                await Promise.resolve();
            });

            expect(hookApi!.deepLink).toBeNull();
            expect(hookApi!.status).toBeNull();
        } finally {
            act(() => tree.unmount());
        }
    });
});
