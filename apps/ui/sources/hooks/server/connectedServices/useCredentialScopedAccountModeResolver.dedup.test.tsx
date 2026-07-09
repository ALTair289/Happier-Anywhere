import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as React from 'react';

import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { flushHookEffects, renderHook } from '@/dev/testkit';

import { useCredentialScopedAccountModeResolver } from './useCredentialScopedAccountModeResolver';

/**
 * VERIFY-FIRST regression guard for the cold-load account-mode preflight.
 *
 * `useCredentialScopedAccountModeResolver` caches the resolved mode PER HOOK
 * INSTANCE, so N mounted account blocks each call `fetchAccountEncryptionMode`
 * once. The claim under test is whether that produces N redundant NETWORK
 * round-trips on cold load. It does NOT: `fetchAccountEncryptionMode` owns a
 * module-level, (server + credential-token)-scoped dedup+TTL cache, so N
 * concurrent preflights for the same credential scope collapse to ONE GET.
 *
 * This test exercises the REAL resolver + REAL `fetchAccountEncryptionMode`
 * (only the HTTP/runtime boundary is mocked) and pins the invariant: N account
 * blocks in one credential scope trigger ONE encryption GET.
 */

const credentials: AuthCredentials = { token: 't', secret: 's' };

vi.mock('@/utils/timing/time', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/utils/timing/time')>();
    const immediate = async <T,>(callback: () => Promise<T>): Promise<T> => await callback();
    return { ...actual, backoff: immediate };
});

vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: () => ({
        serverId: 'test',
        serverUrl: 'https://api.example.test',
        kind: 'custom',
        generation: 1,
    }),
}));

const { encryptionGetSpy, serverFetch } = vi.hoisted(() => {
    const spy = vi.fn();
    return {
        encryptionGetSpy: spy,
        serverFetch: vi.fn(async (path: string, init?: RequestInit) => {
            if (path === '/v1/account/encryption' && (init?.method ?? 'GET') === 'GET') {
                spy();
                return new Response(JSON.stringify({ mode: 'plain', updatedAt: 7 }), { status: 200 });
            }
            throw new Error(`Unexpected serverFetch to ${path}`);
        }),
    };
});
vi.mock('@/sync/http/client', () => ({ serverFetch }));

function useManyResolvers(count: number, credentialScope: string): ReadonlyArray<() => Promise<'plain' | 'e2ee'>> {
    const resolvers: Array<() => Promise<'plain' | 'e2ee'>> = [];
    for (let i = 0; i < count; i += 1) {
        // Rules-of-hooks safe: `count` is constant for the lifetime of the test render.
        // eslint-disable-next-line react-hooks/rules-of-hooks
        resolvers.push(useCredentialScopedAccountModeResolver({ credentials, credentialScope }));
    }
    return resolvers;
}

describe('useCredentialScopedAccountModeResolver — cold-load network dedup', () => {
    beforeEach(async () => {
        vi.clearAllMocks();
        const { invalidateAccountEncryptionModeCache } = await import('@/sync/api/account/apiAccountEncryptionMode');
        invalidateAccountEncryptionModeCache();
    });

    it('N account blocks in one credential scope trigger exactly ONE encryption GET', async () => {
        const ACCOUNT_BLOCKS = 6;
        const hook = await renderHook(() => useManyResolvers(ACCOUNT_BLOCKS, 'scope-A'));
        await flushHookEffects({ cycles: 3, turns: 3 });

        const resolvers = hook.getCurrent();
        expect(resolvers).toHaveLength(ACCOUNT_BLOCKS);

        // Cold load: every account block resolves its mode concurrently.
        const modes = await Promise.all(resolvers.map((resolve) => resolve()));

        expect(modes).toEqual(new Array(ACCOUNT_BLOCKS).fill('plain'));
        expect(encryptionGetSpy).toHaveBeenCalledTimes(1);

        await hook.unmount();
    });
});
