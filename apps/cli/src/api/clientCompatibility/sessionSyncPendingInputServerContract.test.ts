import { describe, expect, it, vi } from 'vitest';

import { createSessionSyncPendingInputServerContractController } from './sessionSyncPendingInputServerContract';

function currentFeatures(params: Readonly<{
    sessionSync?: number;
    pendingInput?: number;
}> = { sessionSync: 2, pendingInput: 1 }) {
    return {
        features: {
            sharing: {
                pendingQueueV2: { enabled: true },
                pendingDeliveryState: { enabled: true },
            },
        },
        capabilities: {
            compatibility: {
                v: 1,
                sessionSync: {
                    v: 1,
                    enforcement: 'observe',
                    minimumSessionSyncProtocolVersion: 1,
                    currentSessionSyncProtocolVersion: params.sessionSync ?? 2,
                    declarationTransport: 'headers-v1',
                },
                ...(params.pendingInput === undefined ? {} : {
                    pendingInput: { currentPendingInputProtocolVersion: params.pendingInput },
                }),
            },
        },
    };
}

// Relevant `/v1/features` bytes from immutable server-v0.2.1 commit
// 4913c1e533c872a0712ba1c25b3104fd470aacc2. Keep this historical JSON
// independent of current feature schemas and fixture builders.
const releasedServerV021Features = {
    features: {
        sharing: {
            session: { enabled: true },
            public: { enabled: true },
            contentKeys: { enabled: true },
            pendingQueueV2: { enabled: true },
        },
    },
    capabilities: {},
};

function currentAck(params: Readonly<{
    sessionSync?: number;
    pendingInput?: number;
}> = { sessionSync: 2, pendingInput: 1 }) {
    return {
        v: 1,
        compatibility: {
            v: 1,
            sessionSync: {
                v: 1,
                enforcement: 'observe',
                minimumSessionSyncProtocolVersion: 1,
                currentSessionSyncProtocolVersion: params.sessionSync ?? 2,
                declarationTransport: 'headers-v1',
            },
            ...(params.pendingInput === undefined ? {} : {
                pendingInput: { currentPendingInputProtocolVersion: params.pendingInput },
            }),
        },
    };
}

function socket(ack: unknown) {
    return {
        connected: true,
        timeout: vi.fn().mockReturnThis(),
        emitWithAck: vi.fn().mockResolvedValue(ack),
    };
}

function response(payload: unknown, status = 200): Response {
    return new Response(typeof payload === 'string' ? payload : JSON.stringify(payload), {
        status,
        headers: { 'content-type': 'application/json' },
    });
}

