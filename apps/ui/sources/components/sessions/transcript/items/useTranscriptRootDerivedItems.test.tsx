import { describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { flushHookEffects, renderHook } from '@/dev/testkit';
import type { AgentTextMessage, Message, UserTextMessage } from '@/sync/domains/messages/messageTypes';

import { useTranscriptRootDerivedItems } from './useTranscriptRootDerivedItems';

const deferredCallbacks = vi.hoisted(() => [] as Array<() => void>);

vi.mock('@/sync/sync', () => ({
    sync: {
        getSyncTuning: () => ({
            transcriptDerivedItemsCacheMaxSessions: 16,
            transcriptMaxTurnEntriesPerListItem: 8,
        }),
    },
}));

vi.mock('@/utils/timing/runAfterInteractionsWithFallback', () => ({
    runAfterInteractionsWithFallback: (fn: () => void) => {
        deferredCallbacks.push(fn);
        return () => {
            const index = deferredCallbacks.indexOf(fn);
            if (index >= 0) deferredCallbacks.splice(index, 1);
        };
    },
}));

function userMessage(id: string, createdAt: number): UserTextMessage {
    return {
        kind: 'user-text',
        id,
        localId: null,
        createdAt,
        text: `user:${id}`,
    };
}

function agentMessage(id: string, createdAt: number): AgentTextMessage {
    return {
        kind: 'agent-text',
        id,
        localId: null,
        createdAt,
        text: `agent:${id}`,
    };
}

function buildTurnMessages(turnCount: number): Message[] {
    const messages: Message[] = [];
    for (let index = 1; index <= turnCount; index += 1) {
        messages.push(userMessage(`u${index}`, index * 2 - 1));
        messages.push(agentMessage(`a${index}`, index * 2));
    }
    return messages;
}

function buildHookParams(messages: readonly Message[]) {
    return {
        actionDrafts: [],
        discardedPendingMessages: [],
        fork: null,
        forkAwareMessageDescriptors: null,
        forkedTranscriptEnabled: false,
        groupToolCalls: true,
        groupingMode: 'turns' as const,
        messageIdsOldestFirst: messages.map((message) => message.id),
        messagesById: Object.fromEntries(messages.map((message) => [message.id, message])),
        pendingMessages: [],
        pendingUserActionRequests: [],
        sessionId: 'tail-window-hook-test',
        toolCallsGroupStrategy: 'consecutive_tools' as const,
    };
}

function turnUserIds(result: ReturnType<typeof useTranscriptRootDerivedItems>): string[] {
    return result.groupedItems.flatMap((item) => item.kind === 'turn' ? [item.turn.userMessageId] : [])
        .filter((id): id is string => typeof id === 'string');
}

describe('useTranscriptRootDerivedItems', () => {
    it('returns tail turns first and completes older backfill through deferred work', async () => {
        deferredCallbacks.length = 0;
        const messages = buildTurnMessages(70);
        const hook = await renderHook(
            (params: ReturnType<typeof buildHookParams>) => useTranscriptRootDerivedItems(params),
            { initialProps: buildHookParams(messages), flushOptions: { cycles: 0 } },
        );

        const firstPaintUserIds = turnUserIds(hook.getCurrent());
        expect(firstPaintUserIds[0]).toBe('u23');
        expect(firstPaintUserIds.at(-1)).toBe('u70');
        expect(firstPaintUserIds).toHaveLength(48);
        expect(deferredCallbacks).toHaveLength(1);

        while (deferredCallbacks.length > 0) {
            const callback = deferredCallbacks.shift()!;
            await act(async () => {
                callback();
            });
            await flushHookEffects();
        }

        const finalUserIds = turnUserIds(hook.getCurrent());
        expect(finalUserIds[0]).toBe('u1');
        expect(finalUserIds.at(-1)).toBe('u70');
        expect(finalUserIds).toHaveLength(70);

        await hook.unmount();
    });
});
