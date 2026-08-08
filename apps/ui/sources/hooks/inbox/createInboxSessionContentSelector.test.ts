import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Session } from '@/sync/domains/state/storageTypes';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import type { StorageState } from '@/sync/store/types';
import type { SessionMessages } from '@/sync/store/domains/messages';
import type { Message } from '@/sync/domains/messages/messageTypes';
import { SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS } from '@/sync/domains/session/attention/deriveSessionRuntimePresentationState';
import { createReducer } from '@/sync/reducer/reducer';
import { registerStorageStateReader } from '@/sync/domains/state/storageStateReaderBridge';
import { createInboxSessionContentSelector } from './createInboxSessionContentSelector';

function createQuietSession(overrides: Partial<Session> = {}): Session {
    return {
        id: 'session-1',
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
        active: true,
        activeAt: 1,
        thinking: false,
        thinkingAt: 0,
        presence: 'online',
        metadata: null,
        metadataVersion: 0,
        agentState: null,
        agentStateVersion: 0,
        ...overrides,
    } as Session;
}

function createTrackedQuietSession(
    overrides: Partial<Session>,
    onSeqRead: () => void,
): Session {
    const session = createQuietSession(overrides);
    Object.defineProperty(session, 'seq', {
        configurable: true,
        enumerable: true,
        get: () => {
            onSeqRead();
            return overrides.seq ?? 1;
        },
    });
    return session;
}

function createState(params: Readonly<{
    sessions?: Record<string, Session>;
    sessionListRenderables?: Record<string, SessionListRenderableSession>;
    sessionMessages?: Record<string, SessionMessages>;
    sessionListRenderableDelta?: StorageState['sessionListRenderableDelta'];
}>): StorageState {
    return {
        sessions: params.sessions ?? {},
        sessionListRenderables: params.sessionListRenderables ?? {},
        sessionMessages: params.sessionMessages ?? {},
        sessionListRenderableDelta: params.sessionListRenderableDelta,
    } as StorageState;
}

function createSessionMessages(messagesVersion: number): SessionMessages {
    return {
        messageIdsOldestFirst: [],
        messagesById: {},
        messagesMap: {},
        reducerState: createReducer(),
        latestThinkingMessageId: null,
        latestThinkingMessageActivityAtMs: null,
        latestReadyEventSeq: null,
        latestReadyEventAt: null,
        messagesVersion,
        isLoaded: true,
    };
}

function createPermissionMessage(createdAt: number): Message {
    return {
        kind: 'tool-call',
        id: 'message-permission',
        localId: null,
        createdAt,
        children: [],
        tool: {
            id: 'request-permission',
            name: 'Bash',
            state: 'running',
            input: { command: 'ls' },
            createdAt,
            startedAt: createdAt,
            completedAt: null,
            description: null,
            permission: {
                id: 'request-permission',
                status: 'pending',
                kind: 'permission',
            },
        },
    };
}

function expectNoObjectValuesOnRecords(action: () => void, guardedRecords: readonly object[]): void {
    const originalObjectValues = Object.values.bind(Object);
    const valuesSpy = vi.spyOn(Object, 'values').mockImplementation(((value: object) => {
        if (guardedRecords.includes(value)) {
            throw new Error('selector materialized a guarded store record with Object.values');
        }
        return originalObjectValues(value);
    }) as typeof Object.values);

    try {
        expect(action).not.toThrow();
    } finally {
        valuesSpy.mockRestore();
    }
}

function expectNoObjectKeysOnRecords(action: () => void, guardedRecords: readonly object[]): void {
    const originalObjectKeys = Object.keys.bind(Object);
    const keysSpy = vi.spyOn(Object, 'keys').mockImplementation(((value: object) => {
        if (guardedRecords.includes(value)) {
            throw new Error('selector materialized guarded store record keys with Object.keys');
        }
        return originalObjectKeys(value);
    }) as typeof Object.keys);

    try {
        expect(action).not.toThrow();
    } finally {
        keysSpy.mockRestore();
    }
}

