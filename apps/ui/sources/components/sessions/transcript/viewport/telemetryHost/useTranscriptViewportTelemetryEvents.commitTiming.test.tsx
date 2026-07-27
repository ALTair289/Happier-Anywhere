import { describe, expect, it, vi } from 'vitest';

import { renderHook } from '@/dev/testkit';
import { getTranscriptNavigationVisibilityStore } from '@/components/sessions/transcript/viewport/visibility/transcriptNavigationVisibilityStore';

import { useTranscriptViewportTelemetryEvents } from './useTranscriptViewportTelemetryEvents';

type TelemetryDeps = Parameters<typeof useTranscriptViewportTelemetryEvents>[0];

function createRef<T>(current: T): { current: T } {
    return { current };
}

describe('useTranscriptViewportTelemetryEvents commit timing', () => {
    it('classifies a committed B child viewability callback from immutable B data while projection refs still contain A', async () => {
        const nativeVisibleWindowSnapshotRef = createRef(null);
        const listData = [{
            id: 'item-b',
            kind: 'message',
            messageId: 'message-b',
            seq: 1,
            createdAt: 1,
        }];
        const deps = {
            applyBlankRecoveryEffects: vi.fn(),
            bottomFollowModeStateRef: createRef({ dragSession: null, mode: 'following' }),
            entryRestoreOwner: { telemetryState: vi.fn(() => 'none') },
            getBottomFollowGestureActiveRef: createRef(() => false),
            hasTranscriptNavigationAnchors: false,
            items: listData,
            // This models parent/child layout ordering: B's callback can run before the
            // parent layout effect atomically replaces the committed A projection refs.
            listDataRef: createRef([]),
            itemsRef: createRef([]),
            lastNativeVisibleRowsSnapshotRef: createRef(null),
            listContentHeightRef: createRef(1_000),
            listData,
            listLayoutHeightRef: createRef(120),
            listRef: createRef(null),
            nativeFlashListMvcpPolicyRef: createRef('none'),
            nativeFlashListPauseOffsetCorrectionRef: createRef(false),
            nativeHotEdgeVisibleRows: null,
            nativeMomentumScrollActiveRef: createRef(false),
            nativePrependTelemetryStateRef: createRef(() => 'none'),
            nativeVisibleWindowSnapshotRef,
            pinThresholdPxRef: createRef(72),
            platformOS: 'ios',
            readCurrentNativeDistanceFromBottom: vi.fn(() => 0),
            readViewportVisibleSourceRange: vi.fn(() => null),
            rendererKind: 'legendList',
            resolveNativeObservedScrollOffset: vi.fn(() => null),
            resolveWebPrependTelemetryFactsRef: createRef(vi.fn(() => ({
                pendingWebPrependAnchorId: undefined,
                pendingWebPrependAnchorIndex: undefined,
                pendingWebPrependAnchorKind: 'none',
            }))),
            resolveWebScrollMetrics: vi.fn(() => null),
            resolveWebViewportTelemetryDiagnostics: vi.fn(() => ({})),
            runtimeAnchorsRef: createRef([]),
            sessionId: 'session-b',
            shouldUseNativeHotColdSplit: false,
            transcriptHotColdSegments: { coldCount: 1, hotCount: 0 },
            usesNativeFlashListBottomMaintenance: true,
            wantsPinnedRef: createRef(true),
            webHotColdCountsRef: createRef({ coldCount: 1, hotCount: 0 }),
        } as unknown as TelemetryDeps;
        const hook = await renderHook(
            (params: TelemetryDeps) => useTranscriptViewportTelemetryEvents(params),
            { initialProps: deps },
        );

        hook.getCurrent().handleNativeViewableItemsChanged({ viewableItems: [] });

        expect(nativeVisibleWindowSnapshotRef.current).toMatchObject({
            blankAreaPx: 120,
            hasVisibleRows: false,
        });

        await hook.unmount();
    });

    it('attaches FlashList viewability on the first committed navigation-anchor render', async () => {
        const store = getTranscriptNavigationVisibilityStore('session-first-anchor');
        const unsubscribe = store.subscribe(() => {});
        const deps = {
            applyBlankRecoveryEffects: vi.fn(),
            bottomFollowModeStateRef: createRef({ dragSession: null, mode: 'following' }),
            entryRestoreOwner: { telemetryState: vi.fn(() => 'none') },
            getBottomFollowGestureActiveRef: createRef(() => false),
            hasTranscriptNavigationAnchors: false,
            items: [],
            lastNativeVisibleRowsSnapshotRef: createRef(null),
            listContentHeightRef: createRef(1_000),
            listData: [],
            listLayoutHeightRef: createRef(120),
            listRef: createRef(null),
            nativeFlashListMvcpPolicyRef: createRef('none'),
            nativeFlashListPauseOffsetCorrectionRef: createRef(false),
            nativeHotEdgeVisibleRows: null,
            nativeMomentumScrollActiveRef: createRef(false),
            nativePrependTelemetryStateRef: createRef(() => 'none'),
            nativeVisibleWindowSnapshotRef: createRef(null),
            pinThresholdPxRef: createRef(72),
            platformOS: 'ios',
            readCurrentNativeDistanceFromBottom: vi.fn(() => 0),
            readViewportVisibleSourceRange: vi.fn(() => null),
            rendererKind: 'flashList',
            resolveNativeObservedScrollOffset: vi.fn(() => null),
            resolveWebPrependTelemetryFactsRef: createRef(vi.fn(() => ({
                pendingWebPrependAnchorId: undefined,
                pendingWebPrependAnchorIndex: undefined,
                pendingWebPrependAnchorKind: 'none',
            }))),
            resolveWebScrollMetrics: vi.fn(() => null),
            resolveWebViewportTelemetryDiagnostics: vi.fn(() => ({})),
            runtimeAnchorsRef: createRef([]),
            sessionId: 'session-first-anchor',
            shouldUseNativeHotColdSplit: false,
            transcriptHotColdSegments: { coldCount: 0, hotCount: 0 },
            usesNativeFlashListBottomMaintenance: true,
            wantsPinnedRef: createRef(true),
            webHotColdCountsRef: createRef({ coldCount: 0, hotCount: 0 }),
        } as unknown as TelemetryDeps;
        const hook = await renderHook(
            (params: TelemetryDeps) => useTranscriptViewportTelemetryEvents(params),
            { initialProps: deps },
        );

        expect(hook.getCurrent().nativeViewabilityConfig).toBeUndefined();

        await hook.rerender({
            ...deps,
            hasTranscriptNavigationAnchors: true,
        } as TelemetryDeps);

        expect(hook.getCurrent().nativeViewabilityConfig).toEqual({
            itemVisiblePercentThreshold: 1,
        });
        await hook.unmount();
        unsubscribe();
    });
});
