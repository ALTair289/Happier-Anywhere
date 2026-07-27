import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

describe('StatusPill', () => {
    it('renders a semantic status pill with a stable variant marker', async () => {
        const { StatusPill } = await import('./StatusPill');

        const screen = await renderScreen(<StatusPill variant="success" label="Online" testID="status-online" />);

        expect(screen.findByTestId('status-online')).not.toBeNull();
        expect(screen.findByTestId('status-online:variant:success')).not.toBeNull();
        expect(screen.getTextContent()).toContain('Online');
    });

    it('keeps the variant marker out of flex layout', async () => {
        const { StatusPill } = await import('./StatusPill');

        const screen = await renderScreen(<StatusPill variant="success" label="Online" testID="status-online" />);
        const variantMarker = screen.findByTestId('status-online:variant:success');
        const flat = flattenStyle(variantMarker?.props.style);

        expect(flat.position).toBe('absolute');
        expect(flat.width).toBe(0);
        expect(flat.height).toBe(0);
    });

    it('can hide the leading dot without hiding the label', async () => {
        const { StatusPill } = await import('./StatusPill');

        const screen = await renderScreen(<StatusPill variant="neutral" label="Clean" hideDot testID="status-clean" />);

        expect(screen.findByTestId('status-clean:dot')).toBeNull();
        expect(screen.getTextContent()).toContain('Clean');
    });

    it('can render without badge chrome for inline status rows', async () => {
        const { StatusPill } = await import('./StatusPill');

        const screen = await renderScreen(
            <StatusPill
                variant="success"
                label="online"
                chrome="plain"
                foregroundColor="#34C759"
                dotColor="#34C759"
                testID="status-online"
            />,
        );
        const container = screen.findByTestId('status-online');
        const flat = flattenStyle(container?.props.style);

        expect(flat.borderWidth).toBe(0);
        expect(flat.backgroundColor).toBe('transparent');
        expect(flat.paddingHorizontal).toBe(0);
        expect(flat.paddingVertical).toBe(0);
        expect(screen.findByTestId('status-online:dot')).not.toBeNull();
        expect(screen.getTextContent()).toContain('online');
    });

    it('renders the default pill chrome as background-only with no border', async () => {
        const { StatusPill } = await import('./StatusPill');

        const screen = await renderScreen(<StatusPill variant="success" label="Online" testID="status-online" />);
        const container = screen.findByTestId('status-online');
        const flat = flattenStyle(container?.props.style);

        // Badges are background-only app-wide: keep the fill, drop the border chrome.
        expect(flat.borderWidth).toBe(0);
        expect(flat.borderColor).toBeUndefined();
        expect(typeof flat.backgroundColor).toBe('string');
        expect(flat.backgroundColor).not.toBe('transparent');
    });

    it('uses compact pill typography for the label', async () => {
        const { StatusPill } = await import('./StatusPill');

        const screen = await renderScreen(<StatusPill variant="info" label="Syncing" testID="status-sync" />);
        const textNode = screen.findByTestId('status-sync:label');
        const flat = flattenStyle(textNode?.props.style);

        expect(Number(flat.fontSize)).toBeGreaterThan(0);
        expect(Number(flat.lineHeight)).toBeGreaterThanOrEqual(Number(flat.fontSize));
    });

    it('uses regular untracked typography for phrase labels', async () => {
        const { StatusPill } = await import('./StatusPill');

        const screen = await renderScreen(
            <StatusPill variant="warning" label="Account rotation pending" labelVariant="phrase" testID="status-rotation" />,
        );
        const label = screen.findByTestId('status-rotation:label');
        const flat = flattenStyle(label?.props.style);

        expect(flat.fontWeight).toBe('400');
        expect(flat.letterSpacing).toBe(0);
    });

    it('replaces the dot with a leading element and truncates constrained labels', async () => {
        const { StatusPill } = await import('./StatusPill');

        const screen = await renderScreen(
            <StatusPill
                variant="info"
                label="A deliberately long status phrase"
                leading={<React.Fragment>marker</React.Fragment>}
                labelNumberOfLines={1}
                testID="status-constrained"
            />,
        );
        const label = screen.findByTestId('status-constrained:label');
        const flat = flattenStyle(label?.props.style);

        expect(screen.findByTestId('status-constrained:dot')).toBeNull();
        expect(screen.getTextContent()).toContain('marker');
        expect(label?.props.numberOfLines).toBe(1);
        expect(label?.props.ellipsizeMode).toBe('tail');
        expect(flat.flexShrink).toBe(1);
    });
});

function flattenStyle(style: unknown): Record<string, any> {
    if (!style) return {};
    if (Array.isArray(style)) {
        return style.reduce<Record<string, any>>((acc, entry) => ({ ...acc, ...flattenStyle(entry) }), {});
    }
    if (typeof style === 'object') return style as Record<string, any>;
    return {};
}
