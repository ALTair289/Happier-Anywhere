import { afterEach, describe, expect, it, vi } from 'vitest';

import { flushHookEffects, renderHook, standardCleanup } from '@/dev/testkit';

import { useSessionListRelativeTimeClock } from './useSessionListRelativeTimeClock';

afterEach(() => {
    standardCleanup();
    vi.useRealTimers();
});

describe('session list row clocks', () => {
    it('does not tick the relative-time clock while the session-list surface is inactive', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000);

        const hook = await renderHook(
            ({ enabled }: { enabled: boolean }) => useSessionListRelativeTimeClock(enabled),
            { initialProps: { enabled: false } },
        );

        expect(hook.getCurrent()).toBe(1_000);

        vi.setSystemTime(61_000);
        await flushHookEffects({ advanceTimersMs: 60_000, cycles: 1, turns: 2 });

        expect(hook.getCurrent()).toBe(1_000);

        await hook.rerender({ enabled: true });
        await flushHookEffects({ cycles: 1, turns: 2 });

        expect(hook.getCurrent()).toBe(121_000);

        await hook.unmount();
    });
});
