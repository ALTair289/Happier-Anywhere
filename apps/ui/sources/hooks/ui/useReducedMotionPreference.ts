import * as React from 'react';
import { AccessibilityInfo, Platform } from 'react-native';

/**
 * The reduced-motion preference is a host property, not per-component state, so
 * it is read from one process-wide store with many readers.
 *
 * Every consumer used to mount its own listener: a `matchMedia` listener on web,
 * an `AccessibilityInfo` listener plus an async `isReduceMotionEnabled()` probe
 * on native. Transcript rows mount motion-aware components by the hundred, so
 * that cost was real and entirely redundant. The platform listener is attached
 * lazily on the first reader and kept for the process lifetime — there is only
 * ever one, and re-attaching it on every mount/unmount would cost more than it
 * could save.
 */

const REDUCED_MOTION_MEDIA_QUERY = '(prefers-reduced-motion: reduce)';

type MediaQueryListLike = Readonly<{
    matches?: boolean;
    addEventListener?: (event: 'change', listener: (event: { matches?: boolean }) => void) => void;
    addListener?: (listener: (event: { matches?: boolean }) => void) => void;
}>;

type WindowLike = Readonly<{ matchMedia?: (query: string) => MediaQueryListLike }>;

type ReduceMotionAccessibilityApi = Readonly<{
    isReduceMotionEnabled?: () => Promise<boolean>;
    addEventListener?: (
        event: 'reduceMotionChanged',
        listener: (enabled: boolean) => void,
    ) => { remove?: () => void } | void;
}>;

let reducedMotion = false;
let hasInitialValue = false;
let watching = false;
let webMediaQuery: MediaQueryListLike | null = null;
const listeners = new Set<() => void>();

function readWebMediaQuery(): MediaQueryListLike | null {
    if (webMediaQuery != null) return webMediaQuery;
    const maybeWindow = (globalThis as { window?: WindowLike }).window;
    if (typeof maybeWindow?.matchMedia !== 'function') return null;
    webMediaQuery = maybeWindow.matchMedia(REDUCED_MOTION_MEDIA_QUERY);
    return webMediaQuery;
}

function publish(next: boolean): void {
    hasInitialValue = true;
    if (reducedMotion === next) return;
    reducedMotion = next;
    for (const listener of [...listeners]) {
        listener();
    }
}

function ensureInitialValue(): void {
    if (hasInitialValue) return;
    hasInitialValue = true;
    if (Platform.OS !== 'web') return;
    reducedMotion = Boolean(readWebMediaQuery()?.matches);
}

function startWatching(): void {
    if (watching) return;
    watching = true;
    ensureInitialValue();

    if (Platform.OS === 'web') {
        const query = readWebMediaQuery();
        if (query == null) return;
        const onChange = (event: { matches?: boolean }): void => publish(Boolean(event?.matches));
        if (typeof query.addEventListener === 'function') {
            query.addEventListener('change', onChange);
            return;
        }
        query.addListener?.(onChange);
        return;
    }

    const accessibility = AccessibilityInfo as unknown as ReduceMotionAccessibilityApi;
    if (typeof accessibility.isReduceMotionEnabled === 'function') {
        void accessibility.isReduceMotionEnabled().then((enabled) => publish(Boolean(enabled)));
    }
    accessibility.addEventListener?.('reduceMotionChanged', (enabled) => publish(Boolean(enabled)));
}

function subscribe(listener: () => void): () => void {
    startWatching();
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

function readSnapshot(): boolean {
    ensureInitialValue();
    return reducedMotion;
}

export function useReducedMotionPreference(): boolean {
    return React.useSyncExternalStore(subscribe, readSnapshot, readSnapshot);
}
