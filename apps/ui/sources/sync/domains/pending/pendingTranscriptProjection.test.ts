import { describe, expect, it } from 'vitest';

import type { Message } from '@/sync/domains/messages/messageTypes';
import type { DiscardedPendingMessage, PendingMessage } from '@/sync/domains/state/storageTypes';

import {
    collectCommittedTranscriptLocalIds,
    filterCommittedTranscriptMessageIdsForPendingState,
    isCommittedTranscriptMessageHiddenByCrossover,
    isPendingTranscriptMessageHiddenByCrossover,
    resolvePendingTranscriptCrossover,
} from './pendingTranscriptProjection';

function pendingRecord(overrides: Partial<PendingMessage> = {}): PendingMessage {
    return {
        id: 'p1',
        localId: 'l1',
        createdAt: 1,
        updatedAt: 1,
        source: 'local_outbound',
        text: 'hello',
        rawRecord: null,
        ...overrides,
    } as PendingMessage;
}

function committedUserMessage(localId: string | null): Message {
    return { kind: 'user-text', id: `m-${localId ?? 'none'}`, localId, createdAt: 2, text: 'hello' } as Message;
}

/**
 * The crossover owns ONE decision for two rows describing one utterance. `sync/store/domains/
 * messages.ts` already drops the matching non-durable pending records in the SAME store update that
 * appends the committed messages, so the handover is a single commit; what this module has to
 * guarantee is that, in every frame, exactly one of the two rows is visible.
 */
describe('pending → committed crossover', () => {
    function visibleRows(params: Readonly<{
        pendingMessages: PendingMessage[];
        discardedMessages?: DiscardedPendingMessage[];
        committed: Message[];
    }>) {
        const messagesById = Object.fromEntries(params.committed.map((message) => [message.id, message]));
        const crossover = resolvePendingTranscriptCrossover({
            committedLocalIds: collectCommittedTranscriptLocalIds(Object.keys(messagesById), messagesById),
            pendingMessages: params.pendingMessages,
            discardedMessages: params.discardedMessages,
        });
        return {
            committed: params.committed.filter((message) => !isCommittedTranscriptMessageHiddenByCrossover(message, crossover)),
            pending: params.pendingMessages.filter((message) => !isPendingTranscriptMessageHiddenByCrossover(message, crossover)),
        };
    }

    it('keeps exactly one row per utterance across the whole local send handover', () => {
        const pending = pendingRecord({ localId: 'l1' });
        const committed = committedUserMessage('l1');

        // 1. queued only.
        const queued = visibleRows({ pendingMessages: [pending], committed: [] });
        expect(queued.pending).toHaveLength(1);
        expect(queued.committed).toHaveLength(0);

        // 2. the one frame where both records can be observed together.
        const overlap = visibleRows({ pendingMessages: [pending], committed: [committed] });
        expect(overlap.pending).toHaveLength(0);
        expect(overlap.committed).toHaveLength(1);

        // 3. committed only (the store removed the pending record in the same update).
        const settled = visibleRows({ pendingMessages: [], committed: [committed] });
        expect(settled.committed).toHaveLength(1);
    });

    it('lets a durable server pending row keep the slot and hides its committed twin', () => {
        const durable = pendingRecord({ localId: 'l1', source: 'server_pending' });
        const rows = visibleRows({ pendingMessages: [durable], committed: [committedUserMessage('l1')] });

        expect(rows.pending).toHaveLength(1);
        expect(rows.committed).toHaveLength(0);
    });

    it('resolves a durable and a local record for one utterance to a single visible row', () => {
        const rows = visibleRows({
            pendingMessages: [
                pendingRecord({ id: 'p-local', localId: 'l1', source: 'local_outbound' }),
                pendingRecord({ id: 'p-durable', localId: 'l1', source: 'server_pending' }),
            ],
            committed: [committedUserMessage('l1')],
        });

        expect(rows.pending.map((message) => message.id)).toEqual(['p-durable']);
        expect(rows.committed).toHaveLength(0);
    });

    it('never hides a pending row whose utterance has no committed twin', () => {
        const rows = visibleRows({
            pendingMessages: [pendingRecord({ localId: 'l1' })],
            committed: [committedUserMessage('other')],
        });

        expect(rows.pending).toHaveLength(1);
        expect(rows.committed).toHaveLength(1);
    });

    it('leaves rows without a localId alone on both sides', () => {
        const rows = visibleRows({
            pendingMessages: [pendingRecord({ localId: null })],
            committed: [committedUserMessage(null)],
        });

        expect(rows.pending).toHaveLength(1);
        expect(rows.committed).toHaveLength(1);
    });

    it('hides a committed row for a durable record that is already discarded (its discarded row shows)', () => {
        const messages = [committedUserMessage('l1'), committedUserMessage('l2')];
        const messagesById = Object.fromEntries(messages.map((message) => [message.id, message]));

        const remaining = filterCommittedTranscriptMessageIdsForPendingState({
            messageIdsOldestFirst: messages.map((message) => message.id),
            messagesById,
            pendingMessages: [],
            discardedMessages: [{
                ...pendingRecord({ localId: 'l1', source: 'server_pending' }),
                discardedAt: 3,
                discardedReason: null,
            } as DiscardedPendingMessage],
        });

        expect(remaining).toEqual([messages[1]!.id]);
    });
});
