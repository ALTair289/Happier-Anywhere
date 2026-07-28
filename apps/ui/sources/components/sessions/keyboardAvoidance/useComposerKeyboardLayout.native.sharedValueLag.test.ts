import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderHook, standardCleanup } from '@/dev/testkit';

// Reanimated 4 guest-runtime semantics: `sharedValue.value = x` dispatches an ASYNC write
// (`setAsync`), while `sharedValue.value` reads return the last synchronized value. A JS
// write immediately followed by a JS read therefore observes the PREVIOUS value. This
// harness models that lag: writes land in `pending` and become readable only after
// `flushSharedValues()`. The layout hook must never depend on write-then-read freshness —
// subscriber notifications must carry the freshly computed local value.
// (Live evidence 2026-07-09: composer growth 137→153→172 notified 404→404→420 instead of
// 404→420→439, leaving the transcript composer inset one step behind and the last rows
// rendered under the composer on native iOS.)

const lagState = vi.hoisted(() => ({
    keyboardHandlers: null as null | {
        onEnd?: (event: { height: number; progress: number }) => void;
        onInteractive?: (event: { height: number; progress: number }) => void;
        onMove?: (event: { height: number; progress: number }) => void;
        onStart?: (event: { height: number; progress: number }) => void;
    },
    keyboardListeners: new Map<string, (event?: { endCoordinates?: { height?: number; screenY?: number } }) => void>(),
    laggingValues: [] as Array<{ commit: () => void }>,
}));

function flushSharedValues(): void {
    for (const value of lagState.laggingValues) {
        value.commit();
    }
}

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Keyboard: {
            addListener: (eventName: string, listener: (event?: { endCoordinates?: { height?: number; screenY?: number } }) => void) => {
                lagState.keyboardListeners.set(eventName, listener);
                return {
                    remove: () => {
                        lagState.keyboardListeners.delete(eventName);
                    },
                };
            },
        },
        Platform: {
            OS: 'android',
            select: <T,>(options: { android?: T; default?: T; native?: T; ios?: T; web?: T }) => (
                options.android ?? options.native ?? options.default ?? options.ios ?? options.web
            ),
        },
        useWindowDimensions: () => ({ width: 390, height: 800, scale: 1, fontScale: 1 }),
    });
});

vi.mock('react-native-keyboard-controller', () => ({
    useKeyboardHandler: (handlers: NonNullable<typeof lagState.keyboardHandlers>) => {
        lagState.keyboardHandlers = handlers;
    },
    useReanimatedKeyboardAnimation: () => ({
        height: { value: 0 },
        progress: { value: 0 },
    }),
}));

vi.mock('react-native-reanimated', async () => {
    const React = await import('react');
    return {
        runOnJS: (callback: (...args: readonly unknown[]) => void) => callback,
        useSharedValue: <T,>(initial: T) => {
            const ref = React.useRef<{ value: T } | null>(null);
            if (ref.current === null) {
                let committed = initial;
                let pending = initial;
                const lagging = {
                    get value(): T {
                        return committed;
                    },
                    set value(next: T) {
                        pending = next;
                    },
                };
                lagState.laggingValues.push({
                    commit: () => {
                        committed = pending;
                    },
                });
                ref.current = lagging;
            }
            return ref.current;
        },
    };
});

