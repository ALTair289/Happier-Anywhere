import { describe, expect, it } from 'vitest';

import {
    mapTranscriptListIndexBetweenOrders,
    orientTranscriptListItems,
    resolveEntrySliceSourceBounds,
    resolveOlderNeighborRenderedIndex,
    resolveOrientedListEdgeSlots,
    resolveTranscriptListPresentation,
} from './listOrientation';

describe('resolveTranscriptListPresentation', () => {
    it('resolves native to the canonical inverted FlashList presentation without reading a setting', () => {
        const presentation = resolveTranscriptListPresentation({ platformIsWeb: false });

        expect(presentation).toEqual({ orientation: 'inverted' });
        expect(presentation).not.toHaveProperty('implementation');
    });

    it('resolves web to the canonical standard FlashList presentation without reading a setting', () => {
        const presentation = resolveTranscriptListPresentation({ platformIsWeb: true });

        expect(presentation).toEqual({ orientation: 'standard' });
        expect(presentation).not.toHaveProperty('implementation');
    });
});

describe('orientTranscriptListItems', () => {
    it('returns the same array reference in standard orientation', () => {
        const items = ['a', 'b', 'c'];
        expect(orientTranscriptListItems(items, 'standard')).toBe(items);
        const empty: string[] = [];
        expect(orientTranscriptListItems(empty, 'standard')).toBe(empty);
    });

    it('returns a newest-first reversed copy in inverted orientation without mutating the input', () => {
        const items = ['oldest', 'middle', 'newest'];
        const result = orientTranscriptListItems(items, 'inverted');
        expect(result).toEqual(['newest', 'middle', 'oldest']);
        expect(result).not.toBe(items);
        expect(items).toEqual(['oldest', 'middle', 'newest']);
    });

    it('handles empty and single-item lists in inverted orientation', () => {
        const empty: string[] = [];
        expect(orientTranscriptListItems(empty, 'inverted')).toEqual([]);
        const single = ['only'];
        expect(orientTranscriptListItems(single, 'inverted')).toEqual(['only']);
    });
});

describe('mapTranscriptListIndexBetweenOrders', () => {
    it('is the identity in standard orientation for in-range indices', () => {
        expect(mapTranscriptListIndexBetweenOrders(0, 5, 'standard')).toBe(0);
        expect(mapTranscriptListIndexBetweenOrders(2, 5, 'standard')).toBe(2);
        expect(mapTranscriptListIndexBetweenOrders(4, 5, 'standard')).toBe(4);
        expect(mapTranscriptListIndexBetweenOrders(0, 1, 'standard')).toBe(0);
    });

    it('mirrors the index in inverted orientation', () => {
        expect(mapTranscriptListIndexBetweenOrders(0, 5, 'inverted')).toBe(4);
        expect(mapTranscriptListIndexBetweenOrders(4, 5, 'inverted')).toBe(0);
        expect(mapTranscriptListIndexBetweenOrders(2, 5, 'inverted')).toBe(2);
        expect(mapTranscriptListIndexBetweenOrders(0, 1, 'inverted')).toBe(0);
    });

    it('is involutive for all in-range indices in both orientations', () => {
        const count = 7;
        for (const orientation of ['standard', 'inverted'] as const) {
            for (let index = 0; index < count; index += 1) {
                const mapped = mapTranscriptListIndexBetweenOrders(index, count, orientation);
                expect(mapped).not.toBeNull();
                expect(mapTranscriptListIndexBetweenOrders(mapped as number, count, orientation)).toBe(index);
            }
        }
    });

    it('returns null for out-of-range indices in both orientations', () => {
        for (const orientation of ['standard', 'inverted'] as const) {
            expect(mapTranscriptListIndexBetweenOrders(-1, 5, orientation)).toBeNull();
            expect(mapTranscriptListIndexBetweenOrders(5, 5, orientation)).toBeNull();
            expect(mapTranscriptListIndexBetweenOrders(100, 5, orientation)).toBeNull();
        }
    });

    it('returns null for non-integer and non-finite indices', () => {
        for (const orientation of ['standard', 'inverted'] as const) {
            expect(mapTranscriptListIndexBetweenOrders(1.5, 5, orientation)).toBeNull();
            expect(mapTranscriptListIndexBetweenOrders(Number.NaN, 5, orientation)).toBeNull();
            expect(mapTranscriptListIndexBetweenOrders(Number.POSITIVE_INFINITY, 5, orientation)).toBeNull();
            expect(mapTranscriptListIndexBetweenOrders(Number.NEGATIVE_INFINITY, 5, orientation)).toBeNull();
        }
    });

    it('returns null for empty and non-positive counts', () => {
        for (const orientation of ['standard', 'inverted'] as const) {
            expect(mapTranscriptListIndexBetweenOrders(0, 0, orientation)).toBeNull();
            expect(mapTranscriptListIndexBetweenOrders(0, -3, orientation)).toBeNull();
        }
    });
});

