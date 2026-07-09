import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
    areSessionListRenderablesEqual,
    buildSessionListRenderableFromSession,
    derivePendingRequestFlagsFromAgentState,
    didSessionListRenderableAttentionPromotionFieldsChange,
    didSessionListRenderablePlacementRelevantTimingChange,
    didSessionListRenderableReachabilityPeerFieldsChange,
    preserveSessionListRenderableStaleFields,
} from './sessionListRenderable';
import type { SessionListRenderableSession } from './sessionListRenderable';
import { resolveSessionReadStateAction } from '../readState/sessionReadState';
import type { Session } from '@/sync/domains/state/storageTypes';

const storageState = vi.hoisted(() => ({
    sessionMessages: {} as Record<string, unknown>,
}));
const readStorageState = () => storageState as any;

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
        storage: {
            getState: () => storageState,
            getInitialState: () => storageState,
            setState: () => undefined,
            subscribe: () => () => undefined,
            destroy: () => undefined,
        },
    } as any);
});

beforeEach(() => {
    storageState.sessionMessages = {};
});

beforeEach(async () => {
    const { registerStorageStateReader } = await import('@/sync/domains/state/storageStateReaderBridge');
    registerStorageStateReader(readStorageState);
});

function buildRenderable(
    overrides: Partial<SessionListRenderableSession> & Pick<SessionListRenderableSession, 'id'>,
): SessionListRenderableSession {
    const { id, ...rest } = overrides;

    return {
        id,
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
        active: false,
        activeAt: 1,
        archivedAt: null,
        metadataVersion: 1,
        agentStateVersion: 0,
        metadata: null,
        thinking: false,
        thinkingAt: 0,
        presence: 1,
        ...rest,
    };
}

describe('derivePendingRequestFlagsFromAgentState', () => {
    it('treats legacy AskUserQuestion requests without kind as user actions', () => {
        const flags = derivePendingRequestFlagsFromAgentState({
            requests: {
                req1: {
                    tool: 'AskUserQuestion',
                    arguments: {},
                    createdAt: 1,
                },
            },
            completedRequests: {},
        } as any);

        expect(flags).toEqual({
            hasPendingPermissionRequests: false,
            hasPendingUserActionRequests: true,
        });
    });
});

describe('preserveSessionListRenderableStaleFields', () => {
    it('keeps metadata-unavailable settled state across placeholder replacements', () => {
        const previous = buildRenderable({
            id: 's_unavailable',
            metadata: null,
            metadataVersion: 2,
            metadataUnavailable: true,
        } as Partial<SessionListRenderableSession> & { id: string; metadataUnavailable: true });
        const next = preserveSessionListRenderableStaleFields(
            previous,
            buildRenderable({
                id: 's_unavailable',
                metadata: null,
                metadataVersion: 2,
            }),
        );

        expect((next as { metadataUnavailable?: boolean }).metadataUnavailable).toBe(true);
    });

    it('preserves stale metadata instead of metadata-unavailable state when safe metadata exists', () => {
        const previousMetadata = {
            path: '/repo',
            homeDir: '/home/user',
            host: 'host-a',
            machineId: 'machine-a',
            flavor: 'codex',
        };
        const previous = buildRenderable({
            id: 's_stale',
            metadata: previousMetadata,
            metadataVersion: 4,
            metadataUnavailable: true,
        } as Partial<SessionListRenderableSession> & { id: string; metadataUnavailable: true });
        const next = preserveSessionListRenderableStaleFields(
            previous,
            buildRenderable({
                id: 's_stale',
                metadata: null,
                metadataVersion: 5,
            }),
        );

        expect(next.metadata).toBe(previousMetadata);
        expect(next.metadataVersion).toBe(4);
        expect((next as { metadataUnavailable?: boolean }).metadataUnavailable).not.toBe(true);
    });
});

