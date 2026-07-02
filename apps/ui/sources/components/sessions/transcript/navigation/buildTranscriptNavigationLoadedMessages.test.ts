import { describe, expect, it } from 'vitest';

import { buildTranscriptNavigationLoadedMessages } from './buildTranscriptNavigationLoadedMessages';

describe('buildTranscriptNavigationLoadedMessages', () => {
    it('keeps loaded message facts ordered by transcript ids and normalizes missing optional fields', () => {
        const loaded = buildTranscriptNavigationLoadedMessages({
            sessionId: 'session-1',
            messageIdsOldestFirst: ['user-1', 'missing', 'assistant-1', 'tool-1'],
            messagesById: {
                'user-1': {
                    id: 'user-1',
                    kind: 'user-text',
                    seq: 7,
                    text: 'raw prompt',
                    displayText: 'display prompt',
                    createdAt: 10,
                    transcriptBlockIndex: 0,
                } as any,
                'assistant-1': {
                    id: 'assistant-1',
                    kind: 'agent-text',
                    seq: 8,
                    text: 'answer',
                    createdAt: 11.9,
                    transcriptBlockIndex: 1,
                } as any,
                'tool-1': {
                    id: 'tool-1',
                    kind: 'tool-call',
                    seq: Number.NaN,
                    tool: { name: 'shell', description: 'Run shell' },
                    createdAt: null,
                    transcriptBlockIndex: null,
                } as any,
            },
        });

        expect(loaded.map((message) => ({
            messageId: message.messageId,
            role: message.role,
            seq: message.seq,
            transcriptBlockIndex: message.transcriptBlockIndex,
            text: message.text,
            createdAtMs: message.createdAtMs,
            loaded: message.loaded,
        }))).toEqual([
            {
                messageId: 'user-1',
                role: 'user',
                seq: 7,
                transcriptBlockIndex: 0,
                text: 'display prompt',
                createdAtMs: 10,
                loaded: true,
            },
            {
                messageId: 'assistant-1',
                role: 'assistant',
                seq: 8,
                transcriptBlockIndex: 1,
                text: 'answer',
                createdAtMs: 11,
                loaded: true,
            },
            {
                messageId: 'tool-1',
                role: 'tool',
                seq: null,
                transcriptBlockIndex: null,
                text: 'Run shell',
                createdAtMs: null,
                loaded: true,
            },
        ]);
    });
});
