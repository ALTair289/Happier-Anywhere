import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ApiMessage } from '@/sync/api/types/apiTypes';
import { syncPerformanceTelemetry } from '@/sync/runtime/syncPerformanceTelemetry';
import type { NormalizedMessage } from '@/sync/typesRaw';

import { runSessionMessagesPagePipeline } from './sessionMessagesPagePipeline';

function buildEncryptedApiMessage(params: {
    id: string;
    seq: number;
    updatedAt?: number;
    sidechainId?: string | null;
}): ApiMessage {
    return {
        id: params.id,
        seq: params.seq,
        localId: null,
        sidechainId: params.sidechainId ?? null,
        content: {
            t: 'encrypted',
            c: `cipher-${params.id}`,
        },
        createdAt: 1_000 + params.seq,
        updatedAt: params.updatedAt ?? 2_000 + params.seq,
    };
}

function buildTextContent(message: ApiMessage, text = `hello-${message.id}`) {
    return {
        id: message.id,
        seq: message.seq,
        localId: message.localId ?? null,
        createdAt: message.createdAt,
        content: {
            role: 'user',
            content: { type: 'text', text },
        },
    };
}

function buildLifecycleContent(message: ApiMessage) {
    return {
        id: message.id,
        seq: message.seq,
        localId: message.localId ?? null,
        createdAt: message.createdAt,
        content: {
            role: 'agent',
            content: {
                type: 'acp',
                provider: 'kimi',
                data: { type: 'turn_aborted', id: `task-${message.seq}` },
            },
        },
    };
}

describe('runSessionMessagesPagePipeline', () => {
    afterEach(() => {
        syncPerformanceTelemetry.configure({ enabled: false });
        syncPerformanceTelemetry.reset();
    });

    it('preserves older-page decrypt order, sidechain metadata, and pre-apply normalized callback semantics', async () => {
        const newest = buildEncryptedApiMessage({ id: 'm100', seq: 100 });
        const oldest = buildEncryptedApiMessage({ id: 'm99', seq: 99 });
        const request = vi.fn(async () => new Response(
            JSON.stringify({
                messages: [newest, oldest],
                hasMore: true,
                nextBeforeSeq: 98,
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
        ));

        const decryptMessages = vi.fn(async (messages: ApiMessage[]) =>
            messages.map((message) => buildTextContent(message)),
        );
        const applyMessages = vi.fn<(sessionId: string, messages: NormalizedMessage[]) => void>();
        const callOrder: string[] = [];
        const onNormalizedMessages = vi.fn((messages: NormalizedMessage[]) => {
            callOrder.push(`normalized:${messages.map((message) => message.id).join(',')}`);
        });
        applyMessages.mockImplementation((_sessionId, messages) => {
            callOrder.push(`apply:${messages.map((message) => message.id).join(',')}`);
        });

        const result = await runSessionMessagesPagePipeline({
            sessionId: 's1',
            purpose: 'older',
            page: {
                direction: 'older',
                requestPath: '/v1/sessions/s1/messages?beforeSeq=101&limit=2&scope=sidechain&sidechainId=tool_task_1',
                scope: 'sidechain',
                sidechainId: 'tool_task_1',
                beforeSeq: 101,
                limit: 2,
            },
            lifecyclePolicy: 'suppress',
            getSessionEncryption: () => ({ decryptMessages }),
            request,
            sessionReceivedMessages: new Map<string, Map<string, number>>(),
            applyMessages,
            onNormalizedMessages,
            log: { log: () => {} },
        });

        expect(request).toHaveBeenCalledWith('/v1/sessions/s1/messages?beforeSeq=101&limit=2&scope=sidechain&sidechainId=tool_task_1');
        expect(decryptMessages.mock.calls[0]?.[0].map((message) => message.id)).toEqual(['m99', 'm100']);
        expect(callOrder).toEqual(['normalized:m99,m100', 'apply:m99,m100']);
        expect(applyMessages.mock.calls[0]?.[1]).toEqual([
            expect.objectContaining({ id: 'm99', seq: 99, isSidechain: true, sidechainId: 'tool_task_1' }),
            expect.objectContaining({ id: 'm100', seq: 100, isSidechain: true, sidechainId: 'tool_task_1' }),
        ]);
        expect(result).toMatchObject({
            applied: 2,
            appliedMessageIds: ['m99', 'm100'],
            appliedSeqs: [99, 100],
            rawSeqs: [100, 99],
            page: {
                hasMore: true,
                nextBeforeSeq: 98,
            },
        });
    });

    it('uses an explicit target-window purpose and lifecycle policy instead of treating newer-side target pages as live-tail newer pages', async () => {
        syncPerformanceTelemetry.configure({
            enabled: true,
            slowThresholdMs: 1_000_000,
            flushIntervalMs: 60_000,
        });
        syncPerformanceTelemetry.reset();

        const lifecycle = buildEncryptedApiMessage({ id: 'm101', seq: 101 });
        const request = vi.fn(async () => new Response(
            JSON.stringify({
                messages: [lifecycle],
                nextAfterSeq: 101,
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
        ));
        const decryptMessages = vi.fn(async (messages: ApiMessage[]) =>
            messages.map((message) => buildLifecycleContent(message)),
        );
        const onTaskLifecycleEvent = vi.fn();
        const applyMessages = vi.fn();

        const result = await runSessionMessagesPagePipeline({
            sessionId: 's1',
            purpose: 'target-window',
            page: {
                direction: 'newer',
                requestPath: '/v1/sessions/s1/messages?afterSeq=100&limit=1&scope=main',
                scope: 'main',
                sidechainId: null,
                afterSeq: 100,
                limit: 1,
            },
            lifecyclePolicy: 'suppress',
            getSessionEncryption: () => ({ decryptMessages }),
            request,
            sessionReceivedMessages: new Map<string, Map<string, number>>(),
            applyMessages,
            onTaskLifecycleEvent,
            log: { log: () => {} },
        });

        expect(onTaskLifecycleEvent).not.toHaveBeenCalled();
        expect(applyMessages).toHaveBeenCalledWith('s1', []);
        expect(result).toMatchObject({
            applied: 0,
            appliedMessageIds: [],
            rawSeqs: [101],
        });

        const events = syncPerformanceTelemetry.snapshot().events;
        const requestEvent = events.find((event) => event.name === 'sync.sessions.messages.request');
        expect(requestEvent?.fields.targetWindow).toBe(1);
        expect(requestEvent?.fields.newer ?? 0).toBe(0);
    });
});