describe('buildSessionListRenderableFromSession', () => {
    it('treats terminal turn projection as authoritative over legacy thinking in renderable state', () => {
        const renderable = buildSessionListRenderableFromSession({
            id: 's_terminal_thinking',
            seq: 4,
            lastViewedSessionSeq: 4,
            createdAt: 1,
            updatedAt: 10_000,
            active: true,
            activeAt: 10_000,
            archivedAt: null,
            metadata: null,
            metadataVersion: 1,
            agentState: null,
            agentStateVersion: 0,
            latestTurnStatus: 'completed',
            latestTurnStatusObservedAt: 9_500,
            thinking: true,
            thinkingAt: 10_000,
            presence: 'online',
        } as Session);

        expect(renderable.thinking).toBe(false);
        expect(renderable.thinkingAt).toBe(9_500);
        expect(renderable.latestTurnStatus).toBe('completed');
    });

    it('projects runtime activity fields onto renderable session rows', () => {
        const renderable = buildSessionListRenderableFromSession({
            id: 's_runtime_activity',
            seq: 4,
            createdAt: 1,
            updatedAt: 1,
            active: true,
            activeAt: 1,
            archivedAt: null,
            metadata: null,
            metadataVersion: 1,
            agentState: null,
            agentStateVersion: 0,
            thinking: false,
            thinkingAt: 0,
            presence: 'online',
            runtimeActivityActiveCount: 1,
            runtimeActivityObservedAt: 100,
            runtimeActivityExpiresAt: 200,
            runtimeActivitySourceClass: 'provider_detached_task',
        } as Session);

        expect(renderable.runtimeActivityActiveCount).toBe(1);
        expect(renderable.runtimeActivityObservedAt).toBe(100);
        expect(renderable.runtimeActivityExpiresAt).toBe(200);
        expect(renderable.runtimeActivitySourceClass).toBe('provider_detached_task');
    });

    it('projects ready unread state onto renderable session rows', () => {
        const renderable = buildSessionListRenderableFromSession({
            id: 's_unread',
            seq: 4,
            lastViewedSessionSeq: 1,
            createdAt: 1,
            updatedAt: 1,
            active: false,
            activeAt: 1,
            archivedAt: null,
            metadata: null,
            metadataVersion: 1,
            agentState: null,
            agentStateVersion: 0,
            latestTurnStatus: 'completed',
            thinking: false,
            thinkingAt: 0,
            presence: 1,
            latestReadyEventSeq: 4,
            latestReadyEventAt: 2_000,
        } as Session);

        expect(renderable.hasUnreadMessages).toBe(true);
    });

    it('does not mark cache-only non-terminal rows unread from raw session seq when transcript activity is unavailable', () => {
        const renderable = buildSessionListRenderableFromSession({
            id: 's_unhydrated_usage_tail',
            seq: 946,
            lastViewedSessionSeq: 945,
            createdAt: 1,
            updatedAt: 1,
            active: true,
            activeAt: 1,
            archivedAt: null,
            metadata: null,
            metadataVersion: 1,
            agentState: null,
            agentStateVersion: 0,
            latestTurnStatus: 'in_progress',
            thinking: false,
            thinkingAt: 0,
            presence: 'online',
        } as any);

        expect(renderable.hasUnreadMessages).toBe(false);
    });

    it('does not keep rows unread for trailing non-displayable session activity after visible messages are read', () => {
        const renderable = buildSessionListRenderableFromSession({
            id: 's_read_usage_tail',
            seq: 946,
            lastViewedSessionSeq: 945,
            createdAt: 1,
            updatedAt: 1,
            active: true,
            activeAt: 1,
            archivedAt: null,
            metadata: null,
            metadataVersion: 1,
            agentState: null,
            agentStateVersion: 0,
            latestTurnStatus: 'in_progress',
            thinking: false,
            thinkingAt: 0,
            presence: 'online',
        } as any, [{
            id: 'm-visible',
            kind: 'agent-text',
            seq: 945,
            localId: null,
            createdAt: 1,
            text: 'Visible final assistant message',
        }]);

        expect(renderable.hasUnreadMessages).toBe(false);
    });

    it('does not treat trailing provider maintenance events as unread or meaningful activity', () => {
        const renderable = buildSessionListRenderableFromSession({
            id: 's_provider_event_tail',
            seq: 946,
            lastViewedSessionSeq: 945,
            createdAt: 1,
            updatedAt: 1,
            active: true,
            activeAt: 1,
            archivedAt: null,
            metadata: null,
            metadataVersion: 1,
            agentState: null,
            agentStateVersion: 0,
            latestTurnStatus: 'in_progress',
            thinking: false,
            thinkingAt: 0,
            presence: 'online',
        } as any, [
            {
                id: 'm-visible',
                kind: 'agent-text',
                seq: 945,
                localId: null,
                createdAt: 1_000,
                text: 'Visible assistant message',
            },
            {
                id: 'm-provider-state',
                kind: 'agent-event',
                seq: 946,
                createdAt: 5_000,
                event: {
                    type: 'provider-state-sharing-degraded',
                    serviceId: 'anthropic',
                    requestedStateMode: 'shared',
                    effectiveStateMode: 'isolated',
                    code: 'state_symlink_unavailable',
                },
            },
        ]);

        expect(renderable.hasUnreadMessages).toBe(false);
        expect(renderable.meaningfulActivityAt).toBe(1_000);
    });

    it('keeps rows unread when a displayable message is newer than the cursor', () => {
        const renderable = buildSessionListRenderableFromSession({
            id: 's_unread_visible',
            seq: 946,
            lastViewedSessionSeq: 944,
            createdAt: 1,
            updatedAt: 1,
            active: true,
            activeAt: 1,
            archivedAt: null,
            metadata: null,
            metadataVersion: 1,
            agentState: null,
            agentStateVersion: 0,
            latestTurnStatus: 'in_progress',
            thinking: false,
            thinkingAt: 0,
            presence: 'online',
        } as any, [{
            id: 'm-visible',
            kind: 'agent-text',
            seq: 945,
            localId: null,
            createdAt: 1,
            text: 'Visible assistant message',
        }]);

        expect(renderable.hasUnreadMessages).toBe(true);
    });

    it('projects runtime attention fields onto renderable session rows', () => {
        const lastRuntimeIssue = {
            v: 1,
            scope: 'primary_session',
            status: 'failed',
            code: 'auth_error',
            source: 'auth_error',
            occurredAt: 123,
            sanitizedPreview: 'Authentication failed',
        };

        const renderable = buildSessionListRenderableFromSession({
            id: 's_failed',
            seq: 4,
            createdAt: 1,
            updatedAt: 1,
            active: false,
            activeAt: 1,
            archivedAt: null,
            metadata: null,
            metadataVersion: 1,
            agentState: null,
            agentStateVersion: 0,
            latestTurnStatus: 'failed',
            lastRuntimeIssue,
            thinking: false,
            thinkingAt: 0,
            presence: 1,
        } as any);

        expect(renderable.latestTurnStatus).toBe('failed');
        expect(renderable.lastRuntimeIssue).toBe(lastRuntimeIssue);
    });

    it('projects ready event fields onto renderable session rows', () => {
        const renderable = buildSessionListRenderableFromSession({
            id: 's_ready',
            seq: 4,
            lastViewedSessionSeq: 3,
            createdAt: 1,
            updatedAt: 1,
            active: false,
            activeAt: 1,
            archivedAt: null,
            metadata: null,
            metadataVersion: 1,
            agentState: null,
            agentStateVersion: 0,
            latestReadyEventSeq: 4,
            latestReadyEventAt: 1_234,
            thinking: false,
            thinkingAt: 0,
            presence: 1,
        } as any);

        expect(renderable.latestReadyEventSeq).toBe(4);
        expect(renderable.latestReadyEventAt).toBe(1_234);
    });

    it('treats runtime attention fields as renderable equality inputs', () => {
        const previous = buildRenderable({
            id: 's_runtime',
            latestTurnStatus: 'in_progress',
            lastRuntimeIssue: null,
        } as any);
        const next = buildRenderable({
            id: 's_runtime',
            latestTurnStatus: 'failed',
            lastRuntimeIssue: {
                v: 1,
                scope: 'primary_session',
                status: 'failed',
                code: 'auth_error',
                source: 'auth_error',
                occurredAt: 123,
            },
        } as any);

        expect(areSessionListRenderablesEqual(previous, next)).toBe(false);
    });

    it('treats ready event fields as renderable equality inputs', () => {
        const previous = buildRenderable({
            id: 's_ready_equality',
            latestReadyEventSeq: null,
            latestReadyEventAt: null,
        });
        const next = buildRenderable({
            id: 's_ready_equality',
            latestReadyEventSeq: 5,
            latestReadyEventAt: 2_000,
        });

        expect(areSessionListRenderablesEqual(previous, next)).toBe(false);
    });

    it('treats runtime activity fields as renderable equality inputs', () => {
        const previous = buildRenderable({
            id: 's_runtime_activity_equality',
            runtimeActivityActiveCount: 1,
            runtimeActivityObservedAt: 100,
            runtimeActivityExpiresAt: 200,
            runtimeActivitySourceClass: 'provider_detached_task',
        });
        const next = buildRenderable({
            id: 's_runtime_activity_equality',
            runtimeActivityActiveCount: 1,
            runtimeActivityObservedAt: 150,
            runtimeActivityExpiresAt: 250,
            runtimeActivitySourceClass: 'provider_detached_task',
        });

        expect(areSessionListRenderablesEqual(previous, next)).toBe(false);
    });

    it('ignores progress timestamps when attention placement is unchanged', () => {
        const previous = buildRenderable({
            id: 's_action',
            updatedAt: 100,
            seq: 10,
            meaningfulActivityAt: 100,
            active: true,
            presence: 'online',
            thinking: true,
            thinkingAt: Date.now() - 1_000,
            hasPendingUserActionRequests: true,
            pendingRequestObservedAt: Date.now() - 1_000,
        });
        const next = buildRenderable({
            id: 's_action',
            updatedAt: 200,
            seq: 11,
            meaningfulActivityAt: 200,
            active: true,
            presence: 'online',
            thinking: true,
            thinkingAt: Date.now() - 1_000,
            hasPendingUserActionRequests: true,
            pendingRequestObservedAt: previous.pendingRequestObservedAt,
        });

        expect(didSessionListRenderableAttentionPromotionFieldsChange(previous, next)).toBe(false);
    });

    it('keeps read-state actions derived from the projected session cursor', () => {
        const renderable = buildSessionListRenderableFromSession({
            id: 's_read',
            seq: 4,
            lastViewedSessionSeq: 4,
            createdAt: 1,
            updatedAt: 1,
            active: false,
            activeAt: 1,
            archivedAt: null,
            metadata: null,
            metadataVersion: 1,
            agentState: null,
            agentStateVersion: 0,
            latestTurnStatus: 'completed',
            thinking: false,
            thinkingAt: 0,
            presence: 1,
        } satisfies Session);

        expect(renderable.latestTurnStatus).toBe('completed');
        expect(resolveSessionReadStateAction(renderable)).toEqual({
            kind: 'mark-unread',
            visible: true,
            targetState: 'unread',
        });
    });

    it('keeps read-state actions derived from projected legacy metadata', () => {
        const renderable = buildSessionListRenderableFromSession({
            id: 's_legacy_read',
            seq: 4,
            createdAt: 1,
            updatedAt: 1,
            active: false,
            activeAt: 1,
            archivedAt: null,
            metadata: {
                path: '',
                host: '',
                readStateV1: { v: 1, sessionSeq: 4, pendingActivityAt: 0, updatedAt: 1 },
            },
            metadataVersion: 1,
            agentState: null,
            agentStateVersion: 0,
            latestTurnStatus: 'completed',
            thinking: false,
            thinkingAt: 0,
            presence: 1,
        } satisfies Session);

        expect(resolveSessionReadStateAction(renderable)).toEqual({
            kind: 'mark-unread',
            visible: true,
            targetState: 'unread',
        });
    });

    it('prefers projected pending-request counts when they are present on the session', () => {
        const renderable = buildSessionListRenderableFromSession({
            id: 's1',
            seq: 1,
            createdAt: 1,
            updatedAt: 1,
            active: true,
            activeAt: 1,
            metadata: null,
            metadataVersion: 1,
            agentState: null,
            agentStateVersion: 0,
            pendingPermissionRequestCount: 2,
            pendingUserActionRequestCount: 1,
            thinking: false,
            thinkingAt: 0,
            presence: 'online',
        } as any);

        expect(renderable.hasPendingPermissionRequests).toBe(true);
        expect(renderable.hasPendingUserActionRequests).toBe(true);
    });

    it('still prefers projected pending-request counts when completedRequests history exists', () => {
        const renderable = buildSessionListRenderableFromSession({
            id: 's1',
            seq: 1,
            createdAt: 1,
            updatedAt: 1,
            active: true,
            activeAt: 1,
            metadata: null,
            metadataVersion: 1,
            agentState: {
                controlledByUser: null,
                requests: {},
                completedRequests: {
                    old_req: {
                        tool: 'Bash',
                        arguments: { command: 'pwd' },
                        createdAt: 1,
                        completedAt: 2,
                        status: 'approved',
                    },
                },
            },
            agentStateVersion: 3,
            pendingPermissionRequestCount: 1,
            pendingUserActionRequestCount: 0,
            thinking: false,
            thinkingAt: 0,
            presence: 'online',
        } as any);

        expect(renderable.hasPendingPermissionRequests).toBe(true);
        expect(renderable.hasPendingUserActionRequests).toBe(false);
    });

    it('projects pending request observed timestamps onto renderable session rows', () => {
        const renderable = buildSessionListRenderableFromSession({
            id: 's_pending_observed_at',
            seq: 1,
            createdAt: 1,
            updatedAt: 100,
            active: true,
            activeAt: 1,
            metadata: null,
            metadataVersion: 1,
            agentState: {
                requests: {},
                completedRequests: null,
            },
            agentStateVersion: 0,
            pendingPermissionRequestCount: 1,
            pendingUserActionRequestCount: 0,
            pendingRequestObservedAt: 25,
            thinking: false,
            thinkingAt: 0,
            presence: 'online',
        } as any);

        expect(renderable.pendingRequestObservedAt).toBe(25);
    });

    it('still prefers projected pending-request counts when the cached transcript only has old terminal history', () => {
        storageState.sessionMessages = {
            s1: {
                messages: [
                    {
                        kind: 'tool-call',
                        id: 'm-tool-old',
                        localId: null,
                        createdAt: 50,
                        children: [],
                        tool: {
                            id: 'old_req',
                            name: 'AskUserQuestion',
                            state: 'error',
                            input: { q: 'old?' },
                            createdAt: 50,
                            completedAt: 51,
                            permission: {
                                id: 'old_req',
                                status: 'canceled',
                                kind: 'user_action',
                            },
                        },
                    },
                ],
            },
        };

        const renderable = buildSessionListRenderableFromSession({
            id: 's1',
            seq: 1,
            createdAt: 1,
            updatedAt: 1_000,
            active: true,
            activeAt: 1,
            metadata: null,
            metadataVersion: 1,
            agentState: {
                controlledByUser: null,
                requests: {},
                completedRequests: null,
            },
            agentStateVersion: 3,
            pendingPermissionRequestCount: 1,
            pendingUserActionRequestCount: 0,
            thinking: false,
            thinkingAt: 0,
            presence: 'online',
        } as any);

        expect(renderable.hasPendingPermissionRequests).toBe(true);
        expect(renderable.hasPendingUserActionRequests).toBe(false);
    });

    it('prefers projected pending-request counts even when cached transcript history has a terminal outcome', () => {
        storageState.sessionMessages = {
            s1: {
                messages: [
                    {
                        kind: 'tool-call',
                        id: 'm-tool-terminal',
                        localId: null,
                        createdAt: 150,
                        children: [],
                        tool: {
                            id: 'req1',
                            name: 'AskUserQuestion',
                            state: 'error',
                            input: { q: 'continue?' },
                            createdAt: 150,
                            completedAt: 151,
                            permission: {
                                id: 'req1',
                                status: 'canceled',
                                kind: 'user_action',
                            },
                        },
                    },
                ],
            },
        };

        const renderable = buildSessionListRenderableFromSession({
            id: 's1',
            seq: 1,
            createdAt: 1,
            updatedAt: 100,
            active: true,
            activeAt: 1,
            metadata: null,
            metadataVersion: 1,
            agentState: {
                controlledByUser: null,
                requests: {},
                completedRequests: null,
            },
            agentStateVersion: 3,
            pendingPermissionRequestCount: 1,
            pendingUserActionRequestCount: 0,
            thinking: false,
            thinkingAt: 0,
            presence: 'online',
        } as any);

        expect(renderable.hasPendingPermissionRequests).toBe(true);
        expect(renderable.hasPendingUserActionRequests).toBe(false);
    });

    it('suppresses inactive permission requests but keeps inactive user-action requests visible', () => {
        const renderable = buildSessionListRenderableFromSession({
            id: 's1',
            seq: 1,
            createdAt: 1,
            updatedAt: 1,
            active: false,
            activeAt: 1,
            metadata: null,
            metadataVersion: 1,
            agentState: {
                controlledByUser: null,
                requests: {
                    req1: { tool: 'Bash', arguments: { command: 'ls' }, createdAt: 1 },
                    req2: { tool: 'AskUserQuestion', kind: 'user_action', arguments: {}, createdAt: 2 },
                },
                completedRequests: null,
            },
            agentStateVersion: 0,
            pendingPermissionRequestCount: 2,
            pendingUserActionRequestCount: 1,
            thinking: false,
            thinkingAt: 0,
            presence: 'online',
        } as any);

        expect(renderable.hasPendingPermissionRequests).toBe(false);
        expect(renderable.hasPendingUserActionRequests).toBe(true);
    });

    it('does not keep stale pending flags when the transcript already marked the request canceled', () => {
        storageState.sessionMessages = {
            s1: {
                messages: [
                    {
                        kind: 'tool-call',
                        id: 'm-tool-1',
                        localId: null,
                        createdAt: 100,
                        children: [],
                        tool: {
                            id: 'req1',
                            name: 'AskUserQuestion',
                            state: 'error',
                            input: { q: 'continue?' },
                            createdAt: 100,
                            completedAt: 101,
                            permission: {
                                id: 'req1',
                                status: 'canceled',
                                kind: 'user_action',
                            },
                        },
                    },
                ],
            },
        };

        const renderable = buildSessionListRenderableFromSession({
            id: 's1',
            seq: 1,
            createdAt: 1,
            updatedAt: 1,
            active: true,
            activeAt: 1,
            metadata: null,
            metadataVersion: 1,
            agentState: {
                controlledByUser: null,
                requests: {
                    req1: { tool: 'AskUserQuestion', kind: 'user_action', arguments: { q: 'continue?' }, createdAt: 100 },
                },
                completedRequests: null,
            },
            agentStateVersion: 0,
            thinking: false,
            thinkingAt: 0,
            presence: 'online',
        } as any);

        expect(renderable.hasPendingPermissionRequests).toBe(false);
        expect(renderable.hasPendingUserActionRequests).toBe(false);
    });

    it('keeps a newer pending request visible when an older transcript entry with the same id was canceled', () => {
        storageState.sessionMessages = {
            s1: {
                messages: [
                    {
                        kind: 'tool-call',
                        id: 'm-tool-1',
                        localId: null,
                        createdAt: 100,
                        children: [],
                        tool: {
                            id: 'req1',
                            name: 'AskUserQuestion',
                            state: 'error',
                            input: { q: 'continue?' },
                            createdAt: 100,
                            completedAt: 101,
                            permission: {
                                id: 'req1',
                                status: 'canceled',
                                kind: 'user_action',
                            },
                        },
                    },
                ],
            },
        };

        const renderable = buildSessionListRenderableFromSession({
            id: 's1',
            seq: 1,
            createdAt: 1,
            updatedAt: 1,
            active: true,
            activeAt: 1,
            metadata: null,
            metadataVersion: 1,
            agentState: {
                controlledByUser: null,
                requests: {
                    req1: { tool: 'AskUserQuestion', kind: 'user_action', arguments: { q: 'continue again?' }, createdAt: 200 },
                },
                completedRequests: null,
            },
            agentStateVersion: 0,
            thinking: false,
            thinkingAt: 0,
            presence: 'online',
        } as any);

        expect(renderable.hasPendingPermissionRequests).toBe(false);
        expect(renderable.hasPendingUserActionRequests).toBe(true);
    });
});

