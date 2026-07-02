import { describe, expect, it, vi } from 'vitest';

import { fetchSessionListPageCompat } from './sessionHttpCompat';

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}

describe('fetchSessionListPageCompat', () => {
    it('preserves public runtime activity projection fields when coercing legacy session rows', async () => {
        const request = vi.fn(async (path: string) => {
            if (path === '/v2/sessions?limit=50') {
                return jsonResponse({ error: 'Not found', path: '/v2/sessions' }, 404);
            }
            if (path === '/v1/sessions') {
                return jsonResponse({
                    sessions: [{
                        id: 's1',
                        seq: 1,
                        createdAt: 10,
                        updatedAt: 20,
                        active: true,
                        activeAt: 30,
                        metadata: '{}',
                        metadataVersion: 1,
                        agentState: null,
                        agentStateVersion: 0,
                        dataEncryptionKey: null,
                        runtimeActivityActiveCount: 2,
                        runtimeActivityObservedAt: 40,
                        runtimeActivityExpiresAt: 50,
                        runtimeActivitySourceClass: 'provider_detached_task',
                    }],
                });
            }
            throw new Error(`Unexpected request path: ${path}`);
        });

        const page = await fetchSessionListPageCompat({
            request,
            token: 'token',
            limit: 50,
        });

        expect(page.source).toBe('v1');
        expect(page.sessions[0]).toEqual(expect.objectContaining({
            runtimeActivityActiveCount: 2,
            runtimeActivityObservedAt: 40,
            runtimeActivityExpiresAt: 50,
            runtimeActivitySourceClass: 'provider_detached_task',
        }));
    });
});
