import { describe, expect, it } from 'vitest';

import type { Message } from '@/sync/domains/messages/messageTypes';

import {
    resolveTranscriptEventEmphasisByMessageId,
} from './transcriptEventEmphasis';

function eventMessage(
    id: string,
    event: Extract<Message, { kind: 'agent-event' }>['event'],
    createdAt = 1,
): Message {
    return {
        kind: 'agent-event',
        id,
        createdAt,
        event,
    };
}

function resolve(messages: readonly Message[], sessionActive = true) {
    const messagesById = Object.fromEntries(messages.map((message) => [message.id, message]));
    return resolveTranscriptEventEmphasisByMessageId({
        messageIdsOldestFirst: messages.map((message) => message.id),
        messagesById,
        sessionActive,
    });
}

describe('resolveTranscriptEventEmphasisByMessageId', () => {
    it('de-emphasizes prior lifecycle events after the active session reaches a newer ready era', () => {
        const emphasis = resolve([
            eventMessage('old-failure', {
                type: 'message',
                message: 'Claude unified terminal exited unexpectedly.',
                lifecycleId: 'runner-old',
            }),
            eventMessage('ready', { type: 'ready', lifecycleId: 'runner-new' }),
            eventMessage('current-failure', {
                type: 'message',
                message: 'Claude unified terminal exited unexpectedly.',
                lifecycleId: 'runner-new',
            }),
        ]);

        expect(emphasis['old-failure']).toBe('deemphasized');
        expect(emphasis['current-failure']).toBeUndefined();
        expect(emphasis.ready).toBeUndefined();
    });

    it('uses the latest ready event position when lifecycle ids are absent', () => {
        const emphasis = resolve([
            eventMessage('old-failure', {
                type: 'message',
                message: 'Claude unified terminal failed 4 times.',
            }),
            eventMessage('ready', { type: 'ready' }),
            eventMessage('current-failure', {
                type: 'message',
                message: 'Claude unified terminal failed 4 times.',
            }),
        ]);

        expect(emphasis['old-failure']).toBe('deemphasized');
        expect(emphasis['current-failure']).toBeUndefined();
    });

    it('does not treat current-era event-domain lifecycle ids as runner-era ids', () => {
        const emphasis = resolve([
            eventMessage('ready', { type: 'ready', lifecycleId: 'runner-new' }),
            eventMessage('current-compaction', {
                type: 'context-compaction',
                phase: 'failed',
                provider: 'claude',
                lifecycleId: 'compact-1',
            }),
        ]);

        expect(emphasis['current-compaction']).toBeUndefined();
    });

    it('leaves old-era events normal until the session is active again', () => {
        const emphasis = resolve([
            eventMessage('old-failure', {
                type: 'message',
                message: 'Claude unified terminal exited unexpectedly.',
                lifecycleId: 'runner-old',
            }),
            eventMessage('ready', { type: 'ready', lifecycleId: 'runner-new' }),
        ], false);

        expect(emphasis['old-failure']).toBeUndefined();
    });
});
