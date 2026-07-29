/**
 * Single presentation-policy owner for the transcript first-paint placeholder.
 *
 * The placeholder is a genuine loading state (UD-3): it covers only content that is not yet
 * presentable, it clears at the earliest presentable frame, and every fact that can hold it has a
 * terminal path. Concealing later movement is explicitly not its purpose, so no producer
 * settlement join (Mermaid/Pierre/held-scroll) participates here.
 *
 * Rules encoded below, in evaluation order:
 * - a loaded, empty transcript is terminal — it shows its empty state, never a placeholder;
 * - the single bounded deadline reveals with a named fallback outcome; it never claims the paint
 *   or placement it was waiting for actually happened;
 * - an entry whose painted rows this policy already revealed is never covered again. Covering a
 *   first paint is a loading state; covering rows the reader is already looking at is a blink,
 *   which is the defect the placeholder exists to prevent. That record only latches from an
 *   uncovered frame, so it answers the SWR shape where the data lands after the rows painted;
 * - painted rows outrank every fact that cannot show the reader something WRONG. A cover may
 *   only sit above them when revealing would present content at a position the reader never
 *   asked for (a keyed anchor restore, a native paint-at-A -> restore-at-B write) or with its
 *   text not yet renderable (the web Markdown runtime renders its raw fallback hidden). Waiting
 *   for a landing that only refines an already-correct position is holding presentable content
 *   to conceal later movement, which is exactly what this placeholder is not for;
 * - the web bottom-entry landing therefore covers only the pre-paint window. Legend paints the
 *   tail entry from `finishInitialScroll`, so the entry's own first paint is already at the
 *   position the landing refines; its remaining write is a settle, not a placement, and its
 *   affirmative terminal is a renderer confirmation the renderer cannot always produce;
 * - rows that already painted stay visible while their session refreshes (cached/SWR content is
 *   never re-covered by route hydration).
 *
 * `firstListPaintObserved` is the web Legend renderer's `onLoad`, and on that renderer it is a
 * PAINT fact, not a settle fact: @legendapp/list 3.3.3 emits `onLoad` from the same block that
 * flips `readyToRender`, and its row container is styled `opacity: readyToRender ? 1 : 0`
 * (`react-native.web.mjs`, `setInitialRenderState` / `ContainersInner`). Mounted rows are
 * therefore invisible until it fires, so DOM row presence is not evidence the reader can see
 * anything and must never be substituted for this fact - that would uncover a transparent list.
 * `paint/legendWebRowVisibility.real.integration.test.tsx` pins both directions of that coupling.
 */

export type TranscriptFirstPaintCoverReason =
    | 'entry-placement'
    | 'first-list-paint'
    | 'markdown-runtime'
    | 'native-placement'
    | 'route-hydration';

export type TranscriptFirstPaintRevealOutcome =
    | 'content-presentable'
    | 'deadline-fallback'
    | 'loaded-empty';

export type TranscriptFirstPaintPresentation =
    | Readonly<{ covered: true; reason: TranscriptFirstPaintCoverReason }>
    | Readonly<{ covered: false; outcome: TranscriptFirstPaintRevealOutcome }>;

/**
 * Owner-local terminal facts. Each one is produced by the owner that can also end it:
 * data availability (`isLoaded`/`itemCount`/`routeHydrationPending`), first list paint,
 * the Markdown runtime (ready or failed both end it), keyed placement, native placement,
 * the web bottom-entry landing.
 *
 * `paintedContentRevealed` is the one fact this policy produces itself: the consumer records,
 * per session entry, that a committed frame revealed painted rows. It adds no new owner and no
 * new lifecycle — it is this policy's own history, scoped to the entry the facts describe.
 *
 * `entryPlacementPending` (keyed entry join) and `initialPlacementPending` (web bottom-entry
 * landing) are two placements by two owners with different readiness, and they are mutually
 * exclusive by construction at the consumer. They share one cover reason because the reader
 * cannot tell them apart; only their terminals differ.
 */
export type TranscriptFirstPaintFacts = Readonly<{
    deadlineElapsed: boolean;
    entryPlacementPending: boolean;
    firstListPaintObserved: boolean;
    firstListPaintPending: boolean;
    initialPlacementPending: boolean;
    isLoaded: boolean;
    itemCount: number;
    markdownRuntimePending: boolean;
    nativePlacementPending: boolean;
    paintedContentRevealed: boolean;
    routeHydrationPending: boolean;
}>;

export function resolveTranscriptFirstPaintPresentation(
    facts: TranscriptFirstPaintFacts,
): TranscriptFirstPaintPresentation {
    if (facts.isLoaded && facts.itemCount <= 0) {
        return { covered: false, outcome: 'loaded-empty' };
    }
    if (facts.deadlineElapsed) {
        return { covered: false, outcome: 'deadline-fallback' };
    }
    // Evaluated ahead of every cover fact: once this entry has shown painted rows, no later
    // pending fact may take the screen back. Both rules above it are reveals too, so nothing
    // here can turn a revealed transcript covered again.
    if (facts.paintedContentRevealed) {
        return { covered: false, outcome: 'content-presentable' };
    }
    // The three facts that outrank painted rows, because revealing under them shows the reader
    // something wrong rather than something unfinished: the native entry restore writes its
    // position AFTER the rows paint (paint-at-A -> restore-at-B), the keyed join is a restore to
    // an anchor the painted frame is not at yet, and the web Markdown runtime renders its raw
    // fallback with `visibility: hidden`, so those rows carry no readable text until it resolves.
    if (facts.nativePlacementPending) {
        return { covered: true, reason: 'native-placement' };
    }
    if (facts.entryPlacementPending) {
        return { covered: true, reason: 'entry-placement' };
    }
    if (facts.markdownRuntimePending) {
        return { covered: true, reason: 'markdown-runtime' };
    }
    if (facts.firstListPaintObserved && facts.itemCount > 0) {
        return { covered: false, outcome: 'content-presentable' };
    }
    // The web bottom-entry landing, below the paint it cannot outrank. Legend paints the tail
    // entry from inside `finishInitialScroll`, so by the time the rows exist they are already at
    // the position this landing refines and its remaining deferred write only settles them; the
    // hold would otherwise keep presentable rows behind the placeholder for the whole web initial
    // pin stabilization window, because its affirmative terminal is a renderer confirmation the
    // renderer cannot always produce. Before that paint it still covers the empty viewport.
    if (facts.initialPlacementPending) {
        return { covered: true, reason: 'entry-placement' };
    }
    if (facts.routeHydrationPending) {
        return { covered: true, reason: 'route-hydration' };
    }
    if (facts.firstListPaintPending) {
        return { covered: true, reason: 'first-list-paint' };
    }
    return { covered: false, outcome: 'content-presentable' };
}

/**
 * The single bound on the placeholder: the initial fill budget plus both mount-settle quiescent
 * windows. Past it the placeholder is removed with `deadline-fallback`, whatever is still pending.
 *
 * The session-open latch arms its own absolute `firstPaintFallbackDeadlineAtMs` from the same
 * duration, so the two must be resolved here rather than recomputed per call site.
 */
export function resolveTranscriptFirstPaintFallbackDelayMs(tuning: Readonly<{
    transcriptInitialFillBudgetMs: number;
    transcriptMountSettleQuiescentWindowMs: number;
}>): number {
    return tuning.transcriptInitialFillBudgetMs
        + tuning.transcriptMountSettleQuiescentWindowMs * 2
        + 1;
}
