import { describe, expect, it } from 'vitest';

import { createPendingDomain } from './pending';

function createHarness(initial: any = {}) {
    let state: any = {
        sessions: {},
        sessionPending: {},
        sessionMessages: {},
        ...initial,
    };

    const get = () => state;
    const set = (updater: any) => {
        const next = typeof updater === 'function' ? updater(state) : updater;
        if (next === state) return;
        state = { ...state, ...next };
    };

    const domain = createPendingDomain({ get, set } as any);
    return { get, domain };
}

describe('pending domain: ordering', () => {
    it('preserves state references for equivalent loaded pending refreshes', () => {
        const { get, domain } = createHarness();
        const pendingMessage = {
            id: 'p1',
            localId: 'p1',
            createdAt: 2_000,
            updatedAt: 2_000,
            text: 'pending',
            rawRecord: { role: 'user', content: { type: 'text', text: 'pending' } } as any,
        };
        const discardedMessage = {
            id: 'd1',
            localId: 'd1',
            createdAt: 3_000,
            updatedAt: 3_000,
            text: 'discarded',
            rawRecord: { role: 'user', content: { type: 'text', text: 'discarded' } } as any,
            discardedAt: 3_100,
            discardedReason: 'manual' as const,
        };

        domain.applyPendingMessages('s1', [pendingMessage]);
        domain.applyDiscardedPendingMessages('s1', [discardedMessage]);
        domain.applyPendingLoaded('s1');
        const stateBefore = get();
        const bucketBefore = stateBefore.sessionPending.s1;
        const messagesBefore = bucketBefore.messages;
        const discardedBefore = bucketBefore.discarded;

        domain.applyPendingMessages('s1', [{ ...pendingMessage }]);
        domain.applyDiscardedPendingMessages('s1', [{ ...discardedMessage }]);
        domain.applyPendingLoaded('s1');

        expect(get()).toBe(stateBefore);
        expect(get().sessionPending.s1).toBe(bucketBefore);
        expect(get().sessionPending.s1.messages).toBe(messagesBefore);
        expect(get().sessionPending.s1.discarded).toBe(discardedBefore);
    });

    it('preserves state references for equivalent upserts and absent removals', () => {
        const { get, domain } = createHarness();
        const pendingMessage = {
            id: 'p1',
            localId: 'p1',
            createdAt: 2_000,
            updatedAt: 2_000,
            text: 'pending',
            rawRecord: { role: 'user', content: { type: 'text', text: 'pending' } } as any,
        };

        domain.upsertPendingMessage('s1', pendingMessage);
        const stateBeforeEquivalentUpsert = get();
        const bucketBeforeEquivalentUpsert = stateBeforeEquivalentUpsert.sessionPending.s1;

        domain.upsertPendingMessage('s1', { ...pendingMessage });

        expect(get()).toBe(stateBeforeEquivalentUpsert);
        expect(get().sessionPending.s1).toBe(bucketBeforeEquivalentUpsert);

        const stateBeforeAbsentRemoval = get();
        domain.removePendingMessage('s1', 'missing-pending-id');

        expect(get()).toBe(stateBeforeAbsentRemoval);
    });

    it('keeps newly queued pending messages in arrival order even when timestamps regress', () => {
        const { get, domain } = createHarness();

        domain.upsertPendingMessage('s1', {
            id: 'p1',
            localId: 'p1',
            createdAt: 2_000,
            updatedAt: 2_000,
            text: 'first',
            rawRecord: { role: 'user', content: { type: 'text', text: 'first' } } as any,
        });

        domain.upsertPendingMessage('s1', {
            id: 'p2',
            localId: 'p2',
            createdAt: 1_000,
            updatedAt: 1_000,
            text: 'second',
            rawRecord: { role: 'user', content: { type: 'text', text: 'second' } } as any,
        });

        expect(get().sessionPending.s1.messages.map((message: any) => message.id)).toEqual(['p1', 'p2']);
    });

    it('keeps unresolved server pending rows visible even when their localId is committed in the transcript', () => {
        const { get, domain } = createHarness({
            sessionMessages: {
                s1: {
                    messagesById: {
                        m1: {
                            id: 'm1',
                            kind: 'user-text',
                            localId: 'p1',
                            createdAt: 3_000,
                            text: 'committed',
                        },
                    },
                    messagesMap: {},
                },
            },
        });

        domain.applyPendingMessages('s1', [
            {
                id: 'p1',
                localId: 'p1',
                source: 'server_pending',
                createdAt: 1_000,
                updatedAt: 1_000,
                text: 'already committed',
                rawRecord: { role: 'user', content: { type: 'text', text: 'already committed' } } as any,
            },
            {
                id: 'p2',
                localId: 'p2',
                source: 'server_pending',
                createdAt: 2_000,
                updatedAt: 2_000,
                text: 'still pending',
                rawRecord: { role: 'user', content: { type: 'text', text: 'still pending' } } as any,
            },
            {
                id: 'local-stale-p1',
                localId: 'p1',
                source: 'local_outbound',
                createdAt: 3_000,
                updatedAt: 3_000,
                text: 'local stale projection',
                rawRecord: { role: 'user', content: { type: 'text', text: 'local stale projection' } } as any,
            },
        ]);
        domain.upsertPendingMessage('s1', {
            id: 'p1',
            localId: 'p1',
            source: 'server_pending',
            createdAt: 4_000,
            updatedAt: 4_000,
            text: 'late stale upsert',
            rawRecord: { role: 'user', content: { type: 'text', text: 'late stale upsert' } } as any,
        });

        expect(get().sessionPending.s1.messages.map((message: any) => message.id)).toEqual(['p1', 'p2']);
        expect(get().sessionPending.s1.messages[0].text).toBe('late stale upsert');
    });
});
