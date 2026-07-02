import type { PrimaryTurnStatusV1 } from '@happier-dev/protocol';

import { messageAttentionImpact } from '@/sync/domains/messages/messageUserAttention';
import type { Message } from '@/sync/domains/messages/messageTypes';

export type ResolveSessionReadableSeqInput = Readonly<{
    messages?: ReadonlyArray<Message> | null;
    /**
     * Precomputed replacement for the `messages` walk, produced by the
     * incrementally-maintained transcript aggregate
     * (`sync/domains/messages/transcriptRenderableAggregate.ts`).
     * Takes precedence over `messages` when provided.
     */
    messagesProjection?: Readonly<{
        hasMessages: boolean;
        latestUnreadAffectingMessageSeq: number | null;
    }> | null;
    latestMessageSeq?: unknown;
    sessionSeq?: unknown;
    latestReadyEventSeq?: unknown;
    latestTurnStatus?: PrimaryTurnStatusV1 | null;
    includeTerminalSessionSeq: boolean;
}>;

export function resolveLatestUnreadAffectingCommittedMessageSeq(
    messages: ReadonlyArray<Message> | null | undefined,
): number | null {
    let readableSeq: number | null = null;
    if (!Array.isArray(messages)) return readableSeq;

    for (const message of messages) {
        if (!messageAttentionImpact(message).affectsUnread) continue;
        readableSeq = maxReadSeq(readableSeq, normalizeReadSeq(message.seq));
    }

    return readableSeq;
}

export function resolveSessionReadableSeq(input: ResolveSessionReadableSeqInput): number | null {
    const projection = input.messagesProjection ?? null;
    const hasCommittedMessageAttentionProjection = projection
        ? projection.hasMessages
        : Array.isArray(input.messages) && input.messages.length > 0;
    let readableSeq = projection
        ? projection.latestUnreadAffectingMessageSeq
        : resolveLatestUnreadAffectingCommittedMessageSeq(input.messages);
    if (!hasCommittedMessageAttentionProjection) {
        readableSeq = maxReadSeq(readableSeq, normalizeReadSeq(input.latestMessageSeq));
    }

    readableSeq = maxReadSeq(readableSeq, normalizeReadSeq(input.latestReadyEventSeq));

    if (
        !hasCommittedMessageAttentionProjection
        && input.includeTerminalSessionSeq
        && isTerminalTurnStatus(input.latestTurnStatus)
    ) {
        readableSeq = maxReadSeq(readableSeq, normalizeReadSeq(input.sessionSeq));
    }

    return readableSeq;
}

function normalizeReadSeq(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value)
        ? Math.max(0, Math.trunc(value))
        : null;
}

function maxReadSeq(left: number | null, right: number | null): number | null {
    if (left === null) return right;
    if (right === null) return left;
    return Math.max(left, right);
}

function isTerminalTurnStatus(value: unknown): value is Exclude<PrimaryTurnStatusV1, 'in_progress'> {
    return value === 'completed' || value === 'cancelled' || value === 'failed';
}
