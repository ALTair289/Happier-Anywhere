import { describe, expect, it } from 'vitest';

import { createTranscriptFreshnessGate, resolveTranscriptUtteranceIdentity } from './transcriptFreshnessGate';

function utteranceId(localId: string): string {
    const identity = resolveTranscriptUtteranceIdentity(localId);
    if (identity == null) throw new Error(`expected an utterance identity for ${localId}`);
    return identity;
}

/**
 * The pending → committed crossover, from the motion gate's side.
 *
 * A send paints the SAME user utterance twice: first inside the `pending-queue` row, then as its
 * committed row (a different Legend item key, a different container). Row-id freshness alone cannot
 * see that, so the committed row read as brand new and entered from `opacity: 0` — which is what
 * the 2026-08-01 native capture recorded as a 500 ms void at the handover.
 */
describe('transcript freshness gate — painted identities', () => {
    it('treats a row that repaints an already-painted identity as not fresh', () => {
        const gate = createTranscriptFreshnessGate({ freshnessMs: 60_000, getNowMs: () => 1_000 });
        const utterance = utteranceId('local-1');

        expect(gate.consumeFreshness({ id: 'pending-queue', createdAt: 990, paintedIds: [utterance] })).toBe(true);

        expect(gate.isFresh({ id: 'msg:server-1', createdAt: 990, paintedIds: [utterance] })).toBe(false);
        expect(gate.consumeFreshness({ id: 'msg:server-1', createdAt: 990, paintedIds: [utterance] })).toBe(false);
    });

    it('leaves a row painting an unrelated identity fresh', () => {
        const gate = createTranscriptFreshnessGate({ freshnessMs: 60_000, getNowMs: () => 1_000 });

        gate.consumeFreshness({
            id: 'pending-queue',
            createdAt: 990,
            paintedIds: [utteranceId('local-1')],
        });

        expect(gate.isFresh({
            id: 'msg:server-2',
            createdAt: 990,
            paintedIds: [utteranceId('local-2')],
        })).toBe(true);
    });

    it('records painted identities for a row that does not itself animate', () => {
        const gate = createTranscriptFreshnessGate({ freshnessMs: 200, getNowMs: () => 1_000 });
        const utterance = utteranceId('local-1');

        // Stale by age, so it never animates — but the reader still saw the utterance.
        expect(gate.consumeFreshness({ id: 'pending-queue', createdAt: 100, paintedIds: [utterance] })).toBe(false);
        gate.markPainted([utterance]);

        expect(gate.isFresh({ id: 'msg:server-1', createdAt: 999, paintedIds: [utterance] })).toBe(false);
    });

    it('namespaces utterance identities so a localId cannot collide with a row id', () => {
        expect(resolveTranscriptUtteranceIdentity('msg:server-1')).not.toBe('msg:server-1');
        expect(resolveTranscriptUtteranceIdentity('')).toBeNull();
    });
});
