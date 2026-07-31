import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Icon } from '@/components/ui/icons/Icon';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Platform: {
            OS: 'ios',
            select: (values: Record<string, unknown>) => values.ios ?? values.default ?? null,
        },
    });
});

describe('normalizeNodeForView', () => {
    beforeEach(() => {
        vi.resetModules();
    });

    it('does not wrap non-text icon components (AgentIcon) in Text', async () => {
        const { normalizeNodeForView } = await import('./normalizeNodeForView');

        function AgentIcon(_props: any) {
            return null;
        }
        AgentIcon.displayName = 'AgentIcon';

        const node = React.createElement(AgentIcon, { size: 14 });
        const normalized = normalizeNodeForView(node);

        // If we wrapped this element, we'd get a different React element.
        expect(normalized).toBe(node);
    });

    it('does not wrap icon-like components in Text', async () => {
        const { normalizeNodeForView } = await import('./normalizeNodeForView');

        function Ionicons(_props: any) {
            return null;
        }
        Ionicons.displayName = 'Ionicons';

        const node = <Icon name="lightning" size={16} />;
        const normalized = normalizeNodeForView(node);

        expect(normalized).toBe(node);
    });

    it('preserves a single child as a single node (React.Children.only contract)', async () => {
        const { normalizeNodeForView } = await import('./normalizeNodeForView');

        // Mirrors RNGH's `GestureDetector`, whose web wrapper calls
        // `React.Children.only(children)`. When a single-child element flows
        // through `Item`'s `rightElement` normalization, the clone must keep a
        // single child — collapsing it to a one-element ARRAY makes
        // `React.Children.only` throw, which RNGH rethrows as the misleading
        // "GestureDetector got more than one view as a child".
        const inner = React.createElement('Inner', null);
        const node = React.createElement('Outer', null, inner);

        const normalized = normalizeNodeForView(node) as React.ReactElement;
        const normalizedChildren = (normalized.props as { children?: React.ReactNode }).children;

        expect(Array.isArray(normalizedChildren)).toBe(false);
        expect(() => React.Children.only(normalizedChildren)).not.toThrow();
    });

    it('fans out multiple children to an array, preserves Fragment children, and tolerates empty children', async () => {
        const { normalizeNodeForView } = await import('./normalizeNodeForView');

        // Multiple element children -> the normalized clone keeps an array of both.
        const multi = React.createElement(
            'Outer',
            null,
            React.createElement('A', { key: 'a' }),
            React.createElement('B', { key: 'b' }),
        );
        const normalizedMulti = normalizeNodeForView(multi) as React.ReactElement;
        const multiChildren = (normalizedMulti.props as { children?: React.ReactNode }).children;
        expect(Array.isArray(multiChildren)).toBe(true);
        expect(React.Children.count(multiChildren)).toBe(2);

        // Explicit null children must not throw.
        const nullChildren = React.createElement('Outer', { children: null });
        expect(() => normalizeNodeForView(nullChildren)).not.toThrow();

        // A Fragment with multiple children preserves them as an array.
        const frag = React.createElement(
            React.Fragment,
            null,
            React.createElement('A', { key: 'a' }),
            React.createElement('B', { key: 'b' }),
        );
        const normalizedFrag = normalizeNodeForView(frag) as React.ReactElement;
        expect(React.Children.count((normalizedFrag.props as { children?: React.ReactNode }).children)).toBe(2);
    });
});
