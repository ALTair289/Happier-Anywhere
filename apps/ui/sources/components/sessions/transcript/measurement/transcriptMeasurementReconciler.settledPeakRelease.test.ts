import { describe, expect, it } from 'vitest';

import { estimateTranscriptRowHeightFromCache } from './estimateTranscriptRowHeightFromCache';
import { resolveTranscriptRowShellHeight } from './resolveTranscriptRowShellHeight';
import type { TranscriptItemHeightValiditySignature } from './transcriptItemHeightCache';
import {
    createTestTranscriptMeasurementReconciler,
    isStructuralSignatureDelta,
} from './transcriptMeasurementReconciler';

/**
 * W17 — a settled row must reserve (and predict) its REAL measured height, never the peak it
 * reached while it was growing.
 *
 * Live web capture 2026-07-28, session `cmrdwwsd60bg0tmo6n0k6zq79` (still streaming) against the
 * settled control `cmrzcw5hk0y23tmj29kmx6x13`: every inter-row delta grouped by boundary kind was 0
 * in the control and 0 for `toolCalls->msg` / `toolCalls->toolCalls` in the live session, while
 * `msg->toolCalls` measured [42, 24, 48]px of blank band. Every row's box height equalled its DOM
 * height, so the heights were right and only the SIZE the renderer accumulated for the message above
 * was too large — by three different per-message amounts, i.e. per-row overshoot, not spacing.
 *
 * Mechanism (all three legs verified in source):
 *  1. `resolveMessageRowState` is the only producer of the growing states, and it can only return
 *     them for a MESSAGE row: a `tool-call` message is pinned to 'tool-progress' and every
 *     tool-group unit row is hardcoded 'stable'. No tool row can ever hold a growing peak — which is
 *     why `toolCalls->*` measured 0.
 *  2. `streaming` is `sessionActive && isLatestCommittedActivity`, and
 *     `resolveLatestCommittedActivityKey` is simply the LAST committed message. So the arrival of a
 *     tool call after an assistant message is the event that flips that message out of the growing
 *     set — at an UNCHANGED `structuralKey`, because the message itself was not rewritten. The
 *     boundary kind is therefore incidental: the message is the row that streamed, and the tool
 *     group is both what follows it and what de-classified it.
 *  3. The reconciler carried the growing peak forward and re-labelled it with the CURRENT
 *     `structuralKey`, so at the instant of the flip the stale peak looked like a same-shape
 *     measurement and was served to both consumers — as a forcing `minHeight` on a fresh mount
 *     (self-fulfilling: the row then measures the peak and writes it into the exact cache) and as
 *     the virtualization estimate (Legend places by accumulation, so an oversized estimate is a
 *     literal gap under the row).
 *
 * The numbers below are the on-screen case the user pointed at: 48px after `msg:isv1earckyq`.
 */
const STREAM_PEAK_PX = 500;
const SETTLED_HEIGHT_PX = 452;

function messageSignature(
    overrides: Partial<TranscriptItemHeightValiditySignature> = {},
): TranscriptItemHeightValiditySignature {
    return {
        itemId: 'msg:isv1earckyq',
        kind: 'message:agent',
        structuralKey: 'msg:isv1earckyq:r7',
        widthBucket: 'width:800',
        fontScaleKey: 'font:1',
        groupingMode: 'turn',
        forkContextKey: 'root',
        expansionKey: 'tools:none|thinking:none',
        rowState: 'streaming',
        ...overrides,
    };
}

