import type { Message } from '@/sync/domains/messages/messageTypes';

import { resolveTranscriptUtteranceIdentity } from './transcriptFreshnessGate';

type PaintedIdentityItem =
    | Readonly<{ kind: 'pending-queue'; pendingMessages: readonly Readonly<{ localId?: string | null }>[] }>
    | Readonly<{ kind: 'message'; messageId: string }>
    | Readonly<{ kind: 'turn'; turn: Readonly<{ userMessageId?: string | null }> }>
    | Readonly<{ kind: string }>;

function readUserUtteranceLocalId(message: Message | null | undefined): string | null {
    if (message?.kind !== 'user-text') return null;
    const localId = message.localId;
    return typeof localId === 'string' && localId.length > 0 ? localId : null;
}

/**
 * The user utterances a transcript row paints.
 *
 * A send shows the same utterance twice under two different Legend item keys — inside the
 * `pending-queue` row, then as the committed row that replaces it. Declaring the utterance from
 * both sides is what lets the motion gate see the second one as a CONTINUATION of pixels the
 * reader already has, instead of a brand-new row that has to enter from `opacity: 0`.
 *
 * Returns `null` (not an empty array) when a row paints no utterance, so callers can skip the
 * prop entirely for the overwhelming majority of rows.
 */
export function resolveTranscriptRowPaintedIdentities(
    item: PaintedIdentityItem,
    getMessageById: (messageId: string) => Message | null,
): readonly string[] | null {
    if (item.kind === 'pending-queue') {
        const pendingMessages = (item as Extract<PaintedIdentityItem, { kind: 'pending-queue' }>).pendingMessages;
        if (!Array.isArray(pendingMessages) || pendingMessages.length === 0) return null;
        const identities: string[] = [];
        for (const pendingMessage of pendingMessages) {
            const identity = resolveTranscriptUtteranceIdentity(pendingMessage?.localId);
            if (identity) identities.push(identity);
        }
        return identities.length > 0 ? identities : null;
    }

    if (item.kind === 'message') {
        const messageId = (item as Extract<PaintedIdentityItem, { kind: 'message' }>).messageId;
        const identity = resolveTranscriptUtteranceIdentity(readUserUtteranceLocalId(getMessageById(messageId)));
        return identity ? [identity] : null;
    }

    if (item.kind === 'turn') {
        const userMessageId = (item as Extract<PaintedIdentityItem, { kind: 'turn' }>).turn?.userMessageId;
        if (typeof userMessageId !== 'string' || userMessageId.length === 0) return null;
        const identity = resolveTranscriptUtteranceIdentity(readUserUtteranceLocalId(getMessageById(userMessageId)));
        return identity ? [identity] : null;
    }

    return null;
}
