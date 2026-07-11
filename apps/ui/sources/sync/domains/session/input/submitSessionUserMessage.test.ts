import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SESSION_USER_MESSAGE_DELIVERY_INTENT_META_KEY } from '@happier-dev/protocol';

import type { ResumeSessionOptions, ResumeSessionResult } from '@/sync/ops/sessions';
import type { Session } from '@/sync/domains/state/storageTypes';
import { syncReliabilityTelemetry } from '@/sync/runtime/syncReliabilityTelemetry';

type TestWakeStorageState = {
    sessions: Record<string, unknown>;
    machines: Record<string, unknown>;
    getProjectForSession: (sessionId: string) => { key: { machineId: string; path: string } } | null;
};

const storageState = vi.hoisted((): { current: TestWakeStorageState } => ({
    current: {
        sessions: {},
        machines: {},
        getProjectForSession: (_sessionId: string) => null,
    },
}));

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
        // Testkit fixture: pendingQueueWake only reads getState/project target fields here.
        storage: {
            getState: () => storageState.current,
        } as any,
    });
});

type LoadedSubject = typeof import('./submitSessionUserMessage');

async function loadSubject(): Promise<LoadedSubject | null> {
    try {
        return await import('./submitSessionUserMessage');
    } catch {
        return null;
    }
}

async function expectSubject(): Promise<LoadedSubject | null> {
    const subject = await loadSubject();
    if (!subject) {
        expect(subject, 'submitSessionUserMessage module should exist').not.toBeNull();
        return null;
    }
    return subject;
}

function createSession(
    overrides: Partial<Omit<Session, 'metadata'>> & {
        metadata?: Partial<NonNullable<Session['metadata']>>;
    } = {},
): Session {
    const { metadata: _metadataOverrides, ...sessionOverrides } = overrides;
    const metadata = {
        ...(_metadataOverrides ?? {}),
        machineId: _metadataOverrides?.machineId ?? 'm1',
        path: _metadataOverrides?.path ?? '/tmp/project',
        host: _metadataOverrides?.host ?? 'host.local',
        flavor: _metadataOverrides?.flavor ?? 'claude',
        claudeSessionId: _metadataOverrides?.claudeSessionId ?? 'claude-1',
        version: _metadataOverrides?.version ?? '999.0.0',
    };

    return {
        id: 's1',
        serverId: 'server-cache',
        seq: 41,
        createdAt: 1,
        updatedAt: 2,
        active: false,
        activeAt: 1,
        pendingVersion: 2,
        pendingCount: 0,
        metadata,
        metadataVersion: 1,
        agentState: null,
        agentStateVersion: 1,
        thinking: false,
        thinkingAt: 0,
        presence: 1,
        optimisticThinkingAt: null,
        ...sessionOverrides,
    };
}

type SubmitCall =
    | { type: 'refresh'; sessionId: string; serverId?: string | null }
    | { type: 'enqueue'; sessionId: string; text: string; displayText?: string; metaOverrides?: Record<string, unknown> }
    | {
        type: 'send';
        sessionId: string;
        text: string;
        displayText?: string;
        metaOverrides?: Record<string, unknown>;
        bypassPendingQueueReason?: string;
        runtimeRpcDeliveryMode?: string;
    }
    | { type: 'resume'; options: ResumeSessionOptions }
    | { type: 'abort'; sessionId: string }
    | { type: 'switchRemote'; sessionId: string };

