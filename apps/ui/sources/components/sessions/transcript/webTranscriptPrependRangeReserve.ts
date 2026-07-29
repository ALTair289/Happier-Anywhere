/**
 * Scroll range held below the web transcript content so a prepend restore can keep the anchored
 * scroll position while the virtualized list re-measures the rows it just gained.
 *
 * The reserve is bounded by one viewport, because that is the most an anchor restore can ever
 * consume: the restore targets the anchor row at its *currently measured* position, so its target
 * scroll top is at most `currentScrollHeight`, and reaching that target only needs
 * `currentScrollHeight + viewportHeight` of range. Anything beyond one viewport is empty space no
 * row can occupy.
 *
 * A shortfall larger than one viewport is therefore not prepend measurement lag at all — the
 * measured content is more than a full screen shorter than it was before the load, which means the
 * rows themselves went away (render-window reset, truncation, session swap). Reserving that range
 * would materialize the collapse as a screenfuls-tall empty spacer at the tail
 * (`transcript-web-prepend-range-reserve`), so nothing is reserved and the restore falls back to
 * the real measured content.
 */
export function resolveWebTranscriptPrependRangeReservePx(params: Readonly<{
    baselineScrollHeight: number;
    currentScrollHeight: number;
    viewportHeight: number;
}>): number {
    const baseline = readMeasurementPx(params.baselineScrollHeight);
    const current = readMeasurementPx(params.currentScrollHeight);
    const viewport = readMeasurementPx(params.viewportHeight);
    if (viewport <= 0) return 0;
    const shortfall = baseline - current;
    if (shortfall <= 1) return 0;
    return shortfall <= viewport ? shortfall : 0;
}

function readMeasurementPx(value: number): number {
    return typeof value === 'number' && Number.isFinite(value)
        ? Math.max(0, Math.trunc(value))
        : 0;
}
