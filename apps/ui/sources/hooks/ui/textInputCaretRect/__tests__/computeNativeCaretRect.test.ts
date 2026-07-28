import { describe, it, expect } from 'vitest';
import { computeNativeCaretRect } from '../useTextInputCaretRect.native';

const NO_SCROLL = { x: 0, y: 0 } as const;

describe('computeNativeCaretRect', () => {
    it('computes window-relative caret rect from input offset and selection coordinates', () => {
        const result = computeNativeCaretRect(
            { x: 100, y: 200 },
            { start: { x: 50, y: 10 }, end: { x: 50, y: 10 } },
            NO_SCROLL,
        );

        expect(result).toEqual({
            left: 150,
            top: 210,
            height: 16,
        });
    });

    it('computes height from selection span when start.y differs from end.y', () => {
        const result = computeNativeCaretRect(
            { x: 0, y: 0 },
            { start: { x: 10, y: 20 }, end: { x: 10, y: 50 } },
            NO_SCROLL,
        );

        expect(result).toEqual({
            left: 10,
            top: 20,
            height: 30,
        });
    });

    it('uses minimum height of 16 when selection start and end y are equal', () => {
        const result = computeNativeCaretRect(
            { x: 50, y: 100 },
            { start: { x: 0, y: 0 }, end: { x: 0, y: 0 } },
            NO_SCROLL,
        );

        expect(result.height).toBe(16);
    });

    it('uses minimum height of 16 when computed height is less than 16', () => {
        const result = computeNativeCaretRect(
            { x: 0, y: 0 },
            { start: { x: 0, y: 5 }, end: { x: 0, y: 10 } },
            NO_SCROLL,
        );

        expect(result.height).toBe(16);
    });

    it('uses actual height when selection span exceeds minimum', () => {
        const result = computeNativeCaretRect(
            { x: 0, y: 0 },
            { start: { x: 0, y: 0 }, end: { x: 0, y: 24 } },
            NO_SCROLL,
        );

        expect(result.height).toBe(24);
    });

    it('handles negative input offsets', () => {
        const result = computeNativeCaretRect(
            { x: -10, y: -20 },
            { start: { x: 30, y: 40 }, end: { x: 30, y: 40 } },
            NO_SCROLL,
        );

        expect(result).toEqual({
            left: 20,
            top: 20,
            height: 16,
        });
    });

    it('handles zero offsets', () => {
        const result = computeNativeCaretRect(
            { x: 0, y: 0 },
            { start: { x: 0, y: 0 }, end: { x: 0, y: 0 } },
            NO_SCROLL,
        );

        expect(result).toEqual({
            left: 0,
            top: 0,
            height: 16,
        });
    });

    it("subtracts the input's own scroll offset, because iOS reports the caret in content coordinates", () => {
        // The composer scrolls its own content once it is clamped at max height, and
        // UITextView.caretRect(for:) is content-relative. Without this term the anchor
        // sits too far DOWN by exactly the scroll amount — which is what put the
        // autocomplete menu on top of the line holding the trigger character.
        const result = computeNativeCaretRect(
            { x: 100, y: 200 },
            { start: { x: 50, y: 300 }, end: { x: 50, y: 322 } },
            { x: 0, y: 240 },
        );

        expect(result).toEqual({
            left: 150,
            top: 260,
            height: 22,
        });
    });

    it('subtracts horizontal scroll too, matching the web sibling', () => {
        const result = computeNativeCaretRect(
            { x: 10, y: 10 },
            { start: { x: 90, y: 0 }, end: { x: 90, y: 0 } },
            { x: 40, y: 0 },
        );

        expect(result.left).toBe(60);
        expect(result.top).toBe(10);
    });
});
