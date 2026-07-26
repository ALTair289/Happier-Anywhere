import { describe, expect, it, vi } from 'vitest';

import { deliverRuntimeActivitySnapshot } from './deliverRuntimeActivitySnapshot';

const mutation = {
    v: 1,
    source: 'runtime_activity_snapshot',
    sessionId: 'session-1',
    mutationId: 'runtime-activity-snapshot:session-1',
    snapshot: { state: 'active', activeCount: 1 },
} as const;

function projection() {
    return { ...mutation.snapshot, observedAt: 100, revision: 2 };
}

describe('deliverRuntimeActivitySnapshot', () => {
    it.each(['applied', 'unchanged'] as const)('acknowledges an exact %s ACK', async (status) => {
        const emitWithAck = vi.fn(async () => ({
            status,
            sessionId: mutation.sessionId,
            mutationId: mutation.mutationId,
            projection: projection(),
        }));

        await expect(deliverRuntimeActivitySnapshot({
            socket: { connected: true, emitWithAck },
            mutation,
        })).resolves.toEqual({
            status: 'delivered',
            path: 'socket',
            runtimeActivityEvidence: { disposition: status, projection: projection() },
        });
        expect(emitWithAck).toHaveBeenCalledWith('session-runtime-activity-snapshot', {
            sessionId: mutation.sessionId,
            mutationId: mutation.mutationId,
            snapshot: mutation.snapshot,
        });
    });

    it('never acknowledges generic legacy success or a mismatched positive ACK', async () => {
        for (const ack of [
            { result: 'success' },
            { status: 'rejected', reason: 'invalid_request' },
            {
                status: 'applied',
                sessionId: mutation.sessionId,
                mutationId: 'another-mutation',
                projection: projection(),
            },
            {
                status: 'unchanged',
                sessionId: mutation.sessionId,
                mutationId: mutation.mutationId,
                projection: {
                    state: 'unknown',
                    activeCount: 0,
                    observedAt: 101,
                    revision: 99,
                },
            },
        ]) {
            await expect(deliverRuntimeActivitySnapshot({
                socket: { connected: true, emitWithAck: vi.fn(async () => ack) },
                mutation,
            })).resolves.toEqual({
                status: 'retryable',
                reason: 'runtime_activity_snapshot_ack_invalid',
            });
        }
    });

    it('classifies strict rejected and retryable ACKs without losing custody', async () => {
        await expect(deliverRuntimeActivitySnapshot({
            socket: {
                connected: true,
                emitWithAck: vi.fn(async () => ({
                    status: 'rejected',
                    sessionId: mutation.sessionId,
                    mutationId: mutation.mutationId,
                    reason: 'archived',
                })),
            },
            mutation,
        })).resolves.toEqual({
            status: 'permanent_invalid_payload',
            reason: 'runtime_activity_snapshot_archived',
        });

        await expect(deliverRuntimeActivitySnapshot({
            socket: {
                connected: true,
                emitWithAck: vi.fn(async () => ({
                    status: 'retryable',
                    sessionId: mutation.sessionId,
                    mutationId: mutation.mutationId,
                    reason: 'internal',
                })),
            },
            mutation,
        })).resolves.toEqual({
            status: 'retryable',
            reason: 'runtime_activity_snapshot_internal',
        });
    });

    it('surfaces unauthorized as typed authentication failure instead of permanent payload rejection', async () => {
        await expect(deliverRuntimeActivitySnapshot({
            socket: { connected: true, emitWithAck: vi.fn(async () => ({
                status: 'rejected', sessionId: mutation.sessionId, mutationId: mutation.mutationId, reason: 'unauthorized',
            })) },
            mutation,
        })).rejects.toMatchObject({ response: { status: 403 }, code: 'not_authenticated' });
    });
});
