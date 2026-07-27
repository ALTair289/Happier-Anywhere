import * as React from 'react';
import { Pressable } from 'react-native';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const platformState = vi.hoisted(() => ({ os: 'web' }));

function flattenStyle(style: unknown): Record<string, unknown> {
    if (Array.isArray(style)) {
        return Object.assign({}, ...style.map((entry) => flattenStyle(entry)));
    }
    if (style && typeof style === 'object') {
        return style as Record<string, unknown>;
    }
    return {};
}

function readOpacity(style: unknown): number | undefined {
    const opacity = flattenStyle(style).opacity;
    if (typeof opacity === 'number') return opacity;
    const animated = opacity as { __getValue?: () => number } | undefined;
    return typeof animated?.__getValue === 'function' ? animated.__getValue() : undefined;
}

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Platform: {
            get OS() {
                return platformState.os;
            },
            select: (values: Record<string, unknown>) => values[platformState.os] ?? values.default,
        },
    });
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@/hooks/ui/useReducedMotionPreference', () => ({
    useReducedMotionPreference: () => false,
}));

describe('RowActionRevealSlot', () => {
    afterEach(() => {
        standardCleanup();
        platformState.os = 'web';
    });

    it('reserves its footprint and blocks pointer interaction while hidden', async () => {
        const { RowActionRevealSlot } = await import('./RowActionRevealSlot');

        const screen = await renderScreen(
            <RowActionRevealSlot revealed={false} reserveWidth={26} testID="slot">
                <Pressable testID="slot-action" onPress={() => undefined} />
            </RowActionRevealSlot>,
        );

        const style = flattenStyle(screen.findByTestId('slot')?.props.style);
        expect(style.width).toBe(26);
        expect(style.pointerEvents).toBe('none');
        expect(readOpacity(style)).toBe(0);
        expect(screen.findByTestId('slot-action')).toBeTruthy();
    });

    it('reveals on descendant focus so a hidden action is never activatable while invisible', async () => {
        const { RowActionRevealSlot } = await import('./RowActionRevealSlot');

        function Host() {
            const [focused, setFocused] = React.useState(false);
            return (
                <RowActionRevealSlot
                    revealed={focused}
                    testID="slot"
                    onFocus={() => setFocused(true)}
                    onBlur={() => setFocused(false)}
                >
                    <Pressable testID="slot-action" onPress={() => undefined} />
                </RowActionRevealSlot>
            );
        }

        const screen = await renderScreen(<Host />);

        expect(readOpacity(screen.findByTestId('slot')?.props.style)).toBe(0);
        // Hidden actions stay reachable by assistive tech: hiding them from the a11y
        // tree while leaving them focusable is what made invisible buttons activatable.
        expect(screen.findByTestId('slot')?.props['aria-hidden']).toBeUndefined();
        expect(screen.findByTestId('slot')?.props.accessibilityElementsHidden).toBeUndefined();

        act(() => {
            screen.findByTestId('slot')?.props.onFocus?.();
        });

        expect(readOpacity(screen.findByTestId('slot')?.props.style)).toBe(1);
        expect(flattenStyle(screen.findByTestId('slot')?.props.style).pointerEvents).toBe('auto');

        act(() => {
            screen.findByTestId('slot')?.props.onBlur?.();
        });

        expect(readOpacity(screen.findByTestId('slot')?.props.style)).toBe(0);
    });

    it('uses the native pointerEvents prop off web', async () => {
        platformState.os = 'ios';
        const { RowActionRevealSlot } = await import('./RowActionRevealSlot');

        const screen = await renderScreen(
            <RowActionRevealSlot revealed={false} testID="slot">
                <Pressable testID="slot-action" onPress={() => undefined} />
            </RowActionRevealSlot>,
        );

        expect(screen.findByTestId('slot')?.props.pointerEvents).toBe('none');
    });
});
