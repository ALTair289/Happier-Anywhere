import { describe, expect, it, vi } from 'vitest';

import { startConnectedServiceRefreshLoop } from './startConnectedServiceRefreshLoop';

describe('startConnectedServiceRefreshLoop', () => {
    it('runs an initial reconcile without waiting for the first interval', async () => {
        vi.useFakeTimers();
        try {
            const coordinator = {
                tickOnce: vi.fn(async () => {}),
            };

            const handle = startConnectedServiceRefreshLoop({
                enabled: true,
                tickMs: 60_000,
                coordinator,
                onTickError: vi.fn(),
            });

            expect(handle).not.toBeNull();
            await Promise.resolve();
            expect(coordinator.tickOnce).toHaveBeenCalledTimes(1);

            handle?.stop();
        } finally {
            vi.useRealTimers();
        }
    });

    it('runs refresh ticks on the configured interval', async () => {
        vi.useFakeTimers();
        try {
            const coordinator = {
                tickOnce: vi.fn(async () => {}),
            };

            const handle = startConnectedServiceRefreshLoop({
                enabled: true,
                tickMs: 50,
                coordinator,
                onTickError: vi.fn(),
            });

            expect(handle).not.toBeNull();
            await vi.advanceTimersByTimeAsync(50);
            expect(coordinator.tickOnce).toHaveBeenCalledTimes(2);

            handle?.stop();
        } finally {
            vi.useRealTimers();
        }
    });

    it('pauses ticks until resume() is called', async () => {
        vi.useFakeTimers();
        try {
            const coordinator = {
                tickOnce: vi.fn(async () => {}),
            };

            const handle = startConnectedServiceRefreshLoop({
                enabled: true,
                tickMs: 50,
                coordinator,
                onTickError: vi.fn(),
            });

            await Promise.resolve();
            expect(coordinator.tickOnce).toHaveBeenCalledTimes(1);

            handle?.pause();
            await vi.advanceTimersByTimeAsync(150);
            expect(coordinator.tickOnce).toHaveBeenCalledTimes(1);

            handle?.resume();
            await vi.advanceTimersByTimeAsync(50);
            expect(coordinator.tickOnce).toHaveBeenCalledTimes(2);

            handle?.stop();
        } finally {
            vi.useRealTimers();
        }
    });

    it('backs off repeated refresh attempts while the server is unavailable', async () => {
        vi.useFakeTimers();
        try {
            const coordinator = {
                tickOnce: vi.fn(async () => {
                    throw new Error('server unavailable');
                }),
            };
            const onTickError = vi.fn();

            const handle = startConnectedServiceRefreshLoop({
                enabled: true,
                tickMs: 50,
                coordinator,
                onTickError,
            });

            await vi.advanceTimersByTimeAsync(50);
            expect(coordinator.tickOnce).toHaveBeenCalledTimes(1);
            expect(onTickError).toHaveBeenCalledTimes(1);

            await vi.advanceTimersByTimeAsync(1000);
            expect(coordinator.tickOnce).toHaveBeenCalledTimes(1);

            await vi.advanceTimersByTimeAsync(4000);
            expect(coordinator.tickOnce).toHaveBeenCalledTimes(2);

            handle?.stop();
        } finally {
            vi.useRealTimers();
        }
    });
});
