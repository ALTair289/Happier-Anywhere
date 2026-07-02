import { describe, expect, it } from 'vitest';
import { DiffInputV2Schema } from '@happier-dev/protocol/tools/v2';
import type { FileChangeEvidence, TurnChangeSet } from '@happier-dev/protocol';

import { buildTurnChangeSetDiffInput } from './buildTurnChangeSetDiffInput';

type WireDiffFile = {
    file_path: string;
    unified_diff?: string;
    oldText?: string;
    newText?: string;
    description?: string;
    truncated?: true;
    stats?: {
        oldTextBytes?: number;
        newTextBytes?: number;
        unifiedDiffBytes?: number;
        addedLines?: number;
        removedLines?: number;
    };
};

function makeTurnChangeSet(files: Array<Partial<FileChangeEvidence> & { filePath: string }>): TurnChangeSet {
    return {
        sessionId: 'session_1',
        turnId: 'turn_1',
        seqRange: { startSeqInclusive: 1, endSeqInclusive: 2 },
        status: 'completed',
        files: files.map((file) => ({
            changeKind: 'modified' as const,
            source: 'provider_tool' as const,
            confidence: 'exact' as const,
            provider: 'claude',
            ...file,
        })),
        provider: 'claude',
        derivedAt: 1730000000000,
    };
}

function build(params: {
    turnChangeSet: TurnChangeSet;
    fileBudgetBytes?: number;
    turnBudgetBytes?: number;
}): { files: WireDiffFile[]; _happier: Record<string, unknown> } {
    return buildTurnChangeSetDiffInput({
        turnChangeSet: params.turnChangeSet,
        protocol: 'claude',
        rawToolName: 'ClaudeTurnDiff',
        fileBudgetBytes: params.fileBudgetBytes,
        turnBudgetBytes: params.turnBudgetBytes,
    }) as { files: WireDiffFile[]; _happier: Record<string, unknown> };
}

function lines(prefix: string, count: number): string {
    return Array.from({ length: count }, (_, i) => `${prefix} line ${i}`).join('\n') + '\n';
}