describe('resolveOlderNeighborRenderedIndex', () => {
    it('returns index - 1 in standard orientation (older rows render above)', () => {
        expect(resolveOlderNeighborRenderedIndex(3, 5, 'standard')).toBe(2);
        expect(resolveOlderNeighborRenderedIndex(1, 5, 'standard')).toBe(0);
        expect(resolveOlderNeighborRenderedIndex(4, 5, 'standard')).toBe(3);
    });

    it('returns index + 1 in inverted orientation (older rows render below)', () => {
        expect(resolveOlderNeighborRenderedIndex(0, 5, 'inverted')).toBe(1);
        expect(resolveOlderNeighborRenderedIndex(3, 5, 'inverted')).toBe(4);
    });

    it('returns null when the older neighbor falls outside the list', () => {
        expect(resolveOlderNeighborRenderedIndex(0, 5, 'standard')).toBeNull();
        expect(resolveOlderNeighborRenderedIndex(4, 5, 'inverted')).toBeNull();
        expect(resolveOlderNeighborRenderedIndex(0, 1, 'standard')).toBeNull();
        expect(resolveOlderNeighborRenderedIndex(0, 1, 'inverted')).toBeNull();
    });

    it('returns null when the input index is outside the list or non-integer', () => {
        for (const orientation of ['standard', 'inverted'] as const) {
            expect(resolveOlderNeighborRenderedIndex(-1, 5, orientation)).toBeNull();
            expect(resolveOlderNeighborRenderedIndex(5, 5, orientation)).toBeNull();
            expect(resolveOlderNeighborRenderedIndex(2.5, 5, orientation)).toBeNull();
            expect(resolveOlderNeighborRenderedIndex(Number.NaN, 5, orientation)).toBeNull();
            expect(resolveOlderNeighborRenderedIndex(Number.POSITIVE_INFINITY, 5, orientation)).toBeNull();
            expect(resolveOlderNeighborRenderedIndex(0, 0, orientation)).toBeNull();
        }
    });
});

describe('resolveEntrySliceSourceBounds', () => {
    it('withholds older rows in standard orientation', () => {
        expect(resolveEntrySliceSourceBounds({ anchorSourceIndex: 3, count: 10, orientation: 'standard' })).toEqual({ start: 3, end: 10 });
        expect(resolveEntrySliceSourceBounds({ anchorSourceIndex: 0, count: 10, orientation: 'standard' })).toEqual({ start: 0, end: 10 });
        expect(resolveEntrySliceSourceBounds({ anchorSourceIndex: 9, count: 10, orientation: 'standard' })).toEqual({ start: 9, end: 10 });
    });

    it('withholds newer rows in inverted orientation', () => {
        expect(resolveEntrySliceSourceBounds({ anchorSourceIndex: 3, count: 10, orientation: 'inverted' })).toEqual({ start: 0, end: 4 });
        expect(resolveEntrySliceSourceBounds({ anchorSourceIndex: 0, count: 10, orientation: 'inverted' })).toEqual({ start: 0, end: 1 });
        expect(resolveEntrySliceSourceBounds({ anchorSourceIndex: 9, count: 10, orientation: 'inverted' })).toEqual({ start: 0, end: 10 });
    });

    it('handles a single-item list', () => {
        expect(resolveEntrySliceSourceBounds({ anchorSourceIndex: 0, count: 1, orientation: 'standard' })).toEqual({ start: 0, end: 1 });
        expect(resolveEntrySliceSourceBounds({ anchorSourceIndex: 0, count: 1, orientation: 'inverted' })).toEqual({ start: 0, end: 1 });
    });

    it('fails open to the full window for out-of-range anchors', () => {
        for (const orientation of ['standard', 'inverted'] as const) {
            expect(resolveEntrySliceSourceBounds({ anchorSourceIndex: -1, count: 10, orientation })).toEqual({ start: 0, end: 10 });
            expect(resolveEntrySliceSourceBounds({ anchorSourceIndex: 10, count: 10, orientation })).toEqual({ start: 0, end: 10 });
            expect(resolveEntrySliceSourceBounds({ anchorSourceIndex: 2.5, count: 10, orientation })).toEqual({ start: 0, end: 10 });
            expect(resolveEntrySliceSourceBounds({ anchorSourceIndex: Number.NaN, count: 10, orientation })).toEqual({ start: 0, end: 10 });
        }
    });

    it('fails open to an empty full window for non-positive counts', () => {
        for (const orientation of ['standard', 'inverted'] as const) {
            expect(resolveEntrySliceSourceBounds({ anchorSourceIndex: 0, count: 0, orientation })).toEqual({ start: 0, end: 0 });
            expect(resolveEntrySliceSourceBounds({ anchorSourceIndex: 0, count: -5, orientation })).toEqual({ start: 0, end: 0 });
        }
    });

    it('produces bounds usable directly with Array.prototype.slice', () => {
        const items = ['m0', 'm1', 'm2', 'm3', 'm4'];
        const standard = resolveEntrySliceSourceBounds({ anchorSourceIndex: 2, count: items.length, orientation: 'standard' });
        expect(items.slice(standard.start, standard.end)).toEqual(['m2', 'm3', 'm4']);
        const inverted = resolveEntrySliceSourceBounds({ anchorSourceIndex: 2, count: items.length, orientation: 'inverted' });
        expect(items.slice(inverted.start, inverted.end)).toEqual(['m0', 'm1', 'm2']);
    });
});

describe('resolveOrientedListEdgeSlots', () => {
    it('keeps slots in place in standard orientation', () => {
        const visualTopNode = { id: 'top' };
        const visualBottomNode = { id: 'bottom' };
        const slots = resolveOrientedListEdgeSlots({ orientation: 'standard', visualTopNode, visualBottomNode });
        expect(slots.listHeaderNode).toBe(visualTopNode);
        expect(slots.listFooterNode).toBe(visualBottomNode);
    });

    it('swaps slots in inverted orientation (header slot renders at the visual bottom)', () => {
        const visualTopNode = { id: 'top' };
        const visualBottomNode = { id: 'bottom' };
        const slots = resolveOrientedListEdgeSlots({ orientation: 'inverted', visualTopNode, visualBottomNode });
        expect(slots.listHeaderNode).toBe(visualBottomNode);
        expect(slots.listFooterNode).toBe(visualTopNode);
    });
});
