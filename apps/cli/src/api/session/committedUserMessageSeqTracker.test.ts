import { describe, expect, it, vi } from 'vitest';

import { CommittedUserMessageSeqTracker } from './committedUserMessageSeqTracker';

describe('CommittedUserMessageSeqTracker', () => {
    it('ignores fractional committed message seqs', () => {
        const tracker = new CommittedUserMessageSeqTracker();

        expect(tracker.record('local-1', 55.9)).toBeNull();
        expect(tracker.get('local-1')).toBeNull();
    });

    it('rejects whitespace-only pending identities', async () => {
        const tracker = new CommittedUserMessageSeqTracker();

        expect(tracker.record('   ', 56)).toBeNull();
        await expect(tracker.wait('   ', { timeoutMs: 1 })).resolves.toBeNull();
    });

    it('preserves surrounding whitespace in an accepted opaque identity', () => {
        const tracker = new CommittedUserMessageSeqTracker();

        expect(tracker.record(' local-1 ', 57)).toBe(57);
        expect(tracker.get(' local-1 ')).toBe(57);
        expect(tracker.get('local-1')).toBeNull();
    });

    it('resolves from record and keeps the fallback timeout bounded without polling', async () => {
        vi.useFakeTimers();
        const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');

        try {
            const tracker = new CommittedUserMessageSeqTracker();
            const recordedWaiter = tracker.wait('local-recorded', { timeoutMs: 25 });

            expect(setIntervalSpy).not.toHaveBeenCalled();
            expect(tracker.record('local-recorded', 58)).toBe(58);
            await expect(recordedWaiter).resolves.toBe(58);

            const timeoutWaiter = tracker.wait('local-missing', { timeoutMs: 25 });
            let didSettle = false;
            void timeoutWaiter.then(() => {
                didSettle = true;
            });

            await vi.advanceTimersByTimeAsync(24);
            expect(didSettle).toBe(false);
            await vi.advanceTimersByTimeAsync(1);
            await expect(timeoutWaiter).resolves.toBeNull();
        } finally {
            setIntervalSpy.mockRestore();
            vi.useRealTimers();
        }
    });
});
