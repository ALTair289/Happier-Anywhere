import { describe, expect, it } from 'vitest';
import type { TurnChangeSet } from '@happier-dev/protocol';

import { resolveCanonicalTurnDiffCallId } from './canonicalTurnDiffIdentity';

function makeTurnChangeSet(overrides?: Partial<{ newText: string; filePath: string }>): TurnChangeSet {
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
        derivedAt: 1730000000000,
    };
}

describe('resolveCanonicalTurnDiffCallId', () => {
    it('is deterministic for identical change sets', () => {
        expect(resolveCanonicalTurnDiffCallId(makeTurnChangeSet()))
            .toBe(resolveCanonicalTurnDiffCallId(makeTurnChangeSet()));
    });

    it('keeps the turn-diff-<hex32> id shape', () => {
        expect(resolveCanonicalTurnDiffCallId(makeTurnChangeSet())).toMatch(/^turn-diff-[0-9a-f]{32}$/);
    });

    it('changes when file content changes, even at identical lengths', () => {
        const a = resolveCanonicalTurnDiffCallId(makeTurnChangeSet({ newText: 'bbbb\n' }));
        const b = resolveCanonicalTurnDiffCallId(makeTurnChangeSet({ newText: 'bbbc\n' }));
        expect(a).not.toBe(b);
    });

    it('changes when the file path changes', () => {
        const a = resolveCanonicalTurnDiffCallId(makeTurnChangeSet({ filePath: 'src/a.ts' }));
        const b = resolveCanonicalTurnDiffCallId(makeTurnChangeSet({ filePath: 'src/b.ts' }));
        expect(a).not.toBe(b);
    });

    it('hashes multi-megabyte texts without building a full stable-JSON copy', () => {
        const big = 'x'.repeat(8 * 1024 * 1024);
        const changeSet: TurnChangeSet = {
            ...makeTurnChangeSet(),
            files: [
                {
                    filePath: 'src/huge.ts',
                    changeKind: 'modified',
                    oldText: big,
                    newText: `${big}y`,
                    source: 'provider_tool',
                    confidence: 'exact',
                    provider: 'claude',
                },
            ],
        };
        // Behavioral contract: identity stays deterministic and content-sensitive for huge payloads.
        const first = resolveCanonicalTurnDiffCallId(changeSet);
        expect(first).toBe(resolveCanonicalTurnDiffCallId(changeSet));
        expect(first).toMatch(/^turn-diff-[0-9a-f]{32}$/);
    });
});