describe('createInboxSessionContentSelector', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('reuses the previous result without rescanning inbox content on unrelated session updates', () => {
        const evaluate = vi.fn(() => false);
        const selectInboxSessionContent = createInboxSessionContentSelector(evaluate);

        expect(selectInboxSessionContent(createState({
            sessions: {
                'session-1': createQuietSession({ updatedAt: 1 }),
            },
        }))).toBe(false);
        expect(evaluate).toHaveBeenCalledTimes(1);

        expect(selectInboxSessionContent(createState({
            sessions: {
                'session-1': createQuietSession({ updatedAt: 2 }),
            },
        }))).toBe(false);
        expect(evaluate).toHaveBeenCalledTimes(1);
    });

    it('reuses session field signatures when only the sessions map reference changes', () => {
        vi.spyOn(Date, 'now').mockReturnValue(1_000);
        let seqReads = 0;
        const session = createTrackedQuietSession({ seq: 7 }, () => {
            seqReads += 1;
        });
        const evaluate = vi.fn(() => false);
        const selectInboxSessionContent = createInboxSessionContentSelector(evaluate);

        expect(selectInboxSessionContent(createState({
            sessions: {
                'session-1': session,
            },
        }))).toBe(false);
        const seqReadsAfterFirstSelection = seqReads;

        expect(selectInboxSessionContent(createState({
            sessions: {
                'session-1': session,
            },
        }))).toBe(false);

        expect(evaluate).toHaveBeenCalledTimes(1);
        expect(seqReads).toBe(seqReadsAfterFirstSelection);
    });

    it('rescans when an inbox-relevant session field changes', () => {
        const evaluate = vi.fn(() => true);
        const selectInboxSessionContent = createInboxSessionContentSelector(evaluate);

        selectInboxSessionContent(createState({
            sessions: {
                'session-1': createQuietSession({ seq: 1 }),
            },
        }));
        selectInboxSessionContent(createState({
            sessions: {
                'session-1': createQuietSession({ seq: 2 }),
            },
        }));

        expect(evaluate).toHaveBeenCalledTimes(2);
    });

    it('uses the session-list delta without sorting records on incremental updates', () => {
        const evaluate = vi.fn((input) => input.sessionRowsById?.changed?.hasUnreadMessages === true);
        const selectInboxSessionContent = createInboxSessionContentSelector(evaluate);

        selectInboxSessionContent(createState({
            sessionListRenderables: {
                unchanged: {
                    id: 'unchanged',
                    seq: 1,
                    createdAt: 1,
                    updatedAt: 1,
                    active: false,
                    activeAt: 1,
                    thinking: false,
                    thinkingAt: 0,
                    presence: 'online',
                    metadata: null,
                    metadataVersion: 0,
                    agentStateVersion: 0,
                    hasUnreadMessages: false,
                } as SessionListRenderableSession,
                changed: {
                    id: 'changed',
                    seq: 1,
                    createdAt: 1,
                    updatedAt: 1,
                    active: false,
                    activeAt: 1,
                    thinking: false,
                    thinkingAt: 0,
                    presence: 'online',
                    metadata: null,
                    metadataVersion: 0,
                    agentStateVersion: 0,
                    hasUnreadMessages: false,
                } as SessionListRenderableSession,
            },
            sessionListRenderableDelta: {
                revision: 1,
                changedSessionIds: ['unchanged', 'changed'],
                removedSessionIds: [],
                rebuiltSessionListViewData: true,
            },
        }));
        expect(evaluate).toHaveBeenCalledTimes(2);
        const sortSpy = vi.spyOn(Array.prototype, 'sort');

        expect(selectInboxSessionContent(createState({
            sessionListRenderables: {
                unchanged: {
                    id: 'unchanged',
                    seq: 1,
                    createdAt: 1,
                    updatedAt: 1,
                    active: false,
                    activeAt: 1,
                    thinking: false,
                    thinkingAt: 0,
                    presence: 'online',
                    metadata: null,
                    metadataVersion: 0,
                    agentStateVersion: 0,
                    hasUnreadMessages: false,
                } as SessionListRenderableSession,
                changed: {
                    id: 'changed',
                    seq: 2,
                    createdAt: 1,
                    updatedAt: 2,
                    active: false,
                    activeAt: 1,
                    thinking: false,
                    thinkingAt: 0,
                    presence: 'online',
                    metadata: null,
                    metadataVersion: 0,
                    agentStateVersion: 0,
                    hasUnreadMessages: true,
                } as SessionListRenderableSession,
            },
            sessionListRenderableDelta: {
                revision: 2,
                changedSessionIds: ['changed'],
                removedSessionIds: [],
                rebuiltSessionListViewData: false,
            },
        }))).toBe(true);

        expect(evaluate).toHaveBeenCalledTimes(3);
        expect(evaluate).toHaveBeenLastCalledWith({
            sessionsById: {},
            sessionRowsById: {
                changed: expect.objectContaining({ id: 'changed' }),
            },
            sessionMessagesById: {},
            nowMs: expect.any(Number),
        });
        expect(sortSpy).not.toHaveBeenCalled();
    });

    it('evaluates inbox candidates without Object.values over store session records', () => {
        const evaluate = vi.fn(() => true);
        const selectInboxSessionContent = createInboxSessionContentSelector(evaluate);
        const state = createState({
            sessions: {
                'session-1': createQuietSession({ seq: 3 }),
            },
            sessionListRenderables: {
                'session-2': {
                    id: 'session-2',
                    seq: 4,
                    createdAt: 1,
                    updatedAt: 1,
                    active: false,
                    activeAt: 1,
                    thinking: false,
                    thinkingAt: 0,
                    presence: 'online',
                    metadata: null,
                    metadataVersion: 0,
                    agentStateVersion: 0,
                    hasUnreadMessages: true,
                } as SessionListRenderableSession,
            },
        });
        let result: boolean | undefined;

        expectNoObjectValuesOnRecords(() => {
            expectNoObjectKeysOnRecords(() => {
                result = selectInboxSessionContent(state);
            }, [state.sessions, state.sessionListRenderables]);
        }, [state.sessions, state.sessionListRenderables]);

        expect(result).toBe(true);
        // One derivation path: the account pass evaluates the same session-scoped
        // records the delta path does, so the two can never disagree.
        expect(evaluate).toHaveBeenCalledWith({
            sessionsById: {},
            sessionRowsById: { 'session-2': state.sessionListRenderables['session-2'] },
            sessionMessagesById: state.sessionMessages,
            nowMs: expect.any(Number),
        });
        expect(evaluate).toHaveBeenCalledWith({
            sessionsById: { 'session-1': state.sessions['session-1'] },
            sessionRowsById: {},
            sessionMessagesById: state.sessionMessages,
            nowMs: expect.any(Number),
        });
    });

    it('rescans when a session messages version changes', () => {
        const evaluate = vi.fn(() => false);
        const selectInboxSessionContent = createInboxSessionContentSelector(evaluate);

        selectInboxSessionContent(createState({
            sessions: {
                'session-1': createQuietSession({ seq: 1 }),
            },
            sessionMessages: {
                'session-1': createSessionMessages(1),
            },
        }));
        selectInboxSessionContent(createState({
            sessions: {
                'session-1': createQuietSession({ seq: 1 }),
            },
            sessionMessages: {
                'session-1': createSessionMessages(2),
            },
        }));

        expect(evaluate).toHaveBeenCalledTimes(2);
    });

    it('detects transcript-only pending permissions from the selector state', () => {
        const observedAtMs = 1_000;
        vi.spyOn(Date, 'now').mockReturnValue(observedAtMs);
        const selectInboxSessionContent = createInboxSessionContentSelector();
        const state = createState({
            sessions: {
                'session-1': createQuietSession({
                    active: true,
                    activeAt: observedAtMs,
                    presence: 'online',
                    latestTurnStatus: 'in_progress',
                    latestTurnStatusObservedAt: observedAtMs,
                    agentState: {
                        controlledByUser: null,
                        requests: {},
                        completedRequests: null,
                    },
                }),
            },
            sessionMessages: {
                'session-1': {
                    ...createSessionMessages(2),
                    messageIdsOldestFirst: ['message-permission'],
                    messagesById: {
                        'message-permission': createPermissionMessage(observedAtMs),
                    },
                },
            },
        });
        registerStorageStateReader(() => createState({}));

        expect(selectInboxSessionContent(state)).toBe(true);
    });

    it('reuses the previous result when an active loaded transcript has no pending requests', () => {
        const dateNow = vi.spyOn(Date, 'now').mockReturnValue(1_000);
        const evaluate = vi.fn(() => false);
        const selectInboxSessionContent = createInboxSessionContentSelector(evaluate);
        const state = createState({
            sessions: {
                'session-1': createQuietSession({
                    active: true,
                    activeAt: 1_000,
                    presence: 'online',
                    latestTurnStatus: 'in_progress',
                    latestTurnStatusObservedAt: 1_000,
                    agentState: {
                        controlledByUser: null,
                        requests: {},
                        completedRequests: null,
                    },
                }),
            },
            sessionMessages: {
                'session-1': createSessionMessages(2),
            },
        });

        expect(selectInboxSessionContent(state)).toBe(false);
        dateNow.mockReturnValue(2_000);
        expect(selectInboxSessionContent(state)).toBe(false);

        expect(evaluate).toHaveBeenCalledTimes(1);
    });

    it('expires pending inbox content when runtime freshness changes', () => {
        const observedAtMs = 1_000;
        const dateNow = vi.spyOn(Date, 'now').mockReturnValue(observedAtMs + SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS - 1);
        const selectInboxSessionContent = createInboxSessionContentSelector();
        const state = createState({
            sessions: {
                'session-1': createQuietSession({
                    active: true,
                    activeAt: observedAtMs,
                    presence: 'online',
                    agentState: {
                        requests: {
                            approve: {
                                tool: 'shell',
                                kind: 'user_action',
                                arguments: {},
                                createdAt: observedAtMs,
                            },
                        },
                        completedRequests: null,
                        capabilities: null,
                    },
                }),
            },
        });

        expect(selectInboxSessionContent(state)).toBe(true);

        dateNow.mockReturnValue(observedAtMs + SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS + 1);

        expect(selectInboxSessionContent(state)).toBe(false);
    });
});
