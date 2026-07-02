import { describe, expect, it } from 'vitest';

import type { Message } from './messageTypes';
import {
    applyMessageChangeToTranscriptRenderableAggregate,
    buildTranscriptRenderableAggregate,
    canReuseTranscriptRenderableAggregateRequestStates,
    isTranscriptRenderableAggregate,
    type TranscriptRenderableAggregate,
} from './transcriptRenderableAggregate';

function agentText(overrides: Partial<Record<string, unknown>> = {}): Message {
    return {
        id: 'agent-1',
        kind: 'agent-text',
        localId: null,
        createdAt: 1_000,
        seq: 10,
        text: 'hello',
        ...overrides,
    } as unknown as Message;
}

function noAttentionEvent(overrides: Partial<Record<string, unknown>> = {}): Message {
    return {
        id: 'event-1',
        kind: 'agent-event',
        localId: null,
        createdAt: 2_000,
        seq: 20,
        event: { type: 'provider-quota-wait' },
        ...overrides,
    } as unknown as Message;
}

function toolCall(overrides: Readonly<{
    id?: string;
    createdAt?: number;
    seq?: number;
    permissionId?: string;
    permissionStatus?: string | null;
    children?: Message[];
}> = {}): Message {
    const id = overrides.id ?? 'tool-msg-1';
    const createdAt = overrides.createdAt ?? 3_000;
    return {
        id,
        kind: 'tool-call',
        localId: null,
        createdAt,
        seq: overrides.seq ?? 30,
        tool: {
            id: `${id}-tool`,
            name: 'bash',
            state: 'running',
            input: { command: 'ls' },
            createdAt,
            startedAt: createdAt,
            completedAt: null,
            description: null,
            ...(overrides.permissionStatus === null
                ? {}
                : {
                    permission: {
                        id: overrides.permissionId ?? `${id}-perm`,
                        status: overrides.permissionStatus ?? 'pending',
                    },
                }),
        },
        children: overrides.children ?? [],
    } as unknown as Message;
}

function expectAggregatesEquivalent(
    actual: TranscriptRenderableAggregate,
    expected: TranscriptRenderableAggregate,
): void {
    expect(actual.latestCommittedMessageCreatedAt).toBe(expected.latestCommittedMessageCreatedAt);
    expect(actual.latestUnreadAffectingMessageSeq).toBe(expected.latestUnreadAffectingMessageSeq);
    expect(actual.messageCount).toBe(expected.messageCount);
    expect(Array.from(actual.requestStates.entries())).toEqual(Array.from(expected.requestStates.entries()));
}

describe('buildTranscriptRenderableAggregate', () => {
    it('folds attention, unread, and transcript request state over all messages', () => {
        const messages = [
            agentText({ id: 'a1', createdAt: 1_000, seq: 10 }),
            noAttentionEvent({ id: 'e1', createdAt: 5_000, seq: 50 }),
            toolCall({ id: 't1', createdAt: 3_000, seq: 30, permissionStatus: 'pending' }),
        ];

        const aggregate = buildTranscriptRenderableAggregate({ messages, completedRequests: null });

        // The no-attention event must not advance either watermark.
        expect(aggregate.latestCommittedMessageCreatedAt).toBe(3_000);
        expect(aggregate.latestUnreadAffectingMessageSeq).toBe(30);
        expect(aggregate.messageCount).toBe(3);
        expect(aggregate.requestStates.get('t1-perm')).toMatchObject({ status: 'pending' });
        expect(isTranscriptRenderableAggregate(aggregate)).toBe(true);
    });

    it('returns empty aggregates for empty transcripts', () => {
        const aggregate = buildTranscriptRenderableAggregate({ messages: [], completedRequests: null });
        expect(aggregate.latestCommittedMessageCreatedAt).toBeNull();
        expect(aggregate.latestUnreadAffectingMessageSeq).toBeNull();
        expect(aggregate.messageCount).toBe(0);
        expect(aggregate.requestStates.size).toBe(0);
    });
});

