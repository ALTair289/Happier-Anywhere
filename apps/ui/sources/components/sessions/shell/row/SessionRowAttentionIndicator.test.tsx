import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        View: 'View',
        ActivityIndicator: 'ActivityIndicator',
        Platform: {
            OS: 'web',
            select: (options: Record<string, unknown>) => options.web ?? options.default,
        },
    });
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('react-native-reanimated', () => ({
    default: { View: 'AnimatedView' },
    useAnimatedStyle: () => ({ opacity: 1 }),
    useSharedValue: (value: number) => ({ value }),
    withRepeat: (value: unknown) => value,
    withTiming: (value: unknown) => value,
}));

function flattenStyle(style: unknown): Record<string, unknown> {
    if (!style) return {};
    if (Array.isArray(style)) {
        return style.reduce((acc, item) => Object.assign(acc, flattenStyle(item)), {} as Record<string, unknown>);
    }
    if (typeof style === 'object') return style as Record<string, unknown>;
    return {};
}

describe('SessionRowAttentionIndicator', () => {
    it('uses a CSS transform spinner for compact working indicators on web instead of React Native Web ActivityIndicator', async () => {
        const { SessionRowAttentionIndicator } = await import('./SessionRowAttentionIndicator');

        const screen = await renderScreen(
            <SessionRowAttentionIndicator
                indicator="working"
                sessionId="session-a"
                attentionState="working"
                workingMode="spinner"
            />,
        );

        expect(screen.findAllByType('ActivityIndicator' as never)).toHaveLength(0);
        const spinner = screen.findByTestId('session-row-attention-indicator-spinner-session-a');
        if (!spinner) {
            throw new Error('Expected CSS working spinner to render');
        }
        expect(flattenStyle(spinner.props.style).animationName).toBe('happierActivitySpinnerSpin');
    });

    it('can render compact row indicators statically for mounted offscreen web rows', async () => {
        const { SessionRowAttentionIndicator } = await import('./SessionRowAttentionIndicator');

        const workingScreen = await renderScreen(
            <SessionRowAttentionIndicator
                indicator="working"
                sessionId="session-a"
                attentionState="working"
                workingMode="spinner"
                animationEnabled={false}
            />,
        );
        const spinner = workingScreen.findByTestId('session-row-attention-indicator-spinner-session-a');
        if (!spinner) {
            throw new Error('Expected CSS working spinner to render');
        }
        expect(flattenStyle(spinner.props.style).animationName).toBeUndefined();

        const failedScreen = await renderScreen(
            <SessionRowAttentionIndicator
                indicator="failed"
                sessionId="session-b"
                attentionState="failed"
                animationEnabled={false}
            />,
        );
        const dot = failedScreen.findByTestId('session-row-attention-indicator-dot-session-b');
        if (!dot) {
            throw new Error('Expected status dot to render');
        }
        expect(flattenStyle(dot.props.style).animationName).toBeUndefined();
    });

});
