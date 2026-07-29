import { describe, expect, it } from 'vitest';

import {
    resolveTranscriptFirstPaintFallbackDelayMs,
    resolveTranscriptFirstPaintPresentation,
    type TranscriptFirstPaintCoverReason,
    type TranscriptFirstPaintFacts,
} from './transcriptFirstPaintPresentation';

function facts(overrides: Partial<TranscriptFirstPaintFacts> = {}): TranscriptFirstPaintFacts {
    return {
        deadlineElapsed: false,
        entryPlacementPending: false,
        firstListPaintObserved: true,
        firstListPaintPending: false,
        initialPlacementPending: false,
        isLoaded: false,
        itemCount: 10,
        markdownRuntimePending: false,
        nativePlacementPending: false,
        paintedContentRevealed: false,
        routeHydrationPending: false,
        ...overrides,
    };
}

const coveringFactsByReason: ReadonlyArray<Readonly<{
    facts: TranscriptFirstPaintFacts;
    reason: TranscriptFirstPaintCoverReason;
}>> = [
    { facts: facts({ nativePlacementPending: true }), reason: 'native-placement' },
    { facts: facts({ entryPlacementPending: true }), reason: 'entry-placement' },
    {
        facts: facts({ firstListPaintObserved: false, initialPlacementPending: true }),
        reason: 'entry-placement',
    },
    { facts: facts({ markdownRuntimePending: true }), reason: 'markdown-runtime' },
    {
        facts: facts({ firstListPaintObserved: false, routeHydrationPending: true }),
        reason: 'route-hydration',
    },
    {
        facts: facts({ firstListPaintObserved: false, firstListPaintPending: true }),
        reason: 'first-list-paint',
    },
];

describe('transcript first-paint presentation policy', () => {
    it('covers for exactly one named reason per pending owner-local fact', () => {
        for (const candidate of coveringFactsByReason) {
            expect(resolveTranscriptFirstPaintPresentation(candidate.facts)).toEqual({
                covered: true,
                reason: candidate.reason,
            });
        }
    });

    it('gives every covering fact a terminal path through the single bounded deadline', () => {
        for (const candidate of coveringFactsByReason) {
            expect(resolveTranscriptFirstPaintPresentation({
                ...candidate.facts,
                deadlineElapsed: true,
            })).toEqual({ covered: false, outcome: 'deadline-fallback' });
        }
    });

    it('reveals a loaded empty transcript even while every other fact is still pending', () => {
        expect(resolveTranscriptFirstPaintPresentation(facts({
            entryPlacementPending: true,
            firstListPaintObserved: false,
            firstListPaintPending: true,
            isLoaded: true,
            itemCount: 0,
            markdownRuntimePending: true,
            nativePlacementPending: true,
            routeHydrationPending: true,
        }))).toEqual({ covered: false, outcome: 'loaded-empty' });
    });

    it('never re-covers an entry whose painted rows this policy already revealed', () => {
        for (const candidate of coveringFactsByReason) {
            expect(resolveTranscriptFirstPaintPresentation({
                ...candidate.facts,
                paintedContentRevealed: true,
            })).toEqual({ covered: false, outcome: 'content-presentable' });
        }
    });

    it('still covers the same pending facts before the entry has revealed anything', () => {
        for (const candidate of coveringFactsByReason) {
            expect(resolveTranscriptFirstPaintPresentation({
                ...candidate.facts,
                paintedContentRevealed: false,
            })).toEqual({ covered: true, reason: candidate.reason });
        }
    });

    it('keeps naming the deadline reveal after the entry has revealed its content', () => {
        expect(resolveTranscriptFirstPaintPresentation(facts({
            deadlineElapsed: true,
            nativePlacementPending: true,
            paintedContentRevealed: true,
        }))).toEqual({ covered: false, outcome: 'deadline-fallback' });
        expect(resolveTranscriptFirstPaintPresentation(facts({
            isLoaded: true,
            itemCount: 0,
            nativePlacementPending: true,
            paintedContentRevealed: true,
        }))).toEqual({ covered: false, outcome: 'loaded-empty' });
    });

    it('keeps painted rows visible while the session route re-hydrates', () => {
        expect(resolveTranscriptFirstPaintPresentation(facts({
            firstListPaintObserved: true,
            isLoaded: true,
            routeHydrationPending: true,
        }))).toEqual({ covered: false, outcome: 'content-presentable' });
    });

    it('does not report a paint that never happened when the deadline reveals', () => {
        const presentation = resolveTranscriptFirstPaintPresentation(facts({
            deadlineElapsed: true,
            firstListPaintObserved: false,
            firstListPaintPending: true,
        }));

        expect(presentation).toEqual({ covered: false, outcome: 'deadline-fallback' });
    });

    it('releases the web bottom-entry landing hold on this entry\'s own painted rows', () => {
        expect(resolveTranscriptFirstPaintPresentation(facts({
            firstListPaintObserved: true,
            initialPlacementPending: true,
            isLoaded: true,
            itemCount: 10,
        }))).toEqual({ covered: false, outcome: 'content-presentable' });
    });

    it('keeps a bottom entry covered until its rows have actually painted', () => {
        expect(resolveTranscriptFirstPaintPresentation(facts({
            firstListPaintObserved: false,
            firstListPaintPending: true,
            initialPlacementPending: true,
            isLoaded: true,
            itemCount: 10,
        }))).toEqual({ covered: true, reason: 'entry-placement' });
    });

    it('never reveals painted rows before a keyed anchor restore has placed them', () => {
        expect(resolveTranscriptFirstPaintPresentation(facts({
            entryPlacementPending: true,
            firstListPaintObserved: true,
            initialPlacementPending: false,
            isLoaded: true,
            itemCount: 10,
        }))).toEqual({ covered: true, reason: 'entry-placement' });
    });

    it('never reveals painted rows before the native entry restore write', () => {
        expect(resolveTranscriptFirstPaintPresentation(facts({
            firstListPaintObserved: true,
            isLoaded: true,
            itemCount: 10,
            nativePlacementPending: true,
        }))).toEqual({ covered: true, reason: 'native-placement' });
    });

    it('never reveals painted rows whose Markdown text the web runtime still renders hidden', () => {
        expect(resolveTranscriptFirstPaintPresentation(facts({
            firstListPaintObserved: true,
            isLoaded: true,
            itemCount: 10,
            markdownRuntimePending: true,
        }))).toEqual({ covered: true, reason: 'markdown-runtime' });
    });

    it('resolves one fallback delay from the shared mount-settle tuning', () => {
        expect(resolveTranscriptFirstPaintFallbackDelayMs({
            transcriptInitialFillBudgetMs: 2_000,
            transcriptMountSettleQuiescentWindowMs: 120,
        })).toBe(2_241);
    });
});