describe('buildTurnChangeSetDiffInput payload bounding', () => {
    it('keeps small old/new text pairs inline and untouched', () => {
        const input = build({
            turnChangeSet: makeTurnChangeSet([
                { filePath: 'src/a.ts', oldText: 'a\n', newText: 'b\n' },
            ]),
            fileBudgetBytes: 4096,
            turnBudgetBytes: 16384,
        });

        expect(input.files).toEqual([
            expect.objectContaining({ file_path: 'src/a.ts', oldText: 'a\n', newText: 'b\n' }),
        ]);
        expect(input.files[0]?.truncated).toBeUndefined();
        expect(input.files[0]?.stats).toBeUndefined();
        expect(input._happier.turnDiffTruncatedFileCount).toBeUndefined();
    });

    it('replaces oversized old/new text pairs with a bounded unified diff', () => {
        const oldText = lines('same', 300);
        const newText = oldText.replace('same line 100', 'changed line 100');
        const input = build({
            turnChangeSet: makeTurnChangeSet([
                { filePath: 'src/big.ts', oldText, newText },
            ]),
            fileBudgetBytes: 4096,
            turnBudgetBytes: 1024 * 1024,
        });

        const file = input.files[0]!;
        expect(file.file_path).toBe('src/big.ts');
        expect(file.oldText).toBeUndefined();
        expect(file.newText).toBeUndefined();
        expect(file.truncated).toBeUndefined();
        expect(file.unified_diff).toContain('-same line 100');
        expect(file.unified_diff).toContain('+changed line 100');
        expect(Buffer.byteLength(file.unified_diff!, 'utf8')).toBeLessThanOrEqual(4096);
        expect(file.stats).toEqual({
            oldTextBytes: Buffer.byteLength(oldText, 'utf8'),
            newTextBytes: Buffer.byteLength(newText, 'utf8'),
        });
        expect(() => DiffInputV2Schema.parse(input)).not.toThrow();
    });

    it('degrades to a truncated placeholder when even the diff exceeds the file budget', () => {
        const oldText = lines('old', 400);
        const newText = lines('new', 400);
        const input = build({
            turnChangeSet: makeTurnChangeSet([
                { filePath: 'src/rewrite.ts', oldText, newText },
            ]),
            fileBudgetBytes: 2048,
            turnBudgetBytes: 1024 * 1024,
        });

        const file = input.files[0]!;
        expect(file.truncated).toBe(true);
        expect(file.oldText).toBeUndefined();
        expect(file.newText).toBeUndefined();
        expect(file.unified_diff).toContain('diff --git a/src/rewrite.ts b/src/rewrite.ts');
        expect(Buffer.byteLength(file.unified_diff!, 'utf8')).toBeLessThanOrEqual(2048);
        expect(file.stats).toEqual(expect.objectContaining({
            oldTextBytes: Buffer.byteLength(oldText, 'utf8'),
            newTextBytes: Buffer.byteLength(newText, 'utf8'),
        }));
        expect(input._happier.turnDiffTruncatedFileCount).toBe(1);
        expect(() => DiffInputV2Schema.parse(input)).not.toThrow();
    });

    it('degrades oversized per-file unified diffs to truncated stats', () => {
        const bigDiff = [
            'diff --git a/src/gen.ts b/src/gen.ts',
            '--- a/src/gen.ts',
            '+++ b/src/gen.ts',
            '@@ -1,500 +1,500 @@',
            ...Array.from({ length: 500 }, (_, i) => `-old ${i}`),
            ...Array.from({ length: 500 }, (_, i) => `+new ${i}`),
        ].join('\n');
        const input = build({
            turnChangeSet: makeTurnChangeSet([
                { filePath: 'src/gen.ts', unifiedDiff: bigDiff },
            ]),
            fileBudgetBytes: 1024,
            turnBudgetBytes: 1024 * 1024,
        });

        const file = input.files[0]!;
        expect(file.truncated).toBe(true);
        expect(file.unified_diff).toContain('diff --git a/src/gen.ts b/src/gen.ts');
        expect(Buffer.byteLength(file.unified_diff!, 'utf8')).toBeLessThanOrEqual(1024);
        expect(file.stats).toEqual({
            unifiedDiffBytes: Buffer.byteLength(bigDiff, 'utf8'),
            addedLines: 500,
            removedLines: 500,
        });
        expect(() => DiffInputV2Schema.parse(input)).not.toThrow();
    });

    it('enforces the per-turn byte budget across files', () => {
        const perFile = () => ({
            oldText: lines('old', 300),
            newText: lines('new', 300),
        });
        const input = build({
            turnChangeSet: makeTurnChangeSet([
                { filePath: 'src/one.ts', ...perFile() },
                { filePath: 'src/two.ts', ...perFile() },
                { filePath: 'src/three.ts', ...perFile() },
            ]),
            fileBudgetBytes: 64 * 1024,
            turnBudgetBytes: 10 * 1024,
        });

        expect(input.files[0]).toEqual(expect.objectContaining({
            file_path: 'src/one.ts',
            oldText: expect.stringContaining('old line 0'),
            newText: expect.stringContaining('new line 0'),
        }));
        expect(input.files[1]?.truncated).toBe(true);
        expect(input.files[2]?.truncated).toBe(true);
        expect(input._happier.turnDiffTruncatedFileCount).toBe(2);
    });

    it('applies no bounding when budgets are disabled with 0', () => {
        const oldText = lines('old', 5000);
        const newText = lines('new', 5000);
        const input = build({
            turnChangeSet: makeTurnChangeSet([
                { filePath: 'src/huge.ts', oldText, newText },
            ]),
            fileBudgetBytes: 0,
            turnBudgetBytes: 0,
        });

        expect(input.files[0]).toEqual(expect.objectContaining({
            file_path: 'src/huge.ts',
            oldText,
            newText,
        }));
        expect(input._happier.turnDiffTruncatedFileCount).toBeUndefined();
    });
});