function createPort(config: {
    enqueueResult?: { localId?: string; accepted?: boolean } | void;
    enqueueReject?: Error;
    enqueueWait?: Promise<void>;
    sendResult?: {
        localId?: string;
        seq?: number;
        persistence?: 'pending' | 'transcript_committed' | 'provider_direct';
        providerAcceptancePending?: boolean;
    } | void;
    resumeResult?: ResumeSessionResult;
    resumeReject?: Error;
    sendReject?: Error;
    canWakeMachine?: boolean;
    refreshSessionResult?: Session | null;
    refreshSessionReject?: Error;
} = {}) {
    const calls: SubmitCall[] = [];
    const port = {
        enqueuePendingMessage: async (
            sessionId: string,
            text: string,
            displayText?: string,
            metaOverrides?: Record<string, unknown>,
            options?: Readonly<{
                onLocalPendingProjectionCreated?: (event: Readonly<{ localId: string }>) => void;
            }>,
        ) => {
            calls.push({ type: 'enqueue', sessionId, text, displayText, metaOverrides });
            if (config.enqueueReject) throw config.enqueueReject;
            options?.onLocalPendingProjectionCreated?.({
                localId: (config.enqueueResult && typeof config.enqueueResult === 'object' && config.enqueueResult.localId) || 'pending-local-id',
            });
            await config.enqueueWait;
            return config.enqueueResult ?? { localId: 'pending-local-id' };
        },
        sendMessage: async (
            sessionId: string,
            text: string,
            displayText?: string,
            metaOverrides?: Record<string, unknown>,
            options?: Readonly<{
                profileId?: string | null;
                localId?: string | null;
                bypassPendingQueueReason?: string;
                runtimeRpcDeliveryMode?: string;
                onLocalPendingProjectionCreated?: (event: Readonly<{ localId: string }>) => void;
            }>,
        ) => {
            calls.push({
                type: 'send',
                sessionId,
                text,
                displayText,
                metaOverrides,
                bypassPendingQueueReason: options?.bypassPendingQueueReason,
                runtimeRpcDeliveryMode: options?.runtimeRpcDeliveryMode,
            });
            if (config.sendReject) throw config.sendReject;
            options?.onLocalPendingProjectionCreated?.({
                localId: (config.sendResult && typeof config.sendResult === 'object' && config.sendResult.localId) || 'direct-local-id',
            });
            return config.sendResult ?? { localId: 'direct-local-id', seq: 42 };
        },
        resumeSession: async (options: ResumeSessionOptions) => {
            calls.push({ type: 'resume', options });
            if (config.resumeReject) throw config.resumeReject;
            return config.resumeResult ?? { type: 'success' as const };
        },
        abortSession: async (sessionId: string) => {
            calls.push({ type: 'abort', sessionId });
        },
        switchSessionControlToRemote: async (sessionId: string) => {
            calls.push({ type: 'switchRemote', sessionId });
        },
        canWakeMachineId: () => config.canWakeMachine ?? true,
        refreshSessionForSubmit: async (sessionId: string, options?: Readonly<{ serverId?: string | null }>) => {
            calls.push({ type: 'refresh', sessionId, serverId: options?.serverId });
            if (config.refreshSessionReject) throw config.refreshSessionReject;
            return config.refreshSessionResult ?? null;
        },
    };

    return { calls, port };
}