describe('W17 · a settled row releases the height peak it reached while growing', () => {
    it('does not reserve or predict the stream peak once a tool call flips the message to stable', () => {
        const reconciler = createTestTranscriptMeasurementReconciler();

        // The message streams. Its tallest frame is the peak the floor exists to hold.
        reconciler.recordMeasuredHeight({
            signature: messageSignature({ structuralKey: 'msg:isv1earckyq:r7' }),
            heightPx: STREAM_PEAK_PX,
        });
        // Its final streamed revision paints 48px shorter (the capture's measured overshoot).
        reconciler.recordMeasuredHeight({
            signature: messageSignature({ structuralKey: 'msg:isv1earckyq:r8' }),
            heightPx: SETTLED_HEIGHT_PX,
        });

        // A tool call is committed after it, so it stops being the latest committed activity: the
        // rowState flips streaming -> stable at the SAME structuralKey (the message was not rewritten).
        const settled = messageSignature({ structuralKey: 'msg:isv1earckyq:r8', rowState: 'stable' });

        // A reservation is a forcing, self-fulfilling `minHeight`. A height measured mid-stream is
        // not a settled row's height, so nothing may be forced here — the row measures naturally.
        expect(reconciler.resolveReservation(settled)).toBeUndefined();
        // A fresh mount (Legend recycled the cell) has no previous signature to diff, so the shell's
        // own release cannot run: this is the path that made the overshoot permanent.
        expect(resolveTranscriptRowShellHeight({ reconciler, signature: settled })).toBeUndefined();

        // The virtualization estimate is the row's own last REAL measurement, never the peak.
        expect(estimateTranscriptRowHeightFromCache({ reconciler, signature: settled }))
            .toBe(SETTLED_HEIGHT_PX);
        expect(reconciler.resolveLastMeasuredHeight(settled)).toBe(SETTLED_HEIGHT_PX);
    });

    it('re-seeds the reservation from the settled row\'s own layout', () => {
        const reconciler = createTestTranscriptMeasurementReconciler();
        const streaming = messageSignature({ structuralKey: 'msg:isv1earckyq:r8' });
        reconciler.recordMeasuredHeight({ signature: streaming, heightPx: STREAM_PEAK_PX });

        const settled = messageSignature({ structuralKey: 'msg:isv1earckyq:r8', rowState: 'stable' });
        // The mounted-row path: the shell releases on the rowState delta, then onLayout records.
        expect(isStructuralSignatureDelta(streaming, settled)).toBe(true);
        reconciler.resetReservationForStructuralChange({ itemId: settled.itemId, signature: settled });
        reconciler.recordMeasuredHeight({ signature: settled, heightPx: SETTLED_HEIGHT_PX });

        expect(reconciler.resolveReservation(settled)).toEqual({ kind: 'exact', minHeight: SETTLED_HEIGHT_PX });
        expect(estimateTranscriptRowHeightFromCache({ reconciler, signature: settled })).toBe(SETTLED_HEIGHT_PX);
    });

    it('releases a thinking peak that was carried into a different presentation, growing or settled', () => {
        // `thinking` is in the growing set because `resolveMessageRowState` returns it BEFORE any
        // streaming branch. When `activeThinkingMessageId` moves on, the SAME row re-renders as
        // `message:agent` — still growing if it is the latest activity, settled once it is not.
        // Neither presentation may inherit the thinking block's peak.
        const reconciler = createTestTranscriptMeasurementReconciler();
        const thinking = messageSignature({
            itemId: 'msg:thinking-1',
            kind: 'message:thinking',
            rowState: 'thinking',
            structuralKey: 'msg:thinking-1:r7',
        });
        reconciler.recordMeasuredHeight({ signature: thinking, heightPx: 612 });
        reconciler.recordMeasuredHeight({
            signature: { ...thinking, structuralKey: 'msg:thinking-1:r8' },
            heightPx: 96,
        });

        const stillGrowing = messageSignature({
            itemId: 'msg:thinking-1',
            kind: 'message:agent',
            rowState: 'streaming',
            structuralKey: 'msg:thinking-1:r8',
        });
        const settled = messageSignature({
            itemId: 'msg:thinking-1',
            kind: 'message:agent',
            rowState: 'stable',
            structuralKey: 'msg:thinking-1:r8',
        });

        expect(reconciler.resolveReservation(stillGrowing)).toBeUndefined();
        expect(reconciler.resolveReservation(settled)).toBeUndefined();
        expect(estimateTranscriptRowHeightFromCache({ reconciler, signature: settled })).toBe(96);
    });

    it('NEGATIVE: keeps the monotonic peak while the row is still growing (no mid-stream shrink jitter)', () => {
        const reconciler = createTestTranscriptMeasurementReconciler();
        reconciler.recordMeasuredHeight({
            signature: messageSignature({ structuralKey: 'msg:isv1earckyq:r7' }),
            heightPx: STREAM_PEAK_PX,
        });
        // A mid-stream frame that measures short must not drop the reservation below the peak.
        reconciler.recordMeasuredHeight({
            signature: messageSignature({ structuralKey: 'msg:isv1earckyq:r8' }),
            heightPx: SETTLED_HEIGHT_PX,
        });

        expect(reconciler.resolveReservation(messageSignature({ structuralKey: 'msg:isv1earckyq:r8' })))
            .toEqual({ kind: 'floor', minHeight: STREAM_PEAK_PX });
        expect(reconciler.resolveReservation(messageSignature({ structuralKey: 'msg:isv1earckyq:r9' })))
            .toEqual({ kind: 'floor', minHeight: STREAM_PEAK_PX });
    });
});
