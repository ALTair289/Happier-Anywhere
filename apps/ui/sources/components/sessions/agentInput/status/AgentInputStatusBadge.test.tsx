import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('Text', props, props.children),
}));

function flattenStyle(style: unknown): Record<string, unknown> {
    if (Array.isArray(style)) {
        return style.reduce<Record<string, unknown>>((acc, entry) => ({
            ...acc,
            ...flattenStyle(entry),
        }), {});
    }
    return style && typeof style === 'object' ? style as Record<string, unknown> : {};
}

describe('AgentInputStatusBadge', () => {
    it('maps quiet active badges to pressable plain info pills', async () => {
        const onPress = vi.fn();
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
        const { AgentInputStatusBadge } = await import('./AgentInputStatusBadge');

        try {
            const screen = await renderScreen(
                <AgentInputStatusBadge
                    key="work-state"
                    label="Goal: Ship the release"
                    testID="quiet-work-state-badge"
                    tone="active"
                    emphasis="quiet"
                    onPress={onPress}
                    accessibilityHint="Open status details"
                    accessibilityState={{ expanded: false }}
                />,
            );

            const badge = screen.findByTestId('quiet-work-state-badge');
            const pill = screen.findByTestId('quiet-work-state-badge:pill');
            const pillStyle = flattenStyle(pill?.props.style);
            const label = screen.findByTestId('quiet-work-state-badge:pill:label');

            expect(badge?.type).toBe('Pressable');
            expect(badge?.props.accessibilityRole).toBe('button');
            expect(badge?.props.accessibilityHint).toBe('Open status details');
            expect(badge?.props.accessibilityState).toEqual({ expanded: false });
            expect(badge?.props.hitSlop).toEqual({ top: 10, bottom: 10, left: 6, right: 6 });
            expect(pillStyle).toEqual(expect.objectContaining({
                backgroundColor: 'transparent',
                borderWidth: 0,
            }));
            expect(screen.findByTestId('quiet-work-state-badge:pill:variant:info')).not.toBeNull();
            expect(screen.findByTestId('quiet-work-state-badge:pill:dot')).toBeNull();
            expect(label?.props.numberOfLines).toBe(1);
            expect(screen.getTextContent()).toContain('Goal: Ship the release');

            badge?.props.onPress?.();
            expect(onPress).toHaveBeenCalledTimes(1);
        } finally {
            consoleError.mockRestore();
        }
    });
});