describe('didSessionListRenderableAttentionPromotionFieldsChange', () => {
    it('detects ready, pending, failed, and working-field changes that affect attention promotion', () => {
        const now = 1_000_000;
        const previous = buildRenderable({ id: 's_attention' });

        expect(didSessionListRenderableAttentionPromotionFieldsChange(previous, {
            ...previous,
            latestReadyEventSeq: 4,
        }, now)).toBe(true);
        expect(didSessionListRenderableAttentionPromotionFieldsChange(previous, {
            ...previous,
            active: true,
            presence: 'online',
            hasPendingUserActionRequests: true,
            pendingRequestObservedAt: now - 1_000,
        }, now)).toBe(true);
        expect(didSessionListRenderableAttentionPromotionFieldsChange(previous, {
            ...previous,
            active: true,
            latestTurnStatus: 'failed',
            lastRuntimeIssue: {
                v: 1,
                scope: 'primary_session',
                status: 'failed',
                code: 'auth_error',
                source: 'auth_error',
                occurredAt: 123,
            },
        }, now)).toBe(true);
        expect(didSessionListRenderableAttentionPromotionFieldsChange(previous, {
            ...previous,
            active: true,
            presence: 'online',
            thinking: true,
            thinkingAt: now - 1_000,
        }, now)).toBe(true);
    });

    it('ignores unread-only changes so unread sessions do not reorder the list', () => {
        const previous = buildRenderable({ id: 's_unread_only', hasUnreadMessages: false });

        expect(didSessionListRenderableAttentionPromotionFieldsChange(previous, {
            ...previous,
            hasUnreadMessages: true,
        })).toBe(false);
    });

    it('detects terminal status changes even when stale runtime freshness projects both rows outside placement', () => {
        const now = 1_000_000;
        const previous = buildRenderable({
            id: 's_retained_working_terminal',
            seq: 10,
            lastViewedSessionSeq: 10,
            active: true,
            presence: 'online',
            latestTurnStatus: 'in_progress',
            latestTurnStatusObservedAt: now - 600_000,
            activeAt: now - 600_000,
            thinking: false,
            thinkingAt: 0,
        });

        expect(didSessionListRenderableAttentionPromotionFieldsChange(previous, {
            ...previous,
            latestTurnStatus: 'completed',
            latestTurnStatusObservedAt: now,
        }, now)).toBe(true);
    });

    it('still ignores progress-only churn that never changes placement at any time', () => {
        const now = 1_000_000;
        const previous = buildRenderable({
            id: 's_progress_churn',
            seq: 5,
            updatedAt: now - 10_000,
            active: true,
            presence: 'online',
            latestTurnStatus: 'in_progress',
            latestTurnStatusObservedAt: now - 60_000,
            activeAt: now - 600_000,
            thinking: false,
            thinkingAt: 0,
        });

        expect(didSessionListRenderableAttentionPromotionFieldsChange(previous, {
            ...previous,
            seq: 6,
            updatedAt: now - 1_000,
        }, now)).toBe(false);
    });
});

