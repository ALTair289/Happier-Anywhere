/**
 * Transcript list orientation seam.
 *
 * Owns presentation/data-order mapping only. Native raw scroll physics live in
 * the viewport driver.
 */

export type TranscriptListOrientation = 'standard' | 'inverted';

export type TranscriptListPresentation = Readonly<{
    orientation: TranscriptListOrientation;
}>;

function isInRangeIndex(index: number, count: number): boolean {
    return Number.isInteger(index) && index >= 0 && index < count;
}

/**
 * Resolves the platform to the canonical rendered list presentation.
 * Native FlashList is inverted; web FlashList stays standard because web hot/cold
 * split + DOM writers assume non-inverted block flow.
 */
export function resolveTranscriptListPresentation(
    params: Readonly<{ platformIsWeb: boolean }>
): TranscriptListPresentation {
    return {
        orientation: params.platformIsWeb ? 'standard' : 'inverted',
    };
}

/**
 * View adapter at the list boundary. standard: returns the SAME array reference
 * (identity — no alloc). inverted: newest-first reversed COPY (input never
 * mutated); may return the same reference when items.length <= 1.
 */
export function orientTranscriptListItems<T>(items: readonly T[], orientation: TranscriptListOrientation): readonly T[] {
    if (orientation === 'standard' || items.length <= 1) {
        return items;
    }
    return [...items].reverse();
}

/**
 * Involutive index map between oldest-first source order and rendered order.
 * standard: identity. inverted: count - 1 - index. Returns null for
 * non-integer, non-finite, or out-of-range [0, count) inputs, and for count <= 0.
 */
export function mapTranscriptListIndexBetweenOrders(
    index: number,
    count: number,
    orientation: TranscriptListOrientation
): number | null {
    if (!isInRangeIndex(index, count)) {
        return null;
    }
    return orientation === 'inverted' ? count - 1 - index : index;
}

/**
 * Rendered index of the CHRONOLOGICALLY previous (older) neighbor of a rendered
 * index. standard: index - 1. inverted: index + 1. Returns null when the
 * neighbor falls outside [0, count) or the input index is outside [0, count) /
 * non-integer.
 */
export function resolveOlderNeighborRenderedIndex(
    index: number,
    count: number,
    orientation: TranscriptListOrientation
): number | null {
    if (!isInRangeIndex(index, count)) {
        return null;
    }
    const neighbor = orientation === 'inverted' ? index + 1 : index - 1;
    return isInRangeIndex(neighbor, count) ? neighbor : null;
}

/**
 * Entry slice-from-anchor window bounds in SOURCE (oldest-first) index terms,
 * for Array.prototype.slice(start, end). standard withholds OLDER rows:
 * { start: anchorSourceIndex, end: count }. inverted withholds NEWER rows:
 * { start: 0, end: anchorSourceIndex + 1 }. Bounds are clamped into [0, count];
 * if anchorSourceIndex is out of [0, count) or count <= 0, returns the full
 * window { start: 0, end: max(0, count) } (fail open: reveal everything).
 */
export function resolveEntrySliceSourceBounds(
    params: Readonly<{ anchorSourceIndex: number; count: number; orientation: TranscriptListOrientation }>
): Readonly<{ start: number; end: number }> {
    const { anchorSourceIndex, count, orientation } = params;
    if (count <= 0 || !isInRangeIndex(anchorSourceIndex, count)) {
        return { start: 0, end: Math.max(0, count) };
    }
    if (orientation === 'inverted') {
        return { start: 0, end: Math.min(count, anchorSourceIndex + 1) };
    }
    return { start: Math.max(0, anchorSourceIndex), end: count };
}

/**
 * Maps the visual-top and visual-bottom edge nodes onto FlashList's
 * ListHeader/ListFooter slots. In an inverted list the header slot renders at
 * the data start = VISUAL BOTTOM, so the slots swap.
 */
export function resolveOrientedListEdgeSlots<T>(
    params: Readonly<{ orientation: TranscriptListOrientation; visualTopNode: T; visualBottomNode: T }>
): Readonly<{ listHeaderNode: T; listFooterNode: T }> {
    if (params.orientation === 'inverted') {
        return { listHeaderNode: params.visualBottomNode, listFooterNode: params.visualTopNode };
    }
    return { listHeaderNode: params.visualTopNode, listFooterNode: params.visualBottomNode };
}
