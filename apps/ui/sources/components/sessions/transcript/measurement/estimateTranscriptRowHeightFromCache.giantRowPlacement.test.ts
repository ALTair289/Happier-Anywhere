import { describe, expect, it } from 'vitest';

import type { Message } from '@/sync/domains/messages/messageTypes';

import { estimateTranscriptRowHeightFromContent } from './estimateTranscriptRowHeightFromCache';
import type { TranscriptRowShellItem } from './transcriptRowShellSignature';

/**
 * C-1 — a size estimate is a POSITION, so it may not carry a ceiling.
 *
 * Live web capture 2026-07-28, session `cmrxjkh2v0vintmk4445ywy9s`, measured while the defect was
 * on screen (a "Turn Diff" row painted ON TOP OF the message above it):
 *
 * ```
 * row A  transcript-item-msg:8y606ubqcvm  top =  2285   height = 21849 (DOM height matches)
 * row B  transcript-item-msg:xocdt74v8li  top = 22285   height =    50 (DOM height matches)
 * container innerH = 22341 | scrollHeight = 24146 | tail after the last row = 1811px
 * ```
 *
 * Both boxes matched their DOM heights exactly, so every HEIGHT was right and only B's POSITION
 * was wrong. The arithmetic names the owner: `B.top 22285 = A.top 2285 + 20000`, while A's real
 * height is 21849, and `21849 - 20000 = 1849` is exactly the measured overlap. 20000 is this
 * module's own `ESTIMATE_MAX_ROW_PX`.
 *
 * The module doc for the tool-group constants already states the principle for the OVER-estimate
 * direction: "Legend places rows by ACCUMULATION, so an estimate that overshoots a row's painted
 * height is not a harmless margin — it is a literal gap under that row." This is that sentence
 * inverted. An estimate that UNDERSHOOTS is a literal OVERLAP, and a ceiling guarantees undershoot
 * for every row taller than it. A 21,849px markdown message is legitimate content, so the ceiling
 * cannot be defended as a guard against absurd input — the layout has to accommodate the real height.
 */
describe('C-1 · a giant row must position its successor at its TRUE bottom', () => {
    /** Row A's real painted height, from the capture above. */
    const MEASURED_ROW_A_PX = 21_849;
    /** Row A's real top, from the capture above. */
    const ROW_A_TOP_PX = 2_285;
    /** Row B's real painted height, from the capture above. */
    const MEASURED_ROW_B_PX = 50;
    /** Where row B actually landed — inside row A. */
    const CAPTURED_ROW_B_TOP_PX = 22_285;
    /** The ceiling this owner applied, and the whole of the defect. */
    const CAPTURED_CEILING_PX = 20_000;

    /**
     * The estimator's own text flow is 72 chars per wrapped line at 22px plus a 32px base, so 992
     * lines model a message whose estimate lands within 7px of row A's real 21,849px. The content
     * model already knew this row's height; the ceiling is what threw that knowledge away.
     */
    const GIANT_MARKDOWN_LINES = 992;
    const GIANT_MARKDOWN_CHARS = 72 * GIANT_MARKDOWN_LINES;
    const UNCEILED_ROW_A_ESTIMATE_PX = 32 + (GIANT_MARKDOWN_LINES * 22);

    function agentText(id: string, text: string): Message {
        return {
            kind: 'agent-text',
            id,
            localId: null,
            createdAt: 1,
            text,
        } as Message;
    }

    function estimateMessageRowPx(text: string): number {
        const estimate = estimateTranscriptRowHeightFromContent({
            toolCallsGroupChromeVariant: 'feed_background',
            getMessageById: () => agentText('m1', text),
            item: { kind: 'message', id: 'i1', messageId: 'm1' } as TranscriptRowShellItem,
        });
        expect(estimate).toBeDefined();
        return estimate as number;
    }

    it('estimates the 21,849px markdown row from its content, not from a ceiling', () => {
        const estimate = estimateMessageRowPx('x'.repeat(GIANT_MARKDOWN_CHARS));
        expect(estimate).not.toBe(CAPTURED_CEILING_PX);
        expect(estimate).toBe(UNCEILED_ROW_A_ESTIMATE_PX);
        // Within a wrapped line of the row's real painted height.
        expect(Math.abs(estimate - MEASURED_ROW_A_PX)).toBeLessThanOrEqual(22);
    });

    it('places the next row at or below the giant row\'s real bottom', () => {
        // Legend accumulates: `positions[i + 1] = positions[i] + size_i`, and `size_i` is what this
        // owner hands `getEstimatedItemSize` for a row it has not measured yet.
        const rowAEstimatePx = estimateMessageRowPx('x'.repeat(GIANT_MARKDOWN_CHARS));
        const rowBTopPx = ROW_A_TOP_PX + rowAEstimatePx;
        const rowABottomPx = ROW_A_TOP_PX + MEASURED_ROW_A_PX;
        // Negative is overlap. The capture measured -1849; a healthy transcript is >= 0.
        const gapPx = rowBTopPx - rowABottomPx;

        expect(rowBTopPx).not.toBe(CAPTURED_ROW_B_TOP_PX);
        expect(gapPx).toBeGreaterThanOrEqual(0);
        // ...and the accommodation is a wrapped line, not a second phantom: the 1811px tail in the
        // capture was this same 1849px error re-surfacing below the last row.
        expect(gapPx).toBeLessThanOrEqual(22);
        expect(rowBTopPx + MEASURED_ROW_B_PX).toBeGreaterThan(rowABottomPx);
    });

    it('keeps the estimate monotone in content past the old ceiling', () => {
        // A ceiling collapses every giant row onto one value, so the estimate carries no
        // information exactly where its error is largest. Two rows that differ by ~400 wrapped
        // lines must not be handed the renderer as the same position-bearing size.
        const tallerLines = GIANT_MARKDOWN_LINES + 400;
        const taller = estimateMessageRowPx('x'.repeat(72 * tallerLines));
        const giant = estimateMessageRowPx('x'.repeat(GIANT_MARKDOWN_CHARS));
        expect(taller).toBeGreaterThan(giant);
        expect(taller).toBe(32 + (tallerLines * 22));
    });

    it('does not ceiling an expanded tool group past 20,000px either', () => {
        // The same accumulation applies to the other unbounded shape: an EXPANDED group renders one
        // row per tool, so a group past ~713 tools crossed the ceiling and under-placed its successor.
        const toolCount = 1_200;
        const estimate = estimateTranscriptRowHeightFromContent({
            toolCallsGroupChromeVariant: 'feed_background',
            getMessageById: () => null,
            item: {
                kind: 'tool-calls-group',
                id: 'g1',
                toolMessageIds: Array.from({ length: toolCount }, (_value, index) => `t${index}`),
                createdAt: 1,
            } as TranscriptRowShellItem,
            toolGroupLayout: { collapsedPreviewCount: 3, isExpanded: () => true },
        });
        // header 33 + one 28px row per tool + footer 34.
        expect(estimate).toBe(33 + (toolCount * 28) + 34);
        expect(estimate).toBeGreaterThan(CAPTURED_CEILING_PX);
    });
});
