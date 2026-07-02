import { beforeEach, describe, expect, it, vi } from 'vitest';

import { syncPerformanceTelemetry } from '@/sync/runtime/syncPerformanceTelemetry';
import { createMessagesDomain } from './messages';

function createHarness(initial: any) {
    let state: any = {
        sessions: {},
        sessionListRenderables: {},
        sessionListViewData: null,
        sessionListViewDataByServerId: {},
        machines: {},
        machineDisplayById: {},
        settings: {},
        sessionPending: {},
        sessionMessages: {},
        ...initial,
    };

    const get = () => state;
    const set = (updater: any) => {
        const next = typeof updater === 'function' ? updater(state) : updater;
        state = { ...state, ...next };
    };

    const domain = createMessagesDomain({ get, set } as any);
    return { get, domain };
}

function buildStreamSegmentMeta(updatedAtMs: number) {
    return {
        happierStreamSegmentV1: {
            v: 1,
            segmentKind: 'assistant',
            segmentLocalId: 'assistant-segment-1',
            segmentState: 'streaming',
            startedAtMs: 1_000,
            updatedAtMs,
        },
    };
}

beforeEach(() => {
    syncPerformanceTelemetry.configure({ enabled: false });
});

describe('messages domain: ordering', () => {
    it('advances the stored session seq from committed message activity', () => {
        const { get, domain } = createHarness({
            sessions: {
                s1: {
                    id: 's1',
                    seq: 1,
                    createdAt: 1,
                    updatedAt: 1,
                    active: true,
                    activeAt: 1,
                    lastViewedSessionSeq: 1,
                    metadataVersion: 1,
                    agentStateVersion: 1,
                    metadata: null,
                    agentState: null,
                    thinking: false,
                    thinkingAt: 0,
                    presence: 'online',
                    permissionMode: null,
                    permissionModeUpdatedAt: 0,
                },
            },
            sessionListRenderables: {
                s1: {
                    id: 's1',
                    seq: 1,
                    createdAt: 1,
                    updatedAt: 1,
                    active: true,
                    activeAt: 1,
                    lastViewedSessionSeq: 1,
                    metadataVersion: 1,
                    agentStateVersion: 1,
                    metadata: null,
                    thinking: false,
                    thinkingAt: 0,
                    presence: 'online',
                },
            },
        });

        domain.applyMessages('s1', [
            {
                id: 'm3',
                seq: 3,
                localId: null,
                createdAt: 1000,
                isSidechain: false,
                role: 'agent',
                content: [{ type: 'text', text: 'done' }],
            } as any,
        ]);

        expect(get().sessions.s1.seq).toBe(3);
        expect(get().sessionListRenderables.s1.seq).toBe(3);
    });

    it('updates session-list renderable pending flags when agent state adds a permission request without advancing seq', () => {
        const { get, domain } = createHarness({
            sessions: {
                s1: {
                    id: 's1',
                    seq: 1,
                    createdAt: 1,
                    updatedAt: 1,
                    active: true,
                    activeAt: 1,
                    lastViewedSessionSeq: 1,
                    metadataVersion: 1,
                    agentStateVersion: 2,
                    metadata: null,
                    agentState: {
                        controlledByUser: null,
                        requests: {
                            req1: {
                                tool: 'Bash',
                                arguments: { command: 'pwd' },
                                createdAt: 2,
                            },
                        },
                        completedRequests: null,
                    },
                    thinking: true,
                    thinkingAt: 2,
                    latestTurnStatus: 'in_progress',
                    presence: 'online',
                    permissionMode: null,
                    permissionModeUpdatedAt: 0,
                },
            },
            sessionMessages: {
                s1: {
                    reducerState: undefined,
                    messageIdsOldestFirst: [],
                    messagesById: {},
                    messagesMap: {},
                    latestThinkingMessageId: null,
                    latestThinkingMessageActivityAtMs: null,
                    latestReadyEventSeq: null,
                    latestReadyEventAt: null,
                    messagesVersion: 0,
                    lastAppliedAgentStateVersion: 1,
                    isLoaded: true,
                },
            },
            sessionListRenderables: {
                s1: {
                    id: 's1',
                    seq: 1,
                    createdAt: 1,
                    updatedAt: 1,
                    active: true,
                    activeAt: 1,
                    lastViewedSessionSeq: 1,
                    metadataVersion: 1,
                    agentStateVersion: 1,
                    metadata: null,
                    thinking: true,
                    thinkingAt: 2,
                    latestTurnStatus: 'in_progress',
                    presence: 'online',
                    hasPendingPermissionRequests: false,
                    hasPendingUserActionRequests: false,
                },
            },
        });

        domain.applyMessages('s1', []);

        expect(get().sessions.s1.seq).toBe(1);
        expect(get().sessionListRenderables.s1.hasPendingPermissionRequests).toBe(true);
        expect(get().sessionListRenderables.s1.hasPendingUserActionRequests).toBe(false);
    });

    it('orders an agent-state permission placeholder by the matching transcript tool call once it arrives', () => {
        const { get, domain } = createHarness({
            sessions: {
                s1: {
                    id: 's1',
                    seq: 1,
                    createdAt: 1,
                    updatedAt: 1,
                    active: true,
                    activeAt: 1,
                    lastViewedSessionSeq: 1,
                    metadataVersion: 1,
                    agentStateVersion: 2,
                    metadata: null,
                    agentState: {
                        controlledByUser: null,
                        requests: {
                            ask1: {
                                tool: 'AskUserQuestion',
                                kind: 'user_action',
                                arguments: { questions: [{ question: 'Choose a path' }] },
                                createdAt: 1_000,
                            },
                        },
                        completedRequests: null,
                    },
                    thinking: false,
                    thinkingAt: 0,
                    presence: 'online',
                    permissionMode: null,
                    permissionModeUpdatedAt: 0,
                },
            },
            sessionMessages: {
                s1: {
                    reducerState: undefined,
                    messageIdsOldestFirst: [],
                    messagesById: {},
                    messagesMap: {},
                    latestThinkingMessageId: null,
                    latestThinkingMessageActivityAtMs: null,
                    latestReadyEventSeq: null,
                    latestReadyEventAt: null,
                    messagesVersion: 0,
                    lastAppliedAgentStateVersion: 1,
                    isLoaded: true,
                },
            },
            sessionListRenderables: {},
        });

        domain.applyMessages('s1', []);

        const placeholderIds = get().sessionMessages.s1.messageIdsOldestFirst;
        expect(placeholderIds).toHaveLength(1);
        const placeholder = get().sessionMessages.s1.messagesById[placeholderIds[0]!] as any;
        expect(placeholder.kind).toBe('tool-call');
        expect(placeholder.seq).toBeUndefined();

        domain.applyMessages('s1', [
            {
                id: 'assistant-text',
                seq: 10,
                localId: null,
                createdAt: 2_000,
                isSidechain: false,
                role: 'agent',
                content: [{ type: 'text', text: 'Here is the rationale before the question.' }],
            } as any,
            {
                id: 'assistant-tool',
                seq: 11,
                localId: null,
                createdAt: 2_100,
                isSidechain: false,
                role: 'agent',
                content: [{
                    type: 'tool-call',
                    id: 'ask1',
                    name: 'AskUserQuestion',
                    input: { questions: [{ question: 'Choose a path' }] },
                    description: null,
                    uuid: 'tool-uuid',
                    parentUUID: null,
                }],
            } as any,
        ]);

        const messages = get().sessionMessages.s1.messageIdsOldestFirst
            .map((id: string) => get().sessionMessages.s1.messagesById[id]);

        expect(messages.map((message: any) => message.kind)).toEqual(['agent-text', 'tool-call']);
        expect((messages[0] as any).text).toBe('Here is the rationale before the question.');
        expect((messages[1] as any).tool.id).toBe('ask1');
        expect((messages[1] as any).seq).toBe(11);
    });

    it('orders blocks from the same transcript message by provider content order', () => {
        const { get, domain } = createHarness({
            sessions: {
                s1: {
                    id: 's1',
                    seq: 1,
                    createdAt: 1,
                    updatedAt: 1,
                    active: true,
                    activeAt: 1,
                    lastViewedSessionSeq: 1,
                    metadataVersion: 1,
                    agentStateVersion: 1,
                    metadata: null,
                    agentState: null,
                    thinking: false,
                    thinkingAt: 0,
                    presence: 'online',
                    permissionMode: null,
                    permissionModeUpdatedAt: 0,
                },
            },
            sessionMessages: {
                s1: {
                    reducerState: undefined,
                    messageIdsOldestFirst: [],
                    messagesById: {},
                    messagesMap: {},
                    latestThinkingMessageId: null,
                    latestThinkingMessageActivityAtMs: null,
                    latestReadyEventSeq: null,
                    latestReadyEventAt: null,
                    messagesVersion: 0,
                    lastAppliedAgentStateVersion: 1,
                    isLoaded: true,
                },
            },
            sessionListRenderables: {},
        });

        const randomSpy = vi.spyOn(Math, 'random')
            .mockReturnValueOnce(0.9)
            .mockReturnValueOnce(0.1);

        try {
            domain.applyMessages('s1', [
                {
                    id: 'assistant-message',
                    seq: 10,
                    localId: null,
                    createdAt: 2_000,
                    isSidechain: false,
                    role: 'agent',
                    content: [
                        {
                            type: 'text',
                            text: 'Text before the tool call.',
                            uuid: 'text-uuid',
                            parentUUID: null,
                        },
                        {
                            type: 'tool-call',
                            id: 'tool1',
                            name: 'AskUserQuestion',
                            input: { questions: [{ question: 'Choose a path' }] },
                            description: null,
                            uuid: 'tool-uuid',
                            parentUUID: null,
                        },
                    ],
                } as any,
            ]);
        } finally {
            randomSpy.mockRestore();
        }

        const messages = get().sessionMessages.s1.messageIdsOldestFirst
            .map((id: string) => get().sessionMessages.s1.messagesById[id]);

        expect(messages.map((message: any) => message.kind)).toEqual(['agent-text', 'tool-call']);
        expect((messages[0] as any).text).toBe('Text before the tool call.');
        expect((messages[1] as any).tool.id).toBe('tool1');
    });

    it('records latest ready event metadata without adding a visible transcript message', () => {
        const { get, domain } = createHarness({
            sessions: {
                s1: {
                    id: 's1',
                    createdAt: 1,
                    active: false,
                    activeAt: 1,
                    metadataVersion: 1,
                    metadata: null,
                    permissionMode: null,
                    permissionModeUpdatedAt: 0,
                },
            },
        });

        const result = domain.applyMessages('s1', [
            {
                id: 'ready-2',
                seq: 2,
                localId: null,
                createdAt: 2_000,
                isSidechain: false,
                role: 'event',
                content: { type: 'ready' },
            } as any,
        ]);

        expect(result).toEqual({
            changed: [],
            hasReadyEvent: true,
            latestReadyEventSeq: 2,
            latestReadyEventAt: 2_000,
        });
        expect(get().sessionMessages.s1.messageIdsOldestFirst).toEqual([]);
        expect(get().sessionMessages.s1.latestReadyEventSeq).toBe(2);
        expect(get().sessionMessages.s1.latestReadyEventAt).toBe(2_000);
    });

    it('keeps the highest ready seq and reset clears ready metadata', () => {
        const { get, domain } = createHarness({
            sessions: {
                s1: {
                    id: 's1',
                    createdAt: 1,
                    active: false,
                    activeAt: 1,
                    metadataVersion: 1,
                    metadata: null,
                    permissionMode: null,
                    permissionModeUpdatedAt: 0,
                },
            },
        });

        domain.applyMessages('s1', [
            {
                id: 'ready-3',
                seq: 3,
                localId: null,
                createdAt: 3_000,
                isSidechain: false,
                role: 'event',
                content: { type: 'ready' },
            } as any,
        ]);
        domain.applyMessages('s1', [
            {
                id: 'ready-2',
                seq: 2,
                localId: null,
                createdAt: 2_000,
                isSidechain: false,
                role: 'event',
                content: { type: 'ready' },
            } as any,
        ]);

        expect(get().sessionMessages.s1.latestReadyEventSeq).toBe(3);
        expect(get().sessionMessages.s1.latestReadyEventAt).toBe(3_000);

        domain.resetSessionMessages('s1');

        expect(get().sessionMessages.s1.latestReadyEventSeq).toBeNull();
        expect(get().sessionMessages.s1.latestReadyEventAt).toBeNull();
    });

    it('orders committed transcript messages by seq when available (oldest first)', () => {
        const { get, domain } = createHarness({
            sessions: {
                s1: {
                    id: 's1',
                    createdAt: 1,
                    active: false,
                    activeAt: 1,
                    metadataVersion: 1,
                    metadata: null,
                    permissionMode: null,
                    permissionModeUpdatedAt: 0,
                },
            },
        });

        domain.applyMessages('s1', [
            {
                id: 'm1',
                seq: 1,
                localId: null,
                createdAt: 1000,
                isSidechain: false,
                role: 'user',
                content: { type: 'text', text: 'first' },
            } as any,
            {
                id: 'm2',
                seq: 2,
                localId: null,
                createdAt: 1000,
                isSidechain: false,
                role: 'user',
                content: { type: 'text', text: 'second' },
            } as any,
        ]);

        const ids = get().sessionMessages.s1.messageIdsOldestFirst;
        expect(ids).toHaveLength(2);
        const first = get().sessionMessages.s1.messagesById[ids[0]!] as any;
        const second = get().sessionMessages.s1.messagesById[ids[1]!] as any;
        expect(first?.kind).toBe('user-text');
        expect(first?.seq).toBe(1);
        expect(first?.text).toBe('first');
        expect(second?.kind).toBe('user-text');
        expect(second?.seq).toBe(2);
        expect(second?.text).toBe('second');
    });

    it('clears matching local optimistic pending rows but keeps unresolved server pending rows when a transcript message commits with the same localId', () => {
        const { get, domain } = createHarness({
            sessions: {
                s1: {
                    id: 's1',
                    createdAt: 1,
                    active: false,
                    activeAt: 1,
                    metadataVersion: 1,
                    metadata: null,
                    permissionMode: null,
                    permissionModeUpdatedAt: 0,
                    agentState: null,
                },
            },
            sessionPending: {
                s1: {
                    isLoaded: true,
                    discarded: [],
                    messages: [
                        {
                            id: 'pending-server-local-1',
                            localId: 'local-1',
                            source: 'server_pending',
                            pendingDeliveryStatus: 'server_delivering',
                            createdAt: 1_000,
                            updatedAt: 1_000,
                            text: 'accepted provider-owned prompt',
                            rawRecord: { role: 'user', content: { type: 'text', text: 'accepted provider-owned prompt' } },
                        },
                        {
                            id: 'pending-local-local-1',
                            localId: 'local-1',
                            source: 'local_outbound',
                            createdAt: 1_000,
                            updatedAt: 1_000,
                            text: 'local optimistic duplicate',
                            rawRecord: { role: 'user', content: { type: 'text', text: 'local optimistic duplicate' } },
                        },
                    ],
                },
            },
        });

        domain.applyMessages('s1', [
            {
                id: 'm1',
                seq: 1,
                localId: 'local-1',
                createdAt: 2_000,
                isSidechain: false,
                role: 'user',
                content: { type: 'text', text: 'committed elsewhere' },
            } as any,
        ]);

        expect(get().sessionPending.s1.messages.map((message: any) => message.id)).toEqual(['pending-server-local-1']);
    });

    it('tracks latest thinking activity time only when a thinking message changes', () => {
        const { get, domain } = createHarness({
            sessions: {
                s1: {
                    id: 's1',
                    createdAt: 1,
                    active: false,
                    activeAt: 1,
                    metadataVersion: 1,
                    metadata: null,
                    permissionMode: null,
                    permissionModeUpdatedAt: 0,
                },
            },
        });

        const nowSpy = vi.spyOn(Date, 'now');

        nowSpy.mockReturnValue(1_000);
        domain.applyMessages('s1', [
            {
                id: 'think-1',
                seq: 1,
                localId: null,
                createdAt: 10,
                isSidechain: false,
                role: 'agent',
                content: [{ type: 'thinking', thinking: 'step 1', uuid: 'u1', parentUUID: null }],
            } as any,
        ]);

        const thinkingId = get().sessionMessages.s1.latestThinkingMessageId;
        expect(typeof thinkingId).toBe('string');
        expect(thinkingId).not.toHaveLength(0);
        const thinkingMessage = get().sessionMessages.s1.messagesById[thinkingId!] as any;
        expect(thinkingMessage?.kind).toBe('agent-text');
        expect(thinkingMessage?.isThinking).toBe(true);
        expect(get().sessionMessages.s1.latestThinkingMessageActivityAtMs).toBe(1_000);

        nowSpy.mockReturnValue(2_000);
        domain.applyMessages('s1', [
            {
                id: 'tool-1',
                seq: 2,
                localId: null,
                createdAt: 11,
                isSidechain: false,
                role: 'agent',
                content: [{
                    type: 'tool-call',
                    id: 'call-1',
                    name: 'Read',
                    input: { path: 'a.txt' },
                    description: null,
                    uuid: 't1',
                    parentUUID: null,
                }],
            } as any,
        ]);

        // Tool-only updates should not bump thinking activity.
        expect(get().sessionMessages.s1.latestThinkingMessageId).toBe(thinkingId);
        expect(get().sessionMessages.s1.latestThinkingMessageActivityAtMs).toBe(1_000);

        nowSpy.mockReturnValue(3_000);
        domain.applyMessages('s1', [
            {
                id: 'think-1',
                seq: 3,
                localId: null,
                createdAt: 10,
                isSidechain: false,
                role: 'agent',
                content: [{ type: 'thinking', thinking: 'step 1 (cont)', uuid: 'u1', parentUUID: null }],
            } as any,
        ]);

        expect(get().sessionMessages.s1.latestThinkingMessageId).toBe(thinkingId);
        expect(get().sessionMessages.s1.latestThinkingMessageActivityAtMs).toBe(3_000);

        nowSpy.mockRestore();
    });

    it('records applyMessages telemetry when sync performance telemetry is enabled', () => {
        const { domain } = createHarness({
            sessions: {
                s1: {
                    id: 's1',
                    createdAt: 1,
                    active: false,
                    activeAt: 1,
                    metadataVersion: 1,
                    metadata: null,
                    permissionMode: null,
                    permissionModeUpdatedAt: 0,
                },
            },
        });

        syncPerformanceTelemetry.configure({
            enabled: true,
            slowThresholdMs: 1_000_000,
            flushIntervalMs: 60_000,
        });
        syncPerformanceTelemetry.reset();

        try {
            domain.applyMessages('s1', [
                {
                    id: 'm1',
                    seq: 1,
                    localId: null,
                    createdAt: 1000,
                    isSidechain: false,
                    role: 'user',
                    content: { type: 'text', text: 'first' },
                } as any,
                {
                    id: 'm2',
                    seq: 2,
                    localId: null,
                    createdAt: 1000,
                    isSidechain: false,
                    role: 'user',
                    content: { type: 'text', text: 'second' },
                } as any,
            ]);

            const event = syncPerformanceTelemetry
                .snapshot()
                .events.find((candidate) => candidate.name === 'sync.store.messages.apply');
            expect(event?.count).toBe(1);
            expect(event?.fields.messages).toBe(2);
            expect(event?.fields.processed).toBe(2);
            expect(event?.fields.changed).toBe(2);
            expect(event?.fields.uniqueInsertedOrMoved).toBe(2);
            expect(event?.fields.stateChanged).toBe(1);

            const reducerEvent = syncPerformanceTelemetry
                .snapshot()
                .events.find((candidate) => candidate.name === 'sync.store.messages.reducer');
            expect(reducerEvent?.count).toBe(1);
            expect(reducerEvent?.fields.messages).toBe(2);
            expect(reducerEvent?.fields.agentStateApplied).toBe(0);

            const indexEvent = syncPerformanceTelemetry
                .snapshot()
                .events.find((candidate) => candidate.name === 'sync.store.messages.index');
            expect(indexEvent?.count).toBe(1);
            expect(indexEvent?.fields.processed).toBe(2);
            expect(indexEvent?.fields.uniqueInsertedOrMoved).toBe(2);
        } finally {
            syncPerformanceTelemetry.configure({ enabled: false });
        }
    });

    it('uses append-only index work for higher-seq streaming messages', () => {
        const messageCount = 1_000;
        const existingIds = Array.from({ length: messageCount }, (_, index) => `m${index + 1}`);
        const messagesById = Object.fromEntries(existingIds.map((id, index) => [
            id,
            {
                id,
                kind: 'user-text',
                seq: index + 1,
                localId: null,
                createdAt: index + 1,
                text: `message ${index + 1}`,
            },
        ]));
        const { get, domain } = createHarness({
            sessions: {
                s1: {
                    id: 's1',
                    seq: messageCount,
                    createdAt: 1,
                    updatedAt: 1,
                    active: true,
                    activeAt: 1,
                    lastViewedSessionSeq: messageCount,
                    metadataVersion: 1,
                    agentStateVersion: 1,
                    metadata: null,
                    agentState: null,
                    thinking: false,
                    thinkingAt: 0,
                    presence: 'online',
                    permissionMode: null,
                    permissionModeUpdatedAt: 0,
                    pendingPermissionRequestCount: 0,
                    pendingUserActionRequestCount: 0,
                },
            },
            sessionMessages: {
                s1: {
                    reducerState: undefined,
                    messageIdsOldestFirst: existingIds,
                    messagesById,
                    messagesMap: messagesById,
                    latestThinkingMessageId: null,
                    latestThinkingMessageActivityAtMs: null,
                    latestReadyEventSeq: null,
                    latestReadyEventAt: null,
                    messagesVersion: 1,
                    lastAppliedAgentStateVersion: 1,
                    isLoaded: true,
                },
            },
            sessionListRenderables: {
                s1: {
                    id: 's1',
                    seq: messageCount,
                    createdAt: 1,
                    updatedAt: 1,
                    active: true,
                    activeAt: 1,
                    lastViewedSessionSeq: messageCount,
                    metadataVersion: 1,
                    agentStateVersion: 1,
                    metadata: null,
                    thinking: false,
                    thinkingAt: 0,
                    presence: 'online',
                    hasPendingPermissionRequests: false,
                    hasPendingUserActionRequests: false,
                },
            },
        });

        syncPerformanceTelemetry.configure({
            enabled: true,
            slowThresholdMs: 1_000_000,
            flushIntervalMs: 60_000,
        });
        syncPerformanceTelemetry.reset();

        try {
            domain.applyMessages('s1', [
                {
                    id: 'm1001',
                    seq: messageCount + 1,
                    localId: null,
                    createdAt: messageCount + 1,
                    isSidechain: false,
                    role: 'agent',
                    content: [{ type: 'text', text: 'next' }],
                } as any,
            ]);

            expect(get().sessionMessages.s1.messageIdsOldestFirst).toHaveLength(messageCount + 1);
            const indexEvent = syncPerformanceTelemetry
                .snapshot()
                .events.find((candidate) => candidate.name === 'sync.store.messages.index');
            expect(indexEvent?.fields.appendOnly).toBe(1);
        } finally {
            syncPerformanceTelemetry.configure({ enabled: false });
        }
    });

    it('keeps transcript store references stable for empty message updates without agent state', () => {
        const { get, domain } = createHarness({
            sessions: {
                s1: {
                    id: 's1',
                    createdAt: 1,
                    active: false,
                    activeAt: 1,
                    metadataVersion: 1,
                    metadata: null,
                    permissionMode: null,
                    permissionModeUpdatedAt: 0,
                    agentState: null,
                },
            },
        });

        domain.applyMessages('s1', [
            {
                id: 'm1',
                seq: 1,
                localId: null,
                createdAt: 1000,
                isSidechain: false,
                role: 'user',
                content: { type: 'text', text: 'first' },
            } as any,
        ]);

        const previousSessionMessages = get().sessionMessages;
        const previousEntry = previousSessionMessages.s1;
        const previousIds = previousEntry.messageIdsOldestFirst;
        const previousMessagesById = previousEntry.messagesById;
        const previousMessagesVersion = previousEntry.messagesVersion;
        const previousReducerVersion = previousEntry.reducerVersion;

        const result = domain.applyMessages('s1', []);

        expect(result).toEqual({
            changed: [],
            hasReadyEvent: false,
            latestReadyEventSeq: null,
            latestReadyEventAt: null,
        });
        expect(get().sessionMessages).toBe(previousSessionMessages);
        expect(get().sessionMessages.s1).toBe(previousEntry);
        expect(get().sessionMessages.s1.messageIdsOldestFirst).toBe(previousIds);
        expect(get().sessionMessages.s1.messagesById).toBe(previousMessagesById);
        expect(get().sessionMessages.s1.messagesVersion).toBe(previousMessagesVersion);
        expect(get().sessionMessages.s1.reducerVersion).toBe(previousReducerVersion);
    });

    it('keeps transcript store references stable when an unchanged message is applied again', () => {
        const { get, domain } = createHarness({
            sessions: {
                s1: {
                    id: 's1',
                    createdAt: 1,
                    active: false,
                    activeAt: 1,
                    metadataVersion: 1,
                    metadata: null,
                    permissionMode: null,
                    permissionModeUpdatedAt: 0,
                    agentState: null,
                },
            },
        });

        const message = {
            id: 'm1',
            seq: 1,
            localId: null,
            createdAt: 1000,
            isSidechain: false,
            role: 'user',
            content: { type: 'text', text: 'first' },
        } as any;

        domain.applyMessages('s1', [message]);

        const previousSessionMessages = get().sessionMessages;
        const previousEntry = previousSessionMessages.s1;
        const previousIds = previousEntry.messageIdsOldestFirst;
        const previousMessagesById = previousEntry.messagesById;
        const previousMessagesVersion = previousEntry.messagesVersion;
        const previousReducerVersion = previousEntry.reducerVersion;

        const result = domain.applyMessages('s1', [message]);

        expect(result).toEqual({
            changed: [],
            hasReadyEvent: false,
            latestReadyEventSeq: null,
            latestReadyEventAt: null,
        });
        expect(get().sessionMessages).toBe(previousSessionMessages);
        expect(get().sessionMessages.s1).toBe(previousEntry);
        expect(get().sessionMessages.s1.messageIdsOldestFirst).toBe(previousIds);
        expect(get().sessionMessages.s1.messagesById).toBe(previousMessagesById);
        expect(get().sessionMessages.s1.messagesVersion).toBe(previousMessagesVersion);
        expect(get().sessionMessages.s1.reducerVersion).toBe(previousReducerVersion);
    });

    it('keeps subagent source version stable for ordinary streamed text updates', () => {
        const { get, domain } = createHarness({
            sessions: {
                s1: {
                    id: 's1',
                    createdAt: 1,
                    active: true,
                    activeAt: 1,
                    metadataVersion: 1,
                    metadata: null,
                    permissionMode: null,
                    permissionModeUpdatedAt: 0,
                },
            },
        });

        domain.applyMessages('s1', [
            {
                id: 'm1',
                seq: 1,
                localId: null,
                createdAt: 1000,
                isSidechain: false,
                role: 'agent',
                content: [{ type: 'text', text: 'first chunk' }],
            } as any,
        ]);
        const firstEntry = get().sessionMessages.s1;

        expect(firstEntry.messagesVersion).toBe(1);
        expect(firstEntry.subagentSourceVersion).toBe(0);

        domain.applyMessages('s1', [
            {
                id: 'm1',
                seq: 1,
                localId: null,
                createdAt: 1000,
                isSidechain: false,
                role: 'agent',
                content: [{ type: 'text', text: 'first chunk plus streamed markdown' }],
            } as any,
        ]);

        expect(get().sessionMessages.s1.messagesVersion).toBeGreaterThan(firstEntry.messagesVersion);
        expect(get().sessionMessages.s1.subagentSourceVersion).toBe(0);
    });

    it('advances subagent source version when a tool call enters the transcript', () => {
        const { get, domain } = createHarness({
            sessions: {
                s1: {
                    id: 's1',
                    createdAt: 1,
                    active: true,
                    activeAt: 1,
                    metadataVersion: 1,
                    metadata: null,
                    permissionMode: null,
                    permissionModeUpdatedAt: 0,
                },
            },
        });

        domain.applyMessages('s1', [
            {
                id: 'tool-1',
                seq: 1,
                localId: null,
                createdAt: 1000,
                isSidechain: false,
                role: 'agent',
                content: [{
                    type: 'tool-call',
                    id: 'call-1',
                    name: 'SubAgentRun',
                    input: { runId: 'run_12345678' },
                    description: null,
                    uuid: 't1',
                    parentUUID: null,
                }],
            } as any,
        ]);

        expect(get().sessionMessages.s1.messagesVersion).toBe(1);
        expect(get().sessionMessages.s1.subagentSourceVersion).toBe(1);
    });

    it('advances subagent source version when an execution-run source message stops matching', () => {
        const { get, domain } = createHarness({
            sessions: {
                s1: {
                    id: 's1',
                    createdAt: 1,
                    active: false,
                    activeAt: 1,
                    metadataVersion: 1,
                    metadata: null,
                    permissionMode: null,
                    permissionModeUpdatedAt: 0,
                    agentState: null,
                },
            },
        });

        domain.applyMessages('s1', [
            {
                id: 'm1',
                seq: 1,
                localId: 'commit-1',
                createdAt: 1000,
                isSidechain: false,
                role: 'agent',
                content: [{ type: 'text', text: 'Execution run run_12345678 started', uuid: 'u1', parentUUID: null }],
                meta: buildStreamSegmentMeta(1_000),
            } as any,
        ]);

        expect(get().sessionMessages.s1.subagentSourceVersion).toBe(1);

        domain.applyMessages('s1', [
            {
                id: 'm1',
                seq: 1,
                localId: 'commit-2',
                createdAt: 1000,
                isSidechain: false,
                role: 'agent',
                content: [{ type: 'text', text: 'ordinary markdown token update', uuid: 'u1', parentUUID: null }],
                meta: buildStreamSegmentMeta(2_000),
            } as any,
        ]);

        expect(get().sessionMessages.s1.subagentSourceVersion).toBe(2);
    });

    it('keeps transcript store references stable for repeated empty updates after the same agent state version was applied', () => {
        const { get, domain } = createHarness({
            sessions: {
                s1: {
                    id: 's1',
                    createdAt: 1,
                    active: true,
                    activeAt: 1,
                    metadataVersion: 1,
                    metadata: null,
                    permissionMode: null,
                    permissionModeUpdatedAt: 0,
                    agentState: {
                        requests: {
                            req1: {
                                tool: 'Bash',
                                arguments: { command: 'ls' },
                                createdAt: 123,
                            },
                        },
                    },
                    agentStateVersion: 7,
                },
            },
        });

        const firstResult = domain.applyMessages('s1', []);
        expect(firstResult.changed.length).toBeGreaterThan(0);

        const previousSessionMessages = get().sessionMessages;
        const previousEntry = previousSessionMessages.s1;
        const previousIds = previousEntry.messageIdsOldestFirst;
        const previousMessagesById = previousEntry.messagesById;
        const previousMessagesVersion = previousEntry.messagesVersion;
        const previousReducerVersion = previousEntry.reducerVersion;

        const secondResult = domain.applyMessages('s1', []);

        expect(secondResult).toEqual({
            changed: [],
            hasReadyEvent: false,
            latestReadyEventSeq: null,
            latestReadyEventAt: null,
        });
        expect(get().sessionMessages).toBe(previousSessionMessages);
        expect(get().sessionMessages.s1).toBe(previousEntry);
        expect(get().sessionMessages.s1.messageIdsOldestFirst).toBe(previousIds);
        expect(get().sessionMessages.s1.messagesById).toBe(previousMessagesById);
        expect(get().sessionMessages.s1.messagesVersion).toBe(previousMessagesVersion);
        expect(get().sessionMessages.s1.reducerVersion).toBe(previousReducerVersion);
    });
});
