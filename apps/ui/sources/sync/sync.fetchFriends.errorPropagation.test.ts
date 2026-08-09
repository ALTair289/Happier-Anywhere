import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/log', () => ({
    log: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const fetchAndApplyFriendsSpy = vi.hoisted(() => vi.fn(async (..._args: any[]) => {
    throw new Error('boom');
}));

vi.mock('./engine/social/syncFriends', () => ({
    fetchAndApplyFriends: (...args: any[]) => fetchAndApplyFriendsSpy(...args),
}));

describe('sync fetchFriends error propagation', () => {
    afterEach(() => {
        fetchAndApplyFriendsSpy.mockClear();
        vi.resetModules();
    });

    it('propagates errors so InvalidateSync can own retry/backoff semantics', async () => {
        const { sync } = await import('./sync');
        (sync as any).credentials = { token: 'token', secret: 'secret' };

        await expect((sync as any).fetchFriends()).rejects.toThrow('boom');
        expect(fetchAndApplyFriendsSpy).toHaveBeenCalledTimes(1);
    });
});
