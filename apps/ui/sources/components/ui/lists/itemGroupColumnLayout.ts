/**
 * Column-count and distribution rules for multi-column {@link ItemGroup} lists.
 *
 * Column count is decided by AVAILABLE WIDTH, not by the device viewport class.
 * A viewport class is a min-edge device heuristic — a short, wide desktop window
 * classifies as `compact` while having ample room for two columns of list rows.
 * Width is the only thing that actually decides whether a second column fits.
 */

/** Narrowest a list-row column may become before collapsing back to one column. */
export const ITEM_GROUP_COLUMN_MIN_WIDTH_PX = 320;

/** Horizontal gutter between adjacent columns. */
export const ITEM_GROUP_COLUMN_GAP_PX = 12;

/** Vertical gutter between stacked cards inside one column. */
export const ITEM_GROUP_COLUMN_ROW_GAP_PX = 12;

export function resolveItemGroupColumnCountForWidth(params: Readonly<{
    availableWidthPx: number;
    requestedColumns: number;
    minColumnWidthPx?: number;
    columnGapPx?: number;
}>): number {
    const requested = Math.floor(params.requestedColumns);
    if (!Number.isFinite(requested) || requested <= 1) return 1;

    const availableWidthPx = params.availableWidthPx;
    // A non-finite width means "not measured yet" (or an unconstrained container).
    // Fail to the safe single-column layout rather than guessing a wide viewport.
    if (!Number.isFinite(availableWidthPx) || availableWidthPx <= 0) return 1;

    const minColumnWidthPx = params.minColumnWidthPx ?? ITEM_GROUP_COLUMN_MIN_WIDTH_PX;
    const columnGapPx = params.columnGapPx ?? ITEM_GROUP_COLUMN_GAP_PX;
    if (!Number.isFinite(minColumnWidthPx) || minColumnWidthPx <= 0) return requested;

    for (let count = requested; count > 1; count -= 1) {
        const requiredWidthPx = (count * minColumnWidthPx) + ((count - 1) * columnGapPx);
        if (requiredWidthPx <= availableWidthPx) return count;
    }
    return 1;
}

/**
 * Round-robin distribution into independent column stacks.
 *
 * Round-robin (not sequential fill) keeps a ranked list readable: with
 * attention-first ordering the two most urgent rows stay on the first visual
 * line instead of being stacked at the top of the left column. Independent
 * stacks also make the layout reflow-safe — an expandable row only pushes the
 * rows below it in its OWN column, never sideways into its neighbour.
 */
export function partitionItemsIntoColumns<T>(
    items: ReadonlyArray<T>,
    columnCount: number,
): T[][] {
    const count = Math.max(1, Math.floor(columnCount));
    const columns: T[][] = Array.from({ length: count }, () => []);
    items.forEach((item, index) => {
        columns[index % count]!.push(item);
    });
    return columns;
}