describe('didSessionListRenderablePlacementRelevantTimingChange', () => {
    it('flags working-signal refreshes whose placements only diverge after a future freshness boundary', () => {
        const now = 1_000_000;
        const previous = buildRenderable({
            id: 's_working_refresh',
            active: true,
            presence: 'online',
            latestTurnStatus: 'in_progress',
            latestTurnStatusObservedAt: now - 60_000,
            activeAt: now - 60_000,
            thinking: false,
            thinkingAt: 0,
        });

        // Both rows are 'working' at nowMs, but the refreshed observation
        // extends the working window: without a row refresh the committed
        // view data would demote the session at the STALE expiry while its
        // row (subscribed to the fresh renderable) still shows the spinner.
        expect(didSessionListRenderablePlacementRelevantTimingChange(previous, {
            ...previous,
            latestTurnStatusObservedAt: now,
            activeAt: now,
        }, now)).toBe(true);
    });

    it('flags retention-input changes on retainable working sessions even when projections match at every horizon', () => {
        const now = 1_000_000;
        const previous = buildRenderable({
            id: 's_retention_inputs',
            active: true,
            presence: 'online',
            latestTurnStatus: 'in_progress',
            latestTurnStatusObservedAt: now - 60_000,
            activeAt: now - 600_000,
            thinking: false,
            thinkingAt: 0,
        });

        // activeAt stays below latestTurnStatusObservedAt so it never counts
        // as a working signal, but it gates working RETENTION (fresh activeAt
        // with thinking=false blocks retention). The committed view data must
        // pick this change up for retained-working evaluation.
        expect(didSessionListRenderablePlacementRelevantTimingChange(previous, {
            ...previous,
            activeAt: now - 90_000,
        }, now)).toBe(true);
    });

    it('does not flag progress-only churn with no placement-relevant timing effect', () => {
        const now = 1_000_000;
        const previous = buildRenderable({
            id: 's_timing_churn',
            seq: 5,
            updatedAt: now - 10_000,
        });

        expect(didSessionListRenderablePlacementRelevantTimingChange(previous, {
            ...previous,
            seq: 6,
            updatedAt: now - 1_000,
        }, now)).toBe(false);
    });
});

