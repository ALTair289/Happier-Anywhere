import axios from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { deliverSessionTurnMutation } from './deliverSessionTurnMutation';

vi.mock('axios');

const mutation = {
    v: 1,
    sessionId: 'session-1',
    mutationId: 'mutation-1',
    action: 'end_session',
    turnId: 'turn-1',
    observedAt: 200,
} as const;

function receipt(overrides: Record<string, unknown> = {}) {
    return {
        ...mutation,
        decision: 'applied',
        appliedAt: 250,
        ...overrides,
    };
}

describe('deliverSessionTurnMutation exact end', () => {
    beforeEach(() => {
        vi.mocked(axios.post).mockReset();
    });

    it('delivers over socket only with a full-identity positive receipt', async () => {
        const socket = {
            connected: true,
            emitWithAck: vi.fn(async () => ({ result: 'success', receipt: receipt() })),
        };

        await expect(deliverSessionTurnMutation({ token: 'token', socket, mutation })).resolves.toEqual({
            status: 'delivered',
            path: 'socket',
        });
        expect(axios.post).not.toHaveBeenCalled();
    });

    it('does not treat generic socket or HTTP success as exact delivery', async () => {
        const socket = {
            connected: true,
            emitWithAck: vi.fn(async () => ({ result: 'success' })),
        };
        vi.mocked(axios.post).mockResolvedValue({ status: 200, data: { success: true, applied: true } } as never);

        await expect(deliverSessionTurnMutation({ token: 'token', socket, mutation })).resolves.toMatchObject({
            status: 'retryable',
            diagnostic: {
                classification: 'receipt_mismatch',
                sessionId: 'session-1',
                mutationId: 'mutation-1',
                turnId: 'turn-1',
            },
        });
    });

    it('retains semantic non-positive decisions with bounded evidence', async () => {
        const socket = {
            connected: true,
            emitWithAck: vi.fn(async () => ({ result: 'success', receipt: receipt({ decision: 'missing-turn' }) })),
        };
        vi.mocked(axios.post).mockResolvedValue({
            status: 200,
            data: { success: true, applied: false, receipt: receipt({ decision: 'stale-terminal' }) },
        } as never);

        await expect(deliverSessionTurnMutation({ token: 'token', socket, mutation })).resolves.toMatchObject({
            status: 'retryable',
            diagnostic: {
                classification: 'semantic_non_positive',
                decision: 'stale-terminal',
            },
        });
    });

    it('does not accept fallback duplicate-mutation as exact delivery', async () => {
        const socket = {
            connected: true,
            emitWithAck: vi.fn(async () => ({ result: 'success', receipt: receipt({ decision: 'duplicate-mutation' }) })),
        };
        vi.mocked(axios.post).mockResolvedValue({
            status: 200,
            data: { success: true, receipt: receipt({ decision: 'duplicate-mutation' }) },
        } as never);

        await expect(deliverSessionTurnMutation({ token: 'token', socket, mutation })).resolves.toMatchObject({
            status: 'retryable',
            diagnostic: {
                classification: 'semantic_non_positive',
                decision: 'duplicate-mutation',
            },
        });
    });

    it('classifies released-old socket no-ACK plus HTTP unsupported as support-visible unsupported', async () => {
        const socket = {
            connected: true,
            emitWithAck: vi.fn(async () => {
                const error = new Error('ack timed out') as Error & { code: string };
                error.code = 'socket_ack_timeout';
                throw error;
            }),
        };
        vi.mocked(axios.post).mockRejectedValue({ response: { status: 404 } });

        await expect(deliverSessionTurnMutation({ token: 'token', socket, mutation })).resolves.toMatchObject({
            status: 'unsupported_capability',
            diagnostic: {
                classification: 'transport_unsupported',
                socket: { evidence: 'no_ack', code: 'socket_ack_timeout' },
                http: { evidence: 'unsupported_status', status: 404 },
            },
        });
    });

    it('classifies explicit socket and HTTP unsupported evidence as unsupported', async () => {
        vi.mocked(axios.post).mockRejectedValue({ response: { status: 501 } });

        await expect(deliverSessionTurnMutation({
            token: 'token',
            socket: {
                connected: true,
                emitWithAck: vi.fn(async () => ({ code: 'unknown_event' })),
            },
            mutation,
        })).resolves.toMatchObject({
            status: 'unsupported_capability',
            diagnostic: {
                classification: 'transport_unsupported',
                socket: { evidence: 'unsupported_ack', code: 'unknown_event' },
                http: { status: 501 },
            },
        });
    });

    it('classifies unavailable exact transports without inventing support', async () => {
        vi.mocked(axios.post).mockRejectedValue(new Error('offline'));

        await expect(deliverSessionTurnMutation({
            token: 'token',
            socket: { connected: false, emitWithAck: vi.fn() },
            mutation,
        })).resolves.toMatchObject({
            status: 'retryable',
            diagnostic: {
                classification: 'transport_unavailable',
                http: { evidence: 'transport_unavailable' },
            },
        });
    });

    it('keeps broad touch_active compatibility behavior unchanged', async () => {
        const socket = {
            connected: true,
            emitWithAck: vi.fn(async () => ({ result: 'success' })),
        };

        await expect(deliverSessionTurnMutation({
            token: 'token',
            socket,
            mutation: {
                v: 1,
                sessionId: 'session-1',
                mutationId: 'touch-1',
                action: 'touch_active',
                turnId: 'turn-1',
                observedAt: 201,
            },
        })).resolves.toEqual({ status: 'delivered', path: 'socket' });
    });
});
