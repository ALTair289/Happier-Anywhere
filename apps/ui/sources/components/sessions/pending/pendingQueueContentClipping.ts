/**
 * Does the transcript's pending block CLIP the messages it paints?
 *
 * The block has two clippers — a compact `maxHeight` on its scroll box
 * (`transcriptPendingQueueMaxHeightPx`, account default 80) and a per-message line clamp
 * (`transcriptPendingMessageCollapseThresholdChars` / `…CollapsedLines`, default 160 chars → 2
 * lines). Both exist for the same reason: a queued BACKLOG must not eat the transcript it sits at
 * the tail of. Neither is a property of an individual utterance, and the committed bubble that
 * replaces a queued utterance has neither.
 *
 * SEND CROSSOVER (measured, native, 2026-08-01 —
 * `.project/reviews/2026-08-01-send-transition/M-send-transition.md` §6, 11 real sends). A send
 * into an empty queue produces a block holding exactly one message: the utterance that is about to
 * be replaced by its own committed row. Clipping it made that handover a height jump of +16px
 * (105-char message: 94.25 → 110) up to **+136px** (258-char message: 94.25 → 230), at the exact
 * frame Legend re-anchors on an unmeasured row. One utterance is not a queue, so it is not clipped
 * and the two rows paint at the same height.
 *
 * This is the SINGLE owner of that decision. Two paths consume it and must not diverge:
 * `PendingMessagesTranscriptBlock` (what is painted) and `estimateTranscriptRowHeightFromCache`
 * (what Legend is told the unmeasured row is worth). Legend places rows by accumulation, so a
 * disagreement between them is a literal gap or overlap under the tail — the same class of error
 * this removes.
 *
 * A lone discarded row is NOT the crossover: it is a tombstone with no committed twin arriving, so
 * it keeps the compact queue presentation.
 */
export function shouldClipPendingQueueContent(params: Readonly<{
    pendingCount: number;
    discardedCount: number;
}>): boolean {
    return !(params.pendingCount === 1 && params.discardedCount === 0);
}
