import { describe, expect, it } from 'vitest';

import {
    clampKeyboardAvoidanceValue,
    normalizeKeyboardEventHeight,
    normalizeReanimatedKeyboardHeight,
    resolveAvailablePanelHeight,
    resolveComposerBottomOffset,
    resolveComposerTranslateY,
    resolveListBottomInset,
} from './composerKeyboardGeometry';

describe('composer keyboard geometry', () => {
    it('normalizes RNKC event heights as positive keyboard heights', () => {
        expect(normalizeKeyboardEventHeight(320)).toBe(320);
        expect(normalizeKeyboardEventHeight(-320)).toBe(320);
        expect(normalizeKeyboardEventHeight(Number.NaN)).toBe(0);
    });

    it('normalizes RNKC reanimated heights as positive keyboard heights', () => {
        expect(normalizeReanimatedKeyboardHeight(-280)).toBe(280);
        expect(normalizeReanimatedKeyboardHeight(280)).toBe(280);
        expect(normalizeReanimatedKeyboardHeight(Number.POSITIVE_INFINITY)).toBe(0);
    });

    it('resolves positive event heights to upward composer translation', () => {
        expect(resolveComposerTranslateY({ keyboardHeight: normalizeKeyboardEventHeight(320) })).toBe(-320);
    });

    it('keeps combined event and reanimated keyboard heights from translating downward', () => {
        const eventHeight = normalizeKeyboardEventHeight(260);
        const reanimatedHeight = normalizeReanimatedKeyboardHeight(-300);

        expect(resolveComposerTranslateY({ keyboardHeight: Math.max(eventHeight, reanimatedHeight) })).toBeLessThanOrEqual(0);
    });

    it('uses the larger safe-area or keyboard height for the composer bottom offset', () => {
        expect(resolveComposerBottomOffset({ keyboardHeight: 0, safeAreaBottom: 34 })).toBe(34);
        expect(resolveComposerBottomOffset({ keyboardHeight: 280, safeAreaBottom: 34 })).toBe(280);
    });

    it('adds the full composer height to the keyboard-aware list inset', () => {
        expect(resolveListBottomInset({
            composerHeight: 144,
            keyboardHeightForInset: 260,
            safeAreaBottom: 34,
        })).toBe(404);
    });

    // REMOVED 2026-08-09 with `resolveInteractiveDismissInset` itself: the helper had ZERO
    // production consumers (only this file and the barrel export referenced it) while being a
    // THIRD written copy of the interactive-dismiss freeze rule, whose two live expressions are
    // `useComposerKeyboardLayout.native.ts` (the JS recompute and the UI-thread derived inset).
    // Its two tests were green against every mutation of the real rule, because they graded a
    // function no keyboard frame ever called.

    it('clamps to the available maximum when the requested minimum is larger', () => {
        expect(clampKeyboardAvoidanceValue({
            value: 220,
            min: 120,
            max: 80,
        })).toBe(80);
    });

    it('never resolves an available panel height larger than the visible region', () => {
        expect(resolveAvailablePanelHeight({
            viewportHeight: 640,
            headerHeight: 80,
            keyboardHeight: 360,
            safeAreaBottom: 34,
            reservedHeight: 40,
            preferredHeight: 680,
            minHeight: 220,
        })).toBe(160);
    });
});
