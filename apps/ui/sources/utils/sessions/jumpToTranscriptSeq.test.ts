import { describe, expect, it, vi } from 'vitest';

import { jumpToTranscriptSeq } from './jumpToTranscriptSeq';

describe('jumpToTranscriptSeq', () => {
    it('scrolls immediately when the target is already in view', async () => {
        const scrollToIndex = vi.fn();
        let index = 7;

        const result = await jumpToTranscriptSeq({
            targetSeq: 42,
            getIndex: () => index,
            scrollToIndex,
        });

        expect(result.status).toBe('scrolled');
        expect(scrollToIndex).toHaveBeenCalledWith(7);
    });

    it('does not load older pages when the target is not already resolvable', async () => {
        const scrollToIndex = vi.fn();

        const result = await jumpToTranscriptSeq({
            targetSeq: 100,
            getIndex: () => null,
            scrollToIndex,
        });

        expect(result).toEqual({ status: 'not_found' });
        expect(scrollToIndex).not.toHaveBeenCalled();
    });

    it('does not report scrolled when the resolved-index adapter reports no command was applied', async () => {
        const scrollToIndex = vi.fn(() => false);

        const result = await jumpToTranscriptSeq({
            targetSeq: 42,
            getIndex: () => 7,
            scrollToIndex,
        });

        expect(result).toEqual({ status: 'not_found' });
        expect(scrollToIndex).toHaveBeenCalledWith(7);
    });
});
