import { afterEach, describe, expect, it } from 'vitest';
import { act } from 'react-test-renderer';

import { renderHook, standardCleanup } from '@/dev/testkit';

import { useSessionConnectedServiceAccountSwitchEvents } from '@/sync/domains/state/storage';
import { storage } from '@/sync/domains/state/storageStore';
import { clearSessionTranscriptDerivedCachesForSession } from '@/sync/runtime/sessionTranscriptDerivedCaches';
import type { Message } from '@/sync/domains/messages/messageTypes';

afterEach(() => {
    clearSessionTranscriptDerivedCachesForSession('s-1');
    clearSessionTranscriptDerivedCachesForSession('s-2');
    standardCleanup();
});

function seedSessionMessages(
    sessionId: string,
    messagesById: Record<string, Message>,
    ids: string[],
    versions?: { messagesVersion?: number; agentEventSourceVersion?: number },
): void {
    storage.setState((state) => ({
        ...state,
        sessionMessages: {
            ...state.sessionMessages,
            [sessionId]: {
                messageIdsOldestFirst: ids,
                messagesById,
                messagesMap: messagesById,
                reducerState: {} as any,
                latestThinkingMessageId: null,
                latestThinkingMessageActivityAtMs: null,
                latestReadyEventSeq: null,
                latestReadyEventAt: null,
                messagesVersion: versions?.messagesVersion ?? 1,
                ...(versions?.agentEventSourceVersion === undefined
                    ? {}
                    : { agentEventSourceVersion: versions.agentEventSourceVersion }),
                lastAppliedAgentStateVersion: null,
                isLoaded: true,
            },
        },
    }));
}

function buildCountingSwitchEventMessage(id: string, onKindRead: () => void): Message {
    return {
        id,
        localId: null,
        createdAt: 10,
        get kind() {
            onKindRead();
            return 'agent-event';
        },
        event: {
            type: 'connected-service-account-switch',
            mode: 'switch',
            reason: 'user',
        },
    } as unknown as Message;
}

describe('useSessionConnectedServiceAccountSwitchEvents', () => {
    it('does not reread transcript messages on unrelated store publishes', async () => {
        const previousState = storage.getState();
        try {
            let kindReadCount = 0;
            const eventMessage = {
                id: 'event-1',
                localId: null,
                createdAt: 10,
                get kind() {
                    kindReadCount += 1;
                    return 'agent-event';
                },
                event: {
                    type: 'connected-service-account-switch',
                    mode: 'switch',
                    reason: 'user',
                },
            } as unknown as Message;
            seedSessionMessages('s-1', { 'event-1': eventMessage }, ['event-1']);

            const hook = await renderHook(
                () => useSessionConnectedServiceAccountSwitchEvents('s-1'),
                { flushOptions: { cycles: 1, turns: 4 } },
            );
            expect(hook.getCurrent()).toHaveLength(1);
            expect(kindReadCount).toBeGreaterThan(0);

            kindReadCount = 0;
            await act(async () => {
                storage.setState((state) => ({
                    ...state,
                    realtimeStatus: state.realtimeStatus === 'connected' ? 'disconnected' : 'connected',
                }));
            });

            expect(hook.getCurrent()).toHaveLength(1);
            expect(kindReadCount).toBe(0);

            await hook.unmount();
        } finally {
            storage.setState(previousState);
        }
    });

    it('does not rescan the transcript when unrelated messages are appended (agent-event source version unchanged)', async () => {
        const previousState = storage.getState();
        try {
            let kindReadCount = 0;
            const eventMessage = buildCountingSwitchEventMessage('event-1', () => {
                kindReadCount += 1;
            });
            seedSessionMessages(
                's-1',
                { 'event-1': eventMessage },
                ['event-1'],
                { messagesVersion: 1, agentEventSourceVersion: 1 },
            );

            const hook = await renderHook(
                () => useSessionConnectedServiceAccountSwitchEvents('s-1'),
                { flushOptions: { cycles: 1, turns: 4 } },
            );
            const initialEvents = hook.getCurrent();
            expect(initialEvents).toHaveLength(1);
            expect(kindReadCount).toBeGreaterThan(0);

            kindReadCount = 0;
            const textMessage = {
                id: 'm-text',
                localId: null,
                createdAt: 20,
                kind: 'agent-text',
                text: 'streamed text',
            } as unknown as Message;
            // Simulate a streaming append: new SessionMessages entry object,
            // new ids array, bumped messagesVersion, same agent-event source.
            await act(async () => {
                seedSessionMessages(
                    's-1',
                    { 'event-1': eventMessage, 'm-text': textMessage },
                    ['event-1', 'm-text'],
                    { messagesVersion: 2, agentEventSourceVersion: 1 },
                );
            });

            expect(hook.getCurrent()).toBe(initialEvents);
            expect(kindReadCount).toBe(0);

            await hook.unmount();
        } finally {
            storage.setState(previousState);
        }
    });

    it('rescans and returns the new events when the agent-event source version advances', async () => {
        const previousState = storage.getState();
        try {
            const first = buildCountingSwitchEventMessage('event-1', () => {});
            seedSessionMessages(
                's-1',
                { 'event-1': first },
                ['event-1'],
                { messagesVersion: 1, agentEventSourceVersion: 1 },
            );

            const hook = await renderHook(
                () => useSessionConnectedServiceAccountSwitchEvents('s-1'),
                { flushOptions: { cycles: 1, turns: 4 } },
            );
            expect(hook.getCurrent()).toHaveLength(1);

            const second = buildCountingSwitchEventMessage('event-2', () => {});
            await act(async () => {
                seedSessionMessages(
                    's-1',
                    { 'event-1': first, 'event-2': second },
                    ['event-1', 'event-2'],
                    { messagesVersion: 2, agentEventSourceVersion: 2 },
                );
            });

            expect(hook.getCurrent()).toHaveLength(2);

            await hook.unmount();
        } finally {
            storage.setState(previousState);
        }
    });

    it('does not return cached events after the session messages entry is removed', async () => {
        const previousState = storage.getState();
        try {
            const eventMessage = buildCountingSwitchEventMessage('event-1', () => {});
            seedSessionMessages(
                's-2',
                { 'event-1': eventMessage },
                ['event-1'],
                { messagesVersion: 0, agentEventSourceVersion: 0 },
            );

            const hook = await renderHook(
                () => useSessionConnectedServiceAccountSwitchEvents('s-2'),
                { flushOptions: { cycles: 1, turns: 4 } },
            );
            expect(hook.getCurrent()).toHaveLength(1);

            await act(async () => {
                storage.setState((state) => {
                    const { ['s-2']: _removed, ...remaining } = state.sessionMessages;
                    return {
                        ...state,
                        sessionMessages: remaining,
                    };
                });
            });

            expect(hook.getCurrent()).toHaveLength(0);

            await hook.unmount();
        } finally {
            storage.setState(previousState);
        }
    });
});
