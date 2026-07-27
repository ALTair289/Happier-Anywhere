import * as React from 'react';

import type { RenderScreenResult } from '@/dev/testkit/render/renderScreen';

// The react-native mock factory below imports this module, so nothing here may
// import `@/dev/testkit` at module scope: that pulls react-native back in while
// its own mock factory is still resolving and the import never settles.

export type RowActionRevealSlotCostState = {
    animatedValues: number;
    timings: number;
    changeListeners: Array<(event: { matches: boolean }) => void>;
};

export const ROW_ACTION_REVEAL_SLOT_COST_ROW_COUNT = 24;

/**
 * Shared react-native mock for the reveal-slot cost tests: counts the animation
 * machinery a row pays for, so "N rows cost N animated values" is an assertion
 * rather than a claim.
 */
export async function createRowActionRevealSlotCostReactNativeMock(
    costState: RowActionRevealSlotCostState,
    platformState: { os: string },
): Promise<unknown> {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    class CountingAnimatedValue {
        private value: number;
        constructor(value: number) {
            this.value = value;
            costState.animatedValues += 1;
        }
        setValue(next: number): void {
            this.value = next;
        }
        interpolate(): CountingAnimatedValue {
            return this;
        }
        __getValue(): number {
            return this.value;
        }
    }
    return createReactNativeWebMock({
        Platform: {
            get OS() {
                return platformState.os;
            },
            select: (values: Record<string, unknown>) => values[platformState.os] ?? values.default,
        },
        Animated: {
            Value: CountingAnimatedValue,
            timing: () => {
                costState.timings += 1;
                return {
                    start: (callback?: (result: { finished: boolean }) => void) => callback?.({ finished: true }),
                    stop: () => undefined,
                };
            },
        },
    });
}

export function installRowActionRevealSlotCostMatchMedia(
    costState: RowActionRevealSlotCostState,
): () => void {
    const previousWindow = (globalThis as { window?: unknown }).window;
    (globalThis as { window?: unknown }).window = {
        matchMedia: () => ({
            matches: false,
            addEventListener: (event: string, listener: (payload: { matches: boolean }) => void) => {
                if (event === 'change') costState.changeListeners.push(listener);
            },
            removeEventListener: (event: string, listener: (payload: { matches: boolean }) => void) => {
                if (event !== 'change') return;
                const index = costState.changeListeners.indexOf(listener);
                if (index >= 0) costState.changeListeners.splice(index, 1);
            },
        }),
    };
    return () => {
        (globalThis as { window?: unknown }).window = previousWindow;
    };
}

export async function renderRowActionRevealSlotRows(): Promise<RenderScreenResult> {
    const { renderScreen } = await import('@/dev/testkit');
    const { RowActionRevealSlot } = await import('./RowActionRevealSlot');
    return renderScreen(
        React.createElement(
            'Rows',
            null,
            Array.from({ length: ROW_ACTION_REVEAL_SLOT_COST_ROW_COUNT }, (_unused, index) => (
                <RowActionRevealSlot key={index} revealed testID={`slot:${index}`}>
                    {React.createElement('Pin', { testID: `pin:${index}` })}
                </RowActionRevealSlot>
            )),
        ),
    );
}