describe('didSessionListRenderableReachabilityPeerFieldsChange', () => {
    it('ignores progress timestamps that do not change reachability peers', () => {
        const previous = buildRenderable({
            id: 's_reachability',
            seq: 1,
            updatedAt: 100,
            meaningfulActivityAt: 100,
            active: true,
            metadata: {
                machineId: 'machine-a',
                host: 'host-a',
                path: '/repo',
                homeDir: '/home/alice',
            } as any,
        });

        expect(didSessionListRenderableReachabilityPeerFieldsChange(previous, {
            ...previous,
            seq: 2,
            updatedAt: 200,
            meaningfulActivityAt: 200,
        })).toBe(false);
    });

    it('ignores metadata-version-only updates when reachability metadata stays stable', () => {
        const previous = buildRenderable({
            id: 's_reachability_metadata_version',
            metadataVersion: 1,
            active: true,
            metadata: {
                machineId: 'machine-a',
                host: 'host-a',
                path: '/repo',
                homeDir: '/home/alice',
                name: 'Initial title',
            } as any,
        });

        expect(didSessionListRenderableReachabilityPeerFieldsChange(previous, {
            ...previous,
            metadataVersion: 2,
            metadata: {
                ...previous.metadata,
                name: 'Updated title',
                summaryText: 'Updated non-reachability summary',
            } as any,
        })).toBe(false);
    });
});