describe('useComposerKeyboardLayout native (guest-runtime shared-value write lag)', () => {
    beforeEach(() => {
        standardCleanup();
        lagState.keyboardHandlers = null;
        lagState.keyboardListeners.clear();
        lagState.laggingValues.length = 0;
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('notifies list bottom inset subscribers with the freshly computed value on composer growth', async () => {
        const { useComposerKeyboardLayout } = await import('./useComposerKeyboardLayout.native');
        const hook = await renderHook(() => useComposerKeyboardLayout({ safeAreaBottom: 34 }));
        const received: number[] = [];

        act(() => {
            hook.getCurrent().setComposerMeasuredHeight(137);
        });
        flushSharedValues();
        act(() => {
            lagState.keyboardListeners.get('keyboardDidShow')?.({ endCoordinates: { height: 267 } });
        });
        flushSharedValues();

        hook.getCurrent().subscribeListBottomInset?.((height) => {
            received.push(height);
        });
        received.length = 0;

        // Composer grows two steps in quick succession; the async shared-value writes have
        // NOT synchronized between steps. Every notification must still carry the total
        // computed from the writer's own fresh inputs, not a stale read-back.
        act(() => {
            hook.getCurrent().setComposerMeasuredHeight(153);
            hook.getCurrent().setComposerMeasuredHeight(172);
        });

        expect(received).toContain(153 + 267);
        expect(received[received.length - 1]).toBe(172 + 267);
    });

    it('notifies the freshly derived inset when the settled keyboard height lands from JS', async () => {
        const { useComposerKeyboardLayout } = await import('./useComposerKeyboardLayout.native');
        const hook = await renderHook(() => useComposerKeyboardLayout({ safeAreaBottom: 34 }));
        const received: number[] = [];

        act(() => {
            hook.getCurrent().setComposerMeasuredHeight(137);
        });
        flushSharedValues();

        hook.getCurrent().subscribeListBottomInset?.((height) => {
            received.push(height);
        });
        received.length = 0;

        // Settled keyboard height arrives via the JS listener; no shared-value flush in
        // between: the notification must reflect the just-received keyboard height.
        act(() => {
            lagState.keyboardListeners.get('keyboardDidShow')?.({ endCoordinates: { height: 267 } });
        });

        expect(received[received.length - 1]).toBe(137 + 267);
    });

    it('notifies the freshly applied safe area in the same pass as the layout option change', async () => {
        const { useComposerKeyboardLayout } = await import('./useComposerKeyboardLayout.native');
        const hook = await renderHook(
            (props: { safeAreaBottom: number }) => useComposerKeyboardLayout({ safeAreaBottom: props.safeAreaBottom }),
            { initialProps: { safeAreaBottom: 34 } },
        );
        const received: number[] = [];

        act(() => {
            hook.getCurrent().setComposerMeasuredHeight(137);
        });
        flushSharedValues();

        hook.getCurrent().subscribeListBottomInset?.((height) => {
            received.push(height);
        });
        received.length = 0;

        // The composer block grows by 26px because the safe area grew. The option effect writes
        // the new safe area and recomputes in the SAME pass, so the recompute must consume the
        // fresh local — a `.value` read-back still sees 34 and leaves the transcript inset one
        // growth step behind, rendering the last rows under the composer.
        await hook.rerender({ safeAreaBottom: 60 });

        expect(received[received.length - 1]).toBe(137 + 60);
    });

    it('notifies the freshly applied header height to available-panel subscribers in the same pass', async () => {
        const { useComposerKeyboardLayout } = await import('./useComposerKeyboardLayout.native');
        const hook = await renderHook(
            (props: { headerHeight: number }) => useComposerKeyboardLayout({
                headerHeight: props.headerHeight,
                safeAreaBottom: 34,
            }),
            { initialProps: { headerHeight: 0 } },
        );
        const received: number[] = [];

        hook.getCurrent().subscribeAvailablePanelHeight?.((height) => {
            received.push(height);
        });
        received.length = 0;

        await hook.rerender({ headerHeight: 44 });

        // viewport 800 - header 44 - max(safeArea 34, keyboard 0) - reserved 0
        expect(received[received.length - 1]).toBe(800 - 44 - 34);
    });

    it('notifies the collapsed inset in the same pass as keyboard lift suppression is applied', async () => {
        const { useComposerKeyboardLayout } = await import('./useComposerKeyboardLayout.native');
        const hook = await renderHook(
            (props: { keyboardLiftSuppressed: boolean }) => useComposerKeyboardLayout({
                keyboardLiftSuppressed: props.keyboardLiftSuppressed,
                safeAreaBottom: 34,
            }),
            { initialProps: { keyboardLiftSuppressed: false } },
        );
        const received: number[] = [];

        act(() => {
            hook.getCurrent().setComposerMeasuredHeight(137);
        });
        flushSharedValues();
        act(() => {
            lagState.keyboardListeners.get('keyboardDidShow')?.({ endCoordinates: { height: 267 } });
        });
        flushSharedValues();

        hook.getCurrent().subscribeListBottomInset?.((height) => {
            received.push(height);
        });
        received.length = 0;

        // Suppression zeroes the keyboard contribution. The effect writes the suppression flag
        // and the zeroed keyboard heights, then recomputes in the same pass: read-backs still
        // report an open 267px keyboard and hold the inset a full step behind.
        await hook.rerender({ keyboardLiftSuppressed: true });

        expect(received[received.length - 1]).toBe(137 + 34);
    });

    it('replays the freshly notified available panel height to a late subscriber', async () => {
        const { useComposerKeyboardLayout } = await import('./useComposerKeyboardLayout.native');
        const hook = await renderHook(() => useComposerKeyboardLayout({ safeAreaBottom: 34 }));
        const received: number[] = [];

        // Scaffold measurement recomputes the panel height; the shared-value write has NOT
        // synchronized when the panel subscribes, so the replay must come from the last
        // notified value rather than a `.value` read-back.
        act(() => {
            hook.getCurrent().setScaffoldMeasuredHeight?.(700);
        });

        hook.getCurrent().subscribeAvailablePanelHeight?.((height) => {
            received.push(height);
        });

        expect(received[0]).toBe(700 - 34);
    });
});
