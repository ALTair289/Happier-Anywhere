import { beforeEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';

import {
    blockPendingQueueV2ProviderDeliveriesOnAttach,
    blockPendingQueueV2Delivery,
    readBlockedPendingQueueV2DeliveryByLocalIdFromServer,
    listPendingQueueV2ProviderDeliveryLocalIdsFromServer,
    markPendingQueueV2DeliveryHandled,
    materializeNextPendingQueueV2Message,
    materializeNextPendingQueueV2MessageViaHttp,
    reconcileAcceptedPendingQueueV2DeliveriesThroughSeq,
    resolveAcceptedPendingQueueV2Delivery,
    retryPendingQueueV2Delivery,
} from './pendingQueueV2Transport';

const { mockGet, mockPost } = vi.hoisted(() => ({
    mockGet: vi.fn(),
    mockPost: vi.fn(),
}));

vi.mock('axios', () => ({
    default: {
        get: mockGet,
        post: mockPost,
    },
}));

describe('pendingQueueV2Transport', () => {
    beforeEach(() => {
        mockGet.mockReset();
        mockPost.mockReset();
    });

    it('uses legacy HTTP materialization unless provider delivery state is explicitly requested', async () => {
        mockPost.mockResolvedValueOnce({
            data: {
                ok: true,
                didMaterialize: false,
                pendingCount: 0,
                pendingVersion: 1,
            },
        });

        await expect(materializeNextPendingQueueV2MessageViaHttp({
            token: 'token',
            sessionId: 'session-1',
        })).resolves.toMatchObject({
            didMaterialize: false,
            pendingQueueState: {
                known: true,
                pendingCount: 0,
                pendingVersion: 1,
            },
        });

        expect(mockPost).toHaveBeenCalledTimes(1);
        expect(mockPost.mock.calls[0]?.[1]).toEqual({});
    });

    it('sends runtime-idle delivery timing in HTTP materialization requests', async () => {
        mockPost.mockResolvedValueOnce({
            data: {
                ok: true,
                didMaterialize: false,
                pendingCount: 1,
                pendingVersion: 2,
                deferredReason: 'runtime_activity_active',
            },
        });

        await expect(materializeNextPendingQueueV2MessageViaHttp({
            token: 'token',
            sessionId: 'session-1',
            deliveryTiming: 'after_runtime_idle',
        })).resolves.toMatchObject({
            didMaterialize: false,
            deferredReason: 'runtime_activity_active',
        });

        expect(mockPost).toHaveBeenCalledTimes(1);
        expect(mockPost.mock.calls[0]?.[1]).toEqual({ deliveryTiming: 'after_runtime_idle' });
    });

    it('fails closed when provider delivery opt-in is rejected instead of falling back to legacy materialization', async () => {
        const error = { response: { status: 400 } };
        mockPost.mockRejectedValueOnce(error);

        await expect(materializeNextPendingQueueV2MessageViaHttp({
            token: 'token',
            sessionId: 'session-1',
            deliveryStateOptIn: true,
        })).rejects.toBe(error);

        expect(mockPost).toHaveBeenCalledTimes(1);
        expect(mockPost.mock.calls[0]?.[1]).toEqual({ deliveryState: 'provider' });
    });

    it('fails closed through the socket/http materializer when provider delivery opt-in is rejected', async () => {
        const error = { response: { status: 422 } };
        mockPost.mockRejectedValueOnce(error);

        await expect(materializeNextPendingQueueV2Message({
            token: 'token',
            sessionId: 'session-1',
            socket: { connected: false } as any,
            deliveryStateOptIn: true,
        })).rejects.toBe(error);

        expect(mockPost).toHaveBeenCalledTimes(1);
        expect(mockPost.mock.calls[0]?.[1]).toEqual({ deliveryState: 'provider' });
    });

    it('rejects legacy committed materialization responses under provider delivery opt-in', async () => {
        mockPost.mockResolvedValueOnce({
            data: {
                ok: true,
                didMaterialize: true,
                localId: 'legacy-local',
                didWriteMessage: true,
                pendingCount: 0,
                pendingVersion: 3,
                message: {
                    id: 'm-legacy',
                    seq: 42,
                    localId: 'legacy-local',
                    messageRole: 'user',
                    content: {
                        t: 'plain',
                        v: {
                            role: 'user',
                            content: { type: 'text', text: 'legacy prompt' },
                            localId: 'legacy-local',
                        },
                    },
                    createdAt: 1_000,
                    updatedAt: 1_000,
                },
            },
        });

        await expect(materializeNextPendingQueueV2MessageViaHttp({
            token: 'token',
            sessionId: 'session-1',
            deliveryStateOptIn: true,
        })).rejects.toThrow(/provider delivery/i);

        expect(mockPost).toHaveBeenCalledTimes(1);
        expect(mockPost.mock.calls[0]?.[1]).toEqual({ deliveryState: 'provider' });
    });

    it('rejects incompatible provider delivery socket ACKs without falling back to HTTP', async () => {
        const socket = {
            connected: true,
            timeout: vi.fn(() => socket),
            emitWithAck: vi.fn(async () => ({
                ok: true,
                didMaterialize: true,
                localId: 'legacy-socket-local',
                didWrite: true,
                pendingCount: 0,
                pendingVersion: 4,
                message: {
                    id: 'm-legacy-socket',
                    seq: 43,
                    localId: 'legacy-socket-local',
                    messageRole: 'user',
                    content: {
                        t: 'plain',
                        v: {
                            role: 'user',
                            content: { type: 'text', text: 'legacy socket prompt' },
                            localId: 'legacy-socket-local',
                        },
                    },
                    createdAt: 1_000,
                    updatedAt: 1_000,
                },
            })),
        };

        await expect(materializeNextPendingQueueV2Message({
            token: 'token',
            sessionId: 'session-1',
            socket: socket as any,
            deliveryStateOptIn: true,
        })).rejects.toThrow(/provider delivery/i);

        expect(socket.emitWithAck).toHaveBeenCalledWith('pending-materialize-next', {
            sid: 'session-1',
            deliveryState: 'provider',
        });
        expect(mockPost).not.toHaveBeenCalled();
    });

    it('sends runtime-idle delivery timing in socket materialization requests', async () => {
        const socket = {
            connected: true,
            timeout: vi.fn(() => socket),
            emitWithAck: vi.fn(async () => ({
                ok: true,
                didMaterialize: false,
                pendingCount: 1,
                pendingVersion: 2,
                deferredReason: 'runtime_activity_active',
            })),
        };

        await expect(materializeNextPendingQueueV2Message({
            token: 'token',
            sessionId: 'session-1',
            socket: socket as any,
            deliveryTiming: 'after_runtime_idle',
        })).resolves.toMatchObject({
            didMaterialize: false,
            deferredReason: 'runtime_activity_active',
        });

        expect(socket.emitWithAck).toHaveBeenCalledWith('pending-materialize-next', {
            sid: 'session-1',
            deliveryTiming: 'after_runtime_idle',
        });
        expect(mockPost).not.toHaveBeenCalled();
    });

    it('parses row-first provider delivery materialization with a durable transcript row', async () => {
        const deliveryState = { mode: 'provider' as const, unresolved: true };
        mockPost.mockResolvedValueOnce({
            data: {
                ok: true,
                didMaterialize: true,
                localId: 'row-first-local',
                didWriteMessage: true,
                pendingCount: 1,
                pendingVersion: 2,
                deliveryState,
                message: {
                    id: 'm-row-first',
                    seq: 42,
                    localId: 'row-first-local',
                    messageRole: 'user',
                    content: {
                        t: 'plain',
                        v: {
                            role: 'user',
                            content: { type: 'text', text: 'row-first prompt' },
                            localId: 'row-first-local',
                            meta: { source: 'ui', sentFrom: 'web' },
                        },
                    },
                    createdAt: 1_000,
                    updatedAt: 1_000,
                },
            },
        });

        await expect(materializeNextPendingQueueV2MessageViaHttp({
            token: 'token',
            sessionId: 'session-1',
            deliveryStateOptIn: true,
        })).resolves.toMatchObject({
            didMaterialize: true,
            localId: 'row-first-local',
            didWrite: true,
            message: {
                id: 'm-row-first',
                seq: 42,
                localId: 'row-first-local',
                deliveryState,
                content: {
                    t: 'plain',
                    v: {
                        role: 'user',
                        content: { type: 'text', text: 'row-first prompt' },
                        localId: 'row-first-local',
                        meta: { source: 'ui', sentFrom: 'web' },
                    },
                },
            },
        });
    });

    it('parses row-first provider delivery materialization from socket ACKs', async () => {
        const deliveryState = { mode: 'provider' as const, unresolved: true };
        const socket = {
            connected: true,
            timeout: vi.fn(() => socket),
            emitWithAck: vi.fn(async () => ({
                ok: true,
                didMaterialize: true,
                localId: 'row-first-socket-local',
                didWrite: true,
                pendingCount: 1,
                pendingVersion: 2,
                deliveryState,
                message: {
                    id: 'm-row-first-socket',
                    seq: 43,
                    localId: 'row-first-socket-local',
                    messageRole: 'user',
                    content: {
                        t: 'plain',
                        v: {
                            role: 'user',
                            content: { type: 'text', text: 'row-first socket prompt' },
                            localId: 'row-first-socket-local',
                            meta: { source: 'ui', sentFrom: 'web' },
                        },
                    },
                    createdAt: 1_000,
                    updatedAt: 1_000,
                },
            })),
        };

        await expect(materializeNextPendingQueueV2Message({
            token: 'token',
            sessionId: 'session-1',
            socket: socket as any,
            deliveryStateOptIn: true,
        })).resolves.toMatchObject({
            didMaterialize: true,
            localId: 'row-first-socket-local',
            didWrite: true,
            message: {
                id: 'm-row-first-socket',
                seq: 43,
                localId: 'row-first-socket-local',
                deliveryState,
            },
        });
        expect(mockPost).not.toHaveBeenCalled();
    });

    it('parses provider delivery claims that are not committed transcript rows yet', async () => {
        const deliveryState = { mode: 'provider' as const, unresolved: true };
        mockPost.mockResolvedValueOnce({
            data: {
                ok: true,
                didMaterialize: true,
                localId: 'claimed-local',
                didWriteMessage: false,
                pendingCount: 1,
                pendingVersion: 2,
                deliveryState,
                message: {
                    id: null,
                    seq: null,
                    localId: 'claimed-local',
                    messageRole: 'user',
                    content: {
                        t: 'plain',
                        v: {
                            role: 'user',
                            content: { type: 'text', text: 'claimed prompt' },
                            localId: 'claimed-local',
                            meta: { source: 'ui', sentFrom: 'web' },
                        },
                    },
                    createdAt: 1_000,
                    updatedAt: 1_000,
                },
            },
        });

        await expect(materializeNextPendingQueueV2MessageViaHttp({
            token: 'token',
            sessionId: 'session-1',
            deliveryStateOptIn: true,
        })).resolves.toMatchObject({
            didMaterialize: true,
            localId: 'claimed-local',
            didWrite: false,
            message: {
                id: null,
                seq: null,
                localId: 'claimed-local',
                deliveryState,
                content: {
                    t: 'plain',
                    v: {
                        role: 'user',
                        content: { type: 'text', text: 'claimed prompt' },
                        localId: 'claimed-local',
                        meta: { source: 'ui', sentFrom: 'web' },
                    },
                },
            },
        });
    });

    it('allows legacy provider delivery claims without explicit delivery state under provider opt-in', async () => {
        mockPost.mockResolvedValueOnce({
            data: {
                ok: true,
                didMaterialize: true,
                localId: 'legacy-claimed-local',
                didWriteMessage: false,
                pendingCount: 1,
                pendingVersion: 2,
                message: {
                    id: null,
                    seq: null,
                    localId: 'legacy-claimed-local',
                    messageRole: 'user',
                    content: {
                        t: 'plain',
                        v: {
                            role: 'user',
                            content: { type: 'text', text: 'legacy claimed prompt' },
                            localId: 'legacy-claimed-local',
                            meta: { source: 'ui', sentFrom: 'web' },
                        },
                    },
                    createdAt: 1_000,
                    updatedAt: 1_000,
                },
            },
        });

        await expect(materializeNextPendingQueueV2MessageViaHttp({
            token: 'token',
            sessionId: 'session-1',
            deliveryStateOptIn: true,
        })).resolves.toMatchObject({
            didMaterialize: true,
            localId: 'legacy-claimed-local',
            didWrite: false,
            message: {
                id: null,
                seq: null,
                localId: 'legacy-claimed-local',
                deliveryState: null,
                content: {
                    t: 'plain',
                    v: {
                        role: 'user',
                        content: { type: 'text', text: 'legacy claimed prompt' },
                        localId: 'legacy-claimed-local',
                        meta: { source: 'ui', sentFrom: 'web' },
                    },
                },
            },
        });
    });

    it('allows uncommitted provider delivery claims with an opaque materialization id under provider opt-in', async () => {
        mockPost.mockResolvedValueOnce({
            data: {
                ok: true,
                didMaterialize: true,
                localId: 'opaque-id-claimed-local',
                didWriteMessage: false,
                pendingCount: 1,
                pendingVersion: 2,
                message: {
                    id: 'opaque-pending-materialization-id',
                    seq: null,
                    localId: 'opaque-id-claimed-local',
                    messageRole: 'user',
                    content: {
                        t: 'plain',
                        v: {
                            role: 'user',
                            content: { type: 'text', text: 'opaque id claimed prompt' },
                            localId: 'opaque-id-claimed-local',
                            meta: { source: 'ui', sentFrom: 'web' },
                        },
                    },
                    createdAt: 1_000,
                    updatedAt: 1_000,
                },
            },
        });

        await expect(materializeNextPendingQueueV2MessageViaHttp({
            token: 'token',
            sessionId: 'session-1',
            deliveryStateOptIn: true,
        })).resolves.toMatchObject({
            didMaterialize: true,
            localId: 'opaque-id-claimed-local',
            didWrite: false,
            message: {
                id: 'opaque-pending-materialization-id',
                seq: null,
                localId: 'opaque-id-claimed-local',
                deliveryState: null,
                content: {
                    t: 'plain',
                    v: {
                        role: 'user',
                        content: { type: 'text', text: 'opaque id claimed prompt' },
                        localId: 'opaque-id-claimed-local',
                        meta: { source: 'ui', sentFrom: 'web' },
                    },
                },
            },
        });
    });

    it('allows uncommitted provider delivery claims with stale resolved provider state under provider opt-in', async () => {
        mockPost.mockResolvedValueOnce({
            data: {
                ok: true,
                didMaterialize: true,
                localId: 'resolved-state-claimed-local',
                didWriteMessage: false,
                pendingCount: 1,
                pendingVersion: 2,
                deliveryState: { mode: 'provider', unresolved: false },
                message: {
                    id: 'opaque-resolved-state-materialization-id',
                    seq: null,
                    localId: 'resolved-state-claimed-local',
                    messageRole: 'user',
                    content: {
                        t: 'plain',
                        v: {
                            role: 'user',
                            content: { type: 'text', text: 'resolved provider state claimed prompt' },
                            localId: 'resolved-state-claimed-local',
                            meta: { source: 'ui', sentFrom: 'web' },
                        },
                    },
                    createdAt: 1_000,
                    updatedAt: 1_000,
                },
            },
        });

        await expect(materializeNextPendingQueueV2MessageViaHttp({
            token: 'token',
            sessionId: 'session-1',
            deliveryStateOptIn: true,
        })).resolves.toMatchObject({
            didMaterialize: true,
            localId: 'resolved-state-claimed-local',
            didWrite: false,
            message: {
                id: 'opaque-resolved-state-materialization-id',
                seq: null,
                localId: 'resolved-state-claimed-local',
                deliveryState: { mode: 'provider', unresolved: false },
            },
        });
    });

    it('allows provider delivery claims whose local id is only present on the materialize ack', async () => {
        mockPost.mockResolvedValueOnce({
            data: {
                ok: true,
                didMaterialize: true,
                localId: 'top-level-claimed-local',
                didWriteMessage: false,
                pendingCount: 1,
                pendingVersion: 2,
                message: {
                    id: null,
                    seq: null,
                    localId: null,
                    messageRole: 'user',
                    content: {
                        t: 'plain',
                        v: {
                            role: 'user',
                            content: { type: 'text', text: 'top-level local id claimed prompt' },
                            meta: { source: 'ui', sentFrom: 'web' },
                        },
                    },
                    createdAt: 1_000,
                    updatedAt: 1_000,
                },
            },
        });

        await expect(materializeNextPendingQueueV2MessageViaHttp({
            token: 'token',
            sessionId: 'session-1',
            deliveryStateOptIn: true,
        })).resolves.toMatchObject({
            didMaterialize: true,
            localId: 'top-level-claimed-local',
            didWrite: false,
            message: {
                id: null,
                seq: null,
                localId: null,
                content: {
                    t: 'plain',
                    v: {
                        role: 'user',
                        content: { type: 'text', text: 'top-level local id claimed prompt' },
                        meta: { source: 'ui', sentFrom: 'web' },
                    },
                },
            },
        });
    });

    it('rejects provider delivery claims whose transcript identity is only null after parser normalization', async () => {
        mockPost.mockResolvedValueOnce({
            data: {
                ok: true,
                didMaterialize: true,
                localId: 'malformed-seq-claimed-local',
                didWriteMessage: false,
                pendingCount: 1,
                pendingVersion: 2,
                message: {
                    id: null,
                    seq: 'not-a-seq',
                    localId: 'malformed-seq-claimed-local',
                    messageRole: 'user',
                    content: {
                        t: 'plain',
                        v: {
                            role: 'user',
                            content: { type: 'text', text: 'malformed seq claimed prompt' },
                            localId: 'malformed-seq-claimed-local',
                        },
                    },
                    createdAt: 1_000,
                    updatedAt: 1_000,
                },
            },
        });

        await expect(materializeNextPendingQueueV2MessageViaHttp({
            token: 'token',
            sessionId: 'session-1',
            deliveryStateOptIn: true,
        })).rejects.toThrow(/provider delivery/i);
    });

    it('rejects provider delivery claims without an explicit false write marker', async () => {
        mockPost.mockResolvedValueOnce({
            data: {
                ok: true,
                didMaterialize: true,
                localId: 'missing-write-marker-local',
                pendingCount: 1,
                pendingVersion: 2,
                message: {
                    id: null,
                    seq: null,
                    localId: 'missing-write-marker-local',
                    messageRole: 'user',
                    content: {
                        t: 'plain',
                        v: {
                            role: 'user',
                            content: { type: 'text', text: 'missing write marker prompt' },
                            localId: 'missing-write-marker-local',
                        },
                    },
                    createdAt: 1_000,
                    updatedAt: 1_000,
                },
            },
        });

        await expect(materializeNextPendingQueueV2MessageViaHttp({
            token: 'token',
            sessionId: 'session-1',
            deliveryStateOptIn: true,
        })).rejects.toThrow(/provider delivery/i);
    });

    it('does not fall back on authentication failures', async () => {
        mockPost.mockRejectedValueOnce({ response: { status: 401 } });

        await expect(materializeNextPendingQueueV2MessageViaHttp({
            token: 'token',
            sessionId: 'session-1',
            deliveryStateOptIn: true,
        })).rejects.toMatchObject({
            response: { status: 401 },
        });

        expect(mockPost).toHaveBeenCalledTimes(1);
        expect(axios.post).toHaveBeenCalledWith(
            expect.stringContaining('/v2/sessions/session-1/pending/materialize-next'),
            { deliveryState: 'provider' },
            expect.objectContaining({
                headers: expect.objectContaining({ Authorization: 'Bearer token' }),
            }),
        );
    });

    it('posts provider-accepted delivery resolution to the dedicated pending route', async () => {
        mockPost.mockResolvedValueOnce({
            data: {
                ok: true,
                pendingCount: 1,
                pendingVersion: 9,
                message: {
                    id: 'm-accepted',
                    seq: 43,
                    localId: 'local/with spaces',
                    messageRole: 'user',
                    content: {
                        t: 'plain',
                        v: {
                            role: 'user',
                            content: { type: 'text', text: 'accepted prompt' },
                            localId: 'local/with spaces',
                        },
                    },
                    createdAt: 1_000,
                    updatedAt: 1_000,
                },
            },
        });

        await expect(resolveAcceptedPendingQueueV2Delivery({
            token: 'token',
            sessionId: 'session-1',
            localId: 'local/with spaces',
        })).resolves.toEqual({
            pendingQueueState: {
                known: true,
                pendingCount: 1,
                pendingVersion: 9,
                pendingBlockedCount: 0,
            },
            message: {
                id: 'm-accepted',
                seq: 43,
                localId: 'local/with spaces',
                messageRole: 'user',
                content: {
                    t: 'plain',
                    v: {
                        role: 'user',
                        content: { type: 'text', text: 'accepted prompt' },
                        localId: 'local/with spaces',
                    },
                },
                createdAt: 1_000,
                updatedAt: 1_000,
                deliveryState: null,
            },
        });

        expect(mockPost).toHaveBeenCalledWith(
            expect.stringContaining('/v2/sessions/session-1/pending/local%2Fwith%20spaces/delivery/accepted'),
            {},
            expect.objectContaining({
                headers: expect.objectContaining({ Authorization: 'Bearer token' }),
            }),
        );
    });

    it('posts provider-accepted seq reconciliation to the dedicated pending route', async () => {
        mockPost.mockResolvedValueOnce({
            data: {
                ok: true,
                pendingCount: 0,
                pendingVersion: 13,
                resolvedLocalIds: ['resolved-1', 'resolved-2'],
            },
        });

        await expect(reconcileAcceptedPendingQueueV2DeliveriesThroughSeq({
            token: 'token',
            sessionId: 'session-1',
            maxAcceptedSeq: 42,
        })).resolves.toEqual({
            pendingQueueState: {
                known: true,
                pendingCount: 0,
                pendingVersion: 13,
                pendingBlockedCount: 0,
            },
            resolvedLocalIds: ['resolved-1', 'resolved-2'],
        });

        expect(mockPost).toHaveBeenCalledWith(
            expect.stringContaining('/v2/sessions/session-1/pending/delivery/accepted-through-seq'),
            { maxAcceptedSeq: 42 },
            expect.objectContaining({
                headers: expect.objectContaining({ Authorization: 'Bearer token' }),
            }),
        );
    });

    it('posts provider-attach stale-claim blocking to the dedicated pending route', async () => {
        mockPost.mockResolvedValueOnce({
            data: {
                ok: true,
                pendingCount: 2,
                pendingBlockedCount: 1,
                pendingVersion: 14,
                blockedCount: 1,
            },
        });

        await expect(blockPendingQueueV2ProviderDeliveriesOnAttach({
            token: 'token',
            sessionId: 'session/with spaces',
        })).resolves.toEqual({
            pendingQueueState: {
                known: true,
                pendingCount: 2,
                pendingBlockedCount: 1,
                pendingVersion: 14,
            },
        });

        expect(mockPost).toHaveBeenCalledWith(
            expect.stringContaining('/v2/sessions/session%2Fwith%20spaces/pending/delivery/provider-attach'),
            {},
            expect.objectContaining({
                headers: expect.objectContaining({
                    Authorization: 'Bearer token',
                    'Content-Type': 'application/json',
                }),
                timeout: 10_000,
            }),
        );
    });

    it('posts provider delivery block state to the dedicated pending route', async () => {
        mockPost.mockResolvedValueOnce({
            data: {
                ok: true,
                pendingCount: 1,
                pendingVersion: 10,
            },
        });

        await expect(blockPendingQueueV2Delivery({
            token: 'token',
            sessionId: 'session-1',
            localId: 'local/with spaces',
            reason: 'payload_too_large',
        })).resolves.toEqual({
            pendingQueueState: {
                known: true,
                pendingCount: 1,
                pendingVersion: 10,
                pendingBlockedCount: 0,
            },
        });

        expect(mockPost).toHaveBeenCalledWith(
            expect.stringContaining('/v2/sessions/session-1/pending/local%2Fwith%20spaces/delivery/block'),
            { reason: 'payload_too_large' },
            expect.objectContaining({
                headers: expect.objectContaining({ Authorization: 'Bearer token' }),
            }),
        );
    });

    it('lists only queued provider-delivery local ids for close recovery', async () => {
        mockGet.mockResolvedValueOnce({
            data: {
                pending: [
                    { localId: 'provider-1', status: 'queued', deliveryState: 'delivering' },
                    { localId: 'regular-queued', status: 'queued', deliveryState: null },
                    { localId: 'provider-blocked', status: 'queued', deliveryState: 'blocked' },
                    { localId: 'discarded-provider', status: 'discarded', deliveryState: 'delivering' },
                    { localId: 'provider-1', status: 'queued', deliveryState: 'delivering' },
                    { localId: 'provider-2', status: 'queued', deliveryState: 'delivering' },
                ],
            },
        });

        await expect(listPendingQueueV2ProviderDeliveryLocalIdsFromServer({
            token: 'token',
            sessionId: 'session/with spaces',
        })).resolves.toEqual(['provider-1', 'provider-2']);

        expect(mockGet).toHaveBeenCalledWith(
            expect.stringContaining('/v2/sessions/session%2Fwith%20spaces/pending'),
            expect.objectContaining({
                headers: expect.objectContaining({ Authorization: 'Bearer token' }),
                timeout: 10_000,
            }),
        );
    });

    it('reads blocked provider delivery state for a specific local id', async () => {
        mockGet.mockResolvedValueOnce({
            data: {
                pending: [
                    { localId: 'other-local', status: 'queued', deliveryState: 'blocked', deliveryBlockedReason: 'payload_too_large' },
                    { localId: 'blocked-local', status: 'queued', deliveryState: 'blocked', deliveryBlockedReason: 'runtime_disposed_before_delivery' },
                    { localId: 'delivering-local', status: 'queued', deliveryState: 'delivering' },
                    { localId: 'future-local', status: 'queued', deliveryState: 'blocked', deliveryBlockedReason: 'future_reason' },
                ],
            },
        });

        await expect(readBlockedPendingQueueV2DeliveryByLocalIdFromServer({
            token: 'token',
            sessionId: 'session/with spaces',
            localId: 'blocked-local',
        })).resolves.toEqual({
            localId: 'blocked-local',
            reason: 'runtime_disposed_before_delivery',
        });

        expect(mockGet).toHaveBeenCalledWith(
            expect.stringContaining('/v2/sessions/session%2Fwith%20spaces/pending'),
            expect.objectContaining({
                headers: expect.objectContaining({ Authorization: 'Bearer token' }),
                timeout: 10_000,
            }),
        );
    });

    it('posts pending delivery retry to the dedicated pending route', async () => {
        mockPost.mockResolvedValueOnce({
            data: {
                ok: true,
                pendingCount: 1,
                pendingVersion: 11,
            },
        });

        await expect(retryPendingQueueV2Delivery({
            token: 'token',
            sessionId: 'session-1',
            localId: 'local-1',
        })).resolves.toEqual({
            pendingQueueState: {
                known: true,
                pendingCount: 1,
                pendingVersion: 11,
                pendingBlockedCount: 0,
            },
        });

        expect(mockPost).toHaveBeenCalledWith(
            expect.stringContaining('/v2/sessions/session-1/pending/local-1/delivery/retry'),
            {},
            expect.objectContaining({
                headers: expect.objectContaining({ Authorization: 'Bearer token' }),
            }),
        );
    });

    it('posts explicit handled resolution to the dedicated pending route', async () => {
        mockPost.mockResolvedValueOnce({
            data: {
                ok: true,
                pendingCount: 0,
                pendingVersion: 12,
            },
        });

        await expect(markPendingQueueV2DeliveryHandled({
            token: 'token',
            sessionId: 'session-1',
            localId: 'local-1',
        })).resolves.toEqual({
            pendingQueueState: {
                known: true,
                pendingCount: 0,
                pendingVersion: 12,
                pendingBlockedCount: 0,
            },
        });

        expect(mockPost).toHaveBeenCalledWith(
            expect.stringContaining('/v2/sessions/session-1/pending/local-1/delivery/handled'),
            {},
            expect.objectContaining({
                headers: expect.objectContaining({ Authorization: 'Bearer token' }),
            }),
        );
    });
});
