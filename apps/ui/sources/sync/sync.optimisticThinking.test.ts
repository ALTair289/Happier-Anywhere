import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ManagedEndpointSupervisor } from '@happier-dev/connection-supervisor';

type EndpointSupervisorLookup = typeof import('@/sync/runtime/connectivity/endpointSupervisorPool').getEndpointSupervisorForServer;
type EndpointSupervisorAcquire = typeof import('@/sync/runtime/connectivity/endpointSupervisorPool').acquireEndpointSupervisor;
type AssertServerReachabilityAuthenticated = typeof import('@/sync/runtime/connectivity/serverReachabilitySupervisorPool').assertServerReachabilityAuthenticated;
type ResumeSession = typeof import('@/sync/ops').resumeSession;

// Sync imports persistence, which instantiates MMKV. Mock it for deterministic tests.
const kvStore = vi.hoisted(() => new Map<string, string>());
vi.mock('react-native-mmkv', () => {
    class MMKV {
        getString(key: string) {
            return kvStore.get(key);
        }
        set(key: string, value: string) {
            kvStore.set(key, value);
        }
        delete(key: string) {
            kvStore.delete(key);
        }
        clearAll() {
            kvStore.clear();
        }
    }

    return { MMKV };
});

const appStateAddListener = vi.hoisted(() => vi.fn(() => ({ remove: vi.fn() })));
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                                            Platform: {
                                                OS: 'web',
                                            },
                                            AppState: {
                                                addEventListener: appStateAddListener as any,
                                            },
                                        }
    );
});

const getEndpointSupervisorForServerMock = vi.hoisted(() => vi.fn<EndpointSupervisorLookup>(() => null));
const acquireEndpointSupervisorMock = vi.hoisted(() => vi.fn<EndpointSupervisorAcquire>());
vi.mock('@/sync/runtime/connectivity/endpointSupervisorPool', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/sync/runtime/connectivity/endpointSupervisorPool')>();
    return {
        ...actual,
        getEndpointSupervisorForServer: (...args: Parameters<typeof actual.getEndpointSupervisorForServer>) =>
            getEndpointSupervisorForServerMock(...args),
        acquireEndpointSupervisor: (...args: Parameters<typeof actual.acquireEndpointSupervisor>) =>
            acquireEndpointSupervisorMock(...args),
    };
});

const assertServerReachabilityAuthenticatedMock = vi.hoisted(() => vi.fn<AssertServerReachabilityAuthenticated>());
vi.mock('@/sync/runtime/connectivity/serverReachabilitySupervisorPool', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/sync/runtime/connectivity/serverReachabilitySupervisorPool')>();
    return {
        ...actual,
        assertServerReachabilityAuthenticated: (...args: Parameters<typeof actual.assertServerReachabilityAuthenticated>) =>
            assertServerReachabilityAuthenticatedMock(...args),
    };
});

const resumeSessionMock = vi.hoisted(() => vi.fn<ResumeSession>(async () => ({ type: 'success' as const })));
vi.mock('@/sync/ops', () => ({
    resumeSession: resumeSessionMock,
}));

vi.mock('@/log', () => ({
    log: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@/voice/context/voiceHooks', () => ({
    voiceHooks: {
        onSessionFocus: vi.fn(),
        onSessionOffline: vi.fn(),
        onSessionOnline: vi.fn(),
        onMessages: vi.fn(),
        reportContextualUpdate: vi.fn(),
    },
}));