describe('session-sync and Pending-input server contract', () => {
    it('selects bundled current only when HTTP and the exact socket both prove both protocol minima', async () => {
        const exactSocket = socket(currentAck());
        const controller = createSessionSyncPendingInputServerContractController({
            serverUrl: 'https://server.example',
            token: 'token',
            fetchImpl: vi.fn().mockResolvedValue(response(currentFeatures())),
        });

        await expect(controller.resolve({ sessionConnectionEpoch: 1, socket: exactSocket, machineId: 'machine-1' }))
            .resolves.toMatchObject({
                mode: 'session_sync_v2_pending_input_v1',
                sessionConnectionEpoch: 1,
                socket: exactSocket,
            });
    });

    it('selects only the immutable released server from matching positive HTTP and empty socket evidence', async () => {
        const exactSocket = socket({});
        const controller = createSessionSyncPendingInputServerContractController({
            serverUrl: 'https://server.example',
            token: 'token',
            fetchImpl: vi.fn().mockResolvedValue(response(releasedServerV021Features)),
        });

        await expect(controller.resolve({ sessionConnectionEpoch: 2, socket: exactSocket, machineId: 'machine-1' }))
            .resolves.toMatchObject({
                mode: 'released_server_v0_2_1',
                sessionConnectionEpoch: 2,
                socket: exactSocket,
            });
    });

    it.each([
        ['Runtime-v2-only HTTP', currentFeatures({ sessionSync: 2 }), currentAck(), 'indeterminate'],
        ['Pending-v1-only HTTP', currentFeatures({ sessionSync: 1, pendingInput: 1 }), currentAck(), 'indeterminate'],
        ['Runtime-v2-only socket', currentFeatures(), currentAck({ sessionSync: 2 }), 'indeterminate'],
        ['Pending-v1-only socket', currentFeatures(), currentAck({ sessionSync: 1, pendingInput: 1 }), 'indeterminate'],
        ['HTTP-current/socket-old', currentFeatures(), {}, 'indeterminate'],
        ['HTTP-old/socket-current', releasedServerV021Features, currentAck(), 'indeterminate'],
        ['unknown successful HTTP', { features: {}, capabilities: {} }, {}, 'indeterminate'],
        ['malformed HTTP', { invalid: true }, {}, 'indeterminate'],
        ['malformed socket', currentFeatures(), { v: 1 }, 'indeterminate'],
    ] as const)('keeps %s evidence fail-closed', async (_name, httpPayload, socketAck, mode) => {
        const controller = createSessionSyncPendingInputServerContractController({
            serverUrl: 'https://server.example',
            token: 'token',
            fetchImpl: vi.fn().mockResolvedValue(response(httpPayload)),
        });

        await expect(controller.resolve({ sessionConnectionEpoch: 1, socket: socket(socketAck), machineId: 'machine-1' }))
            .resolves.toMatchObject({ mode });
    });

    it.each([
        [401, 'auth_failed'],
        [403, 'auth_failed'],
        [302, 'indeterminate'],
        [400, 'indeterminate'],
        [404, 'indeterminate'],
        [405, 'indeterminate'],
        [409, 'indeterminate'],
        [422, 'indeterminate'],
        [429, 'indeterminate'],
        [500, 'indeterminate'],
        [501, 'indeterminate'],
    ] as const)('classifies HTTP %s as %s without trusting its body', async (status, mode) => {
        const controller = createSessionSyncPendingInputServerContractController({
            serverUrl: 'https://server.example',
            token: 'token',
            fetchImpl: vi.fn().mockResolvedValue(response(currentFeatures(), status)),
        });

        await expect(controller.resolve({ sessionConnectionEpoch: 1, socket: socket(currentAck()), machineId: 'machine-1' }))
            .resolves.toMatchObject({ mode });
    });

    it('single-flights one exact epoch/socket and invalidates stale completion without reconnecting', async () => {
        let release: ((value: Response) => void) | undefined;
        const fetchImpl = vi.fn(() => new Promise<Response>((resolve) => { release = resolve; }));
        const exactSocket = socket(currentAck());
        const controller = createSessionSyncPendingInputServerContractController({
            serverUrl: 'https://server.example/', token: 'token', fetchImpl,
        });
        const probe = { sessionConnectionEpoch: 7, socket: exactSocket, machineId: 'machine-1' };

        const first = controller.resolve(probe);
        const second = controller.resolve(probe);
        expect(second).toBe(first);
        expect(fetchImpl).toHaveBeenCalledTimes(1);
        expect(controller.invalidate({ sessionConnectionEpoch: 7, socket: exactSocket })).toEqual({
            mode: 'indeterminate',
            sessionConnectionEpoch: 7,
            socket: exactSocket,
        });
        release?.(response(currentFeatures()));

        await expect(first).resolves.toMatchObject({ mode: 'indeterminate' });
        await expect(second).resolves.toMatchObject({ mode: 'indeterminate' });
        expect(exactSocket.emitWithAck).not.toHaveBeenCalled();
    });

    it.each([
        ['a disconnected exact socket', { connected: false, machineId: 'machine-1' }],
        ['a blank machine id', { connected: true, machineId: ' ' }],
    ] as const)('does not reuse a cached positive result for %s', async (_name, nextProbe) => {
        const exactSocket = socket(currentAck());
        const fetchImpl = vi.fn().mockResolvedValue(response(currentFeatures()));
        const controller = createSessionSyncPendingInputServerContractController({
            serverUrl: 'https://server.example', token: 'token', fetchImpl,
        });
        const first = await controller.resolve({
            sessionConnectionEpoch: 7,
            socket: exactSocket,
            machineId: 'machine-1',
        });

        exactSocket.connected = nextProbe.connected;
        await expect(controller.resolve({
            sessionConnectionEpoch: 7,
            socket: exactSocket,
            machineId: nextProbe.machineId,
        })).resolves.toEqual({
            mode: 'indeterminate',
            sessionConnectionEpoch: 7,
            socket: exactSocket,
        });
        expect(controller.invalidate({ sessionConnectionEpoch: 7, socket: exactSocket })).toEqual({
            mode: 'indeterminate',
            sessionConnectionEpoch: 7,
            socket: exactSocket,
        });
        expect(fetchImpl).toHaveBeenCalledTimes(1);
        expect(first.mode).toBe('session_sync_v2_pending_input_v1');
    });

    it('replaces an in-flight probe for the same numeric epoch when the exact socket changes', async () => {
        const releases: Array<(value: Response) => void> = [];
        const fetchImpl = vi.fn(() => new Promise<Response>((resolve) => { releases.push(resolve); }));
        const firstSocket = socket(currentAck());
        const replacementSocket = socket(currentAck());
        const controller = createSessionSyncPendingInputServerContractController({
            serverUrl: 'https://server.example', token: 'token', fetchImpl,
        });

        const stale = controller.resolve({ sessionConnectionEpoch: 4, socket: firstSocket, machineId: 'machine-1' });
        const current = controller.resolve({ sessionConnectionEpoch: 4, socket: replacementSocket, machineId: 'machine-1' });
        releases[1]?.(response(currentFeatures()));
        const currentResult = await current;
        releases[0]?.(response(currentFeatures()));

        await expect(stale).resolves.toEqual({
            mode: 'indeterminate',
            sessionConnectionEpoch: 4,
            socket: firstSocket,
        });
        expect(currentResult).toEqual({
            mode: 'session_sync_v2_pending_input_v1',
            sessionConnectionEpoch: 4,
            socket: replacementSocket,
        });
        await expect(controller.resolve({
            sessionConnectionEpoch: 4,
            socket: replacementSocket,
            machineId: 'machine-1',
        })).resolves.toBe(currentResult);
    });

    it('replaces an in-flight probe for a new epoch even when the socket object is unchanged', async () => {
        const releases: Array<(value: Response) => void> = [];
        const fetchImpl = vi.fn(() => new Promise<Response>((resolve) => { releases.push(resolve); }));
        const exactSocket = socket(currentAck());
        const controller = createSessionSyncPendingInputServerContractController({
            serverUrl: 'https://server.example', token: 'token', fetchImpl,
        });

        const stale = controller.resolve({ sessionConnectionEpoch: 4, socket: exactSocket, machineId: 'machine-1' });
        const current = controller.resolve({ sessionConnectionEpoch: 5, socket: exactSocket, machineId: 'machine-1' });
        releases[1]?.(response(currentFeatures()));
        await expect(current).resolves.toEqual({
            mode: 'session_sync_v2_pending_input_v1',
            sessionConnectionEpoch: 5,
            socket: exactSocket,
        });
        releases[0]?.(response(currentFeatures()));
        await expect(stale).resolves.toEqual({
            mode: 'indeterminate',
            sessionConnectionEpoch: 4,
            socket: exactSocket,
        });
        expect(fetchImpl).toHaveBeenCalledTimes(2);
    });

    it('keeps disconnects during HTTP authentication and socket acknowledgement indeterminate', async () => {
        let releaseHttp: ((value: Response) => void) | undefined;
        const httpSocket = socket(currentAck());
        const httpController = createSessionSyncPendingInputServerContractController({
            serverUrl: 'https://server.example',
            token: 'token',
            fetchImpl: vi.fn(() => new Promise<Response>((resolve) => { releaseHttp = resolve; })),
        });
        const duringHttp = httpController.resolve({
            sessionConnectionEpoch: 1,
            socket: httpSocket,
            machineId: 'machine-1',
        });
        httpSocket.connected = false;
        releaseHttp?.(response({}, 401));
        await expect(duringHttp).resolves.toEqual({
            mode: 'indeterminate',
            sessionConnectionEpoch: 1,
            socket: httpSocket,
        });

        let releaseAck: ((value: unknown) => void) | undefined;
        const ackSocket = socket(currentAck());
        ackSocket.emitWithAck.mockImplementation(() => new Promise((resolve) => { releaseAck = resolve; }));
        const ackController = createSessionSyncPendingInputServerContractController({
            serverUrl: 'https://server.example',
            token: 'token',
            fetchImpl: vi.fn().mockResolvedValue(response(currentFeatures())),
        });
        const duringAck = ackController.resolve({
            sessionConnectionEpoch: 2,
            socket: ackSocket,
            machineId: 'machine-1',
        });
        await vi.waitFor(() => expect(ackSocket.emitWithAck).toHaveBeenCalledTimes(1));
        ackSocket.connected = false;
        releaseAck?.(currentAck());
        await expect(duringAck).resolves.toEqual({
            mode: 'indeterminate',
            sessionConnectionEpoch: 2,
            socket: ackSocket,
        });
    });

    it('keeps network, timeout, disconnected socket, and missing machine evidence indeterminate', async () => {
        const failureFetches = [
            vi.fn().mockRejectedValue(new Error('network')),
            vi.fn((...args: Parameters<typeof fetch>) => new Promise<Response>((_resolve, reject) => {
                args[1]?.signal?.addEventListener(
                    'abort',
                    () => reject(new DOMException('timed out', 'AbortError')),
                    { once: true },
                );
            })),
        ];
        for (const fetchImpl of failureFetches) {
            const controller = createSessionSyncPendingInputServerContractController({
                serverUrl: 'https://server.example', token: 'token', fetchImpl, timeoutMs: 1,
            });
            await expect(controller.resolve({ sessionConnectionEpoch: 1, socket: socket(currentAck()), machineId: 'machine-1' }))
                .resolves.toMatchObject({ mode: 'indeterminate' });
        }

        const disconnected = { ...socket(currentAck()), connected: false };
        const controller = createSessionSyncPendingInputServerContractController({
            serverUrl: 'https://server.example',
            token: 'token',
            fetchImpl: vi.fn().mockResolvedValue(response(currentFeatures())),
        });
        await expect(controller.resolve({ sessionConnectionEpoch: 2, socket: disconnected, machineId: 'machine-1' }))
            .resolves.toMatchObject({ mode: 'indeterminate' });
        await expect(controller.resolve({ sessionConnectionEpoch: 3, socket: socket(currentAck()), machineId: ' ' }))
            .resolves.toMatchObject({ mode: 'indeterminate' });
    });
});
