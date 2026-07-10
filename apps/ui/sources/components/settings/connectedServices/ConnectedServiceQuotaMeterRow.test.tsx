import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { lightTheme } from '@/theme';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({
        translate: (key, params) => {
            if (key === 'connectedServices.quota.remainingWithReset') {
                return `${String(params?.percent)} left · resets in ${String(params?.reset)}`;
            }
            if (key === 'connectedServices.quota.usageCount') {
                return `${String(params?.used)}/${String(params?.limit)} used`;
            }
            if (key === 'connectedServices.quota.duration.hours') {
                return `translated-${String(params?.hours)}h`;
            }
            return key;
        },
    });
});

describe('ConnectedServiceQuotaMeterRow', () => {
    it('renders remaining quota text and a consumed-quota bar state', async () => {
        const { ConnectedServiceQuotaMeterRow } = await import('./ConnectedServiceQuotaMeterRow');

        const nowMs = 1_000_000;
        const screen = await renderScreen(
            <ConnectedServiceQuotaMeterRow
                meter={{
                    meterId: 'weekly',
                    label: 'Weekly',
                    used: 82,
                    limit: 100,
                    unit: 'count',
                    utilizationPct: null,
                    resetsAt: nowMs + 2 * 60 * 60 * 1000,
                    status: 'ok',
                    details: {},
                }}
                nowMs={nowMs}
                pinned={false}
                onTogglePin={() => {}}
            />,
        );

        expect(screen.getTextContent()).toContain('18% left · resets in translated-2h');
        expect(screen.getTextContent()).toContain('82/100 used');

        const bar = screen.findByTestId('connected-service-quota-meter-row:remaining-bar:fill');
        const style = flattenStyle(bar?.props?.style);
        expect(style.width).toBe('82%');
        expect(style.backgroundColor).toBe(lightTheme.colors.state.warning.foreground);
    });

    it('renders unknown remaining quota as an unavailable dash without a remaining suffix', async () => {
        const { ConnectedServiceQuotaMeterRow } = await import('./ConnectedServiceQuotaMeterRow');

        const screen = await renderScreen(
            <ConnectedServiceQuotaMeterRow
                meter={{
                    meterId: 'oauth_apps',
                    label: 'Weekly (OAuth apps)',
                    used: null,
                    limit: null,
                    unit: 'unknown',
                    utilizationPct: null,
                    resetsAt: null,
                    status: 'ok',
                    details: {},
                }}
                nowMs={1_000_000}
                pinned={false}
                onTogglePin={() => {}}
            />,
        );

        expect(screen.getTextContent()).toContain('—');
        expect(screen.getTextContent()).not.toContain('— left');
    });
});

function flattenStyle(style: unknown): Record<string, unknown> {
    if (!style) return {};
    if (Array.isArray(style)) {
        return style.reduce<Record<string, unknown>>((acc, entry) => ({ ...acc, ...flattenStyle(entry) }), {});
    }
    if (typeof style === 'object') return style as Record<string, unknown>;
    return {};
}
