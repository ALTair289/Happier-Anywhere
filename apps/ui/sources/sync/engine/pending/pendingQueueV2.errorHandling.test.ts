import { beforeEach, describe, expect, it } from 'vitest';

import { storage } from '@/sync/domains/state/storage';
import type { DiscardedPendingMessage } from '@/sync/domains/state/storageTypes';

import {
    deleteDiscardedPendingMessageV2,
    deletePendingMessageV2,
    discardPendingMessageV2,
    enqueuePendingMessageV2,
    fetchAndApplyPendingMessagesV2,
    markPendingDeliveryHandledV2,
    reorderPendingMessagesV2,
    retryPendingMessageEnqueueV2,
    retryPendingDeliveryV2,
    restoreDiscardedPendingMessageV2,
    updatePendingMessageV2,
} from './pendingQueueV2';
import { buildSession, createPendingQueueEncryption, resetPendingQueueState } from './pendingQueueV2.testHelpers';

function buildDiscardedPendingMessage(): DiscardedPendingMessage {
    return {
        id: 'd1',
        localId: 'd1',
        createdAt: 1,
        updatedAt: 1,
        text: 'x',
        rawRecord: { role: 'user', content: { type: 'text', text: 'x' } },
        discardedAt: 2,
        discardedReason: 'manual',
    };
}

async function expectNotAuthenticated(promise: Promise<unknown>, status: 401 | 403): Promise<void> {
    await expect(promise).rejects.toMatchObject({
        name: 'HappyError',
        canTryAgain: false,
        kind: 'auth',
        code: 'not_authenticated',
        status,
    });
}

function insertEditablePendingMessage(sessionId: string): void {
    storage.getState().applySessions([buildSession({ sessionId })]);
    storage.getState().upsertPendingMessage(sessionId, {
        id: 'p1',
        localId: 'p1',
        createdAt: 1,
        updatedAt: 1,
        text: 'original',
        rawRecord: {
            role: 'user',
            content: { type: 'text', text: 'original' },
            meta: {},
        },
    });
}

