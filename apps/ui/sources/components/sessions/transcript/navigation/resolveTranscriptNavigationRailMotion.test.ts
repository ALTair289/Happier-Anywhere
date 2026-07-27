import { beforeEach, describe, expect, it, vi } from 'vitest';

import { resolveTranscriptNavigationRailMarkerMotion } from './resolveTranscriptNavigationRailMotion';

async function importMotionResolverForPlatform(os: 'web' | 'ios') {
    vi.resetModules();
    vi.doMock('react-native', async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({ Platform: { OS: os } });
    });
    return import('./resolveTranscriptNavigationRailMotion');
}

describe('resolveTranscriptNavigationRailMarkerMotion', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.doUnmock('react-native');
    });

    it('uses a smooth symmetric falloff around the focused marker', () => {
        const focused = resolveTranscriptNavigationRailMarkerMotion({
            activeIndex: null,
            focusIndex: 10,
            markerIndex: 10,
            reducedMotion: false,
            visible: false,
        });
        const neighbor = resolveTranscriptNavigationRailMarkerMotion({
            activeIndex: null,
            focusIndex: 10,
            markerIndex: 11,
            reducedMotion: false,
            visible: false,
        });
        const symmetricNeighbor = resolveTranscriptNavigationRailMarkerMotion({
            activeIndex: null,
            focusIndex: 10,
            markerIndex: 9,
            reducedMotion: false,
            visible: false,
        });
        const far = resolveTranscriptNavigationRailMarkerMotion({
            activeIndex: null,
            focusIndex: 10,
            markerIndex: 18,
            reducedMotion: false,
            visible: false,
        });

        expect(focused.widthPx).toBeGreaterThan(neighbor.widthPx);
        expect(neighbor.widthPx).toBeGreaterThan(far.widthPx);
        expect(neighbor.widthPx).toBeCloseTo(symmetricNeighbor.widthPx, 3);
        // Markers beyond the update window rest exactly, so focus changes only
        // restyle the bounded falloff window (no all-marker churn).
        expect(far.widthPx).toBe(3);
        expect(far.translateYPx).toBe(0);
    });

    it('keeps active and visible marker opacity above their floors', () => {
        expect(resolveTranscriptNavigationRailMarkerMotion({
            activeIndex: 3,
            focusIndex: null,
            markerIndex: 3,
            reducedMotion: false,
            visible: false,
        }).opacity).toBeGreaterThanOrEqual(0.86);
        expect(resolveTranscriptNavigationRailMarkerMotion({
            activeIndex: null,
            focusIndex: null,
            markerIndex: 3,
            reducedMotion: false,
            visible: true,
        }).opacity).toBeGreaterThanOrEqual(0.54);
    });

    it('uses static width and translation for reduced motion while preserving visibility opacity', () => {
        const focused = resolveTranscriptNavigationRailMarkerMotion({
            activeIndex: null,
            focusIndex: 3,
            markerIndex: 3,
            reducedMotion: true,
            visible: true,
        });
        const far = resolveTranscriptNavigationRailMarkerMotion({
            activeIndex: null,
            focusIndex: 3,
            markerIndex: 12,
            reducedMotion: true,
            visible: false,
        });

        expect(focused.widthPx).toBe(far.widthPx);
        expect(focused.translateYPx).toBe(0);
        expect(focused.opacity).toBeGreaterThan(far.opacity);
    });

    it('returns finite safe styles for invalid input', () => {
        const style = resolveTranscriptNavigationRailMarkerMotion({
            activeIndex: Number.NaN,
            focusIndex: Number.POSITIVE_INFINITY,
            markerIndex: Number.NaN,
            reducedMotion: false,
            visible: false,
        });

        expect(Number.isFinite(style.widthPx)).toBe(true);
        expect(Number.isFinite(style.opacity)).toBe(true);
        expect(Number.isFinite(style.translateYPx)).toBe(true);
    });

    it('eases every motion channel through CSS and collapses the duration under reduced motion', async () => {
        const { resolveTranscriptNavigationRailMarkerTransitionStyle } =
            await importMotionResolverForPlatform('web');
        const eased = resolveTranscriptNavigationRailMarkerTransitionStyle(false) as Record<string, unknown> | null;
        const instant = resolveTranscriptNavigationRailMarkerTransitionStyle(true) as Record<string, unknown> | null;

        expect(eased?.transitionProperty).toBe('width, opacity, transform, background-color');
        expect(eased?.transitionDuration).toBe('160ms');
        expect(instant?.transitionProperty).toBe('width, opacity, transform, background-color');
        expect(instant?.transitionDuration).toBe('0ms');
    });

    it('never emits the web-only transition declaration on native', async () => {
        const { resolveTranscriptNavigationRailMarkerTransitionStyle } =
            await importMotionResolverForPlatform('ios');

        expect(resolveTranscriptNavigationRailMarkerTransitionStyle(false)).toBeNull();
        expect(resolveTranscriptNavigationRailMarkerTransitionStyle(true)).toBeNull();
    });
});
