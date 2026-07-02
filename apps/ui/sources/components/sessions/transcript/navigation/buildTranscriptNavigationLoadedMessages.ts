import { buildMessageRouteId } from '@/sync/domains/messages/messageRouteIds';
import type { Message } from '@/sync/domains/messages/messageTypes';

import type {
    TranscriptNavigationLoadedMessage,
    TranscriptNavigationRole,
} from './transcriptNavigationTypes';

function roleForMessage(message: Message): TranscriptNavigationRole {
    if (message.kind === 'user-text') return 'user';
    if (message.kind === 'agent-text') return 'assistant';
    if (message.kind === 'tool-call') return 'tool';
    if (message.kind === 'agent-event') return 'system';
    return 'unknown';
}

function textForMessage(message: Message): string | null {
    if (message.kind === 'user-text') {
        return message.displayText ?? message.text;
    }
    if (message.kind === 'agent-text') {
        return message.text;
    }
    if (message.kind === 'tool-call') {
        return message.tool.description ?? message.tool.name;
    }
    return null;
}

function normalizeFiniteInteger(value: unknown): number | null {
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    return Math.trunc(value);
}

export function buildTranscriptNavigationLoadedMessages(params: Readonly<{
    messageIdsOldestFirst: readonly string[];
    messagesById: Readonly<Record<string, Message>>;
    sessionId: string;
}>): TranscriptNavigationLoadedMessage[] {
    const loadedMessages: TranscriptNavigationLoadedMessage[] = [];
    for (const messageId of params.messageIdsOldestFirst) {
        const message = params.messagesById[messageId];
        if (!message) continue;
        loadedMessages.push({
            sessionId: params.sessionId,
            messageId: message.id,
            routeMessageId: buildMessageRouteId(message),
            seq: normalizeFiniteInteger(message.seq),
            transcriptBlockIndex: normalizeFiniteInteger(message.transcriptBlockIndex),
            role: roleForMessage(message),
            text: textForMessage(message),
            createdAtMs: normalizeFiniteInteger(message.createdAt),
            loaded: true,
        });
    }
    return loadedMessages;
}