describe('buildSessionListRenderableFromSession with transcript aggregate', () => {
    function buildTranscriptFixture() {
        const messages = [
            {
                id: 'u1',
                kind: 'user-text',
                localId: null,
                createdAt: 1_000,
                seq: 3,
                text: 'run it',
            },
            {
                id: 't1',
                kind: 'tool-call',
                localId: null,
                createdAt: 2_000,
                seq: 5,
                tool: {
                    id: 't1-tool',
                    name: 'bash',
                    state: 'running',
                    input: { command: 'ls' },
                    createdAt: 2_000,
                    startedAt: 2_000,
                    completedAt: null,
                    description: null,
                    permission: {
                        id: 't1-perm',
                        status: 'pending',
                    },
                },
                children: [],
            },
            {
                id: 'a1',
                kind: 'agent-text',
                localId: null,
                createdAt: 3_000,
                seq: 7,
                text: 'done',
            },
        ] as unknown as import('@/sync/domains/messages/messageTypes').Message[];

        const session = {
            id: 's_aggregate',
            seq: 7,
            lastViewedSessionSeq: 3,
            createdAt: 1,
            updatedAt: 3_000,
            active: true,
            activeAt: 3_000,
            archivedAt: null,
            metadata: null,
            metadataVersion: 1,
            agentState: {
                requests: {},
                completedRequests: null,
            },
            agentStateVersion: 2,
            thinking: false,
            thinkingAt: 0,
            presence: 'online',
        } as unknown as Session;

        return { session, messages };
    }

    it('derives a byte-identical renderable from the aggregate without a messages walk', async () => {
        const { buildTranscriptRenderableAggregate } = await import('@/sync/domains/messages/transcriptRenderableAggregate');
        const { session, messages } = buildTranscriptFixture();

        const fromMessages = buildSessionListRenderableFromSession(session, messages);
        const aggregate = buildTranscriptRenderableAggregate({
            messages,
            completedRequests: null,
        });
        const fromAggregate = buildSessionListRenderableFromSession(session, undefined, aggregate);

        expect(fromAggregate).toEqual(fromMessages);
        expect(fromMessages.hasPendingPermissionRequests).toBe(true);
        expect(fromMessages.hasUnreadMessages).toBe(true);
        expect(fromMessages.meaningfulActivityAt).toBe(3_000);
        expect(fromMessages.pendingRequestObservedAt).toBe(2_000);
    });

    it('does not fall back to stored-transcript reads when an aggregate is provided', async () => {
        const { buildTranscriptRenderableAggregate } = await import('@/sync/domains/messages/transcriptRenderableAggregate');
        const { session, messages } = buildTranscriptFixture();

        // Poison the storage bridge for this session: a stored-messages
        // fallback would surface this bogus transcript.
        storageState.sessionMessages[session.id] = {
            messageIdsOldestFirst: [],
            messagesById: {},
            messagesVersion: 0,
        };

        const aggregate = buildTranscriptRenderableAggregate({
            messages,
            completedRequests: null,
        });
        const fromAggregate = buildSessionListRenderableFromSession(session, undefined, aggregate);

        expect(fromAggregate.hasPendingPermissionRequests).toBe(true);
        expect(fromAggregate.pendingRequestObservedAt).toBe(2_000);
    });
});