describe('applyMessageChangeToTranscriptRenderableAggregate', () => {
    it('matches a full rebuild when appending new messages', () => {
        const initial = [agentText({ id: 'a1', createdAt: 1_000, seq: 10 })];
        const aggregate = buildTranscriptRenderableAggregate({ messages: initial, completedRequests: null });

        const appended = toolCall({ id: 't1', createdAt: 2_500, seq: 25, permissionStatus: 'pending' });
        const applied = applyMessageChangeToTranscriptRenderableAggregate({
            aggregate,
            previous: null,
            next: appended,
        });

        expect(applied).toBe(true);
        expectAggregatesEquivalent(
            aggregate,
            buildTranscriptRenderableAggregate({ messages: [...initial, appended], completedRequests: null }),
        );
    });

    it('matches a full rebuild for streaming text updates without touching the request map identity', () => {
        const base = agentText({ id: 'a1', createdAt: 1_000, seq: 10, text: 'hel' });
        const tool = toolCall({ id: 't1', createdAt: 900, seq: 9, permissionStatus: 'pending' });
        const aggregate = buildTranscriptRenderableAggregate({ messages: [tool, base], completedRequests: null });
        const requestStates = aggregate.requestStates;

        const updated = agentText({ id: 'a1', createdAt: 1_000, seq: 10, text: 'hello world' });
        const applied = applyMessageChangeToTranscriptRenderableAggregate({
            aggregate,
            previous: base,
            next: updated,
        });

        expect(applied).toBe(true);
        expect(aggregate.requestStates).toBe(requestStates);
        expectAggregatesEquivalent(
            aggregate,
            buildTranscriptRenderableAggregate({ messages: [tool, updated], completedRequests: null }),
        );
    });

    it('matches a full rebuild when a pending permission resolves to a terminal status', () => {
        const pendingTool = toolCall({ id: 't1', createdAt: 3_000, seq: 30, permissionStatus: 'pending' });
        const aggregate = buildTranscriptRenderableAggregate({ messages: [pendingTool], completedRequests: null });
        expect(aggregate.requestStates.get('t1-perm')).toMatchObject({ status: 'pending' });

        const approvedTool = toolCall({ id: 't1', createdAt: 3_000, seq: 30, permissionStatus: 'approved' });
        const applied = applyMessageChangeToTranscriptRenderableAggregate({
            aggregate,
            previous: pendingTool,
            next: approvedTool,
        });

        expect(applied).toBe(true);
        expectAggregatesEquivalent(
            aggregate,
            buildTranscriptRenderableAggregate({ messages: [approvedTool], completedRequests: null }),
        );
        expect(aggregate.requestStates.get('t1-perm')).toMatchObject({ status: 'terminal' });
    });

    it('matches a full rebuild when a message gains a seq on commit', () => {
        const optimistic = agentText({ id: 'a1', createdAt: 1_000, seq: null });
        const aggregate = buildTranscriptRenderableAggregate({ messages: [optimistic], completedRequests: null });

        const committed = agentText({ id: 'a1', createdAt: 1_000, seq: 12 });
        const applied = applyMessageChangeToTranscriptRenderableAggregate({
            aggregate,
            previous: optimistic,
            next: committed,
        });

        expect(applied).toBe(true);
        expectAggregatesEquivalent(
            aggregate,
            buildTranscriptRenderableAggregate({ messages: [committed], completedRequests: null }),
        );
    });

    it('refuses non-monotone attention changes so callers rebuild', () => {
        const base = agentText({ id: 'a1', createdAt: 9_000, seq: 90 });
        const aggregate = buildTranscriptRenderableAggregate({
            messages: [agentText({ id: 'a0', createdAt: 1_000, seq: 10 }), base],
            completedRequests: null,
        });

        const weakened = agentText({ id: 'a1', createdAt: 500, seq: 5 });
        expect(applyMessageChangeToTranscriptRenderableAggregate({
            aggregate,
            previous: base,
            next: weakened,
        })).toBe(false);
    });

    it('refuses changes that drop a previously contributed request id', () => {
        const pendingTool = toolCall({ id: 't1', createdAt: 3_000, seq: 30, permissionStatus: 'pending' });
        const aggregate = buildTranscriptRenderableAggregate({ messages: [pendingTool], completedRequests: null });

        const withoutPermission = toolCall({ id: 't1', createdAt: 3_000, seq: 30, permissionStatus: null });
        expect(applyMessageChangeToTranscriptRenderableAggregate({
            aggregate,
            previous: pendingTool,
            next: withoutPermission,
        })).toBe(false);
    });
});

describe('canReuseTranscriptRenderableAggregateRequestStates', () => {
    it('requires the same completedRequests identity used to build the aggregate', () => {
        const completedRequests = { done: { createdAt: 1 } };
        const aggregate = buildTranscriptRenderableAggregate({
            messages: [toolCall({ id: 't1', permissionStatus: 'pending' })],
            completedRequests,
        });

        expect(canReuseTranscriptRenderableAggregateRequestStates(aggregate, completedRequests)).toBe(true);
        expect(canReuseTranscriptRenderableAggregateRequestStates(aggregate, { ...completedRequests })).toBe(false);
        expect(canReuseTranscriptRenderableAggregateRequestStates(aggregate, null)).toBe(false);
    });
});

describe('isTranscriptRenderableAggregate', () => {
    it('rejects rehydrated shapes that lost their Map', () => {
        expect(isTranscriptRenderableAggregate(null)).toBe(false);
        expect(isTranscriptRenderableAggregate({
            latestCommittedMessageCreatedAt: 1,
            latestUnreadAffectingMessageSeq: 1,
            messageCount: 1,
            requestStates: {},
            completedRequestsRef: null,
        })).toBe(false);
    });
});
