import { afterEach, describe, expect, it, vi } from 'vitest';

const runtimeFetchMock = vi.hoisted(() => vi.fn());
const appState = vi.hoisted(() => ({ currentState: 'active' as string }));

vi.mock('@/utils/system/runtimeFetch', () => ({
    runtimeFetch: runtimeFetchMock,
}));

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

function requestedUrls(): string[] {
    return runtimeFetchMock.mock.calls.map((call) => String(call[0]));
}

describe('createEndpointReadinessProbe', () => {
    afterEach(() => {
        runtimeFetchMock.mockReset();
        appState.currentState = 'active';
        vi.resetModules();
        vi.useRealTimers();
    });

    it('answers readiness with a single authenticated ping when a token is available', async () => {
        runtimeFetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        }));

        const { createEndpointReadinessProbe } = await import('./createEndpointReadinessProbe');
        const probe = createEndpointReadinessProbe({
            endpoint: 'https://server.example.test',
            token: async () => 'token-1',
            timeoutMs: 50,
        });

        await expect(probe()).resolves.toEqual({ status: 'ready' });
        expect(requestedUrls()).toEqual(['https://server.example.test/v1/auth/ping']);

        const init = runtimeFetchMock.mock.calls.at(-1)?.[1] as RequestInit | undefined;
        expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer token-1');
    });

    it('does not report ready when a captive portal answers the authenticated ping with an HTML 200', async () => {
        runtimeFetchMock.mockResolvedValue(new Response('<html><body>Sign in to WiFi</body></html>', {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
        }));

        const { createEndpointReadinessProbe } = await import('./createEndpointReadinessProbe');
        const probe = createEndpointReadinessProbe({
            endpoint: 'https://server.example.test',
            token: 'token-1',
            timeoutMs: 50,
        });

        await expect(probe()).resolves.toEqual(
            expect.objectContaining({ status: 'server_unreachable' }),
        );
    });

    it('does not report ready when the host does not serve the authenticated ping route', async () => {
        runtimeFetchMock.mockResolvedValue(new Response('Not Found', {
            status: 404,
            headers: { 'Content-Type': 'text/plain' },
        }));

        const { createEndpointReadinessProbe } = await import('./createEndpointReadinessProbe');
        const probe = createEndpointReadinessProbe({
            endpoint: 'https://server.example.test',
            token: 'token-1',
            timeoutMs: 50,
        });

        await expect(probe()).resolves.toEqual(
            expect.objectContaining({ status: 'server_unreachable' }),
        );
        expect(requestedUrls()).toEqual(['https://server.example.test/v1/auth/ping']);
    });

    it('skips network probes when the app is backgrounded', async () => {
        appState.currentState = 'background';
        runtimeFetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));

        const { createEndpointReadinessProbe } = await import('./createEndpointReadinessProbe');

        const probe = createEndpointReadinessProbe({
            endpoint: 'https://server.example.test',
            token: 'token-1',
            timeoutMs: 50,
        });

        await expect(probe()).resolves.toEqual(expect.objectContaining({ status: 'retry_later' }));
        expect(runtimeFetchMock).toHaveBeenCalledTimes(0);
    });

    it('skips network probes when the runtime tab is hidden (web)', async () => {
        const globalWithDocument = globalThis as unknown as { document?: unknown };
        const originalDocument = globalWithDocument.document;
        try {
            globalWithDocument.document = { visibilityState: 'hidden' };

            runtimeFetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));

            const { createEndpointReadinessProbe } = await import('./createEndpointReadinessProbe');
            const probe = createEndpointReadinessProbe({
                endpoint: 'https://server.example.test',
                token: 'token-1',
                timeoutMs: 50,
            });

            await expect(probe()).resolves.toEqual(expect.objectContaining({ status: 'retry_later' }));
            expect(runtimeFetchMock).toHaveBeenCalledTimes(0);
        } finally {
            globalWithDocument.document = originalDocument;
        }
    });

    it('fails closed without network calls when the endpoint URL is invalid', async () => {
        runtimeFetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));

        const { createEndpointReadinessProbe } = await import('./createEndpointReadinessProbe');
        const probe = createEndpointReadinessProbe({
            endpoint: 'localhost:3000',
            token: 'token-1',
            timeoutMs: 50,
        });

        await expect(probe()).resolves.toEqual(
            expect.objectContaining({
                status: 'server_unreachable',
                errorMessage: expect.stringContaining('Invalid endpoint'),
            }),
        );
        expect(runtimeFetchMock).toHaveBeenCalledTimes(0);
    });

    it('classifies authenticated rejection as auth_failed', async () => {
        runtimeFetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: false }), { status: 401 }));

        const { createEndpointReadinessProbe } = await import('./createEndpointReadinessProbe');
        const probe = createEndpointReadinessProbe({
            endpoint: 'https://server.example.test',
            token: 'token-1',
            timeoutMs: 50,
        });

        await expect(probe()).resolves.toEqual(
            expect.objectContaining({ status: 'auth_failed', statusCode: 401 }),
        );
    });

    it('marks proxy maintenance 503 responses as planned server restarts', async () => {
        runtimeFetchMock.mockResolvedValue(new Response('Server reload in progress\n', {
            status: 503,
            headers: {
                'Retry-After': '2',
                'X-Happier-Retry-Reason': 'server_restarting',
            },
        }));

        const { createEndpointReadinessProbe } = await import('./createEndpointReadinessProbe');
        const probe = createEndpointReadinessProbe({
            endpoint: 'https://server.example.test',
            token: 'token-1',
            timeoutMs: 50,
        });

        await expect(probe()).resolves.toEqual(
            expect.objectContaining({
                status: 'retry_later',
                retryAfterMs: 2000,
                reason: 'server_restarting',
            }),
        );
    });

    it('falls back to an unauthenticated health check when no token is available', async () => {
        runtimeFetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));

        const { createEndpointReadinessProbe } = await import('./createEndpointReadinessProbe');
        const probe = createEndpointReadinessProbe({
            endpoint: 'https://server.example.test',
            token: () => null,
            timeoutMs: 50,
        });

        await expect(probe()).resolves.toEqual({ status: 'ready' });
        expect(requestedUrls()).toEqual(['https://server.example.test/health']);
    });

    it('returns retry_later when the unauthenticated health check is rate limited', async () => {
        runtimeFetchMock.mockResolvedValue(new Response('', { status: 429, headers: { 'Retry-After': '2' } }));

        const { createEndpointReadinessProbe } = await import('./createEndpointReadinessProbe');
        const probe = createEndpointReadinessProbe({
            endpoint: 'https://server.example.test',
            token: () => null,
            timeoutMs: 50,
        });

        await expect(probe()).resolves.toEqual(
            expect.objectContaining({ status: 'retry_later', retryAfterMs: 2000 }),
        );
    });

    it('sanitizes error messages from runtimeFetch failures', async () => {
        runtimeFetchMock.mockRejectedValue(
            new Error('Failed to fetch https://admin:secret@custom.example.test:9443/path/?token=abc#frag (Bearer hdr.eyJzdWIiOiJ0ZXN0In0.sig)'),
        );

        const { createEndpointReadinessProbe } = await import('./createEndpointReadinessProbe');
        const probe = createEndpointReadinessProbe({
            endpoint: 'https://admin:secret@custom.example.test:9443/path/?token=abc#frag',
            token: 'token-1',
            timeoutMs: 50,
        });

        const result = await probe();
        expect(result.status).toBe('server_unreachable');
        if (result.status !== 'server_unreachable') {
            throw new Error('Expected server_unreachable');
        }
        expect(result.errorMessage).toContain('https://custom.example.test:9443/path');
        expect(result.errorMessage).not.toContain('admin:secret@');
        expect(result.errorMessage).not.toContain('token=abc');
        expect(result.errorMessage).toContain('Bearer [REDACTED]');
        expect(result.errorMessage).not.toContain('hdr.eyJ');
    });
});