describe('submitSessionUserMessage', () => {
    beforeEach(() => {
        syncReliabilityTelemetry.reset();
        storageState.current = {
            sessions: {
                s1: {
                    active: false,
                    updatedAt: 10,
                    metadata: { machineId: 'm1', path: '/tmp/project', homeDir: '/Users/test', host: 'host.local' },
                },
            },
            machines: {
                m1: {
                    id: 'm1',
                    active: true,
                    activeAt: 20,
                    metadata: { host: 'host.local' },
                },
            },
            getProjectForSession: (sessionId: string) =>
                sessionId === 's1'
                    ? {
                        key: {
                            machineId: 'm1',
                            path: '/tmp/project',
                        },
                    }
                    : null,
        };
    });

    it('enqueues pending messages and wakes with the pre-enqueue transcript cursor', async () => {
        const subject = await expectSubject();
        if (!subject) return;
        const { calls, port } = createPort();
        const outboundHandoffs: unknown[] = [];

        const result = await subject.submitSessionUserMessage(port, {
            sessionId: 's1',
            session: createSession(),
            text: 'hello',
            configuredMode: 'agent_queue',
            resumeCapabilityOptions: { accountSettings: {} },
            serverId: 'server-cache',
            onOutboundHandoff: (event) => {
                outboundHandoffs.push({
                    event,
                    callTypes: calls.map((call) => call.type),
                });
            },
        });

        expect(result).toMatchObject({
            type: 'success',
            persistence: 'pending',
            wake: { attempted: true, state: 'started' },
            localId: 'pending-local-id',
        });
        expect(calls.map((call) => call.type)).toEqual(['enqueue', 'resume']);
        expect(outboundHandoffs).toEqual([{
            event: {
                persistence: 'pending',
                localId: 'pending-local-id',
            },
            callTypes: ['enqueue'],
        }]);
        expect(calls).toContainEqual(expect.objectContaining({
            type: 'resume',
            options: expect.objectContaining({
                sessionId: 's1',
                machineId: 'm1',
                directory: '/tmp/project',
                initialTranscriptAfterSeq: 41,
                serverId: 'server-cache',
            }),
        }));
    }, 120_000);

    it('hands off pending outbound when the local pending projection is created before enqueue persistence settles', async () => {
        const subject = await expectSubject();
        if (!subject) return;
        let resolveEnqueue!: () => void;
        const enqueueWait = new Promise<void>((resolve) => {
            resolveEnqueue = resolve;
        });
        const { calls, port } = createPort({ enqueueWait });
        const outboundHandoffs: unknown[] = [];

        const resultPromise = subject.submitSessionUserMessage(port, {
            sessionId: 's1',
            session: createSession(),
            text: 'hello',
            configuredMode: 'agent_queue',
            resumeCapabilityOptions: { accountSettings: {} },
            onOutboundHandoff: (event) => {
                outboundHandoffs.push({
                    event,
                    callTypes: calls.map((call) => call.type),
                });
            },
        });

        await Promise.resolve();

        expect(calls.map((call) => call.type)).toEqual(['enqueue']);
        expect(outboundHandoffs).toEqual([{
            event: {
                persistence: 'pending',
                localId: 'pending-local-id',
            },
            callTypes: ['enqueue'],
        }]);

        resolveEnqueue();
        await expect(resultPromise).resolves.toMatchObject({
            type: 'success',
            persistence: 'pending',
            localId: 'pending-local-id',
        });
        expect(outboundHandoffs).toHaveLength(1);
    });

    it('keeps the pending row when no wake target is available', async () => {
        const subject = await expectSubject();
        if (!subject) return;
        const { calls, port } = createPort({ canWakeMachine: false });

        const result = await subject.submitSessionUserMessage(port, {
            sessionId: 's1',
            session: createSession(),
            text: 'queued',
            configuredMode: 'agent_queue',
            resumeCapabilityOptions: { accountSettings: {} },
        });

        expect(result).toMatchObject({
            type: 'wake_pending',
            persistence: 'pending',
            wake: { attempted: false, state: 'not_needed' },
        });
        expect(calls.map((call) => call.type)).toEqual(['enqueue']);
    });

    it('does not wake the runtime when pending enqueue only has a local retry row', async () => {
        const subject = await expectSubject();
        if (!subject) return;
        const { calls, port } = createPort({
            enqueueResult: { localId: 'local-pending-retry', accepted: false },
        });
        const outboundHandoff = vi.fn();

        const result = await subject.submitSessionUserMessage(port, {
            sessionId: 's1',
            session: createSession(),
            text: 'queued locally',
            configuredMode: 'server_pending',
            resumeCapabilityOptions: { accountSettings: {} },
            onOutboundHandoff: outboundHandoff,
        });

        expect(result).toMatchObject({
            type: 'wake_pending',
            persistence: 'pending',
            wake: { attempted: false, state: 'not_needed' },
            localId: 'local-pending-retry',
        });
        expect(calls.map((call) => call.type)).toEqual(['enqueue']);
        expect(outboundHandoff).toHaveBeenCalledWith({
            persistence: 'pending',
            localId: 'local-pending-retry',
        });
    });

    it('reports wake failure without falling through to direct send', async () => {
        const subject = await expectSubject();
        if (!subject) return;
        const { calls, port } = createPort({
            resumeResult: {
                type: 'error',
                errorCode: 'DAEMON_RPC_UNAVAILABLE',
                errorMessage: 'Daemon RPC is not available',
            },
        });

        const result = await subject.submitSessionUserMessage(port, {
            sessionId: 's1',
            session: createSession(),
            text: 'queued',
            configuredMode: 'agent_queue',
            resumeCapabilityOptions: { accountSettings: {} },
        });

        expect(result).toMatchObject({
            type: 'wake_failed',
            persistence: 'pending',
            wake: {
                attempted: true,
                state: 'failed',
                errorMessage: 'Daemon RPC is not available',
            },
        });
        expect(calls.map((call) => call.type)).toEqual(['enqueue', 'resume']);
    });

    it('rejects configured pending on old CLI without direct-sending', async () => {
        const subject = await expectSubject();
        if (!subject) return;
        const { calls, port } = createPort();

        const result = await subject.submitSessionUserMessage(port, {
            sessionId: 's1',
            session: createSession({
                metadata: { version: '0.0.1' },
            }),
            text: 'legacy send',
            configuredMode: 'server_pending',
            resumeCapabilityOptions: { accountSettings: {} },
        });

        expect(result).toMatchObject({
            type: 'rejected',
            persistence: 'none',
            wake: { attempted: false, state: 'not_needed' },
            errorCode: 'PENDING_QUEUE_UNSUPPORTED',
        });
        expect(calls).toEqual([]);
    });

    it('refreshes unknown pending support once before enqueuing', async () => {
        const subject = await expectSubject();
        if (!subject) return;
        const { calls, port } = createPort({
            refreshSessionResult: createSession({
                active: false,
                pendingVersion: 2,
                metadata: { version: '999.0.0' },
            }),
        });

        const result = await subject.submitSessionUserMessage(port, {
            sessionId: 's1',
            session: createSession({
                active: false,
                pendingVersion: undefined,
                metadata: { version: '999.0.0' },
            }),
            text: 'refresh then queue',
            configuredMode: 'server_pending',
            resumeCapabilityOptions: { accountSettings: {} },
            serverId: 'server-cache',
        });

        expect(result).toMatchObject({
            type: 'success',
            persistence: 'pending',
        });
        expect(calls.map((call) => call.type)).toEqual(['refresh', 'enqueue', 'resume']);
        expect(calls[0]).toEqual({
            type: 'refresh',
            sessionId: 's1',
            serverId: 'server-cache',
        });
    });

    it('rejects unknown pending support after refresh without direct-sending or enqueuing', async () => {
        const subject = await expectSubject();
        if (!subject) return;
        const { calls, port } = createPort({
            refreshSessionResult: createSession({
                pendingVersion: undefined,
                metadata: { version: '999.0.0' },
            }),
        });

        const result = await subject.submitSessionUserMessage(port, {
            sessionId: 's1',
            session: createSession({
                pendingVersion: undefined,
                metadata: { version: '999.0.0' },
            }),
            text: 'do not strand or direct send',
            configuredMode: 'server_pending',
            resumeCapabilityOptions: { accountSettings: {} },
            serverId: 'server-cache',
        });

        expect(result).toMatchObject({
            type: 'rejected',
            persistence: 'none',
            wake: { attempted: false, state: 'not_needed' },
            errorCode: 'PENDING_QUEUE_SUPPORT_UNKNOWN',
        });
        expect(calls.map((call) => call.type)).toEqual(['refresh']);
    });

    it('does not let forceImmediate bypass inactive-session pending safety', async () => {
        const subject = await expectSubject();
        if (!subject) return;
        const { calls, port } = createPort();

        const result = await subject.submitSessionUserMessage(port, {
            sessionId: 's1',
            session: createSession(),
            text: 'force-safe',
            configuredMode: 'agent_queue',
            forceImmediate: true,
            resumeCapabilityOptions: { accountSettings: {} },
            serverId: 'server-cache',
        });

        expect(result).toMatchObject({
            type: 'success',
            persistence: 'pending',
            wake: { attempted: true, state: 'started' },
        });
        expect(calls.map((call) => call.type)).toEqual(['enqueue', 'resume']);
    });

    it('lets forceImmediate bypass configured pending for active direct-safe sessions', async () => {
        const subject = await expectSubject();
        if (!subject) return;
        const { calls, port } = createPort();

        const result = await subject.submitSessionUserMessage(port, {
            sessionId: 's1',
            session: createSession({ active: true, presence: 'online', agentStateVersion: 1 }),
            text: 'send now',
            configuredMode: 'server_pending',
            forceImmediate: true,
            callerSurface: 'session_composer',
            resumeCapabilityOptions: { accountSettings: {} },
            serverId: 'server-cache',
        });

        expect(result).toMatchObject({
            type: 'success',
            persistence: 'transcript_committed',
            wake: { attempted: false, state: 'not_needed' },
        });
        expect(calls.map((call) => call.type)).toEqual(['send']);
        expect(calls[0]).toMatchObject({
            type: 'send',
            sessionId: 's1',
            text: 'send now',
            bypassPendingQueueReason: 'force_immediate',
        });
        expect(syncReliabilityTelemetry.snapshot().events).toContainEqual(expect.objectContaining({
            name: 'ui.sessionMessage.delivery.decision',
            fields: expect.objectContaining({
                sessionId: 's1',
                mode: 'agent_queue',
                decisionReason: 'force_immediate_direct',
                configuredMode: 'server_pending',
                busySteerSendPolicy: 'steer_immediately',
                callerSurface: 'session_composer',
                forceImmediate: true,
                pendingRequested: true,
                pendingSupportState: 'supported',
            }),
        }));
    });

    it('forwards required runtime delivery through the existing direct send option object', async () => {
        const subject = await expectSubject();
        if (!subject) return;
        const { calls, port } = createPort({
            sendResult: { localId: 'direct-local-id', persistence: 'provider_direct', providerAcceptancePending: true },
        });

        const result = await subject.submitSessionUserMessage(port, {
            sessionId: 's1',
            session: createSession({ active: true, presence: 'online', agentStateVersion: 1 }),
            text: 'send now',
            configuredMode: 'server_pending',
            forceImmediate: true,
            runtimeRpcDeliveryMode: 'required',
            resumeCapabilityOptions: { accountSettings: {} },
        });

        expect(result).toMatchObject({
            type: 'success',
            persistence: 'provider_direct',
            providerAcceptancePending: true,
        });
        expect(calls).toEqual([expect.objectContaining({
            type: 'send',
            bypassPendingQueueReason: 'force_immediate',
            runtimeRpcDeliveryMode: 'required',
        })]);
    });

    it('lets forceImmediate bypass configured pending when pending support is unknown but direct send is safe', async () => {
        const subject = await expectSubject();
        if (!subject) return;
        const { calls, port } = createPort();

        const result = await subject.submitSessionUserMessage(port, {
            sessionId: 's1',
            session: createSession({
                active: true,
                presence: 'online',
                agentStateVersion: 1,
                pendingVersion: undefined,
            }),
            text: 'send now during stale snapshot',
            configuredMode: 'server_pending',
            forceImmediate: true,
            resumeCapabilityOptions: { accountSettings: {} },
            serverId: 'server-cache',
        });

        expect(result).toMatchObject({
            type: 'success',
            persistence: 'transcript_committed',
            wake: { attempted: false, state: 'not_needed' },
        });
        expect(calls.map((call) => call.type)).toEqual(['send']);
        expect(calls[0]).toMatchObject({
            type: 'send',
            bypassPendingQueueReason: 'force_immediate',
        });
    });

    it('queues normal busy sends when settings prefer pending even if in-flight steer is available', async () => {
        const subject = await expectSubject();
        if (!subject) return;
        const { calls, port } = createPort();

        const result = await subject.submitSessionUserMessage(port, {
            sessionId: 's1',
            session: createSession({
                active: true,
                presence: 'online',
                agentStateVersion: 1,
                thinking: true,
                thinkingAt: 1_000,
                agentState: {
                    controlledByUser: false,
                    capabilities: {
                        inFlightSteer: true,
                        inFlightSteerSupported: true,
                        inFlightSteerAvailable: true,
                    },
                } as any,
            }),
            text: 'queue while busy',
            configuredMode: 'server_pending',
            busySteerSendPolicy: 'server_pending',
            resumeCapabilityOptions: { accountSettings: {} },
            nowMs: 1_100,
        });

        expect(result).toMatchObject({
            type: 'wake_pending',
            persistence: 'pending',
            wake: { attempted: false, state: 'not_needed' },
        });
        expect(calls.map((call) => call.type)).toEqual(['enqueue']);
    });

    it('persists steerable busy sends before runtime delivery so an occupied provider slot cannot drop them', async () => {
        const subject = await expectSubject();
        if (!subject) return;
        const { calls, port } = createPort();

        const result = await subject.submitSessionUserMessage(port, {
            sessionId: 's1',
            session: createSession({
                active: true,
                presence: 'online',
                agentStateVersion: 1,
                thinking: true,
                thinkingAt: 1_000,
                agentState: {
                    controlledByUser: false,
                    capabilities: {
                        inFlightSteer: true,
                        inFlightSteerSupported: true,
                        inFlightSteerAvailable: true,
                    },
                } as any,
            }),
            text: 'durable steer while Claude is busy',
            configuredMode: 'agent_queue',
            busySteerSendPolicy: 'steer_immediately',
            resumeCapabilityOptions: { accountSettings: {} },
            nowMs: 1_100,
        });

        expect(result).toMatchObject({
            type: 'wake_pending',
            persistence: 'pending',
            wake: { attempted: false, state: 'not_needed' },
        });
        expect(calls.map((call) => call.type)).toEqual(['enqueue']);
        expect(calls[0]).toMatchObject({
            type: 'enqueue',
            text: 'durable steer while Claude is busy',
        });
    });

    it('queues busy sends when provider-owned classification marks outgoing config metadata non-steerable', async () => {
        const subject = await expectSubject();
        if (!subject) return;
        const { calls, port } = createPort();

        const result = await subject.submitSessionUserMessage(port, {
            sessionId: 's1',
            session: createSession({
                active: true,
                presence: 'online',
                agentStateVersion: 1,
                thinking: true,
                thinkingAt: 1_000,
                agentState: {
                    controlledByUser: false,
                    capabilities: {
                        inFlightSteer: true,
                        inFlightSteerSupported: true,
                        inFlightSteerAvailable: true,
                    },
                } as any,
            }),
            text: 'do this with the selected config',
            metaOverrides: { reasoningEffort: 'xhigh' },
            configuredMode: 'agent_queue',
            busySteerSendPolicy: 'steer_immediately',
            nonSteerableSendPrompt: 'queue_silently',
            providerNonSteerablePayloadReason: 'provider_config_change_refused',
            resumeCapabilityOptions: { accountSettings: {} },
            nowMs: 1_100,
        });

        expect(result).toMatchObject({
            type: 'wake_pending',
            persistence: 'pending',
            wake: { attempted: false, state: 'not_needed' },
        });
        expect(calls.map((call) => call.type)).toEqual(['enqueue']);
        expect(calls[0]).toMatchObject({
            type: 'enqueue',
            metaOverrides: { reasoningEffort: 'xhigh' },
        });
    });

    it('persists explicit pending delivery intent on server-pending rows', async () => {
        const subject = await expectSubject();
        if (!subject) return;
        const { calls, port } = createPort();

        const result = await subject.submitSessionUserMessage(port, {
            sessionId: 's1',
            session: createSession({
                active: true,
                presence: 'online',
                agentStateVersion: 1,
                thinking: true,
                thinkingAt: 1_000,
                agentState: {
                    controlledByUser: false,
                    capabilities: {
                        inFlightSteer: true,
                        inFlightSteerSupported: true,
                        inFlightSteerAvailable: true,
                    },
                } as any,
            }),
            text: 'queue this after the current turn',
            metaOverrides: {
                reasoningEffort: 'xhigh',
                [SESSION_USER_MESSAGE_DELIVERY_INTENT_META_KEY]: 'default',
            },
            configuredMode: 'server_pending',
            explicitMode: 'server_pending',
            busySteerSendPolicy: 'steer_immediately',
            resumeCapabilityOptions: { accountSettings: {} },
            nowMs: 1_100,
        });

        expect(result).toMatchObject({
            type: 'wake_pending',
            persistence: 'pending',
        });
        expect(calls).toHaveLength(1);
        expect(calls[0]).toMatchObject({
            type: 'enqueue',
            metaOverrides: {
                reasoningEffort: 'xhigh',
                [SESSION_USER_MESSAGE_DELIVERY_INTENT_META_KEY]: 'explicit_pending',
            },
        });
    });

    it('does not make forceImmediate sticky for the next normal pending send', async () => {
        const subject = await expectSubject();
        if (!subject) return;
        const { calls, port } = createPort();
        const session = createSession({ active: true, presence: 'online', agentStateVersion: 1 });

        await subject.submitSessionUserMessage(port, {
            sessionId: 's1',
            session,
            text: 'send now',
            configuredMode: 'server_pending',
            forceImmediate: true,
            resumeCapabilityOptions: { accountSettings: {} },
        });
        const result = await subject.submitSessionUserMessage(port, {
            sessionId: 's1',
            session,
            text: 'normal pending',
            configuredMode: 'server_pending',
            resumeCapabilityOptions: { accountSettings: {} },
        });

        expect(result).toMatchObject({
            type: 'success',
            persistence: 'pending',
        });
        expect(calls.map((call) => call.type)).toEqual(['send', 'enqueue', 'resume']);
    });

    it('aborts before enqueueing interrupt messages on the durable pending transport', async () => {
        const subject = await expectSubject();
        if (!subject) return;
        const { calls, port } = createPort();
        const outboundHandoff = vi.fn();

        const result = await subject.submitSessionUserMessage(port, {
            sessionId: 's1',
            session: createSession({ active: true, presence: 'online' }),
            text: 'stop and do this',
            configuredMode: 'interrupt',
            resumeCapabilityOptions: { accountSettings: {} },
            onOutboundHandoff: outboundHandoff,
        });

        expect(result).toMatchObject({
            type: 'success',
            persistence: 'pending',
        });
        expect(calls[0]?.type).toBe('abort');
        expect(calls[1]?.type).toBe('enqueue');
        expect(calls.some((call) => call.type === 'send')).toBe(false);
        expect(calls[1]).toMatchObject({
            type: 'enqueue',
            text: 'stop and do this',
            metaOverrides: {
                [SESSION_USER_MESSAGE_DELIVERY_INTENT_META_KEY]: 'interrupt',
            },
        });
        expect(outboundHandoff).toHaveBeenCalledWith({
            persistence: 'pending',
            localId: 'pending-local-id',
        });
    });

    it('keeps interrupt messages durable when the runner dies before provider acceptance', async () => {
        const subject = await expectSubject();
        if (!subject) return;
        const { calls, port } = createPort({
            enqueueResult: { localId: 'interrupt-local-id', accepted: false },
        });

        const result = await subject.submitSessionUserMessage(port, {
            sessionId: 's1',
            session: createSession({ active: true, presence: 'online' }),
            text: 'stop and send durably',
            configuredMode: 'interrupt',
            resumeCapabilityOptions: { accountSettings: {} },
        });

        expect(result).toMatchObject({
            type: 'wake_pending',
            persistence: 'pending',
            localId: 'interrupt-local-id',
        });
        expect(calls.map((call) => call.type)).toEqual(['abort', 'enqueue']);
        expect(calls[1]).toMatchObject({
            type: 'enqueue',
            text: 'stop and send durably',
            metaOverrides: {
                [SESSION_USER_MESSAGE_DELIVERY_INTENT_META_KEY]: 'interrupt',
            },
        });
    });

    it('uses an existing durable pending row for interrupt send-now without enqueueing a duplicate', async () => {
        const subject = await expectSubject();
        if (!subject) return;
        const { calls, port } = createPort({
            sendResult: {
                localId: 'p1',
                persistence: 'provider_direct',
                providerAcceptancePending: true,
            },
        });

        const result = await subject.submitSessionUserMessage(port, {
            sessionId: 's1',
            session: createSession({ active: true, presence: 'online' }),
            text: 'send this pending row now',
            configuredMode: 'server_pending',
            explicitMode: 'interrupt',
            localId: 'p1',
            existingDurablePendingMessage: true,
            resumeCapabilityOptions: { accountSettings: {} },
        });

        expect(result).toMatchObject({
            type: 'success',
            persistence: 'provider_direct',
            providerAcceptancePending: true,
            localId: 'p1',
        });
        expect(calls.map((call) => call.type)).toEqual(['abort', 'send']);
        expect(calls[1]).toMatchObject({
            type: 'send',
            bypassPendingQueueReason: 'interrupt',
        });
    });

    it('returns send_failed when direct send fails', async () => {
        const subject = await expectSubject();
        if (!subject) return;
        const { calls, port } = createPort({ sendReject: new Error('send rejected') });
        const outboundHandoff = vi.fn();

        const result = await subject.submitSessionUserMessage(port, {
            sessionId: 's1',
            session: createSession({ active: true, presence: 'online' }),
            text: 'hello',
            configuredMode: 'agent_queue',
            resumeCapabilityOptions: { accountSettings: {} },
            onOutboundHandoff: outboundHandoff,
        });

        expect(result).toMatchObject({
            type: 'send_failed',
            persistence: 'none',
            errorMessage: 'send rejected',
        });
        expect(calls.map((call) => call.type)).toEqual(['send']);
        expect(outboundHandoff).not.toHaveBeenCalled();
    });

    it('reports local pending handoff when direct send creates an optimistic projection before transcript commit', async () => {
        const subject = await expectSubject();
        if (!subject) return;
        const { calls, port } = createPort({ sendResult: { localId: 'projection-local-id', seq: 42 } });
        const handoffTrace: Array<Readonly<{ event: unknown; callTypes: readonly string[] }>> = [];

        const result = await subject.submitSessionUserMessage(port, {
            sessionId: 's1',
            session: createSession({ active: true, presence: 'online' }),
            text: 'hello',
            configuredMode: 'agent_queue',
            resumeCapabilityOptions: { accountSettings: {} },
            onOutboundHandoff: (event) => {
                handoffTrace.push({
                    event,
                    callTypes: calls.map((call) => call.type),
                });
            },
        });

        expect(result).toMatchObject({
            type: 'success',
            persistence: 'transcript_committed',
            localId: 'projection-local-id',
        });
        expect(calls.map((call) => call.type)).toEqual(['send']);
        expect(handoffTrace).toEqual([{
            event: {
                persistence: 'pending',
                localId: 'projection-local-id',
            },
            callTypes: ['send'],
        }]);
    });

    it('keeps direct send persistence pending when the port has only local projection evidence', async () => {
        const subject = await expectSubject();
        if (!subject) return;
        const { calls, port } = createPort({ sendResult: { localId: 'projection-local-id' } });
        const outboundHandoff = vi.fn();

        const result = await subject.submitSessionUserMessage(port, {
            sessionId: 's1',
            session: createSession({ active: true, presence: 'online' }),
            text: 'hello',
            configuredMode: 'agent_queue',
            resumeCapabilityOptions: { accountSettings: {} },
            onOutboundHandoff: outboundHandoff,
        });

        expect(result).toMatchObject({
            type: 'success',
            persistence: 'pending',
            localId: 'projection-local-id',
        });
        expect(calls.map((call) => call.type)).toEqual(['send']);
        expect(outboundHandoff).toHaveBeenCalledWith({
            persistence: 'pending',
            localId: 'projection-local-id',
        });
    });

    it('does not mark outbound handoff when pending enqueue fails before a pending row exists', async () => {
        const subject = await expectSubject();
        if (!subject) return;
        const { calls, port } = createPort({ enqueueReject: new Error('enqueue rejected') });
        const outboundHandoff = vi.fn();

        const result = await subject.submitSessionUserMessage(port, {
            sessionId: 's1',
            session: createSession(),
            text: 'hello',
            configuredMode: 'agent_queue',
            resumeCapabilityOptions: { accountSettings: {} },
            onOutboundHandoff: outboundHandoff,
        });

        expect(result).toMatchObject({
            type: 'send_failed',
            persistence: 'none',
            errorMessage: 'enqueue rejected',
        });
        expect(calls.map((call) => call.type)).toEqual(['enqueue']);
        expect(outboundHandoff).not.toHaveBeenCalled();
    });
});
