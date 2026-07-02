/**
 * Always-on bridge from the patched @shopify/flash-list offset corrector
 * (see `apps/ui/patches/@shopify+flash-list+*.patch`, marker
 * `HAPPIER PATCH(flash-list-offset-correction-hook)`) to app-side consumers.
 *
 * The vendor patch notifies `globalThis.__HAPPIER_FLASHLIST_OFFSET_CORRECTION_HOOK__` (when it
 * is a function) on every `pauseOffsetCorrection` transition and on every nonzero MVCP
 * correction decision; with the slot empty it is a single property read per decision and all
 * failures are swallowed on the vendor side. This module owns the global slot as a
 * multi-subscriber dispatcher: it sanitizes the untyped vendor payloads once, fans typed events
 * out to every subscriber with per-listener exception isolation, and never lets observability
 * or deference failures propagate into the scroll path.
 *
 * Consumers (N2d.1): the prepend transaction's corrector-deference signal (production-on — the
 * transaction defers its fallback write to corrections the vendor corrector already applied)
 * and viewport telemetry (which keeps its own enablement gating at the listener level).
 */

export const FLASHLIST_OFFSET_CORRECTION_HOOK_GLOBAL_KEY = '__HAPPIER_FLASHLIST_OFFSET_CORRECTION_HOOK__';

export type FlashListOffsetCorrectionEventType =
    | 'pause-set'
    | 'pause-cleared'
    | 'correction-applied'
    | 'correction-skipped-paused'
    | 'correction-skipped-animation'
    | 'correction-skipped-happier-paused';

export type FlashListOffsetCorrectionSource = 'scroll-to-index' | 'initial-scroll-index';

export type FlashListOffsetCorrectionEvent = Readonly<{
    type: FlashListOffsetCorrectionEventType;
    source?: FlashListOffsetCorrectionSource;
    diffPx?: number;
    timestampMs?: number;
}>;

const EVENT_TYPES = new Set<FlashListOffsetCorrectionEventType>([
    'pause-set',
    'pause-cleared',
    'correction-applied',
    'correction-skipped-paused',
    'correction-skipped-animation',
    'correction-skipped-happier-paused',
]);

const SOURCES = new Set<FlashListOffsetCorrectionSource>([
    'scroll-to-index',
    'initial-scroll-index',
]);

function sanitizeVendorEvent(event: unknown): FlashListOffsetCorrectionEvent | null {
    if (!event || typeof event !== 'object') return null;
    const source = event as Record<string, unknown>;
    const type = typeof source.type === 'string' && EVENT_TYPES.has(source.type as FlashListOffsetCorrectionEventType)
        ? source.type as FlashListOffsetCorrectionEventType
        : null;
    if (!type) return null;
    const correctionSource = typeof source.source === 'string' && SOURCES.has(source.source as FlashListOffsetCorrectionSource)
        ? source.source as FlashListOffsetCorrectionSource
        : undefined;
    const diffPx = typeof source.diffPx === 'number' && Number.isFinite(source.diffPx)
        ? source.diffPx
        : undefined;
    const timestampMs = typeof source.timestampMs === 'number' && Number.isFinite(source.timestampMs)
        ? source.timestampMs
        : undefined;
    return {
        type,
        ...(correctionSource ? { source: correctionSource } : {}),
        ...(diffPx === undefined ? {} : { diffPx }),
        ...(timestampMs === undefined ? {} : { timestampMs }),
    };
}

type Listener = (event: FlashListOffsetCorrectionEvent) => void;

const listeners = new Set<Listener>();

const dispatch = (rawEvent: unknown): void => {
    let event: FlashListOffsetCorrectionEvent | null;
    try {
        event = sanitizeVendorEvent(rawEvent);
    } catch {
        return;
    }
    if (!event) return;
    for (const listener of listeners) {
        try {
            listener(event);
        } catch {
            // One consumer must never break the vendor scroll path or other consumers.
        }
    }
};

/**
 * Subscribes to corrector events. The global vendor hook is installed while at least one
 * subscriber exists and released when the last one unsubscribes. Subscribing re-claims the slot
 * if another writer clobbered it. Unsubscribe is idempotent.
 */
export function subscribeToFlashListOffsetCorrections(listener: Listener): () => void {
    const target = globalThis as Record<string, unknown>;
    listeners.add(listener);
    if (target[FLASHLIST_OFFSET_CORRECTION_HOOK_GLOBAL_KEY] !== dispatch) {
        target[FLASHLIST_OFFSET_CORRECTION_HOOK_GLOBAL_KEY] = dispatch;
    }
    return () => {
        listeners.delete(listener);
        if (listeners.size === 0 && target[FLASHLIST_OFFSET_CORRECTION_HOOK_GLOBAL_KEY] === dispatch) {
            delete target[FLASHLIST_OFFSET_CORRECTION_HOOK_GLOBAL_KEY];
        }
    };
}
