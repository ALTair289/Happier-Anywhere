import { describe, expect, it, vi } from 'vitest';

import { renderHook } from '@/dev/testkit';
import {
    clearTranscriptNavigationVisibilityStore,
    getTranscriptNavigationVisibilityStore,
} from '@/components/sessions/transcript/viewport/visibility/transcriptNavigationVisibilityStore';

import { useTranscriptViewportTelemetryEvents } from './useTranscriptViewportTelemetryEvents';

type TelemetryDeps = Parameters<typeof useTranscriptViewportTelemetryEvents>[0];

function createRef<T>(current: T): { current: T } {
    return { current };
}

describe('useTranscriptViewportTelemetryEvents navigation visibility', () => {
    it('triggers the single navigation-visibility owner instead of writing its own containment snapshot', async () => {
        const sessionId = 'session-native-viewability-landing';
        const store = getTranscriptNavigationVisibilityStore(sessionId);
        const unsubscribe = store.subscribe(() => {});
        const observeTranscriptNavigationVisibility = vi.fn();
        const listData = [
            { id: 'item-0', kind: 'message', messageId: 'message-0', seq: 0, createdAt: 0 },
            { id: 'item-1', kind: 'message', messageId: 'message-1', seq: 1, createdAt: 1 },
            { id: 'item-2', kind: 'message', messageId: 'message-2', seq: 2, createdAt: 2 },
        ];
        const deps = {
            applyBlankRecoveryEffects: vi.fn(),
            bottomFollowModeStateRef: createRef({ dragSession: null, mode: 'following' }),
            entryRestoreOwner: { telemetryState: vi.fn(() => 'none') },
            getBottomFollowGestureActiveRef: createRef(() => false),
            hasTranscriptNavigationAnchors: true,
            items: listData,
            lastNativeVisibleRowsSnapshotRef: createRef(null),
            listContentHeightRef: createRef(1_000),
            listData,
            listLayoutHeightRef: createRef(400),
            // The renderer window still reports the PRE-jump turn: a landing
            // routinely settles one or two rows above its target row, which is
            // exactly what a second publisher here would re-derive from.
            listRef: createRef({
                readVisibleSourceIndexRange: () => ({ startIndex: 0, endIndex: 0 }),
            }),
            nativeFlashListMvcpPolicyRef: createRef('none'),
            nativeFlashListPauseOffsetCorrectionRef: createRef(false),
            nativeHotEdgeVisibleRows: null,
            nativeMomentumScrollActiveRef: createRef(false),
            nativePrependTelemetryStateRef: createRef(() => 'none'),
            nativeVisibleWindowSnapshotRef: createRef(null),
            observeTranscriptNavigationVisibilityRef: createRef(observeTranscriptNavigationVisibility),
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
            sessionId,
            shouldUseNativeHotColdSplit: false,
            transcriptHotColdSegments: { coldCount: 3, hotCount: 0 },
            usesNativeFlashListBottomMaintenance: true,
            wantsPinnedRef: createRef(true),
            webHotColdCountsRef: createRef({ coldCount: 3, hotCount: 0 }),
        } as unknown as TelemetryDeps;
        const hook = await renderHook(
            (params: TelemetryDeps) => useTranscriptViewportTelemetryEvents(params),
            { initialProps: deps },
        );

        // A rail jump landed on anchor-b and the landing owner published it.
        store.set({ currentAnchorId: 'anchor-b', visibleAnchorIds: ['anchor-b'] });

        hook.getCurrent().handleNativeViewableItemsChanged({ viewableItems: [] });

        // Viewability is a TRIGGER, not a second publisher: re-deriving from
        // containment here reverts the rail to the pre-jump turn.
        expect(store.get().currentAnchorId).toBe('anchor-b');
        expect(observeTranscriptNavigationVisibility).toHaveBeenCalledTimes(1);

        await hook.unmount();
        unsubscribe();
        clearTranscriptNavigationVisibilityStore(sessionId);
    });
});
