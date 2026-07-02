import { describe, expect, it } from 'vitest';

import { resolveTranscriptJumpSeqIndex } from './viewport/jump/resolveTranscriptJumpTargetIndex';

const seqByMessageId: Record<string, number> = {
    'msg-2200': 2200,
    'msg-2300': 2300,
    'msg-2400': 2400,
    'msg-2400-tool': 2401,
    'msg-2500': 2500,
};

function resolveSeqForMessageId(messageId: string): number | null {
    return seqByMessageId[messageId] ?? null;
}

const loadedWindowItems = [
    {
        id: 'turn:a',
        kind: 'turn',
        turn: {
            userMessageId: 'msg-2200',
            content: [{ kind: 'message', messageId: 'msg-2300' }],
        },
    },
    {
        id: 'turn:b',
        kind: 'turn',
        turn: {
            userMessageId: 'msg-2400',
            content: [{ kind: 'tool_calls', toolMessageIds: ['msg-2400-tool'] }],
        },
    },
    { id: 'msg:msg-2500', kind: 'message', messageId: 'msg-2500', seq: 2500 },
] as const;

describe('resolveTranscriptJumpSeqIndex', () => {
    it('returns the exact item index when the target seq is loaded', () => {
        expect(resolveTranscriptJumpSeqIndex({
            targetSeq: 2300,
            items: loadedWindowItems,
            resolveSeqForMessageId,
            hasMoreOlder: true,
        })).toBe(0);
        expect(resolveTranscriptJumpSeqIndex({
            targetSeq: 2401,
            items: loadedWindowItems,
            resolveSeqForMessageId,
            hasMoreOlder: true,
        })).toBe(1);
        expect(resolveTranscriptJumpSeqIndex({
            targetSeq: 2500,
            items: loadedWindowItems,
            resolveSeqForMessageId,
            hasMoreOlder: true,
        })).toBe(2);
    });

    it('returns null for a target older than the loaded window while older pages may exist', () => {
        // Regression: the nearest-loaded fallback must not preempt jump materialization —
        // returning an index here makes jumpToTranscriptSeq scroll to the top of the loaded
        // window instead of loading older pages down to the target seq.
        expect(resolveTranscriptJumpSeqIndex({
            targetSeq: 200,
            items: loadedWindowItems,
            resolveSeqForMessageId,
            hasMoreOlder: true,
        })).toBeNull();
    });

    it('falls back to the oldest loaded item for an older target when no more pages exist', () => {
        expect(resolveTranscriptJumpSeqIndex({
            targetSeq: 200,
            items: loadedWindowItems,
            resolveSeqForMessageId,
            hasMoreOlder: false,
        })).toBe(0);
    });

    it('falls back to the nearest neighbours for an in-window gap seq without loading', () => {
        // Seq 2350 sits between loaded seqs (gap: pruned/sidechain) — materializing older
        // pages cannot surface it, so the nearest-next item is the right landing.
        expect(resolveTranscriptJumpSeqIndex({
            targetSeq: 2350,
            items: loadedWindowItems,
            resolveSeqForMessageId,
            hasMoreOlder: true,
        })).toBe(1);
    });

    it('falls back to the newest loaded item for a target beyond the window end', () => {
        expect(resolveTranscriptJumpSeqIndex({
            targetSeq: 9999,
            items: loadedWindowItems,
            resolveSeqForMessageId,
            hasMoreOlder: true,
        })).toBe(2);
    });

    describe('tool-group unit rows (N2c)', () => {
        // Rule implemented: a `tool-group-tool` unit resolves its OWN seq (item.seq first,
        // resolver fallback); header/expand/footer caps resolve NO seqs, so a jump to a
        // tool hidden behind the collapsed preview lands on the nearest loaded seq —
        // an adjacent row of the same group.
        const groupId = 'toolCalls:turn:b:msg-2400-tool';
        const unitWindowItems = [
            { id: 'msg:msg-2300', kind: 'message', messageId: 'msg-2300' },
            { id: `${groupId}#header`, kind: 'tool-group-header', toolMessageIds: ['msg-2400-tool', 'msg-2500'] },
            { id: `${groupId}#expand`, kind: 'tool-group-expand', toolMessageIds: ['msg-2400-tool', 'msg-2500'] },
            { id: `${groupId}#tool:msg-2500`, kind: 'tool-group-tool', toolMessageId: 'msg-2500', seq: 2500 },
            { id: `${groupId}#footer`, kind: 'tool-group-footer', toolMessageIds: ['msg-2400-tool', 'msg-2500'] },
        ] as const;

        it('resolves a tool unit by its own item seq', () => {
            expect(resolveTranscriptJumpSeqIndex({
                targetSeq: 2500,
                items: unitWindowItems,
                resolveSeqForMessageId,
                hasMoreOlder: true,
            })).toBe(3);
        });

        it('resolves a tool unit through the seq resolver when the item seq is absent', () => {
            const items = [
                { id: `${groupId}#tool:msg-2400-tool`, kind: 'tool-group-tool', toolMessageId: 'msg-2400-tool' },
            ] as const;
            expect(resolveTranscriptJumpSeqIndex({
                targetSeq: 2401,
                items,
                resolveSeqForMessageId,
                hasMoreOlder: true,
            })).toBe(0);
        });

        it('lands a hidden collapsed tool on the nearest loaded seq instead of a cap row', () => {
            // msg-2400-tool (seq 2401) has no own row: nearest-next loaded seq is the
            // visible tail tool at index 3.
            expect(resolveTranscriptJumpSeqIndex({
                targetSeq: 2401,
                items: unitWindowItems,
                resolveSeqForMessageId,
                hasMoreOlder: false,
            })).toBe(3);
        });
    });

    it('returns null when nothing is resolvable yet', () => {
        expect(resolveTranscriptJumpSeqIndex({
            targetSeq: 10,
            items: [],
            resolveSeqForMessageId,
            hasMoreOlder: true,
        })).toBeNull();
        expect(resolveTranscriptJumpSeqIndex({
            targetSeq: -1,
            items: loadedWindowItems,
            resolveSeqForMessageId,
            hasMoreOlder: true,
        })).toBeNull();
    });
});