import { Encryption } from '@/sync/encryption/encryption';
import { storage } from './domains/state/storage';
import type { Session } from './domains/state/storageTypes';
import { apiSocket } from '@/sync/api/session/apiSocket';
import { HappyError } from '@/utils/errors/errors';
import { RPC_ERROR_CODES, SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import { RpcError } from '@happier-dev/protocol/rpcErrors';

const initialStorageState = storage.getState();

function createSession(params: { sessionId: string; metadata?: Session['metadata'] }): Session {
    const now = Date.now();
    return {
        id: params.sessionId,
        seq: 0,
        createdAt: now,
        updatedAt: now,
        active: true,
        activeAt: now,
        metadata: params.metadata ?? null,
        metadataVersion: 0,
        agentState: null,
        // Mark as ready to avoid the 10s wait-for-ready timeout.
        agentStateVersion: 1,
        thinking: false,
        thinkingAt: 0,
        presence: 'online',
        optimisticThinkingAt: null,
    };
}

function createRpcMethodNotAvailableError(): RpcError {
    return new RpcError('RPC method not available', RPC_ERROR_CODES.METHOD_NOT_AVAILABLE);
}

function createFallbackSafeSessionRpcErrors(): Error[] {
    return [
        new RpcError('RPC method not available', RPC_ERROR_CODES.METHOD_NOT_AVAILABLE),
        new RpcError('Method not found', RPC_ERROR_CODES.METHOD_NOT_FOUND),
        new Error('Socket connect timeout'),
        new Error('connect_error: legacy daemon reconnecting'),
        new Error('read ECONNRESET'),
        new Error('connect ECONNREFUSED 127.0.0.1:3005'),
    ];
}

function createAuthFailedEndpointSupervisor(): ManagedEndpointSupervisor {
    return {
        start: async () => {},
        stop: async () => {},
        invalidate: vi.fn(),
        reportFailure: vi.fn(),
        waitUntilOnline: async () => {},
        getState: () => ({
            phase: 'auth_failed',
            reason: 'auth_invalid',
            attempt: 1,
            nextRetryAt: null,
            lastConnectedAt: Date.now(),
            lastDisconnectedAt: Date.now(),
            lastErrorMessage: 'expired token',
            lastProbe: {
                status: 'auth_failed',
                statusCode: 401,
                errorMessage: 'expired token',
            },
        }),
        subscribe: () => vi.fn(),
    };
}

function createAuthProbeEndpointSupervisor(): ManagedEndpointSupervisor {
    let phase: 'online' | 'connecting' | 'auth_failed' = 'online';
    let lastProbe: ReturnType<ManagedEndpointSupervisor['getState']>['lastProbe'] = { status: 'ready' };
    const listeners = new Set<(state: ReturnType<ManagedEndpointSupervisor['getState']>) => void>();
    const readState = (): ReturnType<ManagedEndpointSupervisor['getState']> => ({
        phase,
        reason: phase === 'auth_failed' ? 'auth_invalid' : phase === 'online' ? 'initial_connect' : 'initial_connect',
        attempt: phase === 'auth_failed' ? 2 : 1,
        nextRetryAt: null,
        lastConnectedAt: Date.now(),
        lastDisconnectedAt: phase === 'auth_failed' ? Date.now() : null,
        lastErrorMessage: phase === 'auth_failed' ? 'expired token' : null,
        lastProbe,
    });
    const publish = () => {
        const state = readState();
        listeners.forEach((listener) => listener(state));
    };

    return {
        start: async () => {},
        stop: async () => {},
        invalidate: vi.fn(() => {
            phase = 'connecting';
            publish();
            phase = 'auth_failed';
            lastProbe = {
                status: 'auth_failed',
                statusCode: 401,
                errorMessage: 'expired token',
            };
            publish();
        }),
        reportFailure: vi.fn(),
        waitUntilOnline: async () => {},
        getState: readState,
        subscribe: (listener) => {
            listeners.add(listener);
            listener(readState());
            return () => listeners.delete(listener);
        },
    };
}

function createReadyEndpointSupervisor(): ManagedEndpointSupervisor {
    const readState = (): ReturnType<ManagedEndpointSupervisor['getState']> => ({
        phase: 'online',
        reason: 'initial_connect',
        attempt: 1,
        nextRetryAt: null,
        lastConnectedAt: Date.now(),
        lastDisconnectedAt: null,
        lastErrorMessage: null,
        lastProbe: { status: 'ready' },
    });

    return {
        start: async () => {},
        stop: async () => {},
        invalidate: vi.fn(),
        reportFailure: vi.fn(),
        waitUntilOnline: async () => {},
        getState: readState,
        subscribe: (listener) => {
            listener(readState());
            return vi.fn();
        },
    };
}

describe('sync.sendMessage optimistic thinking', () => {
    beforeEach(() => {
        storage.setState(initialStorageState, true);
        kvStore.clear();
        appStateAddListener.mockClear();
        getEndpointSupervisorForServerMock.mockReset();
        getEndpointSupervisorForServerMock.mockReturnValue(null);
        acquireEndpointSupervisorMock.mockReset();
        acquireEndpointSupervisorMock.mockResolvedValue({
            supervisor: createReadyEndpointSupervisor(),
            release: vi.fn(async () => {}),
        });
        assertServerReachabilityAuthenticatedMock.mockReset();
        resumeSessionMock.mockClear();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('preserves optimistic thinking after a successful ACK/commit (until lifecycle clears)', async () => {
        const sessionId = 's_test';
        storage.getState().applySessions([createSession({ sessionId })]);

        const encryption = await Encryption.create(new Uint8Array(32).fill(9));
        await encryption.initializeSessions(new Map([[sessionId, null]]));

        const { sync } = await import('./sync');
        sync.encryption = encryption;
        vi.spyOn(apiSocket, 'sessionRPC').mockRejectedValue(createRpcMethodNotAvailableError());
        sync.setMessageTransport({
            emitWithAck: vi.fn(async () => ({
                ok: true,
                id: 'm1',
                seq: 1,
                localId: null,
                didWrite: true,
            })) as any,
            send: vi.fn(),
        });

        expect(storage.getState().sessions[sessionId].optimisticThinkingAt ?? null).toBeNull();

        const promise = sync.sendMessage(sessionId, 'hello');

        // sendMessage marks optimistic thinking before the first await.
        expect(storage.getState().sessions[sessionId].optimisticThinkingAt ?? null).not.toBeNull();

        await promise;

        // ACK means the user message was committed; it does not mean the agent turn is complete.
        // Keep optimistic thinking so the UI can still show "processing" and expose abort controls
        // until we see a terminal lifecycle marker (task_complete / turn_aborted) or the timeout fires.
        expect(storage.getState().sessions[sessionId].optimisticThinkingAt ?? null).not.toBeNull();

        await (sync as any).applySessionThinkingFromTaskLifecycle(sessionId, {
            type: 'task_complete',
            id: 'task-1',
            createdAt: Date.now(),
        });
        expect(storage.getState().sessions[sessionId].optimisticThinkingAt ?? null).toBeNull();
    });

    it('notifies local pending projection after the pending row exists', async () => {
        const sessionId = 's_local_pending_projection_callback';
        storage.getState().applySessions([createSession({ sessionId })]);

        const encryption = await Encryption.create(new Uint8Array(32).fill(9));
        await encryption.initializeSessions(new Map([[sessionId, null]]));

        const { sync } = await import('./sync');
        sync.encryption = encryption;
        vi.spyOn(apiSocket, 'sessionRPC').mockRejectedValue(createRpcMethodNotAvailableError());
        sync.setMessageTransport({
            emitWithAck: vi.fn(async () => ({
                ok: true,
                id: 'm1',
                seq: 1,
                localId: 'local-visible-id',
                didWrite: true,
            })) as any,
            send: vi.fn(),
        });

        const projectionEvents: Array<Readonly<{ localId: string; pendingIds: readonly string[] }>> = [];

        await sync.sendMessage(sessionId, 'hello', undefined, undefined, {
            localId: 'local-visible-id',
            onLocalPendingProjectionCreated: ({ localId }) => {
                projectionEvents.push({
                    localId,
                    pendingIds: (storage.getState().sessionPending[sessionId]?.messages ?? []).map((message) => message.id),
                });
            },
        });

        expect(projectionEvents).toEqual([{
            localId: 'local-visible-id',
            pendingIds: ['local-visible-id'],
        }]);
    });

    it('hydrates a missing active session before sending the user message', async () => {
        const sessionId = 's_missing_then_hydrated';

        const encryption = await Encryption.create(new Uint8Array(32).fill(9));
        await encryption.initializeSessions(new Map([[sessionId, null]]));

        const emitWithAck = vi.fn(async () => ({
            ok: true,
            id: 'm1',
            seq: 1,
            localId: null,
            didWrite: true,
        })) as any;

        const { sync } = await import('./sync');
        sync.encryption = encryption;
        vi.spyOn(apiSocket, 'sessionRPC').mockRejectedValue(createRpcMethodNotAvailableError());
        sync.setMessageTransport({
            emitWithAck,
            send: vi.fn(),
        });

        const ensureSessionVisibleForMessageRouteSpy = vi
            .spyOn(sync as any, 'ensureSessionVisibleForMessageRoute')
            .mockImplementation(async () => {
                storage.getState().applySessions([createSession({ sessionId })]);
                return true;
            });

        await sync.sendMessage(sessionId, 'hello after hydrate');

        expect(ensureSessionVisibleForMessageRouteSpy).toHaveBeenCalledWith(sessionId, { forceRefresh: true });
        expect(emitWithAck).toHaveBeenCalledWith(
            'message',
            expect.objectContaining({
                sid: sessionId,
            }),
            expect.anything(),
        );
        expect(storage.getState().sessions[sessionId].optimisticThinkingAt ?? null).not.toBeNull();
    });

    it('removes the local pending row when socket fallback sees an auth-failed endpoint', async () => {
        const sessionId = 's_stale_auth_no_ack';
        storage.getState().applySessions([createSession({ sessionId })]);

        const encryption = await Encryption.create(new Uint8Array(32).fill(9));
        await encryption.initializeSessions(new Map([[sessionId, null]]));

        const { sync } = await import('./sync');
        sync.encryption = encryption;
        vi.spyOn(apiSocket, 'sessionRPC').mockRejectedValue(createRpcMethodNotAvailableError());

        getEndpointSupervisorForServerMock.mockReturnValue(createAuthFailedEndpointSupervisor());

        const send = vi.fn();
        sync.setMessageTransport({
            emitWithAck: vi.fn(async () => {
                throw new Error('operation has timed out');
            }),
            send,
        });

        await expect(sync.sendMessage(sessionId, 'stale auth send')).rejects.toMatchObject({
            name: 'HappyError',
            canTryAgain: false,
            kind: 'auth',
            code: 'not_authenticated',
        });

        expect(send).not.toHaveBeenCalled();
        expect(storage.getState().sessionPending[sessionId]?.messages ?? []).toEqual([]);
        expect(storage.getState().sessions[sessionId].optimisticThinkingAt ?? null).toBeNull();
        expect(storage.getState().syncError).toMatchObject({
            kind: 'auth',
            retryable: false,
            message: 'Authentication required',
        });
    });

    it('forces endpoint auth convergence before user no-ack fallback restores the draft', async () => {
        const sessionId = 's_stale_auth_probe_no_ack';
        storage.getState().applySessions([createSession({ sessionId })]);

        const encryption = await Encryption.create(new Uint8Array(32).fill(9));
        await encryption.initializeSessions(new Map([[sessionId, null]]));

        const { sync } = await import('./sync');
        sync.encryption = encryption;
        vi.spyOn(apiSocket, 'sessionRPC').mockRejectedValue(createRpcMethodNotAvailableError());

        const supervisor = createAuthProbeEndpointSupervisor();
        getEndpointSupervisorForServerMock.mockReturnValue(supervisor);

        const send = vi.fn();
        sync.setMessageTransport({
            emitWithAck: vi.fn(async () => {
                throw new Error('operation has timed out');
            }),
            send,
        });

        await expect(sync.sendMessage(sessionId, 'stale auth send')).rejects.toMatchObject({
            name: 'HappyError',
            canTryAgain: false,
            kind: 'auth',
            code: 'not_authenticated',
        });

        expect(supervisor.invalidate).toHaveBeenCalledTimes(1);
        expect(send).not.toHaveBeenCalled();
        expect(storage.getState().sessionPending[sessionId]?.messages ?? []).toEqual([]);
        expect(storage.getState().sessions[sessionId].optimisticThinkingAt ?? null).toBeNull();
        expect(storage.getState().syncError).toMatchObject({
            kind: 'auth',
            retryable: false,
            message: 'Authentication required',
        });
    });

    it('acquires an endpoint supervisor before probing auth for user no-ack fallback', async () => {
        const sessionId = 's_stale_auth_probe_no_existing_supervisor';
        storage.getState().applySessions([createSession({ sessionId })]);

        const encryption = await Encryption.create(new Uint8Array(32).fill(9));
        await encryption.initializeSessions(new Map([[sessionId, null]]));

        const { sync } = await import('./sync');
        sync.encryption = encryption;
        vi.spyOn(apiSocket, 'sessionRPC').mockRejectedValue(createRpcMethodNotAvailableError());

        const supervisor = createAuthProbeEndpointSupervisor();
        acquireEndpointSupervisorMock.mockResolvedValue({
            supervisor,
            release: vi.fn(async () => {}),
        });

        const send = vi.fn();
        sync.setMessageTransport({
            emitWithAck: vi.fn(async () => {
                throw new Error('operation has timed out');
            }),
            send,
        });

        await expect(sync.sendMessage(sessionId, 'stale auth send')).rejects.toMatchObject({
            name: 'HappyError',
            canTryAgain: false,
            kind: 'auth',
            code: 'not_authenticated',
        });

        expect(acquireEndpointSupervisorMock).toHaveBeenCalledTimes(1);
        expect(supervisor.invalidate).toHaveBeenCalledTimes(1);
        expect(send).not.toHaveBeenCalled();
        expect(storage.getState().sessionPending[sessionId]?.messages ?? []).toEqual([]);
        expect(storage.getState().syncError).toMatchObject({
            kind: 'auth',
            retryable: false,
        });
    });

    it('uses server reachability auth state before user no-ack fallback restores the draft', async () => {
        const sessionId = 's_stale_auth_reachability_no_ack';
        storage.getState().applySessions([createSession({ sessionId })]);

        const encryption = await Encryption.create(new Uint8Array(32).fill(9));
        await encryption.initializeSessions(new Map([[sessionId, null]]));

        const { sync } = await import('./sync');
        sync.encryption = encryption;
        vi.spyOn(apiSocket, 'sessionRPC').mockRejectedValue(createRpcMethodNotAvailableError());

        assertServerReachabilityAuthenticatedMock.mockImplementation(() => {
            throw new HappyError('Authentication required', false, {
                kind: 'auth',
                code: 'not_authenticated',
                status: 401,
            });
        });

        const send = vi.fn();
        sync.setMessageTransport({
            emitWithAck: vi.fn(async () => {
                throw new Error('operation has timed out');
            }),
            send,
        });

        await expect(sync.sendMessage(sessionId, 'stale auth send')).rejects.toMatchObject({
            name: 'HappyError',
            canTryAgain: false,
            kind: 'auth',
            code: 'not_authenticated',
        });

        expect(assertServerReachabilityAuthenticatedMock).toHaveBeenCalled();
        expect(acquireEndpointSupervisorMock).not.toHaveBeenCalled();
        expect(send).not.toHaveBeenCalled();
        expect(storage.getState().sessionPending[sessionId]?.messages ?? []).toEqual([]);
        expect(storage.getState().syncError).toMatchObject({
            kind: 'auth',
            retryable: false,
        });
    });

    it('prefers session runtime RPC for active sessions so steering-capable agents receive the user message directly', async () => {
        const sessionId = 's_active_runtime_rpc';
        storage.getState().applySessions([createSession({ sessionId })]);

        const encryption = await Encryption.create(new Uint8Array(32).fill(9));
        await encryption.initializeSessions(new Map([[sessionId, null]]));

        const sessionRpcSpy = vi.spyOn(apiSocket, 'sessionRPC').mockResolvedValue({ ok: true } as any);
        const emitWithAck = vi.fn(async () => ({
            ok: true,
            id: 'm1',
            seq: 1,
            localId: null,
            didWrite: true,
        })) as any;

        const { sync } = await import('./sync');
        sync.encryption = encryption;
        sync.setMessageTransport({
            emitWithAck,
            send: vi.fn(),
        });

        await sync.sendMessage(sessionId, 'steer this');

        expect(sessionRpcSpy).toHaveBeenCalledWith(
            sessionId,
            SESSION_RPC_METHODS.SESSION_USER_MESSAGE_SEND,
            expect.objectContaining({
                text: 'steer this',
                localId: expect.any(String),
                meta: expect.objectContaining({
                    sentFrom: expect.any(String),
                    permissionMode: 'default',
                }),
            }),
            { timeoutMs: 7_500 },
        );
        expect(emitWithAck).not.toHaveBeenCalled();

        const pending = storage.getState().sessionPending[sessionId]?.messages ?? [];
        expect(pending.map((message) => message.text)).toEqual(['steer this']);
        expect(pending.map((message) => message.deliveryStatus)).toEqual(['accepted']);
        expect(storage.getState().sessions[sessionId].optimisticThinkingAt ?? null).not.toBeNull();

        sessionRpcSpy.mockRestore();
    });

    it('keeps a runtime-accepted local pending message when server pending refresh is empty', async () => {
        const sessionId = 's_active_runtime_rpc_pending_refresh';
        storage.getState().applySessions([createSession({ sessionId })]);

        const encryption = await Encryption.create(new Uint8Array(32).fill(9));
        await encryption.initializeSessions(new Map([[sessionId, null]]));

        const sessionRpcSpy = vi.spyOn(apiSocket, 'sessionRPC').mockResolvedValue({ ok: true } as any);
        const requestSpy = vi.spyOn(apiSocket, 'request').mockResolvedValue(
            new Response(JSON.stringify({ pending: [] }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            }),
        );

        const { sync } = await import('./sync');
        sync.encryption = encryption;
        sync.setMessageTransport({
            emitWithAck: vi.fn(),
            send: vi.fn(),
        });

        await sync.sendMessage(
            sessionId,
            'first prompt remains visible',
            undefined,
            undefined,
            { localId: 'first-turn-local' },
        );
        expect(storage.getState().sessionPending[sessionId]?.messages.map((message) => message.id)).toEqual([
            'first-turn-local',
        ]);

        await sync.fetchPendingMessages(sessionId);

        expect(requestSpy).toHaveBeenCalledWith(
            `/v2/sessions/${sessionId}/pending?includeDiscarded=1`,
            { method: 'GET' },
        );
        expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
            expect.objectContaining({
                id: 'first-turn-local',
                localId: 'first-turn-local',
                deliveryStatus: 'accepted',
                text: 'first prompt remains visible',
            }),
        ]);

        sessionRpcSpy.mockRestore();
        requestSpy.mockRestore();
    });

    it.each(createFallbackSafeSessionRpcErrors())(
        'falls back to the socket commit path when active-session runtime RPC fails with %s',
        async (sessionRpcError) => {
            const sessionId = 's_active_runtime_rpc_fallback';
            storage.getState().applySessions([createSession({ sessionId })]);

            const encryption = await Encryption.create(new Uint8Array(32).fill(9));
            await encryption.initializeSessions(new Map([[sessionId, null]]));

            const sessionRpcSpy = vi.spyOn(apiSocket, 'sessionRPC').mockRejectedValue(sessionRpcError);
            const emitWithAck = vi.fn(async () => ({
                ok: true,
                id: 'm-fallback',
                seq: 7,
                localId: null,
                didWrite: true,
            })) as any;

            const { sync } = await import('./sync');
            sync.encryption = encryption;
            sync.setMessageTransport({
                emitWithAck,
                send: vi.fn(),
            });

            await sync.sendMessage(sessionId, 'fallback please');

            expect(sessionRpcSpy).toHaveBeenCalledTimes(1);
            expect(emitWithAck).toHaveBeenCalledWith(
                'message',
                expect.objectContaining({
                    sid: sessionId,
                    localId: expect.any(String),
                    messageRole: 'user',
                }),
                expect.anything(),
            );

            sessionRpcSpy.mockRestore();
        },
    );

    it('retries runtime RPC readiness for messages that require provider delivery instead of using transcript fallback', async () => {
        vi.useFakeTimers();
        try {
            const sessionId = 's_required_runtime_rpc';
            storage.getState().applySessions([{
                ...createSession({ sessionId }),
                encryptionMode: 'plain',
            } as Session]);

            const encryption = await Encryption.create(new Uint8Array(32).fill(9));
            await encryption.initializeSessions(new Map([[sessionId, null]]));

            const sessionRpcSpy = vi.spyOn(apiSocket, 'sessionRPC')
                .mockRejectedValueOnce(createRpcMethodNotAvailableError())
                .mockResolvedValueOnce({ ok: true } as any);
            const emitWithAck = vi.fn(async () => ({
                ok: true,
                id: 'm-should-not-commit',
                seq: 7,
                localId: null,
                didWrite: true,
            })) as any;

            const { sync } = await import('./sync');
            sync.encryption = encryption;
            sync.setMessageTransport({
                emitWithAck,
                send: vi.fn(),
            });

            const sendPromise = sync.sendMessage(
                sessionId,
                'first prompt must reach runtime',
                undefined,
                undefined,
                {
                    localId: 'first-turn-local',
                    bypassPendingQueueReason: 'spawned_session_follow_up',
                    runtimeRpcDeliveryMode: 'required',
                },
            );

            await Promise.resolve();
            await Promise.resolve();
            expect(sessionRpcSpy).toHaveBeenCalledTimes(1);
            expect(emitWithAck).not.toHaveBeenCalled();

            await vi.advanceTimersByTimeAsync(250);
            await sendPromise;

            expect(sessionRpcSpy).toHaveBeenCalledTimes(2);
            expect(emitWithAck).not.toHaveBeenCalled();
            expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
                expect.objectContaining({
                    id: 'first-turn-local',
                    localId: 'first-turn-local',
                    deliveryStatus: 'accepted',
                    text: 'first prompt must reach runtime',
                }),
            ]);

            sessionRpcSpy.mockRestore();
        } finally {
            vi.useRealTimers();
        }
    });

    it('skips session runtime RPC for older attached CLI versions and uses the legacy socket commit path directly', async () => {
        const sessionId = 's_active_legacy_cli';
        storage.getState().applySessions([createSession({
            sessionId,
            metadata: {
                version: '0.1.0',
            } as any,
        })]);

        const encryption = await Encryption.create(new Uint8Array(32).fill(9));
        await encryption.initializeSessions(new Map([[sessionId, null]]));

        const sessionRpcSpy = vi.spyOn(apiSocket, 'sessionRPC').mockResolvedValue({ ok: true } as any);
        const emitWithAck = vi.fn(async () => ({
            ok: true,
            id: 'm-legacy',
            seq: 7,
            localId: null,
            didWrite: true,
        })) as any;

        const { sync } = await import('./sync');
        sync.encryption = encryption;
        sync.setMessageTransport({
            emitWithAck,
            send: vi.fn(),
        });

        await sync.sendMessage(sessionId, 'legacy please');

        expect(sessionRpcSpy).not.toHaveBeenCalled();
        expect(emitWithAck).toHaveBeenCalledWith(
            'message',
            expect.objectContaining({
                sid: sessionId,
                localId: expect.any(String),
                messageRole: 'user',
            }),
            expect.anything(),
        );
    });

    it('still uses session runtime RPC for compatible 0.1.0 dev session versions', async () => {
        const sessionId = 's_active_dev_cli';
        storage.getState().applySessions([createSession({
            sessionId,
            metadata: {
                version: '0.1.0-dev.1775063171.91734',
            } as any,
        })]);

        const encryption = await Encryption.create(new Uint8Array(32).fill(9));
        await encryption.initializeSessions(new Map([[sessionId, null]]));

        const sessionRpcSpy = vi.spyOn(apiSocket, 'sessionRPC').mockResolvedValue({ ok: true } as any);
        const emitWithAck = vi.fn(async () => ({
            ok: true,
            id: 'm-dev',
            seq: 7,
            localId: null,
            didWrite: true,
        })) as any;

        const { sync } = await import('./sync');
        sync.encryption = encryption;
        sync.setMessageTransport({
            emitWithAck,
            send: vi.fn(),
        });

        await sync.sendMessage(sessionId, 'dev please');

        expect(sessionRpcSpy).toHaveBeenCalledTimes(1);
        expect(emitWithAck).not.toHaveBeenCalled();
    });

    it('sendPendingMessageNow routes explicit steer-now through the active session submit path', async () => {
        const sessionId = 's_pending_send_now';
        storage.getState().applySessions([createSession({ sessionId })]);

        const encryption = await Encryption.create(new Uint8Array(32).fill(9));
        await encryption.initializeSessions(new Map([[sessionId, null]]));

        const rawRecord = {
            role: 'user',
            content: { type: 'text', text: 'hello' },
            meta: {},
        } as any;

        storage.getState().upsertPendingMessage(sessionId, {
            id: 'p1',
            localId: 'p1',
            createdAt: 111,
            updatedAt: 111,
            text: 'hello',
            rawRecord,
        });

        const sessionRpcSpy = vi.spyOn(apiSocket, 'sessionRPC').mockResolvedValue({ ok: true } as any);
        const emitWithAck = vi.fn(async () => ({
            ok: true,
            id: 'm1',
            seq: 1,
            localId: null,
            didWrite: true,
        })) as any;

        const { sync } = await import('./sync');
        sync.encryption = encryption;
        sync.setMessageTransport({
            emitWithAck,
            send: vi.fn(),
        });

        const pendingBefore = (storage.getState().sessionPending[sessionId]?.messages ?? []).map((m) => m.id);
        expect(pendingBefore).toContain('p1');

        const result = await sync.sendPendingMessageNow(sessionId, {
            localId: 'p1',
            createdAt: 111,
            rawRecord,
            text: 'hello',
            deliveryIntent: 'steer_now',
        });

        expect(result).toEqual({ type: 'committed' });
        expect(sessionRpcSpy).toHaveBeenCalledWith(
            sessionId,
            SESSION_RPC_METHODS.SESSION_USER_MESSAGE_SEND,
            expect.objectContaining({
                text: 'hello',
                localId: 'p1',
                meta: expect.any(Object),
            }),
            { timeoutMs: 7_500 },
        );
        expect(emitWithAck).not.toHaveBeenCalled();

        // No duplicate pending row should be created (localId is preserved).
        const pendingAfter = storage.getState().sessionPending[sessionId]?.messages ?? [];
        expect(pendingAfter.map((message) => message.id)).toEqual(['p1']);
        expect(pendingAfter.map((message) => message.deliveryStatus)).toEqual(['accepted']);

        expect(storage.getState().sessions[sessionId].optimisticThinkingAt ?? null).not.toBeNull();

        await (sync as any).applySessionThinkingFromTaskLifecycle(sessionId, {
            type: 'task_complete',
            id: 'task-1',
            createdAt: Date.now(),
        });
        expect(storage.getState().sessions[sessionId].optimisticThinkingAt ?? null).toBeNull();
    });

    it('sendPendingMessageNow removes the pending row when the server rejects the message', async () => {
        const sessionId = 's_pending_rejected';
        storage.getState().applySessions([createSession({ sessionId })]);

        const encryption = await Encryption.create(new Uint8Array(32).fill(9));
        await encryption.initializeSessions(new Map([[sessionId, null]]));

        const rawRecord = {
            role: 'user',
            content: { type: 'text', text: 'hello' },
            meta: {},
        } as const;

        storage.getState().upsertPendingMessage(sessionId, {
            id: 'p-reject',
            localId: 'p-reject',
            createdAt: 111,
            updatedAt: 111,
            text: 'hello',
            rawRecord,
        });

        const emitWithAck = vi.fn(async () => ({
            ok: false,
            error: 'rejected',
        })) as any;

        const { sync } = await import('./sync');
        sync.encryption = encryption;
        sync.setMessageTransport({
            emitWithAck,
            send: vi.fn(),
        });

        await expect(sync.sendPendingMessageNow(sessionId, {
            localId: 'p-reject',
            createdAt: 111,
            rawRecord,
            text: 'hello',
        })).rejects.toThrow('rejected');

        expect(storage.getState().sessionPending[sessionId]?.messages ?? []).toEqual([]);
        expect(storage.getState().sessions[sessionId].optimisticThinkingAt ?? null).toBeNull();
    });

    it('sendPendingMessageNow schedules a retry when the transport produces no ack', async () => {
        const sessionId = 's_pending_retry';
        storage.getState().applySessions([createSession({ sessionId })]);

        const encryption = await Encryption.create(new Uint8Array(32).fill(9));
        await encryption.initializeSessions(new Map([[sessionId, null]]));

        const rawRecord = {
            role: 'user',
            content: { type: 'text', text: 'hello' },
            meta: {},
        } as const;

        storage.getState().upsertPendingMessage(sessionId, {
            id: 'p-retry',
            localId: 'p-retry',
            createdAt: 111,
            updatedAt: 111,
            text: 'hello',
            rawRecord,
        });

        const { sync } = await import('./sync');
        sync.encryption = encryption;
        sync.setMessageTransport({
            emitWithAck: vi.fn(async () => null) as any,
            send: vi.fn(),
        });

        const result = await sync.sendPendingMessageNow(sessionId, {
            localId: 'p-retry',
            createdAt: 111,
            rawRecord,
            text: 'hello',
        });

        expect(result).toEqual({ type: 'retry_scheduled' });
        expect((sync as any).pendingMessageCommitRetryTimers.has(`${sessionId}:p-retry`)).toBe(true);
        expect(storage.getState().sessions[sessionId].optimisticThinkingAt ?? null).toBeNull();
    });

    it('sendPendingMessageNow wakes inactive sessions from the committed pending row cursor', async () => {
        const sessionId = 's_pending_send_now_inactive_wake';
        storage.getState().applySessions([{
            ...createSession({
                sessionId,
                metadata: {
                    machineId: 'm1',
                    path: '/repo',
                    flavor: 'codex',
                } as any,
            }),
            active: false,
            presence: 'online',
        }]);

        const encryption = await Encryption.create(new Uint8Array(32).fill(9));
        await encryption.initializeSessions(new Map([[sessionId, null]]));

        const rawRecord = {
            role: 'user',
            content: { type: 'text', text: 'wake from pending' },
            meta: {},
        } as const;

        storage.getState().upsertPendingMessage(sessionId, {
            id: 'p-wake',
            localId: 'p-wake',
            createdAt: 111,
            updatedAt: 111,
            text: 'wake from pending',
            rawRecord,
        });

        const emitWithAck = vi.fn(async () => ({
            ok: true,
            id: 'm-wake',
            seq: 42,
            localId: null,
            didWrite: true,
        })) as any;

        const { sync } = await import('./sync');
        sync.encryption = encryption;
        sync.setMessageTransport({
            emitWithAck,
            send: vi.fn(),
        });

        await sync.sendPendingMessageNow(sessionId, {
            localId: 'p-wake',
            createdAt: 111,
            rawRecord,
            text: 'wake from pending',
        });

        expect(resumeSessionMock).toHaveBeenCalledTimes(1);
        expect(resumeSessionMock).toHaveBeenCalledWith(expect.objectContaining({
            sessionId,
            machineId: 'm1',
            directory: '/repo',
            backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
            initialTranscriptAfterSeq: 41,
        }));
    });

    it('removes only the retried local pending row when retry discovers terminal auth', async () => {
        vi.useFakeTimers();
        try {
            const sessionId = 's_pending_retry_auth';
            storage.getState().applySessions([createSession({ sessionId })]);

            const encryption = await Encryption.create(new Uint8Array(32).fill(9));
            await encryption.initializeSessions(new Map([[sessionId, null]]));

            const retryRawRecord = {
                role: 'user',
                content: { type: 'text', text: 'retry me' },
                meta: {},
            } as const;
            const persistedRawRecord = {
                role: 'user',
                content: { type: 'text', text: 'keep me' },
                meta: {},
            } as const;

            storage.getState().upsertPendingMessage(sessionId, {
                id: 'p-retry-auth',
                localId: 'p-retry-auth',
                createdAt: 111,
                updatedAt: 111,
                text: 'retry me',
                rawRecord: retryRawRecord,
            });
            storage.getState().upsertPendingMessage(sessionId, {
                id: 'p-persisted',
                localId: 'p-persisted',
                createdAt: 222,
                updatedAt: 222,
                text: 'keep me',
                rawRecord: persistedRawRecord,
            });

            const emitWithAck = vi.fn()
                .mockResolvedValueOnce(null)
                .mockRejectedValueOnce(new HappyError('Authentication required', false, {
                    kind: 'auth',
                    code: 'not_authenticated',
                    status: 401,
                }));

            const { sync } = await import('./sync');
            sync.encryption = encryption;
            sync.setMessageTransport({
                emitWithAck: emitWithAck as any,
                send: vi.fn(),
            });

            await sync.sendPendingMessageNow(sessionId, {
                localId: 'p-retry-auth',
                createdAt: 111,
                rawRecord: retryRawRecord,
                text: 'retry me',
            });
            storage.getState().markSessionOptimisticThinking(sessionId);

            await vi.advanceTimersByTimeAsync(1_000);
            await Promise.resolve();

            expect(emitWithAck).toHaveBeenCalledTimes(2);
            expect(emitWithAck.mock.calls[1]?.[1]).toEqual(expect.objectContaining({
                localId: 'p-retry-auth',
                messageRole: 'user',
            }));
            expect((sync as any).pendingMessageCommitRetryTimers.has(`${sessionId}:p-retry-auth`)).toBe(false);
            expect(storage.getState().sessionPending[sessionId]?.messages.map((message) => message.id)).toEqual(['p-persisted']);
            expect(storage.getState().sessions[sessionId].optimisticThinkingAt ?? null).toBeNull();
            expect(storage.getState().syncError).toMatchObject({
                kind: 'auth',
                retryable: false,
                message: 'Authentication required',
            });
        } finally {
            vi.useRealTimers();
        }
    });

    it('forces endpoint auth convergence before a pending retry keeps backing off on timeout', async () => {
        vi.useFakeTimers();
        try {
            const sessionId = 's_pending_retry_probe_auth';
            storage.getState().applySessions([createSession({ sessionId })]);

            const encryption = await Encryption.create(new Uint8Array(32).fill(9));
            await encryption.initializeSessions(new Map([[sessionId, null]]));

            const initialSupervisor = createReadyEndpointSupervisor();
            const retrySupervisor = createAuthProbeEndpointSupervisor();
            getEndpointSupervisorForServerMock
                .mockReturnValueOnce(initialSupervisor)
                .mockReturnValueOnce(initialSupervisor)
                .mockReturnValue(retrySupervisor);

            const emitWithAck = vi.fn()
                .mockResolvedValueOnce(null)
                .mockRejectedValueOnce(new Error('ack timeout'));

            const { sync } = await import('./sync');
            sync.encryption = encryption;
            vi.spyOn(apiSocket, 'sessionRPC').mockRejectedValue(createRpcMethodNotAvailableError());
            sync.setMessageTransport({
                emitWithAck: emitWithAck as any,
                send: vi.fn(),
            });

            await sync.sendMessage(sessionId, 'retry me');
            storage.getState().markSessionOptimisticThinking(sessionId);

            await vi.advanceTimersByTimeAsync(1_000);
            await Promise.resolve();

            expect(emitWithAck).toHaveBeenCalledTimes(2);
            expect(retrySupervisor.invalidate).toHaveBeenCalledTimes(1);
            const retryKeys = Array.from((sync as any).pendingMessageCommitRetryTimers.keys()) as string[];
            expect(retryKeys.some((key) => key.startsWith(`${sessionId}:`))).toBe(false);
            expect(storage.getState().sessionPending[sessionId]?.messages ?? []).toEqual([]);
            expect(storage.getState().sessions[sessionId].optimisticThinkingAt ?? null).toBeNull();
            expect(storage.getState().syncError).toMatchObject({
                kind: 'auth',
                retryable: false,
                message: 'Authentication required',
            });
        } finally {
            vi.useRealTimers();
        }
    });

    it('forces endpoint auth convergence before retrying a pending local row again', async () => {
        vi.useFakeTimers();
        try {
            const sessionId = 's_pending_retry_auth_probe';
            storage.getState().applySessions([createSession({ sessionId })]);

            const encryption = await Encryption.create(new Uint8Array(32).fill(9));
            await encryption.initializeSessions(new Map([[sessionId, null]]));

            const retryRawRecord = {
                role: 'user',
                content: { type: 'text', text: 'retry me' },
                meta: {},
            } as const;
            const persistedRawRecord = {
                role: 'user',
                content: { type: 'text', text: 'keep me' },
                meta: {},
            } as const;

            storage.getState().upsertPendingMessage(sessionId, {
                id: 'p-retry-auth-probe',
                localId: 'p-retry-auth-probe',
                createdAt: 111,
                updatedAt: 111,
                text: 'retry me',
                rawRecord: retryRawRecord,
            });
            storage.getState().upsertPendingMessage(sessionId, {
                id: 'p-persisted',
                localId: 'p-persisted',
                createdAt: 222,
                updatedAt: 222,
                text: 'keep me',
                rawRecord: persistedRawRecord,
            });

            const initialSupervisor = createReadyEndpointSupervisor();
            const supervisor = createAuthProbeEndpointSupervisor();
            getEndpointSupervisorForServerMock
                .mockReturnValueOnce(initialSupervisor)
                .mockReturnValueOnce(initialSupervisor)
                .mockReturnValue(supervisor);

            const emitWithAck = vi.fn()
                .mockResolvedValueOnce(null)
                .mockRejectedValueOnce(new Error('operation has timed out'));

            const { sync } = await import('./sync');
            sync.encryption = encryption;
            sync.setMessageTransport({
                emitWithAck: emitWithAck as any,
                send: vi.fn(),
            });

            await sync.sendPendingMessageNow(sessionId, {
                localId: 'p-retry-auth-probe',
                createdAt: 111,
                rawRecord: retryRawRecord,
                text: 'retry me',
            });
            storage.getState().markSessionOptimisticThinking(sessionId);

            await vi.advanceTimersByTimeAsync(1_000);
            await Promise.resolve();

            expect(emitWithAck).toHaveBeenCalledTimes(2);
            expect(supervisor.invalidate).toHaveBeenCalledTimes(1);
            expect((sync as any).pendingMessageCommitRetryTimers.has(`${sessionId}:p-retry-auth-probe`)).toBe(false);
            expect(storage.getState().sessionPending[sessionId]?.messages.map((message) => message.id)).toEqual(['p-persisted']);
            expect(storage.getState().sessions[sessionId].optimisticThinkingAt ?? null).toBeNull();
            expect(storage.getState().syncError).toMatchObject({
                kind: 'auth',
                retryable: false,
                message: 'Authentication required',
            });
        } finally {
            vi.useRealTimers();
        }
    });

    it('sends plaintext message envelopes when session encryptionMode is plain', async () => {
        const sessionId = 's_plain_send';
        storage.getState().applySessions([{ ...createSession({ sessionId }), encryptionMode: 'plain' }]);

        const encryptRawRecord = vi.fn(async () => {
            throw new Error('encryptRawRecord should not be called')
        })
        const encryption = {
            getSessionEncryption: () => ({ encryptRawRecord }),
        } as unknown as Encryption;

        const emitWithAck = vi.fn(async () => ({
            ok: true,
            id: 'm1',
            seq: 1,
            localId: null,
            didWrite: true,
        })) as any;

        const { sync } = await import('./sync');
        sync.encryption = encryption as any;
        vi.spyOn(apiSocket, 'sessionRPC').mockRejectedValue(createRpcMethodNotAvailableError());
        sync.setMessageTransport({
            emitWithAck,
            send: vi.fn(),
        });

        await sync.sendMessage(sessionId, 'hello');

        expect(encryptRawRecord).not.toHaveBeenCalled();
        expect(emitWithAck).toHaveBeenCalledWith(
            'message',
            expect.objectContaining({
                sid: sessionId,
                message: expect.objectContaining({ t: 'plain', v: expect.any(Object) }),
                messageRole: 'user',
            }),
            expect.anything(),
        );
    });

    it('retries pending message commits with plaintext envelopes for plaintext sessions', async () => {
        vi.useFakeTimers();
        try {
            const sessionId = 's_plain_pending_retry';
            storage.getState().applySessions([{ ...createSession({ sessionId }), encryptionMode: 'plain' }]);

            const getSessionEncryption = vi.fn(() => null);
            const encryption = {
                getSessionEncryption,
            } as unknown as Encryption;

            const emitWithAck = vi.fn()
                .mockImplementationOnce(async () => {
                    throw new Error('ack timeout');
                })
                .mockImplementationOnce(async () => ({
                    ok: true,
                    id: 'm_plain_retry_1',
                    seq: 1,
                    localId: null,
                    didWrite: true,
                })) as any;

            const { sync } = await import('./sync');
            sync.encryption = encryption as any;
            vi.spyOn(apiSocket, 'sessionRPC').mockRejectedValue(createRpcMethodNotAvailableError());
            sync.setMessageTransport({
                emitWithAck,
                send: vi.fn(),
            });

            await sync.sendMessage(sessionId, 'hello');
            expect(storage.getState().sessionPending[sessionId]?.messages?.length ?? 0).toBe(1);

            await vi.advanceTimersByTimeAsync(1_000);
            await Promise.resolve();

            expect(getSessionEncryption).not.toHaveBeenCalled();
            expect(emitWithAck).toHaveBeenCalledTimes(2);
            expect(emitWithAck).toHaveBeenLastCalledWith(
                'message',
                expect.objectContaining({
                    sid: sessionId,
                    message: expect.objectContaining({ t: 'plain', v: expect.any(Object) }),
                    messageRole: 'user',
                }),
                expect.anything(),
            );
            expect(storage.getState().sessionPending[sessionId]?.messages ?? []).toEqual([]);
        } finally {
            vi.useRealTimers();
        }
    });

    it('includes metaOverrides (e.g. meta.happier) in the outbound rawRecord meta', async () => {
        const sessionId = 's_meta_overrides';
        storage.getState().applySessions([createSession({ sessionId })]);

        const encryption = await Encryption.create(new Uint8Array(32).fill(9));
        await encryption.initializeSessions(new Map([[sessionId, null]]));

        const { sync } = await import('./sync');
        sync.encryption = encryption;
        vi.spyOn(apiSocket, 'sessionRPC').mockRejectedValue(createRpcMethodNotAvailableError());
        sync.setMessageTransport({
            emitWithAck: vi.fn(async () => ({
                ok: true,
                id: 'm1',
                seq: 1,
                localId: null,
                didWrite: true,
            })) as any,
            send: vi.fn(),
        });

        await sync.sendMessage(sessionId, 'hello', 'Review comments (0)', {
            happier: { kind: 'review_comments.v1', payload: { sessionId, comments: [] } },
        } as any);

        const pending = storage.getState().sessionPending[sessionId]?.messages ?? [];
        expect(pending.length).toBe(0);
        const sessionMessages = storage.getState().sessionMessages[sessionId];
        const transcriptIds = sessionMessages?.messageIdsOldestFirst ?? [];
        const transcript = sessionMessages
            ? transcriptIds.map((id) => sessionMessages.messagesById[id]).filter(Boolean)
            : [];
        const user = transcript.find((m) => m.kind === 'user-text') as any;
        expect(user?.meta?.happier?.kind).toBe('review_comments.v1');
        expect(user?.seq).toBe(1);
    });

    it('does not materialize appendSystemPrompt in first-turn message metadata', async () => {
        const sessionId = 's_profile_override';
        storage.getState().applySessions([{ ...createSession({ sessionId }), encryptionMode: 'plain' }]);

        const emitWithAck = vi.fn(async () => ({
            ok: true,
            id: 'm1',
            seq: 1,
            localId: null,
            didWrite: true,
        })) as any;

        const { sync } = await import('./sync');
        sync.encryption = {
            getSessionEncryption: () => null,
        } as any;
        vi.spyOn(apiSocket, 'sessionRPC').mockRejectedValue(createRpcMethodNotAvailableError());
        sync.setMessageTransport({
            emitWithAck,
            send: vi.fn(),
        });

        await sync.sendMessage(
            sessionId,
            'hello',
            undefined,
            undefined,
            { profileId: 'profile-test' },
        );

        const payload = emitWithAck.mock.calls[0]?.[1];
        expect(payload?.message?.t).toBe('plain');
        expect(Object.prototype.hasOwnProperty.call(payload?.message?.v?.meta ?? {}, 'appendSystemPrompt')).toBe(false);
    });

    it('clears optimistic thinking when a turn is aborted even if session.thinking is already false', async () => {
        const sessionId = 's_turn_aborted';
        storage.getState().applySessions([createSession({ sessionId })]);
        storage.getState().markSessionOptimisticThinking(sessionId);
        expect(storage.getState().sessions[sessionId].optimisticThinkingAt ?? null).not.toBeNull();

        const { sync } = await import('./sync');
        await (sync as any).applySessionThinkingFromTaskLifecycle(sessionId, {
            type: 'turn_aborted',
            id: 'task-abort-1',
            createdAt: Date.now(),
        });

        expect(storage.getState().sessions[sessionId].thinking).toBe(false);
        expect(storage.getState().sessions[sessionId].optimisticThinkingAt ?? null).toBeNull();
    });

    it.each(['turn_failed', 'turn_cancelled'] as const)(
        'clears optimistic thinking when catch-up observes terminal %s lifecycle events',
        async (eventType) => {
            const sessionId = `s_${eventType}`;
            storage.getState().applySessions([createSession({ sessionId })]);
            storage.getState().markSessionOptimisticThinking(sessionId);
            expect(storage.getState().sessions[sessionId].optimisticThinkingAt ?? null).not.toBeNull();

            const { sync } = await import('./sync');
            await (sync as any).applySessionThinkingFromTaskLifecycle(sessionId, {
                type: eventType,
                id: `task-${eventType}`,
                createdAt: Date.now(),
            });

            expect(storage.getState().sessions[sessionId].thinking).toBe(false);
            expect(storage.getState().sessions[sessionId].optimisticThinkingAt ?? null).toBeNull();
        },
    );

    it('marks running approved tools unavailable when a turn is aborted', async () => {
        const sessionId = 's_turn_aborted_tools';
        const now = Date.now();

        storage.getState().applySessions([{
            ...createSession({ sessionId }),
            agentState: {
                completedRequests: {
                    'tool-1': {
                        tool: 'Bash',
                        arguments: { command: 'sleep 5' },
                        createdAt: now - 5_000,
                        completedAt: now - 4_000,
                        status: 'approved',
                    },
                },
            },
        } as any]);

        storage.getState().applyMessagesLoaded(sessionId);
        storage.getState().applyMessages(sessionId, [{
            id: 'm-tool-call',
            localId: null,
            createdAt: now - 3_000,
            role: 'agent',
            isSidechain: false,
            content: [{
                type: 'tool-call',
                id: 'tool-1',
                name: 'Bash',
                input: { command: 'sleep 5' },
                description: null,
                uuid: 'tool-uuid-1',
                parentUUID: null,
            }],
        } as any]);

        const beforeAbortSessionMessages = storage.getState().sessionMessages[sessionId];
        const beforeAbortIds = beforeAbortSessionMessages?.messageIdsOldestFirst ?? [];
        const beforeAbortMessages = beforeAbortIds.map((id) => beforeAbortSessionMessages.messagesById[id]).filter(Boolean);
        const beforeAbort = beforeAbortMessages.find(
            (message) => message.kind === 'tool-call' && message.tool.permission?.id === 'tool-1'
        );
        if (!beforeAbort || beforeAbort.kind !== 'tool-call') {
            throw new Error('Expected tool-call message before abort');
        }
        expect(beforeAbort.tool.state).toBe('running');

        const { sync } = await import('./sync');
        await (sync as any).applySessionThinkingFromTaskLifecycle(sessionId, {
            type: 'turn_aborted',
            id: 'tool-1',
            createdAt: Date.now(),
        });

        const afterAbortSessionMessages = storage.getState().sessionMessages[sessionId];
        const afterAbortIds = afterAbortSessionMessages?.messageIdsOldestFirst ?? [];
        const afterAbortMessages = afterAbortIds.map((id) => afterAbortSessionMessages.messagesById[id]).filter(Boolean);
        const afterAbort = afterAbortMessages.find(
            (message) => message.kind === 'tool-call' && message.tool.permission?.id === 'tool-1'
        );
        if (!afterAbort || afterAbort.kind !== 'tool-call') {
            throw new Error('Expected tool-call message after abort');
        }
        expect(afterAbort.tool.state).toBe('unavailable');
        expect(afterAbort.tool.permission?.status).toBe('approved');
        expect(afterAbort.tool.result).toBeUndefined();
        expect(afterAbort.tool.completedAt).toBeGreaterThanOrEqual(now);
    });

    it.each(['turn_failed', 'turn_cancelled'] as const)(
        'marks running tools unavailable when catch-up observes terminal %s lifecycle events',
        async (eventType) => {
            const sessionId = `s_${eventType}_tools`;
            const now = Date.now();

            storage.getState().applySessions([createSession({ sessionId })]);
            storage.getState().applyMessagesLoaded(sessionId);
            storage.getState().applyMessages(sessionId, [{
                id: `m-tool-call-${eventType}`,
                localId: null,
                createdAt: now - 3_000,
                role: 'agent',
                isSidechain: false,
                content: [{
                    type: 'tool-call',
                    id: `tool-${eventType}`,
                    name: 'Bash',
                    input: { command: 'sleep 5' },
                    description: null,
                    uuid: `tool-uuid-${eventType}`,
                    parentUUID: null,
                }],
            } as any]);

            const { sync } = await import('./sync');
            await (sync as any).applySessionThinkingFromTaskLifecycle(sessionId, {
                type: eventType,
                id: `tool-${eventType}`,
                createdAt: now,
            });

            const sessionMessages = storage.getState().sessionMessages[sessionId];
            const messages = (sessionMessages?.messageIdsOldestFirst ?? [])
                .map((id) => sessionMessages?.messagesById[id])
                .filter(Boolean);
            const toolMessage = messages.find((message) => message.kind === 'tool-call');
            if (!toolMessage || toolMessage.kind !== 'tool-call') {
                throw new Error(`Expected tool-call message after ${eventType}`);
            }
            expect(toolMessage.tool.state).toBe('unavailable');
            expect(toolMessage.tool.completedAt).toBe(now);
        },
    );

    it('does not force running state from fetched task_started lifecycle events', async () => {
        const sessionId = 's_task_started_fetch';
        storage.getState().applySessions([
            {
                ...createSession({ sessionId }),
                latestTurnStatus: 'completed',
            },
        ]);

        const { sync } = await import('./sync');
        await (sync as any).applySessionThinkingFromTaskLifecycle(sessionId, {
            type: 'task_started',
            id: 'task-start-1',
            createdAt: Date.now(),
        });

        expect(storage.getState().sessions[sessionId].thinking).toBe(false);
        expect(storage.getState().sessions[sessionId].latestTurnStatus).toBe('completed');
    });

    it('publishes session metadata after send when apply timing is next_prompt and local permission selection is newer', async () => {
        const sessionId = 's_perm_next_prompt';
        storage.getState().applySessions([
            {
                ...createSession({ sessionId }),
                metadata: { permissionMode: 'default', permissionModeUpdatedAt: 1 } as any,
            },
        ]);

        storage.getState().applySettingsLocal({ sessionPermissionModeApplyTiming: 'next_prompt' as any });
        storage.getState().updateSessionPermissionMode(sessionId, 'yolo' as any);

        const localUpdatedAt = storage.getState().sessions[sessionId].permissionModeUpdatedAt;
        expect(typeof localUpdatedAt).toBe('number');

        const encryption = await Encryption.create(new Uint8Array(32).fill(9));
        await encryption.initializeSessions(new Map([[sessionId, null]]));

        const { sync } = await import('./sync');
        sync.encryption = encryption;
        vi.spyOn(apiSocket, 'sessionRPC').mockRejectedValue(createRpcMethodNotAvailableError());
        sync.setMessageTransport({
            emitWithAck: vi.fn(async () => ({
                ok: true,
                id: 'm1',
                seq: 1,
                localId: null,
                didWrite: true,
            })) as any,
            send: vi.fn(),
        });

        const publish = vi.fn(async () => {});
        (sync as any).publishSessionPermissionModeToMetadata = publish;

        await sync.sendMessage(sessionId, 'hello');

        expect(publish).toHaveBeenCalledTimes(1);
        expect(publish).toHaveBeenCalledWith({
            sessionId,
            permissionMode: 'yolo',
            permissionModeUpdatedAt: localUpdatedAt,
        });
    });

    it('does not publish session metadata after send when apply timing is next_prompt but metadata is already up to date', async () => {
        const sessionId = 's_perm_next_prompt_noop';
        storage.getState().applySessions([
            {
                ...createSession({ sessionId }),
                metadata: { permissionMode: 'safe-yolo', permissionModeUpdatedAt: Date.now() } as any,
            },
        ]);

        storage.getState().applySettingsLocal({ sessionPermissionModeApplyTiming: 'next_prompt' as any });

        const encryption = await Encryption.create(new Uint8Array(32).fill(9));
        await encryption.initializeSessions(new Map([[sessionId, null]]));

        const { sync } = await import('./sync');
        sync.encryption = encryption;
        vi.spyOn(apiSocket, 'sessionRPC').mockRejectedValue(createRpcMethodNotAvailableError());
        sync.setMessageTransport({
            emitWithAck: vi.fn(async () => ({
                ok: true,
                id: 'm1',
                seq: 1,
                localId: null,
                didWrite: true,
            })) as any,
            send: vi.fn(),
        });

        const publish = vi.fn(async () => {});
        (sync as any).publishSessionPermissionModeToMetadata = publish;

        await sync.sendMessage(sessionId, 'hello');

        expect(publish).not.toHaveBeenCalled();
    });
});
