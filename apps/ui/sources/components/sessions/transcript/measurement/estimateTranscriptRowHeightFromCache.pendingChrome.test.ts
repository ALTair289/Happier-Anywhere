import { describe, expect, it } from 'vitest';

import type { DiscardedPendingMessage, PendingMessage } from '@/sync/domains/state/storageTypes';

import { estimateTranscriptRowHeightFromContent } from './estimateTranscriptRowHeightFromCache';
import type { TranscriptRowShellItem } from './transcriptRowShellSignature';

/** Measured on native (iOS simulator, rAF sampler on the mounted LegendList fiber, 2026-07-30). */
const MEASURED_ONE_SHORT_PENDING_MESSAGE_PX = 68.625;
/** `transcriptPendingQueueMaxHeightPx` account default: the block's own painted bound. */
const PENDING_QUEUE_SCROLL_CAP_PX = 80;
const PENDING_QUEUE_HEADER_PX = 14.625;
const PENDING_QUEUE_HEADER_WITH_SUBTITLE_PX = 31;

function pendingMessage(overrides: Partial<PendingMessage> = {}): PendingMessage {
    return {
        id: 'p1',
        localId: 'l1',
        createdAt: 1,
        updatedAt: 1,
        source: 'local_outbound',
        text: 'ok',
        rawRecord: null,
        ...overrides,
    } as PendingMessage;
}

function discardedMessage(overrides: Partial<DiscardedPendingMessage> = {}): DiscardedPendingMessage {
    return {
        ...pendingMessage({ id: 'd1', localId: 'ld1' }),
        discardedAt: 2,
        discardedReason: null,
        ...overrides,
    } as DiscardedPendingMessage;
}

function estimatePendingQueue(
    pendingMessages: PendingMessage[],
    discardedMessages: DiscardedPendingMessage[] = [],
): number | undefined {
    return estimateTranscriptRowHeightFromContent({
        toolCallsGroupChromeVariant: 'feed_background',
        getMessageById: () => null,
        item: {
            kind: 'pending-queue',
            id: 'pending-queue',
            pendingMessages,
            discardedMessages,
        } satisfies TranscriptRowShellItem,
    });
}

/**
 * J/D2 (2026-07-30). Legend places rows by ACCUMULATION, so this estimate is a POSITION: an
 * undershoot is a literal overlap and an overshoot a literal gap. The previous model summed a text
 * heuristic over every queued message — the height of the block's SCROLL CONTENT, not of the row —
 * so it undershot the one shape that was measured live and overshot everything else without bound.
 */
describe('pending-queue estimate is chrome-aware', () => {
    it('matches the measured painted height of a single short queued message', () => {
        expect(estimatePendingQueue([pendingMessage({ text: 'ok' })]))
            .toBeCloseTo(MEASURED_ONE_SHORT_PENDING_MESSAGE_PX, 1);
    });

    it('never exceeds the block header plus its own scroll cap, however long the queue is', () => {
        const bounded = PENDING_QUEUE_HEADER_PX + PENDING_QUEUE_SCROLL_CAP_PX;

        // One long message: the old model returned ~246px for a row that paints ~95px.
        expect(estimatePendingQueue([pendingMessage({ text: 'x'.repeat(600) })])).toBeCloseTo(bounded, 1);
        // Three long messages: the old model returned ~438px — a ~340px phantom gap at the tail.
        expect(estimatePendingQueue([
            pendingMessage({ id: 'p1', text: 'a'.repeat(300) }),
            pendingMessage({ id: 'p2', text: 'b'.repeat(300) }),
            pendingMessage({ id: 'p3', text: 'c'.repeat(300) }),
        ])).toBeCloseTo(bounded, 1);
    });

    it('grows monotonically with the queue up to that bound', () => {
        const one = estimatePendingQueue([pendingMessage()]) as number;
        const two = estimatePendingQueue([
            pendingMessage({ id: 'p1' }),
            pendingMessage({ id: 'p2' }),
        ]) as number;

        expect(two).toBeGreaterThan(one);
        expect(two).toBeLessThanOrEqual(PENDING_QUEUE_HEADER_PX + PENDING_QUEUE_SCROLL_CAP_PX);
    });

    it('sizes a message from the string the row renders (displayText)', () => {
        const displayed = estimatePendingQueue([pendingMessage({ text: 'hi', displayText: 'z'.repeat(600) })]) as number;
        const stored = estimatePendingQueue([pendingMessage({ text: 'hi' })]) as number;

        expect(displayed).toBeGreaterThan(stored);
    });

    it('accounts for the two-line header the block paints when queued and discarded rows coexist', () => {
        const both = estimatePendingQueue([pendingMessage()], [discardedMessage()]) as number;
        const discardedOnly = estimatePendingQueue([], [discardedMessage()]) as number;

        expect(both).toBeCloseTo(PENDING_QUEUE_HEADER_WITH_SUBTITLE_PX + PENDING_QUEUE_SCROLL_CAP_PX, 1);
        expect(discardedOnly).toBeCloseTo(PENDING_QUEUE_HEADER_PX + PENDING_QUEUE_SCROLL_CAP_PX, 1);
    });

    it('adds the terminal-draft notice, which the block paints OUTSIDE the capped scroll box', () => {
        const blocked = estimatePendingQueue([pendingMessage({
            source: 'server_pending',
            pendingDeliveryStatus: 'blocked',
            pendingDeliveryBlockedReason: 'terminal_composer_draft',
        })]) as number;

        expect(blocked).toBeGreaterThan(PENDING_QUEUE_HEADER_PX + PENDING_QUEUE_SCROLL_CAP_PX);
    });
});
