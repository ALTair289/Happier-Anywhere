import { describe, expect, it, vi } from 'vitest';

import { CodexAppServerHistoryBoundary } from './codexAppServerHistoryBoundary';

describe('CodexAppServerHistoryBoundary', () => {
    it('retains every identity in one authoritative hydration beyond 2,048 items', async () => {
        const boundary = new CodexAppServerHistoryBoundary();
        const emit = vi.fn();
        const items = Array.from({ length: 2_050 }, (_, index) => ({ id: `item-${index}` }));

        await boundary.hydrateFromThreadSnapshot({
            thread: {
                id: 'thread-history',
                turns: [{ id: 'turn-history', status: 'inProgress', items }],
            },
        });
        await boundary.onNotification({
            method: 'item/completed',
            params: {
                threadId: 'thread-history',
                turnId: 'turn-history',
                item: { id: 'item-0' },
            },
        }, emit);

        expect(emit).not.toHaveBeenCalled();
    });

    it('atomically reserves a completed item identity before awaiting emission', async () => {
        const boundary = new CodexAppServerHistoryBoundary();
        await boundary.hydrateFromThreadSnapshot({ thread: { id: 'thread-live', turns: [] } });
        let releaseFirst!: () => void;
        const firstEmission = new Promise<void>((resolve) => {
            releaseFirst = resolve;
        });
        const emit = vi.fn(async () => await firstEmission);
        const notification = {
            method: 'item/completed',
            params: {
                threadId: 'thread-live',
                turnId: 'turn-live',
                item: { id: 'item-live' },
            },
        };

        const first = boundary.onNotification(notification, emit);
        const duplicate = boundary.onNotification(notification, emit);
        await Promise.resolve();

        expect(emit).toHaveBeenCalledTimes(1);
        releaseFirst();
        await Promise.all([first, duplicate]);
        expect(emit).toHaveBeenCalledTimes(1);
    });

    it('fails closed for a child scope absent from hydration while releasing a new parent event once', async () => {
        const boundary = new CodexAppServerHistoryBoundary();
        const historicalChildEmit = vi.fn();
        const liveParentEmit = vi.fn();

        await boundary.onNotification({
            method: 'item/completed',
            params: {
                threadId: 'thread-child-history',
                turnId: 'turn-child-history',
                item: { id: 'item-child-history' },
            },
        }, historicalChildEmit);
        await boundary.onNotification({
            method: 'item/completed',
            params: {
                threadId: 'thread-parent',
                turnId: 'turn-new-parent',
                item: { id: 'item-new-parent' },
            },
        }, liveParentEmit);

        await boundary.hydrateFromThreadSnapshot({ thread: { id: 'thread-parent', turns: [] } });

        expect(historicalChildEmit).not.toHaveBeenCalled();
        expect(liveParentEmit).toHaveBeenCalledTimes(1);
    });

    it('fails closed when hydration cannot establish a durable thread identity', async () => {
        const boundary = new CodexAppServerHistoryBoundary();
        const emit = vi.fn();
        await boundary.onNotification({
            method: 'turn/started',
            params: { turn: { id: 'turn-without-thread' } },
        }, emit);

        await expect(boundary.hydrateFromThreadSnapshot({ turns: [] }))
            .rejects.toThrow('codex_app_server_history_identity_unavailable');
        expect(emit).not.toHaveBeenCalled();
        await expect(boundary.onNotification({
            method: 'turn/started',
            params: { turn: { id: 'later-turn' } },
        }, emit)).rejects.toThrow('codex_app_server_history_identity_unavailable');
    });

    it('releases completion for an explicitly in-progress hydrated item once', async () => {
        const boundary = new CodexAppServerHistoryBoundary();
        const emit = vi.fn();
        await boundary.onNotification({
            method: 'item/completed',
            params: {
                threadId: 'thread-current',
                turnId: 'turn-current',
                item: { id: 'item-current', status: 'completed' },
            },
        }, emit);

        await boundary.hydrateFromThreadSnapshot({
            thread: {
                id: 'thread-current',
                turns: [{
                    id: 'turn-current',
                    status: 'inProgress',
                    items: [{ id: 'item-current', status: 'inProgress' }],
                }],
            },
        });

        expect(emit).toHaveBeenCalledTimes(1);
    });
});
