import { describe, expect, it } from 'vitest';

import { resolveWebTranscriptPrependRangeReservePx } from './webTranscriptPrependRangeReserve';

describe('resolveWebTranscriptPrependRangeReservePx', () => {
    it('reserves the missing scroll range while virtualized prepend measurement is below the captured baseline', () => {
        expect(resolveWebTranscriptPrependRangeReservePx({
            baselineScrollHeight: 1200,
            currentScrollHeight: 900,
            viewportHeight: 600,
        })).toBe(300);
    });

    it('does not reserve range once measurement catches up or grows past the baseline', () => {
        expect(resolveWebTranscriptPrependRangeReservePx({
            baselineScrollHeight: 1200,
            currentScrollHeight: 1200,
            viewportHeight: 600,
        })).toBe(0);
        expect(resolveWebTranscriptPrependRangeReservePx({
            baselineScrollHeight: 1200,
            currentScrollHeight: 1400,
            viewportHeight: 600,
        })).toBe(0);
    });

    it('reserves a shortfall up to the whole viewport, which is the most an anchor restore can consume', () => {
        expect(resolveWebTranscriptPrependRangeReservePx({
            baselineScrollHeight: 1500,
            currentScrollHeight: 900,
            viewportHeight: 600,
        })).toBe(600);
    });

    it('reserves nothing when the measured content collapsed more than a viewport below the baseline', () => {
        // A shrink larger than one viewport cannot be prepend measurement lag the restore could
        // use: it means the rows themselves went away (window reset, truncation, session swap).
        expect(resolveWebTranscriptPrependRangeReservePx({
            baselineScrollHeight: 1501,
            currentScrollHeight: 900,
            viewportHeight: 600,
        })).toBe(0);
        expect(resolveWebTranscriptPrependRangeReservePx({
            baselineScrollHeight: 16192,
            currentScrollHeight: 3896,
            viewportHeight: 772,
        })).toBe(0);
    });

    it('never reserves the captured phantom tail range', () => {
        // Live capture: an 18620px baseline against 3896px of measured rows would otherwise
        // render a 14724px empty spacer under the transcript.
        expect(resolveWebTranscriptPrependRangeReservePx({
            baselineScrollHeight: 18620,
            currentScrollHeight: 3896,
            viewportHeight: 772,
        })).toBe(0);
    });

    it('reserves nothing when the viewport is unknown, so the reserve can never be unbounded', () => {
        expect(resolveWebTranscriptPrependRangeReservePx({
            baselineScrollHeight: 1200,
            currentScrollHeight: 900,
            viewportHeight: 0,
        })).toBe(0);
        expect(resolveWebTranscriptPrependRangeReservePx({
            baselineScrollHeight: 1200,
            currentScrollHeight: 900,
            viewportHeight: Number.NaN,
        })).toBe(0);
    });

    it('ignores sub-pixel and invalid measurements', () => {
        expect(resolveWebTranscriptPrependRangeReservePx({
            baselineScrollHeight: 1200.8,
            currentScrollHeight: 1200.1,
            viewportHeight: 600,
        })).toBe(0);
        expect(resolveWebTranscriptPrependRangeReservePx({
            baselineScrollHeight: Number.NaN,
            currentScrollHeight: 900,
            viewportHeight: 600,
        })).toBe(0);
        expect(resolveWebTranscriptPrependRangeReservePx({
            baselineScrollHeight: 1200,
            currentScrollHeight: Number.POSITIVE_INFINITY,
            viewportHeight: 600,
        })).toBe(0);
    });
});
