import { describe, expect, it } from 'vitest';

import {
    createEntryPresentationKey,
    createEntryPresentationState,
    reduceEntryPresentationState,
} from './entryPresentation';

describe('entry presentation join', () => {
    it('reveals a started placement on the entry owner confirming the restore landed', () => {
        const pending = createEntryPresentationState(createEntryPresentationKey({
            platform: 'native',
            sessionId: 'session-a',
        }));
        const rendererStarted = reduceEntryPresentationState(pending, { type: 'renderer-started' });
        const ownerConfirmed = reduceEntryPresentationState(rendererStarted, { type: 'entry-confirmed' });

        expect(rendererStarted.released).toBe(false);
        // `entry-confirmed` is the owner's OBSERVED alignment with the restore target, so the
        // frame is already at the anchor. Waiting for the renderer's own finish after that adds
        // no correctness and, when the renderer never emits one, leaves the reader behind the
        // first-paint placeholder until its deadline (live web repro, 2026-07-29).
        expect(ownerConfirmed.released).toBe(true);
        expect(reduceEntryPresentationState(ownerConfirmed, { type: 'renderer-settled' }).released).toBe(true);
    });

    it('ignores a stale finish and waits for the app owner after renderer fallback', () => {
        const pending = createEntryPresentationState(createEntryPresentationKey({
            platform: 'web',
            sessionId: 'session-a',
        }));
        expect(reduceEntryPresentationState(pending, { type: 'renderer-settled' })).toEqual(pending);

        const rendererStarted = reduceEntryPresentationState(pending, { type: 'renderer-started' });
        const rendererFallback = reduceEntryPresentationState(rendererStarted, { type: 'renderer-fallback' });
        expect(rendererFallback.released).toBe(false);
        expect(reduceEntryPresentationState(rendererFallback, { type: 'entry-fallback' }).released).toBe(true);
    });

    it('waits for renderer terminal settlement after the app owner falls back from a started placement', () => {
        const pending = createEntryPresentationState(createEntryPresentationKey({
            platform: 'web',
            sessionId: 'session-a',
        }));
        const rendererStarted = reduceEntryPresentationState(pending, { type: 'renderer-started' });
        const ownerFallback = reduceEntryPresentationState(rendererStarted, { type: 'entry-fallback' });

        expect(ownerFallback.released).toBe(false);
        expect(reduceEntryPresentationState(ownerFallback, { type: 'renderer-settled' }).released).toBe(true);
    });

    it('fails open when the terminal entry never needed a renderer placement', () => {
        const pending = createEntryPresentationState(createEntryPresentationKey({
            platform: 'native',
            sessionId: 'session-a',
        }));

        expect(reduceEntryPresentationState(pending, { type: 'entry-confirmed' }).released).toBe(true);
        expect(reduceEntryPresentationState(pending, { type: 'entry-fallback' }).released).toBe(true);
    });
});
