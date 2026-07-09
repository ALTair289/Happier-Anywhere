import { describe, expect, it } from 'vitest';

import {
    createLegendListRuntimeModel,
    type LegendListRuntimeModelRow,
} from './legendListRuntimeModel';

function rows(count: number, options: Readonly<{ heightPx?: number; start?: number }> = {}): LegendListRuntimeModelRow[] {
    const heightPx = options.heightPx ?? 100;
    const start = options.start ?? 0;
    return Array.from({ length: count }, (_value, index) => ({
        heightPx,
        key: `message-${start + index}`,
    }));
}

describe('Legend List runtime contract model', () => {
    it('opens chronological data at the live tail without using an inverted raw-offset model', () => {
        const model = createLegendListRuntimeModel({
            alignItemsAtEnd: true,
            initialScrollAtEnd: true,
            layoutHeightPx: 300,
            rows: rows(8, { heightPx: 75 }),
        });

        expect(model.observe()).toMatchObject({
            dataOrder: 'oldest-first',
            distanceFromEndPx: 0,
            initialScrollAtEnd: true,
            orientation: 'standard',
            rawOffsetY: 300,
        });
        expect(model.onScreenTopOfRow('message-7')).toBe(225);
    });

    it('preserves the visible anchor when older rows are prepended with MVCP data and size enabled', () => {
        const model = createLegendListRuntimeModel({
            initialScrollAtEnd: true,
            layoutHeightPx: 300,
            maintainVisibleContentPosition: { data: true, size: true },
            rows: rows(10, { heightPx: 80 }),
        });

        model.scrollToIndex({ index: 4, viewPosition: 0 });
        const beforeTop = model.onScreenTopOfRow('message-4');
        const diff = model.prependOlder(rows(3, { heightPx: 50, start: -3 }));

        expect(diff).toBe(150);
        expect(model.onScreenTopOfRow('message-4')).toBe(beforeTop);
        expect(model.computeVisibleIndices()).toEqual({ startIndex: 7, endIndex: 10 });
    });

    it('jumps to canonical chronological indices and reports visible ranges through the shell contract', () => {
        const model = createLegendListRuntimeModel({
            initialScrollAtEnd: false,
            layoutHeightPx: 250,
            rows: rows(12, { heightPx: 50 }),
        });

        expect(model.scrollToIndex({ index: 7, viewPosition: 0.5 })).toEqual({
            appliedOffsetY: 225,
            index: 7,
        });
        expect(model.onScreenTopOfRow('message-7')).toBe(125);
        expect(model.computeVisibleIndices()).toEqual({ startIndex: 4, endIndex: 9 });
    });

    it('keeps bottom-follow attached for newer appends while already at the live tail', () => {
        const model = createLegendListRuntimeModel({
            initialScrollAtEnd: true,
            layoutHeightPx: 300,
            maintainScrollAtEnd: true,
            rows: rows(6, { heightPx: 100 }),
        });

        model.appendNewer(rows(2, { heightPx: 75, start: 6 }));

        expect(model.observe()).toMatchObject({
            distanceFromEndPx: 0,
            rawOffsetY: 450,
        });
        expect(model.onScreenTopOfRow('message-7')).toBe(225);
    });

    it('leaves newer appends to the external write scheduler when maintainScrollAtEnd is disabled', () => {
        const model = createLegendListRuntimeModel({
            initialScrollAtEnd: true,
            layoutHeightPx: 300,
            maintainScrollAtEnd: false,
            rows: rows(6, { heightPx: 100 }),
        });

        const beforeAppend = model.observe();
        model.appendNewer(rows(2, { heightPx: 75, start: 6 }));

        expect(beforeAppend).toMatchObject({
            distanceFromEndPx: 0,
            rawOffsetY: 300,
        });
        expect(model.observe()).toMatchObject({
            distanceFromEndPx: 150,
            rawOffsetY: 300,
        });
        model.scrollToEnd();
        expect(model.observe().distanceFromEndPx).toBe(0);
    });

    it('maps semantic distance-from-live-tail commands into standard scroll offsets', () => {
        const model = createLegendListRuntimeModel({
            initialScrollAtEnd: false,
            layoutHeightPx: 300,
            rows: rows(8, { heightPx: 100 }),
        });

        expect(model.scrollToOffset({ offset: 275 })).toEqual({ appliedOffsetY: 275 });
        expect(model.observe()).toMatchObject({
            distanceFromEndPx: 225,
            rawOffsetY: 275,
        });

        const distanceFromLiveTailPx = 125;
        const standardOffset = model.observe().contentHeightPx - model.observe().layoutHeightPx - distanceFromLiveTailPx;
        expect(model.scrollToOffset({ offset: standardOffset })).toEqual({ appliedOffsetY: 375 });
        expect(model.observe()).toMatchObject({
            distanceFromEndPx: 125,
            rawOffsetY: 375,
        });
    });

    it('detaches bottom-follow after the user scrolls away before newer appends arrive', () => {
        const model = createLegendListRuntimeModel({
            initialScrollAtEnd: true,
            layoutHeightPx: 300,
            maintainScrollAtEnd: true,
            rows: rows(8, { heightPx: 100 }),
        });

        model.userScrollBy(-150);
        const beforeAppend = model.observe();
        model.appendNewer(rows(2, { heightPx: 100, start: 8 }));

        expect(beforeAppend.distanceFromEndPx).toBe(150);
        expect(model.observe()).toMatchObject({
            distanceFromEndPx: 350,
            rawOffsetY: beforeAppend.rawOffsetY,
        });
    });

    it('jumps back to the live tail after the user has detached', () => {
        const model = createLegendListRuntimeModel({
            initialScrollAtEnd: true,
            layoutHeightPx: 300,
            maintainScrollAtEnd: true,
            rows: rows(8, { heightPx: 100 }),
        });

        model.userScrollBy(-250);
        expect(model.observe().distanceFromEndPx).toBe(250);

        model.scrollToEnd();

        expect(model.observe()).toMatchObject({
            distanceFromEndPx: 0,
            rawOffsetY: 500,
        });
    });

    it('keeps the anchored row stable when giant markdown prepends grow after measurement', () => {
        const model = createLegendListRuntimeModel({
            initialScrollAtEnd: false,
            layoutHeightPx: 800,
            maintainVisibleContentPosition: { data: true, size: true },
            rows: rows(12, { heightPx: 220 }),
        });

        model.scrollToIndex({ index: 5, viewPosition: 0.25 });
        const beforeTop = model.onScreenTopOfRow('message-5');

        model.prependOlder([
            { key: 'giant-old-2', heightPx: 3200 },
            { key: 'giant-old-1', heightPx: 2800 },
        ]);
        expect(model.onScreenTopOfRow('message-5')).toBe(beforeTop);

        model.resizeRow('giant-old-2', 6400);
        model.resizeRow('giant-old-1', 5200);

        expect(model.onScreenTopOfRow('message-5')).toBe(beforeTop);
        expect(model.observe().distanceFromEndPx).toBeGreaterThan(0);
    });
});
