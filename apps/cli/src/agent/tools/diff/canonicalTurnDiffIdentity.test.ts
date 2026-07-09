import { describe, expect, it } from 'vitest';

import { resolveCanonicalTurnDiffCallId } from './canonicalTurnDiffIdentity';

function makeBoundedDiffInput(overrides?: Partial<{ newText: string; filePath: string }>): Record<string, unknown> {
    return {
        sessionId: 'session_1',
        turnId: 'turn_1',
        seqRange: { startSeqInclusive: 1, endSeqInclusive: 2 },
        status: 'completed',
        files: [
            {
                filePath: overrides?.filePath ?? 'src/a.ts',
                changeKind: 'modified',
                oldText: 'aaaa\n',
                newText: overrides?.newText ?? 'bbbb\n',
                source: 'provider_tool',
                confidence: 'exact',
                provider: 'claude',
            },
        ],
        provider: 'claude',
    };
}

describe('resolveCanonicalTurnDiffCallId', () => {
    it('is deterministic for identical bounded inputs', () => {
        expect(resolveCanonicalTurnDiffCallId(makeBoundedDiffInput()))
            .toBe(resolveCanonicalTurnDiffCallId(makeBoundedDiffInput()));
    });

    it('keeps the turn-diff-<hex32> id shape', () => {
        expect(resolveCanonicalTurnDiffCallId(makeBoundedDiffInput())).toMatch(/^turn-diff-[0-9a-f]{32}$/);
    });

    it('changes when emitted file content changes, even at identical lengths', () => {
        const a = resolveCanonicalTurnDiffCallId(makeBoundedDiffInput({ newText: 'bbbb\n' }));
        const b = resolveCanonicalTurnDiffCallId(makeBoundedDiffInput({ newText: 'bbbc\n' }));
        expect(a).not.toBe(b);
    });

    it('changes when the file path changes', () => {
        const a = resolveCanonicalTurnDiffCallId(makeBoundedDiffInput({ filePath: 'src/a.ts' }));
        const b = resolveCanonicalTurnDiffCallId(makeBoundedDiffInput({ filePath: 'src/b.ts' }));
        expect(a).not.toBe(b);
    });

    it('hashes the bounded representation instead of omitted source content', () => {
        const inputA = {
            ...makeBoundedDiffInput(),
            files: [
                {
                    filePath: 'src/huge.ts',
                    changeKind: 'modified',
                    unified_diff: 'diff --git a/src/huge.ts b/src/huge.ts\n--- a/src/huge.ts\n+++ b/src/huge.ts\n@@ -0,0 +0,0 @@\n# Diff too large',
                    truncated: true,
                    stats: { oldTextBytes: 10_000, newTextBytes: 10_000 },
                    source: 'provider_tool',
                    confidence: 'exact',
                    provider: 'claude',
                },
            ],
        };
        const inputB = JSON.parse(JSON.stringify(inputA)) as Record<string, unknown>;

        expect(resolveCanonicalTurnDiffCallId(inputB)).toBe(resolveCanonicalTurnDiffCallId(inputA));
    });
});
