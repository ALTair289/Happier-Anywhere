import { describe, expect, it } from 'vitest';

import { createTestTranscriptMeasurementReconciler } from './transcriptMeasurementReconciler';
import type { TranscriptItemHeightValiditySignature } from './transcriptItemHeightCache';
import { resolveTranscriptRowShellHeight } from './resolveTranscriptRowShellHeight';

function stableSignature(
    overrides: Partial<TranscriptItemHeightValiditySignature> = {},
): TranscriptItemHeightValiditySignature {
    return {
        itemId: 'message-1',
        kind: 'message:agent',
        structuralKey: 'message-1:content-v1',
        widthBucket: 'width:400',
        fontScaleKey: 'font:1',
        groupingMode: 'turn',
        forkContextKey: 'root',
        expansionKey: 'tools:collapsed',
        rowState: 'stable',
        ...overrides,
    };
}

describe('resolveTranscriptRowShellHeight', () => {
    it('returns an exact reservation for a valid cached stable height', () => {
        const reconciler = createTestTranscriptMeasurementReconciler();
        const signature = stableSignature();
        reconciler.recordMeasuredHeight({ signature, heightPx: 184 });

        const reservation = resolveTranscriptRowShellHeight({ reconciler, signature });

        expect(reservation).toEqual({ kind: 'exact', minHeight: 184 });
    });

    it('does not expose FlashList estimate props', () => {
        const reconciler = createTestTranscriptMeasurementReconciler();
        const signature = stableSignature();
        reconciler.recordMeasuredHeight({ signature, heightPx: 184 });

        const reservation = resolveTranscriptRowShellHeight({ reconciler, signature });

        expect(reservation).not.toHaveProperty('estimatedItemSize');
        expect(reservation).not.toHaveProperty('overrideItemLayout');
    });

    it('serves a monotonic floor reservation for a streaming row', () => {
        const reconciler = createTestTranscriptMeasurementReconciler();
        const signature = stableSignature({ rowState: 'streaming' });
        reconciler.recordMeasuredHeight({ signature, heightPx: 184 });

        expect(resolveTranscriptRowShellHeight({ reconciler, signature })).toEqual({ kind: 'floor', minHeight: 184 });
    });

    it('never serves a stale EXACT height when the stable content revision changes', () => {
        const reconciler = createTestTranscriptMeasurementReconciler();
        reconciler.recordMeasuredHeight({ signature: stableSignature({ structuralKey: 'message-1:content-v1' }), heightPx: 184 });

        const reservation = resolveTranscriptRowShellHeight({
            reconciler,
            signature: stableSignature({ structuralKey: 'message-1:content-v2' }),
        });

        // The exact cache misses on a content change; a floor may still be served, but never a
        // stale `exact` height that would compete with FlashList's authoritative re-measure.
        expect(reservation?.kind).not.toBe('exact');
    });

    it('suppresses an inherited floor during a shrink-capable structural transition render', () => {
        const reconciler = createTestTranscriptMeasurementReconciler();
        const runningHeader = stableSignature({
            itemId: 'group-1#header',
            kind: 'tool-group-header',
            structuralKey: 'group-1|status:running',
        });
        const completedHeader = stableSignature({
            itemId: 'group-1#header',
            kind: 'tool-group-header',
            structuralKey: 'group-1|status:completed',
        });
        reconciler.recordMeasuredHeight({ signature: runningHeader, heightPx: 36 });

        const reservation = resolveTranscriptRowShellHeight({
            previousSignature: runningHeader,
            reconciler,
            signature: completedHeader,
        });

        expect(reservation).toBeUndefined();
    });

    it('returns undefined for an unknown streaming row with no sample', () => {
        const reconciler = createTestTranscriptMeasurementReconciler();
        const signature = stableSignature({ rowState: 'streaming' });

        expect(resolveTranscriptRowShellHeight({ reconciler, signature })).toBeUndefined();
    });
});