describe('pendingQueueV2 error handling', () => {
    beforeEach(() => {
        resetPendingQueueState();
    });

    it('clears discarded messages when the pending fetch fails', async () => {
        const sessionId = 's_test';
        const encryption = await createPendingQueueEncryption({ sessionId });

        storage.getState().applyDiscardedPendingMessages(sessionId, [buildDiscardedPendingMessage()]);

        await fetchAndApplyPendingMessagesV2({
            sessionId,
            encryption,
            request: async () => new Response('nope', { status: 500 }),
        });

        const pendingState = storage.getState().sessionPending[sessionId];
        expect(pendingState?.discarded ?? []).toEqual([]);
        expect(pendingState?.isLoaded).toBe(true);
    });

    it('clears discarded messages when the pending response JSON shape is invalid', async () => {
        const sessionId = 's_test_bad_shape';
        const encryption = await createPendingQueueEncryption({ sessionId });

        storage.getState().applyDiscardedPendingMessages(sessionId, [buildDiscardedPendingMessage()]);

        await fetchAndApplyPendingMessagesV2({
            sessionId,
            encryption,
            request: async () => new Response(JSON.stringify({ pending: 'bad' }), { status: 200 }),
        });

        const pendingState = storage.getState().sessionPending[sessionId];
        expect(pendingState?.discarded ?? []).toEqual([]);
        expect(pendingState?.isLoaded).toBe(true);
    });

    it('clears discarded messages when response JSON parsing fails', async () => {
        const sessionId = 's_test_parse_fail';
        const encryption = await createPendingQueueEncryption({ sessionId, seedByte: 6 });

        storage.getState().applyDiscardedPendingMessages(sessionId, [buildDiscardedPendingMessage()]);

        await fetchAndApplyPendingMessagesV2({
            sessionId,
            encryption,
            request: async () => new Response('{', { status: 200 }),
        });

        const pendingState = storage.getState().sessionPending[sessionId];
        expect(pendingState?.discarded ?? []).toEqual([]);
        expect(pendingState?.isLoaded).toBe(true);
    });

    it.each([401, 403] as const)('surfaces pending fetch auth status %s as not_authenticated', async (status) => {
        const sessionId = `s_test_fetch_auth_${status}`;
        const encryption = await createPendingQueueEncryption({ sessionId, seedByte: 7 });
        const discarded = buildDiscardedPendingMessage();

        storage.getState().applyDiscardedPendingMessages(sessionId, [discarded]);

        await expectNotAuthenticated(
            fetchAndApplyPendingMessagesV2({
                sessionId,
                encryption,
                request: async () => new Response(null, { status }),
            }),
            status,
        );

        const pendingState = storage.getState().sessionPending[sessionId];
        expect(pendingState?.discarded ?? []).toEqual([discarded]);
        expect(pendingState?.isLoaded ?? false).toBe(false);
    });

    it('keeps the local pending row when pending enqueue fails from transient connectivity', async () => {
        const sessionId = 's_test_enqueue_timeout';
        storage.getState().applySessions([buildSession({ sessionId })]);
        const encryption = await createPendingQueueEncryption({ sessionId, seedByte: 10 });
        const timeoutError = Object.assign(new Error('operation has timed out'), {
            name: 'ServerFetchConnectivityTimeoutError',
        });

        await expect(enqueuePendingMessageV2({
            sessionId,
            text: 'hello',
            encryption,
            request: async () => {
                throw timeoutError;
            },
        })).resolves.toEqual({
            accepted: false,
            localId: expect.any(String),
        });

        expect(storage.getState().sessionPending[sessionId]?.messages ?? []).toEqual([
            expect.objectContaining({
                source: 'local_outbound',
                deliveryStatus: 'queued',
                text: 'hello',
            }),
        ]);
        expect(storage.getState().sessions[sessionId].optimisticThinkingAt ?? null).toBeNull();
    });

    it.each([401, 403] as const)('surfaces pending mutation auth status %s as not_authenticated', async (status) => {
        const sessionId = `s_test_mutation_auth_${status}`;
        const encryption = await createPendingQueueEncryption({ sessionId, seedByte: 8 });
        insertEditablePendingMessage(sessionId);
        const request = async () => new Response(null, { status });

        const mutations: Array<() => Promise<void>> = [
            () => updatePendingMessageV2({ sessionId, pendingId: 'p1', text: 'new text', encryption, request }),
            () => deletePendingMessageV2({ sessionId, pendingId: 'p1', request }),
            () => discardPendingMessageV2({ sessionId, pendingId: 'p1', encryption, request }),
            () => restoreDiscardedPendingMessageV2({ sessionId, pendingId: 'p1', encryption, request }),
            () => deleteDiscardedPendingMessageV2({ sessionId, pendingId: 'p1', encryption, request }),
            () => reorderPendingMessagesV2({ sessionId, orderedLocalIds: ['p1'], encryption, request }),
            () => retryPendingDeliveryV2({ sessionId, pendingId: 'p1', encryption, request }),
            () => markPendingDeliveryHandledV2({ sessionId, pendingId: 'p1', encryption, request }),
        ];

        for (const runMutation of mutations) {
            await expectNotAuthenticated(runMutation(), status);
        }
    });

    it('removes a locally queued pending row without requiring a server delete', async () => {
        const sessionId = 's_test_delete_local_queued';
        storage.getState().applySessions([buildSession({ sessionId })]);
        storage.getState().upsertPendingMessage(sessionId, {
            id: 'local-delete-me',
            localId: 'local-delete-me',
            createdAt: 111,
            updatedAt: 111,
            source: 'local_outbound',
            deliveryStatus: 'queued',
            text: 'cancel before enqueue',
            rawRecord: {
                role: 'user',
                content: { type: 'text', text: 'cancel before enqueue' },
                meta: {},
            },
        });

        let requestCalled = false;
        await expect(deletePendingMessageV2({
            sessionId,
            pendingId: 'local-delete-me',
            request: async () => {
                requestCalled = true;
                throw new TypeError('Failed to fetch');
            },
        })).resolves.toBeUndefined();

        expect(requestCalled).toBe(false);
        expect(storage.getState().sessionPending[sessionId]?.messages ?? []).toEqual([]);
    });

    it('retries a locally queued pending enqueue and marks the row accepted after the server accepts it', async () => {
        const sessionId = 's_test_retry_pending_enqueue';
        storage.getState().applySessions([buildSession({ sessionId })]);
        const encryption = await createPendingQueueEncryption({ sessionId, seedByte: 11 });

        storage.getState().upsertPendingMessage(sessionId, {
            id: 'local-pending-retry',
            localId: 'local-pending-retry',
            createdAt: 111,
            updatedAt: 111,
            source: 'local_outbound',
            deliveryStatus: 'queued',
            text: 'retry me',
            rawRecord: {
                role: 'user',
                content: { type: 'text', text: 'retry me' },
                meta: {},
            },
        });

        const bodies: unknown[] = [];
        await expect(retryPendingMessageEnqueueV2({
            sessionId,
            localId: 'local-pending-retry',
            encryption,
            request: async (_path, init) => {
                bodies.push(JSON.parse(String(init?.body ?? 'null')));
                return new Response(null, { status: 200 });
            },
        })).resolves.toEqual({ accepted: true });

        expect(bodies).toEqual([
            expect.objectContaining({
                localId: 'local-pending-retry',
                messageRole: 'user',
            }),
        ]);
        expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
            expect.objectContaining({
                id: 'local-pending-retry',
                localId: 'local-pending-retry',
                source: 'local_outbound',
                deliveryStatus: 'accepted',
                text: 'retry me',
            }),
        ]);
    });

    it('keeps the locally queued pending enqueue row when retry still has transient connectivity', async () => {
        const sessionId = 's_test_retry_pending_enqueue_transient';
        storage.getState().applySessions([buildSession({ sessionId })]);
        const encryption = await createPendingQueueEncryption({ sessionId, seedByte: 12 });

        storage.getState().upsertPendingMessage(sessionId, {
            id: 'local-pending-retry-transient',
            localId: 'local-pending-retry-transient',
            createdAt: 111,
            updatedAt: 111,
            source: 'local_outbound',
            deliveryStatus: 'queued',
            text: 'retry transient',
            rawRecord: {
                role: 'user',
                content: { type: 'text', text: 'retry transient' },
                meta: {},
            },
        });

        await expect(retryPendingMessageEnqueueV2({
            sessionId,
            localId: 'local-pending-retry-transient',
            encryption,
            request: async () => {
                throw new TypeError('Failed to fetch');
            },
        })).resolves.toEqual({ accepted: false });

        expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
            expect.objectContaining({
                id: 'local-pending-retry-transient',
                localId: 'local-pending-retry-transient',
                source: 'local_outbound',
                deliveryStatus: 'queued',
                text: 'retry transient',
            }),
        ]);
    });

    it('preserves generic status errors for non-auth pending mutations', async () => {
        const sessionId = 's_test_mutation_generic_error';
        const encryption = await createPendingQueueEncryption({ sessionId, seedByte: 9 });
        insertEditablePendingMessage(sessionId);
        const request = async () => new Response(null, { status: 500 });

        const mutations: Array<{ run: () => Promise<void>; message: string }> = [
            {
                run: () => updatePendingMessageV2({ sessionId, pendingId: 'p1', text: 'new text', encryption, request }),
                message: 'Failed to update pending message (500)',
            },
            {
                run: () => deletePendingMessageV2({ sessionId, pendingId: 'p1', request }),
                message: 'Failed to delete pending message (500)',
            },
            {
                run: () => discardPendingMessageV2({ sessionId, pendingId: 'p1', encryption, request }),
                message: 'Failed to discard pending message (500)',
            },
            {
                run: () => restoreDiscardedPendingMessageV2({ sessionId, pendingId: 'p1', encryption, request }),
                message: 'Failed to restore discarded message (500)',
            },
            {
                run: () => deleteDiscardedPendingMessageV2({ sessionId, pendingId: 'p1', encryption, request }),
                message: 'Failed to delete discarded message (500)',
            },
            {
                run: () => reorderPendingMessagesV2({ sessionId, orderedLocalIds: ['p1'], encryption, request }),
                message: 'Failed to reorder pending messages (500)',
            },
            {
                run: () => retryPendingDeliveryV2({ sessionId, pendingId: 'p1', encryption, request }),
                message: 'Failed to retry pending delivery (500)',
            },
            {
                run: () => markPendingDeliveryHandledV2({ sessionId, pendingId: 'p1', encryption, request }),
                message: 'Failed to mark pending delivery handled (500)',
            },
        ];

        for (const mutation of mutations) {
            await expect(mutation.run()).rejects.toThrow(mutation.message);
        }
    });

    it('preserves request rejections for pending mutation timeouts', async () => {
        const sessionId = 's_test_mutation_timeout';
        const encryption = await createPendingQueueEncryption({ sessionId, seedByte: 10 });
        insertEditablePendingMessage(sessionId);
        const timeout = new Error('request timed out');

        await expect(
            discardPendingMessageV2({
                sessionId,
                pendingId: 'p1',
                encryption,
                request: async () => {
                    throw timeout;
                },
            }),
        ).rejects.toBe(timeout);
    });

    it('posts pending delivery retry and handled actions then refreshes pending rows', async () => {
        const sessionId = 's_test_delivery_actions';
        const encryption = await createPendingQueueEncryption({ sessionId, seedByte: 11 });
        const calls: Array<{ path: string; method: string | undefined }> = [];
        const request = async (path: string, init?: RequestInit) => {
            calls.push({ path, method: init?.method });
            if (path.endsWith('/delivery/retry') || path.endsWith('/delivery/handled')) {
                return new Response(JSON.stringify({ ok: true }), { status: 200 });
            }
            if (path.endsWith('/pending?includeDiscarded=1')) {
                return new Response(JSON.stringify({ pending: [] }), { status: 200 });
            }
            return new Response(null, { status: 404 });
        };

        await retryPendingDeliveryV2({ sessionId, pendingId: 'p1', encryption, request });
        await markPendingDeliveryHandledV2({ sessionId, pendingId: 'p1', encryption, request });

        expect(calls).toEqual([
            { path: `/v2/sessions/${sessionId}/pending/p1/delivery/retry`, method: 'POST' },
            { path: `/v2/sessions/${sessionId}/pending?includeDiscarded=1`, method: 'GET' },
            { path: `/v2/sessions/${sessionId}/pending/p1/delivery/handled`, method: 'POST' },
            { path: `/v2/sessions/${sessionId}/pending?includeDiscarded=1`, method: 'GET' },
        ]);
    });
});
