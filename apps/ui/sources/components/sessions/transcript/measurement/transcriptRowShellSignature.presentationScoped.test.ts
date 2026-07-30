import { describe, expect, it } from 'vitest';

import type { DiscardedPendingMessage, PendingMessage } from '@/sync/domains/state/storageTypes';

import {
    buildTranscriptRowShellSignature,
    type TranscriptRowShellItem,
} from './transcriptRowShellSignature';

function signatureFor(item: TranscriptRowShellItem) {
    return buildTranscriptRowShellSignature({
        activeThinkingMessageId: null,
        expandedToolCallsAnchorMessageIds: new Set<string>(),
        forkMessageMetadataById: null,
        getMessageById: () => null,
        getMessageRevisionById: () => null,
        groupingMode: 'linear',
        item,
        latestCommittedActivityKey: null,
        resolveThinkingExpanded: () => false,
        sessionActive: true,
        widthBucket: 'w:400',
        fontScaleKey: 'fs:1',
    });
}

function pendingMessage(overrides: Partial<PendingMessage> = {}): PendingMessage {
    return {
        id: 'p1',
        localId: 'l1',
        createdAt: 1_000,
        updatedAt: 1_000,
        source: 'local_outbound',
        text: 'hello',
        rawRecord: { v: 1 },
        ...overrides,
    } as PendingMessage;
}

function pendingQueueItem(
    pendingMessages: PendingMessage[],
    discardedMessages: DiscardedPendingMessage[] = [],
): TranscriptRowShellItem {
    return {
        kind: 'pending-queue',
        id: 'pending-queue',
        pendingMessages,
        discardedMessages,
    };
}

/**
 * J/D2 (2026-07-30): `ChatListInternal` wires Legend's vendored `getItemSizeVersion` to this
 * signature, and the patched `validateItemSizeVersion` DELETES the row's measured size whenever the
 * version moves (`TranscriptRowShell` additionally wipes its reservation on an
 * `isStructuralSignatureDelta`). So a signature that churns on non-visual record fields destroys the
 * row's measurement on every server tick — measured on native as a ±12.70px scroll oscillation with
 * `contentLength` byte-identical while the pending row is on screen.
 */
describe('pending row signatures are presentation-scoped', () => {
    it('ignores a pending record tick that changes nothing the row paints', () => {
        const before = signatureFor(pendingQueueItem([pendingMessage()]));
        const after = signatureFor(pendingQueueItem([pendingMessage({
            updatedAt: 9_999,
            rawRecord: { v: 2, serverTouchedAt: 9_999 },
        })]));

        expect(after.structuralKey).toBe(before.structuralKey);
    });

    it('moves when the queue composition changes, so a drained queue re-seeds its floor', () => {
        const two = signatureFor(pendingQueueItem([
            pendingMessage({ id: 'p1', localId: 'l1' }),
            pendingMessage({ id: 'p2', localId: 'l2' }),
        ]));
        const one = signatureFor(pendingQueueItem([pendingMessage({ id: 'p1', localId: 'l1' })]));

        expect(one.structuralKey).not.toBe(two.structuralKey);
    });

    it('moves when the rendered text extent changes', () => {
        const short = signatureFor(pendingQueueItem([pendingMessage({ text: 'hi' })]));
        const long = signatureFor(pendingQueueItem([pendingMessage({ text: 'x'.repeat(400) })]));
        const wrapped = signatureFor(pendingQueueItem([pendingMessage({ text: 'a\nb' })]));
        const flat = signatureFor(pendingQueueItem([pendingMessage({ text: 'ab ' })]));

        expect(long.structuralKey).not.toBe(short.structuralKey);
        expect(wrapped.structuralKey).not.toBe(flat.structuralKey);
    });

    it('moves when the row switches to a state that paints extra chrome', () => {
        const queued = signatureFor(pendingQueueItem([pendingMessage({ source: 'server_pending' })]));
        const blocked = signatureFor(pendingQueueItem([pendingMessage({
            source: 'server_pending',
            pendingDeliveryStatus: 'blocked',
            pendingDeliveryBlockedReason: 'terminal_composer_draft',
        })]));

        expect(blocked.structuralKey).not.toBe(queued.structuralKey);
    });

    it('sizes discarded rows by their own presentation, not by a record serialization', () => {
        const discarded = (overrides: Partial<DiscardedPendingMessage>): DiscardedPendingMessage => ({
            ...pendingMessage({ id: 'd1', localId: 'ld1' }),
            discardedAt: 5,
            discardedReason: null,
            ...overrides,
        } as DiscardedPendingMessage);

        const plain = signatureFor(pendingQueueItem([], [discarded({})]));
        const ticked = signatureFor(pendingQueueItem([], [discarded({ updatedAt: 7_777, rawRecord: { v: 3 } })]));
        const withReason = signatureFor(pendingQueueItem([], [discarded({ discardedReason: 'interrupted' })]));

        expect(ticked.structuralKey).toBe(plain.structuralKey);
        expect(withReason.structuralKey).not.toBe(plain.structuralKey);
    });

    it('keeps an unbounded permission-request payload out of the size version', () => {
        const request = (args: unknown) => ({
            kind: 'pending-user-action' as const,
            id: 'pending-user-action:r1',
            request: {
                id: 'r1',
                tool: 'Bash',
                kind: 'user_action' as const,
                arguments: args,
                createdAt: 1,
            },
            createdAt: 1,
        }) as TranscriptRowShellItem;

        const small = signatureFor(request({ command: 'ls' }));
        const huge = signatureFor(request({ command: 'x'.repeat(200_000) }));

        expect(huge.structuralKey).toBe(small.structuralKey);
        expect(huge.structuralKey.length).toBeLessThan(200);
    });

    it('keys a fork divider and a window gap on their own identity', () => {
        const divider = signatureFor({
            kind: 'fork-divider',
            id: 'fork:1',
            parentSessionId: 'parent',
            childSessionId: 'child',
            parentCutoffSeqInclusive: 12,
        });
        const gap = signatureFor({
            kind: 'transcript-window-gap',
            id: 'gap:older',
            direction: 'older',
        });

        expect(divider.structuralKey).toContain('parent');
        expect(divider.rowState).toBe('stable');
        expect(gap.structuralKey).toContain('older');
        expect(gap.rowState).toBe('stable');
    });
});
