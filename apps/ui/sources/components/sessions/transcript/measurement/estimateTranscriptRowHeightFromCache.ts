import type { Message } from '@/sync/domains/messages/messageTypes';

import type { TranscriptItemHeightValiditySignature } from './transcriptItemHeightCache';
import {
    TRANSCRIPT_GROWING_ROW_STATES,
    type TranscriptMeasurementReconciler,
} from './transcriptMeasurementReconciler';
import { collectMessageIdsFromTurn, type TranscriptRowShellItem } from './transcriptRowShellSignature';

/**
 * Size ESTIMATE served to the list renderer's virtualization layer for rows it has
 * not yet measured (Legend `getEstimatedItemSize`, vendored @legendapp/list 3.3.3
 * patch): the app's own measured-height cache is the best predictor of a row's real
 * height — a prior EXACT measurement beats Legend's per-type average learning,
 * which is biased toward whichever rows rendered first (LegendApp/legend-list#492;
 * live scrollHeight-oscillation captures 2026-07-22/23: switch-back/reopen jiggle).
 * Unknown rows fall through (undefined) to Legend's per-type average / scalar estimate.
 *
 * A GROWING row's floor (`streaming`, `thinking`) is NOT a size: the reconciler
 * deliberately carries that floor across content shapes, so it is a lower bound on a
 * row whose content is still arriving, and the content estimate below tracks the live
 * text better. Every other row state is shrink-capable, and for those this estimate is
 * the row's own last measurement at this width/font — a real measurement, not a
 * prediction. It cannot come from the exact-height cache alone, because that cache is
 * stable-only and a row that never reaches `stable` (every `pending-action` row:
 * `pending-queue`, `pending-user-action`, `action-draft`, and every `tool-progress`
 * row) structurally cannot enter it.
 *
 * W-1: an estimate and a reservation are OPPOSITE contracts over that same measurement
 * and must not be read through one call. A reservation is a forcing, self-fulfilling
 * `minHeight` style, so it is released the instant a shrink-capable row's shape moves
 * (`isFloorShapeValid`) — otherwise a shrunk row strands blank space. An estimate is
 * discarded by that row's very next onLayout, so releasing it buys nothing and costs
 * everything: `ChatListInternal` wires the vendored Legend `getItemSizeVersion` to the
 * full signature key, so an OFFSCREEN row whose shape moves has its measured size
 * deleted and is re-sized from this estimate. Returning `undefined` there sent already
 * scrolled-past rows to the flat content heuristic below (a settled tool row: real
 * ~420px, heuristic 56px), collapsing the content above the viewport and pulling the
 * user's scroll position backwards. `resolveLastMeasuredHeight` is therefore read for
 * exactly the case the reservation refuses.
 */
export function estimateTranscriptRowHeightFromCache(params: Readonly<{
    reconciler: TranscriptMeasurementReconciler;
    signature: TranscriptItemHeightValiditySignature;
}>): number | undefined {
    const reservation = params.reconciler.resolveReservation(params.signature);
    if (reservation?.kind === 'exact') return reservation.minHeight;
    // Consume the reconciler's set rather than re-listing the growing states here: it is the
    // single owner of that decision (`isFloorShapeValid` reads the same set), so a future state
    // cannot silently diverge between the reservation producer and this estimate consumer.
    if (TRANSCRIPT_GROWING_ROW_STATES.has(params.signature.rowState)) return undefined;
    if (reservation) return reservation.minHeight;
    return params.reconciler.resolveLastMeasuredHeight(params.signature);
}

// Conservative text-flow constants for rows never measured in this app run. Estimates
// only need to shrink first-visit error (a flat 240px scalar undercounted a real
// transcript by 53% in the live reopen capture 2026-07-23); measurement replaces them
// the moment a row mounts.
const ESTIMATE_ROW_BASE_PX = 32;
const ESTIMATE_LINE_HEIGHT_PX = 22;
const ESTIMATE_CHARS_PER_LINE = 72;
const ESTIMATE_COMPACT_ROW_PX = 56;
const ESTIMATE_MAX_ROW_PX = 20_000;

