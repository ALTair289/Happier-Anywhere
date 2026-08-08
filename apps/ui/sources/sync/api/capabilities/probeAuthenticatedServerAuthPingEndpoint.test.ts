import { afterEach, describe, expect, it, vi } from 'vitest';

import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';

import { probeAuthenticatedServerAuthPingEndpoint } from './probeAuthenticatedServerAuthPingEndpoint';

afterEach(() => {
    resetRuntimeFetch();
});

function stubAuthPing(response: Response | (() => Promise<Response>)) {
    const spy = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (!url.endsWith('/v1/auth/ping')) {
            throw new Error(`Unexpected probe URL: ${url}`);
        }
        return typeof response === 'function' ? await response() : response;
    });
    setRuntimeFetch(spy);
    return spy;
}

const jsonHeaders = { 'Content-Type': 'application/json' } as const;

describe('probeAuthenticatedServerAuthPingEndpoint', () => {
    it('reports ready for the documented authenticated ping response', async () => {
        stubAuthPing(new Response('{"ok":true}', { status: 200, headers: jsonHeaders }));

        await expect(probeAuthenticatedServerAuthPingEndpoint({
            endpoint: 'https://example.test',
            token: 'token-a',
        })).resolves.toEqual({ status: 'ready' });
    });

    it('does not report ready when the endpoint does not serve the authenticated ping route', async () => {
        stubAuthPing(new Response('Not Found', { status: 404, headers: { 'Content-Type': 'text/plain' } }));

        const result = await probeAuthenticatedServerAuthPingEndpoint({
            endpoint: 'https://example.test',
            token: 'token-a',
        });

        expect(result.status).toBe('server_unreachable');
    });

    it('does not report ready when an interceptor answers 200 with a non-Happier body', async () => {
        // Captive portal / transparent proxy: HTTP 200, but not this server.
        stubAuthPing(new Response('<html><body>Sign in to WiFi</body></html>', {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
        }));

        const result = await probeAuthenticatedServerAuthPingEndpoint({
            endpoint: 'https://example.test',
            token: 'token-a',
        });

        expect(result.status).toBe('server_unreachable');
    });

    it('preserves auth_failed classification for 401/403', async () => {
        stubAuthPing(new Response('Unauthorized', { status: 401 }));

        await expect(probeAuthenticatedServerAuthPingEndpoint({
            endpoint: 'https://example.test',
            token: 'token-a',
        })).resolves.toEqual({
            status: 'auth_failed',
            statusCode: 401,
            errorMessage: 'Authenticated probe returned 401',
        });
    });

    it('preserves retry_later classification (and Retry-After) for server-side backpressure', async () => {
        stubAuthPing(new Response('Server reload in progress', {
            status: 503,
            headers: { 'Retry-After': '2', 'X-Happier-Retry-Reason': 'server_restarting' },
        }));

        const result = await probeAuthenticatedServerAuthPingEndpoint({
            endpoint: 'https://example.test',
            token: 'token-a',
        });

        expect(result).toMatchObject({
            status: 'retry_later',
            retryAfterMs: 2000,
            reason: 'server_restarting',
        });
    });
});
