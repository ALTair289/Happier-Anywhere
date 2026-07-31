import { afterEach, describe, expect, it, vi } from 'vitest';

async function importItemDensityMetricsForPlatform(os: 'ios' | 'web') {
    vi.resetModules();
    vi.doMock('react-native', () => ({
        Platform: {
            OS: os,
            select: (value: Record<string, unknown>) => value[os] ?? value.default ?? undefined,
        },
    }));

    return await import('./itemDensityMetrics');
}

afterEach(() => {
    vi.doUnmock('react-native');
    vi.resetModules();
});

describe('itemDensityMetrics', () => {
    it('reserves extra room around comfortable iOS item icons', async () => {
        const { ITEM_ICON_BOX_SIZE } = await importItemDensityMetricsForPlatform('ios');

        expect(ITEM_ICON_BOX_SIZE.comfortable).toBeGreaterThan(29);
    });

    it('keeps the web comfortable icon box unchanged', async () => {
        const { ITEM_ICON_BOX_SIZE } = await importItemDensityMetricsForPlatform('web');

        expect(ITEM_ICON_BOX_SIZE.comfortable).toBe(32);
    });
});

describe('itemDensityMetrics glyph vs box', () => {
    it('keeps every glyph size on the app icon scale', async () => {
        const { ITEM_ICON_GLYPH_SIZE } = await importItemDensityMetricsForPlatform('web');
        const { ICON_SIZE } = await import('@/components/ui/icons/Icon');

        // Deriving these from the row's own type metrics was tried and reverted: it read as oversized
        // and, because iOS and web use different line heights, it silently gave the two platforms
        // different icons. A scale step is the same number everywhere.
        const scale = new Set<number>(Object.values(ICON_SIZE));
        for (const density of ['comfortable', 'cozy', 'compact', 'tight'] as const) {
            expect(scale.has(ITEM_ICON_GLYPH_SIZE[density])).toBe(true);
        }
    });

    it('resolves to the same glyph size on iOS and web', async () => {
        const ios = await importItemDensityMetricsForPlatform('ios');
        const web = await importItemDensityMetricsForPlatform('web');

        expect(ios.ITEM_ICON_GLYPH_SIZE).toEqual(web.ITEM_ICON_GLYPH_SIZE);
    });

    it('shrinks monotonically as the density tightens', async () => {
        const { ITEM_ICON_GLYPH_SIZE } = await importItemDensityMetricsForPlatform('web');

        const order = ['comfortable', 'cozy', 'compact', 'tight'] as const;
        for (let i = 1; i < order.length; i += 1) {
            expect(ITEM_ICON_GLYPH_SIZE[order[i]]).toBeLessThanOrEqual(ITEM_ICON_GLYPH_SIZE[order[i - 1]]);
        }
    });
});