function estimateTextBlockPx(text: string): number {
    let newlines = 0;
    for (let i = 0; i < text.length; i += 1) {
        if (text.charCodeAt(i) === 10) newlines += 1;
    }
    const lines = Math.max(1, newlines + Math.ceil(text.length / ESTIMATE_CHARS_PER_LINE));
    return ESTIMATE_ROW_BASE_PX + lines * ESTIMATE_LINE_HEIGHT_PX;
}

function estimateMessagePx(message: Message | null): number {
    if (!message) return ESTIMATE_COMPACT_ROW_PX;
    if (message.kind === 'user-text' || message.kind === 'agent-text') {
        return estimateTextBlockPx(message.text);
    }
    return ESTIMATE_COMPACT_ROW_PX;
}

/**
 * Content-aware size estimate for rows with no prior measurement: text-bearing rows
 * scale with their real text length instead of a flat scalar, so a giant markdown
 * turn no longer collapses the renderer's content model to a fraction of its true
 * height (the estimate-vs-measured relayout oscillation on reopen/switch-back).
 * Non-text and unknown item shapes fall through to the renderer's own estimate.
 */
export function estimateTranscriptRowHeightFromContent(params: Readonly<{
    getMessageById: (messageId: string) => Message | null;
    item: TranscriptRowShellItem;
}>): number | undefined {
    const { item } = params;
    if (item.kind === 'message') {
        return Math.min(ESTIMATE_MAX_ROW_PX, estimateMessagePx(params.getMessageById(item.messageId)));
    }
    if (item.kind === 'turn') {
        let total = 0;
        for (const messageId of collectMessageIdsFromTurn(item.turn)) {
            total += estimateMessagePx(params.getMessageById(messageId));
        }
        return Math.min(ESTIMATE_MAX_ROW_PX, Math.max(ESTIMATE_COMPACT_ROW_PX, total));
    }
    if (item.kind === 'tool-calls-group') {
        // A collapsed tool group renders one compact row PER tool: a 30-tool group is
        // ~1.7k px, and estimating it flat was the residual ±1.9k px landing error in
        // the live reopen re-test (2026-07-23).
        return Math.min(
            ESTIMATE_MAX_ROW_PX,
            Math.max(ESTIMATE_COMPACT_ROW_PX, item.toolMessageIds.length * ESTIMATE_COMPACT_ROW_PX),
        );
    }
    if (item.kind === 'pending-queue') {
        // The row a SEND creates. It renders one text block per queued and per discarded message,
        // reading `displayText ?? text` (`PendingMessagesTranscriptBlock.tsx:46`) — estimate from
        // the SAME string the row renders, or a message with a distinct display form is mis-sized.
        // Iterate both arrays directly: `getEstimatedItemSize` runs per row per render, so the
        // concatenated copy would be a per-row allocation in a hot path.
        let total = 0;
        for (const pendingMessage of item.pendingMessages) {
            total += estimateTextBlockPx(pendingMessage.displayText ?? pendingMessage.text);
        }
        for (const discardedMessage of item.discardedMessages) {
            total += estimateTextBlockPx(discardedMessage.displayText ?? discardedMessage.text);
        }
        return Math.min(ESTIMATE_MAX_ROW_PX, Math.max(ESTIMATE_COMPACT_ROW_PX, total));
    }
    if (
        item.kind === 'tool-group-header'
        || item.kind === 'tool-group-expand'
        || item.kind === 'tool-group-tool'
        || item.kind === 'tool-group-footer'
        || item.kind === 'pending-user-action'
        || item.kind === 'action-draft'
        || item.kind === 'fork-divider'
    ) {
        return ESTIMATE_COMPACT_ROW_PX;
    }
    return undefined;
}
