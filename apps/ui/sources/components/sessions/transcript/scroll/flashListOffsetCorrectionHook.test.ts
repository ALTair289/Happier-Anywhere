import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    FLASHLIST_OFFSET_CORRECTION_HOOK_GLOBAL_KEY,
    subscribeToFlashListOffsetCorrections,
    type FlashListOffsetCorrectionEvent,
} from './flashListOffsetCorrectionHook';

type GlobalHook = (event: unknown) => void;

function readGlobalHook(): GlobalHook | undefined {
    return (globalThis as Record<string, unknown>)[FLASHLIST_OFFSET_CORRECTION_HOOK_GLOBAL_KEY] as
        | GlobalHook
        | undefined;
}

const cleanups: Array<() => void> = [];

function subscribe(listener: (event: FlashListOffsetCorrectionEvent) => void): () => void {
    const unsubscribe = subscribeToFlashListOffsetCorrections(listener);
    cleanups.push(unsubscribe);
    return unsubscribe;
}

describe('flashListOffsetCorrectionHook', () => {
    afterEach(() => {
        while (cleanups.length > 0) cleanups.pop()?.();
        delete (globalThis as Record<string, unknown>)[FLASHLIST_OFFSET_CORRECTION_HOOK_GLOBAL_KEY];
    });

    it('installs the global hook on first subscribe and forwards sanitized corrector events', () => {
        const received: FlashListOffsetCorrectionEvent[] = [];
        subscribe((event) => received.push(event));

        const hook = readGlobalHook();
        expect(typeof hook).toBe('function');

        hook?.({ type: 'pause-set', source: 'scroll-to-index', timestampMs: 10 });
        hook?.({ type: 'correction-applied', diffPx: -312.25, timestampMs: 20 });
        hook?.({ type: 'correction-skipped-paused', diffPx: 44, timestampMs: 30 });
        hook?.({ type: 'pause-cleared', source: 'initial-scroll-index', timestampMs: 40 });

        expect(received).toEqual([
            { type: 'pause-set', source: 'scroll-to-index', timestampMs: 10 },
            { type: 'correction-applied', diffPx: -312.25, timestampMs: 20 },
            { type: 'correction-skipped-paused', diffPx: 44, timestampMs: 30 },
            { type: 'pause-cleared', source: 'initial-scroll-index', timestampMs: 40 },
        ]);
    });

    it('forwards the carve-pause skip event emitted by the CORRIDOR-2a vendor patch (REVIEW-2a F1)', () => {
        // The 2a patch reports corrections withheld while `happierPauseOffsetCorrection` is set.
        // Dropping this type in the sanitizer would blind the pause seam's only runtime signal.
        const received: FlashListOffsetCorrectionEvent[] = [];
        subscribe((event) => received.push(event));

        readGlobalHook()?.({ type: 'correction-skipped-happier-paused', diffPx: 18, timestampMs: 50 });

        expect(received).toEqual([
            { type: 'correction-skipped-happier-paused', diffPx: 18, timestampMs: 50 },
        ]);
    });

    it('is production-safe always-on: subscribing installs the hook with no dev gating', () => {
        // The prepend transaction's corrector-deference depends on this signal in production:
        // the API intentionally exposes no dev flag.
        subscribe(vi.fn());
        expect(typeof readGlobalHook()).toBe('function');
    });

    it('drops malformed vendor events instead of forwarding them', () => {
        const listener = vi.fn();
        subscribe(listener);
        const hook = readGlobalHook();

        hook?.(null);
        hook?.('correction-applied');
        hook?.({ type: 'made-up-action', diffPx: 4 });
        hook?.({ type: 'pause-set', source: 'free-form text' });
        hook?.({ type: 'correction-applied', diffPx: Number.NaN });

        // The two structurally valid events survive with invalid optional fields stripped.
        expect(listener.mock.calls.map(([event]) => event)).toEqual([
            { type: 'pause-set' },
            { type: 'correction-applied' },
        ]);
    });

    it('fans out to every subscriber and isolates listener exceptions per listener', () => {
        const first = vi.fn(() => {
            throw new Error('listener bug');
        });
        const second = vi.fn();
        subscribe(first);
        subscribe(second);

        expect(() => readGlobalHook()?.({ type: 'correction-applied', diffPx: 12 })).not.toThrow();
        expect(first).toHaveBeenCalledTimes(1);
        expect(second).toHaveBeenCalledTimes(1);
        expect(second).toHaveBeenCalledWith({ type: 'correction-applied', diffPx: 12 });
    });

    it('keeps the hook installed until the last subscriber unsubscribes, then releases the slot', () => {
        const firstListener = vi.fn();
        const secondListener = vi.fn();
        const first = subscribe(firstListener);
        const second = subscribe(secondListener);

        first();
        expect(typeof readGlobalHook()).toBe('function');
        readGlobalHook()?.({ type: 'pause-set' });
        expect(firstListener).not.toHaveBeenCalled();
        expect(secondListener).toHaveBeenCalledTimes(1);

        second();
        expect(readGlobalHook()).toBeUndefined();
    });

    it('treats unsubscribe as idempotent', () => {
        const listener = vi.fn();
        const unsubscribe = subscribe(listener);
        const other = subscribe(vi.fn());

        unsubscribe();
        unsubscribe();
        expect(typeof readGlobalHook()).toBe('function');

        other();
        expect(readGlobalHook()).toBeUndefined();
    });

    it('re-claims the global slot if another writer clobbered it', () => {
        const listener = vi.fn();
        subscribe(listener);
        (globalThis as Record<string, unknown>)[FLASHLIST_OFFSET_CORRECTION_HOOK_GLOBAL_KEY] = undefined;

        subscribe(vi.fn());
        expect(typeof readGlobalHook()).toBe('function');
        readGlobalHook()?.({ type: 'pause-set' });
        expect(listener).toHaveBeenCalledTimes(1);
    });
});
