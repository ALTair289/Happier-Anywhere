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
 * - rows that already painted stay visible while their session refreshes (cached/SWR content is
 *   never re-covered by route hydration).
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
 * the Markdown runtime (ready or failed both end it), keyed placement, native placement.
 */
export type TranscriptFirstPaintFacts = Readonly<{
    deadlineElapsed: boolean;
    entryPlacementPending: boolean;
    firstListPaintObserved: boolean;
    firstListPaintPending: boolean;
    isLoaded: boolean;
    itemCount: number;
    markdownRuntimePending: boolean;
    nativePlacementPending: boolean;
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
