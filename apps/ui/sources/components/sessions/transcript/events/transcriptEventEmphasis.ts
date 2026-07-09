import type { Message } from '@/sync/domains/messages/messageTypes';

export type TranscriptEventEmphasis = 'normal' | 'deemphasized';
export type TranscriptEventEmphasisByMessageId = Readonly<Record<string, TranscriptEventEmphasis>>;

const EMPTY_TRANSCRIPT_EVENT_EMPHASIS_BY_MESSAGE_ID: TranscriptEventEmphasisByMessageId = Object.freeze({});

type TranscriptEventEmphasisInput = Readonly<{
    messageIdsOldestFirst: readonly string[];
    messagesById: Readonly<Record<string, Message>>;
    sessionActive: boolean;
}>;

type EraBoundary = Readonly<{
    readyIndex: number;
}>;

export function resolveTranscriptEventEmphasisByMessageId(
    input: TranscriptEventEmphasisInput,
): TranscriptEventEmphasisByMessageId {
    if (input.sessionActive !== true) return EMPTY_TRANSCRIPT_EVENT_EMPHASIS_BY_MESSAGE_ID;
    const eraBoundary = resolveLatestReadyEraBoundary(input);
    if (eraBoundary === null) return EMPTY_TRANSCRIPT_EVENT_EMPHASIS_BY_MESSAGE_ID;

    const emphasisByMessageId: Record<string, TranscriptEventEmphasis> = {};
    input.messageIdsOldestFirst.forEach((messageId, index) => {
        const message = input.messagesById[messageId];
        if (message?.kind !== 'agent-event') return;
        if (message.event.type === 'ready') return;
        if (index >= eraBoundary.readyIndex) return;
        emphasisByMessageId[messageId] = 'deemphasized';
    });
    return emphasisByMessageId;
}

function resolveLatestReadyEraBoundary(input: TranscriptEventEmphasisInput): EraBoundary | null {
    let readyIndex = -1;
    input.messageIdsOldestFirst.forEach((messageId, index) => {
        const message = input.messagesById[messageId];
        if (message?.kind !== 'agent-event' || message.event.type !== 'ready') return;
        readyIndex = index;
    });
    if (readyIndex < 0) return null;
    return { readyIndex };
}
