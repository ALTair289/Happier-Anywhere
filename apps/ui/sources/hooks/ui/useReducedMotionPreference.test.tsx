import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type MediaChangeListener = (event: { matches: boolean }) => void;

const mediaState = vi.hoisted(() => ({
    matches: false,
    changeListeners: [] as MediaChangeListener[],
    matchMediaCalls: [] as string[],
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

function installMatchMedia(): () => void {
    const previousWindow = (globalThis as { window?: unknown }).window;
    (globalThis as { window?: unknown }).window = {
        matchMedia: (query: string) => {
            mediaState.matchMediaCalls.push(query);
            return {
                get matches() {
                    return mediaState.matches;
                },
                addEventListener: (event: string, listener: MediaChangeListener) => {
                    if (event === 'change') mediaState.changeListeners.push(listener);
                },
                removeEventListener: (event: string, listener: MediaChangeListener) => {
                    if (event !== 'change') return;
                    const index = mediaState.changeListeners.indexOf(listener);
                    if (index >= 0) mediaState.changeListeners.splice(index, 1);
                },
            };
        },
    };
    return () => {
        (globalThis as { window?: unknown }).window = previousWindow;
    };
}

const CONSUMER_COUNT = 12;

function ReducedMotionProbe(props: Readonly<{ index: number; read: () => boolean }>): React.ReactElement {
    const reducedMotion = props.read();
    return React.createElement('ReducedMotionProbe', {
        testID: `reduced-motion-probe:${props.index}`,
        reducedMotion,
    });
}

describe('useReducedMotionPreference', () => {
    afterEach(() => {
        standardCleanup();
    });

    it('shares one platform subscription across every reader and updates them all on change', async () => {
        const restoreWindow = installMatchMedia();
        try {
            const { useReducedMotionPreference } = await import('./useReducedMotionPreference');
            const read = () => useReducedMotionPreference();

            const screen = await renderScreen(
                React.createElement(
                    'Host',
                    null,
                    Array.from({ length: CONSUMER_COUNT }, (_unused, index) =>
                        React.createElement(ReducedMotionProbe, { key: index, index, read }),
                    ),
                ),
            );

            // One store, many readers: mounting N consumers must not mount N
            // media-query listeners.
            expect(mediaState.changeListeners).toHaveLength(1);
            expect(
                screen.findAllByTestId(`reduced-motion-probe:${CONSUMER_COUNT - 1}`)[0]?.props.reducedMotion,
            ).toBe(false);

            await act(async () => {
                mediaState.matches = true;
                for (const listener of [...mediaState.changeListeners]) {
                    listener({ matches: true });
                }
            });

            for (let index = 0; index < CONSUMER_COUNT; index += 1) {
                expect(screen.findAllByTestId(`reduced-motion-probe:${index}`)[0]?.props.reducedMotion).toBe(true);
            }
        } finally {
            restoreWindow();
        }
    });
});
