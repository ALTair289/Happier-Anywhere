import * as React from 'react';
import { Platform, View, type LayoutChangeEvent, type NativeSyntheticEvent, type NativeScrollEvent } from 'react-native';
import {
    LegendList,
    type LegendListProps,
    type LegendListRef,
    type LegendListState,
} from '@legendapp/list/react-native';

import { LayoutCommitObserver } from '@/components/ui/lists/flashListCompat/FlashListCompat';
import {
    resolveWebTranscriptScrollMetrics,
    type WebTranscriptScrollMetrics,
} from '@/components/sessions/transcript/webTranscriptScrollMetrics';

import type {
    TranscriptRendererAtEndState,
    TranscriptListRenderer,
    TranscriptListRendererProps,
    TranscriptListShellRef,
} from './types';

const LEGEND_LIST_STYLE = { flex: 1, minHeight: 0 } as const;
// The measurement runtime models ordinary transcript rows around 168-240px and
// handles giant markdown rows with per-row measured floors, so this is only a
// first-render hint. It intentionally stays below the giant-row outliers.
const LEGEND_TRANSCRIPT_ESTIMATED_ITEM_SIZE_PX = 240;
// Legend/browser reconciliation can replay the pre-resize DOM offset about 400ms after
// a composer resize. Keep that specific layout-settle transaction distinguishable from
// a later keyboard/user scroll; wheel/drag interactions cancel it immediately.
const LEGEND_WEB_TAIL_RETARGET_SETTLE_MS = 750;
// Identity host wrapper: @legendapp/list does not forward nativeID/testID to any
// rendered node (verified against the 3.3.0 dist). The web viewport ownership stack
// resolves its scroll container via document.getElementById(nativeID) and then
// descends to the scrollable, so the adapter must own the identity on a wrapper
// View that is an ancestor of the Legend scroller.
const LEGEND_IDENTITY_HOST_STYLE = { flex: 1, minHeight: 0 } as const;

type ScrollToIndexFailureInfo = Readonly<{
    averageItemLength: number;
    highestMeasuredFrameIndex: number;
    index: number;
}>;

function resolveAverageItemLength(
    state: LegendListState | undefined,
    dataLength: number,
): number {
    if (!state || dataLength <= 0) return 1;
    const scrollLength = typeof state.scrollLength === 'number' && Number.isFinite(state.scrollLength)
        ? state.scrollLength
        : 0;
    if (scrollLength > 0) return Math.max(1, scrollLength / dataLength);
    const visibleCount = Math.max(1, Math.abs(state.end - state.start) + 1);
    let measuredTotal = 0;
    let measuredCount = 0;
    if (typeof state.sizeAtIndex === 'function') {
        const start = Math.max(0, Math.min(state.start, state.end));
        const end = Math.min(dataLength - 1, Math.max(state.start, state.end));
        for (let index = start; index <= end; index += 1) {
            const size = state.sizeAtIndex(index);
            if (typeof size === 'number' && Number.isFinite(size) && size > 0) {
                measuredTotal += size;
                measuredCount += 1;
            }
        }
    }
    if (measuredCount > 0) return Math.max(1, measuredTotal / measuredCount);
    return Math.max(1, scrollLength / visibleCount);
}

function reportScrollToIndexFailed<TItem>(
    onScrollToIndexFailed: TranscriptListRendererProps<TItem>['onScrollToIndexFailed'] | undefined,
    info: ScrollToIndexFailureInfo,
): void {
    if (!onScrollToIndexFailed) return;
    onScrollToIndexFailed(info);
}

function settleLegendScroll(
    promise: Promise<void> | undefined,
    onRejected?: () => void,
): void {
    void promise?.catch(() => {
        onRejected?.();
    });
}

function toLegendData<TItem>(data: readonly TItem[], dataOrder: TranscriptListRendererProps<TItem>['frame']['dataOrder']): readonly TItem[] {
    if (dataOrder === 'newest-first') {
        return [...data].reverse();
    }
    return data;
}

function shouldProjectChronologicalIndex<TItem>(props: TranscriptListRendererProps<TItem>): boolean {
    return props.frame.dataOrder === 'newest-first';
}

function toLegendIndex(sourceIndex: number, dataLength: number, projectChronologicalIndex: boolean): number {
    if (!projectChronologicalIndex) return sourceIndex;
    return Math.max(0, dataLength - 1 - sourceIndex);
}

function toSourceIndex(legendIndex: number, dataLength: number, projectChronologicalIndex: boolean): number {
    if (!projectChronologicalIndex) return legendIndex;
    return Math.max(0, dataLength - 1 - legendIndex);
}

function readDataVersion(extraData: unknown): React.Key | undefined {
    return typeof extraData === 'string' || typeof extraData === 'number' ? extraData : undefined;
}

function toLegendSlot(node: React.ReactNode): React.ReactElement | null {
    return React.isValidElement(node) ? node : null;
}

function readLegendAtEndState(state: LegendListState | undefined): TranscriptRendererAtEndState | null {
    if (!state) return null;
    return {
        isAtEnd: state.isAtEnd === true,
        isNearEnd: state.isNearEnd === true,
        isWithinMaintainScrollAtEndThreshold: state.isWithinMaintainScrollAtEndThreshold === true,
    };
}

export function resolveLegendRendererAtEndStateFromWebMetrics(params: Readonly<{
    metrics: Pick<WebTranscriptScrollMetrics, 'clientHeight' | 'scrollHeight' | 'scrollTop'>;
    maintainScrollAtEndThreshold: number;
}>): TranscriptRendererAtEndState {
    const distanceFromBottom = Math.max(
        0,
        params.metrics.scrollHeight - params.metrics.clientHeight - params.metrics.scrollTop,
    );
    const thresholdRatio = Number.isFinite(params.maintainScrollAtEndThreshold)
        ? Math.max(0, params.maintainScrollAtEndThreshold)
        : 0;
    const thresholdPx = thresholdRatio * Math.max(0, params.metrics.clientHeight);
    return {
        isAtEnd: distanceFromBottom <= 1,
        isNearEnd: distanceFromBottom <= thresholdPx,
        isWithinMaintainScrollAtEndThreshold: distanceFromBottom <= thresholdPx,
    };
}

export function scrollLegendWebElementToEnd(element: Pick<
    HTMLElement,
    'clientHeight' | 'scrollHeight' | 'scrollLeft' | 'scrollTo'
>, animated = false): void {
    element.scrollTo({
        behavior: animated ? 'smooth' : 'auto',
        left: element.scrollLeft,
        top: Math.max(0, element.scrollHeight - element.clientHeight),
    });
}

function LegendListTranscriptRendererInner<TItem>(
    props: TranscriptListRendererProps<TItem>,
    ref: React.ForwardedRef<TranscriptListShellRef<TItem>>,
): React.ReactElement {
    const legendListRef = React.useRef<LegendListRef | null>(null);
    const identityHostRef = React.useRef<React.ElementRef<typeof View> | null>(null);
    const visualBottomSlotHostRef = React.useRef<React.ElementRef<typeof View> | null>(null);
    const maintainEndIntentRef = React.useRef(false);
    const lastViewportHeightRef = React.useRef<number | null>(null);
    const lastVisualBottomSlotHeightRef = React.useRef<number | null>(null);
    const hasCommittedVisualBottomSlotRef = React.useRef(false);
    const previousVisualBottomSlotRef = React.useRef<React.ReactNode>(null);
    const lastObservedScrollOffsetRef = React.useRef<number | null>(null);
    const webScrollableElementRef = React.useRef<HTMLElement | null>(null);
    const webTailRetargetFrameRef = React.useRef<number | null>(null);
    const webTailRetargetSettleUntilRef = React.useRef(0);
    const data = React.useMemo(() => toLegendData(props.data, props.frame.dataOrder), [props.data, props.frame.dataOrder]);
    const dataLength = data.length;
    const projectChronologicalIndex = shouldProjectChronologicalIndex(props);

    // @legendapp/list has NO onContentSizeChange support (zero occurrences in the 3.x dist) —
    // forwarding the shell prop is a silent no-op. The session-open chain depends on the signal
    // (onContentSizeChange -> setListContentHeight -> sessionOpenLatch leaves 'awaiting-layout'
    // -> initial fill settles -> older pagination's 'fill-not-done' suspension clears), so the
    // adapter synthesizes it from Legend's own measured state: on every adapter layout commit
    // (data/extraData changes incl. prepends) and on Legend-internal item remeasures
    // (onItemSizeChanged), deduped by the last emitted size.
    const onContentSizeChangeRef = React.useRef(props.onContentSizeChange);
    onContentSizeChangeRef.current = props.onContentSizeChange;
    const lastEmittedContentHeightRef = React.useRef<number | null>(null);
    const emitSynthesizedContentSize = React.useCallback(() => {
        const emit = onContentSizeChangeRef.current;
        if (!emit) return;
        const height = legendListRef.current?.getState().contentLength;
        if (typeof height !== 'number' || !Number.isFinite(height) || height <= 0) return;
        if (lastEmittedContentHeightRef.current === height) return;
        lastEmittedContentHeightRef.current = height;
        // Width is not part of Legend's public state surface and no transcript consumer reads
        // it (the shell handler is `(_, h) => ...`), so the synthesized signal reports 0.
        emit(0, height);
    }, []);

    const readRendererAtEndState = React.useCallback((): TranscriptRendererAtEndState | null => {
        if (Platform.OS === 'web' && typeof document !== 'undefined' && typeof window !== 'undefined') {
            const nativeID = props.frame.rendererOptions.flashList.nativeID;
            const root = nativeID ? document.getElementById(nativeID) : null;
            const metrics = resolveWebTranscriptScrollMetrics({
                root,
                cachedElement: webScrollableElementRef.current,
                win: window,
                minOverflowPx: 0,
                allowRootFallback: true,
            });
            if (metrics) {
                webScrollableElementRef.current = metrics.element;
                return resolveLegendRendererAtEndStateFromWebMetrics({
                    metrics,
                    maintainScrollAtEndThreshold: props.frame.rendererOptions.legend.maintainScrollAtEndThreshold,
                });
            }
        }
        return readLegendAtEndState(legendListRef.current?.getState());
    }, [
        props.frame.rendererOptions.flashList.nativeID,
        props.frame.rendererOptions.legend.maintainScrollAtEndThreshold,
    ]);

    const emitRendererAtEndState = React.useCallback(() => {
        const state = readRendererAtEndState();
        if (!state) return;
        if (state.isAtEnd) {
            maintainEndIntentRef.current = true;
        }
        if (lastObservedScrollOffsetRef.current === null) {
            const webScroll = webScrollableElementRef.current?.scrollTop;
            const scroll = Platform.OS === 'web' && typeof webScroll === 'number' && Number.isFinite(webScroll)
                ? webScroll
                : legendListRef.current?.getState().scroll;
            if (typeof scroll === 'number' && Number.isFinite(scroll)) {
                lastObservedScrollOffsetRef.current = scroll;
            }
        }
        const emit = props.onRendererAtEndChange;
        if (!emit) return;
        emit(state);
    }, [props.onRendererAtEndChange, readRendererAtEndState]);

    const scrollRendererToEnd = React.useCallback((params?: { animated?: boolean }) => {
        if (Platform.OS === 'web' && typeof document !== 'undefined' && typeof window !== 'undefined') {
            const nativeID = props.frame.rendererOptions.flashList.nativeID;
            const root = nativeID ? document.getElementById(nativeID) : null;
            const metrics = resolveWebTranscriptScrollMetrics({
                root,
                cachedElement: webScrollableElementRef.current,
                win: window,
                minOverflowPx: 0,
                allowRootFallback: true,
            });
            if (metrics) {
                webScrollableElementRef.current = metrics.element;
                scrollLegendWebElementToEnd(metrics.element, params?.animated === true);
                return;
            }
        }
        settleLegendScroll(legendListRef.current?.scrollToEnd(params));
    }, [props.frame.rendererOptions.flashList.nativeID]);

    const cancelScheduledWebTailRetarget = React.useCallback(() => {
        const cancelAnimationFrame = globalThis.cancelAnimationFrame;
        if (typeof cancelAnimationFrame === 'function') {
            if (webTailRetargetFrameRef.current !== null) {
                cancelAnimationFrame(webTailRetargetFrameRef.current);
            }
        }
        webTailRetargetFrameRef.current = null;
    }, []);

    const releaseHeldWebTailIntent = React.useCallback(() => {
        maintainEndIntentRef.current = false;
        webTailRetargetSettleUntilRef.current = 0;
        cancelScheduledWebTailRetarget();
    }, [cancelScheduledWebTailRetarget]);

    const requestHeldTailRetarget = React.useCallback(() => {
        // Legend owns native viewport/footer maintenance through maintainScrollAtEnd.
        // The explicit retarget is a web-only repair for the browser DOM/Legend geometry split.
        if (Platform.OS !== 'web') return;
        if (!maintainEndIntentRef.current) return;
        scrollRendererToEnd({ animated: false });
        cancelScheduledWebTailRetarget();
        const requestAnimationFrame = globalThis.requestAnimationFrame;
        if (typeof requestAnimationFrame !== 'function') return;
        // Browser/Legend reconciliation can replay the pre-resize offset for several frames
        // after a synchronous ResizeObserver/layout-effect write. Monitor the short settle
        // transaction and reassert only when the canonical DOM metrics move off the held tail.
        // A real wheel interaction releases the held intent and cancels this loop immediately.
        webTailRetargetSettleUntilRef.current = Date.now() + LEGEND_WEB_TAIL_RETARGET_SETTLE_MS;
        const monitorHeldTailThroughLayoutSettle = () => {
            webTailRetargetFrameRef.current = null;
            if (!maintainEndIntentRef.current) return;
            if (Date.now() > webTailRetargetSettleUntilRef.current) return;
            const state = readRendererAtEndState();
            if (state && !state.isAtEnd) {
                scrollRendererToEnd({ animated: false });
            }
            webTailRetargetFrameRef.current = requestAnimationFrame(monitorHeldTailThroughLayoutSettle);
        };
        webTailRetargetFrameRef.current = requestAnimationFrame(monitorHeldTailThroughLayoutSettle);
    }, [cancelScheduledWebTailRetarget, readRendererAtEndState, scrollRendererToEnd]);

    React.useEffect(() => cancelScheduledWebTailRetarget, [cancelScheduledWebTailRetarget]);

    const recordViewportHeight = React.useCallback((nextHeight: number) => {
        const previousHeight = lastViewportHeightRef.current;
        lastViewportHeightRef.current = nextHeight;
        if (previousHeight === null || Math.abs(previousHeight - nextHeight) < 1) return;
        requestHeldTailRetarget();
    }, [requestHeldTailRetarget]);

    const recordVisualBottomSlotHeight = React.useCallback((nextHeight: number) => {
        const previousHeight = lastVisualBottomSlotHeightRef.current;
        lastVisualBottomSlotHeightRef.current = nextHeight;
        if (previousHeight === null || Math.abs(previousHeight - nextHeight) < 1) return;
        requestHeldTailRetarget();
    }, [requestHeldTailRetarget]);

    const handleLegendLayout = React.useCallback((event: LayoutChangeEvent) => {
        props.onLayout?.(event);
        recordViewportHeight(event.nativeEvent.layout.height);
    }, [props.onLayout, recordViewportHeight]);

    const handleVisualBottomSlotLayout = React.useCallback((event: LayoutChangeEvent) => {
        recordVisualBottomSlotHeight(event.nativeEvent.layout.height);
    }, [recordVisualBottomSlotHeight]);

    React.useEffect(() => {
        if (Platform.OS !== 'web') return undefined;
        const ResizeObserverCtor = globalThis.ResizeObserver;
        if (typeof ResizeObserverCtor !== 'function') return undefined;
        const nativeID = props.frame.rendererOptions.flashList.nativeID;
        const identityHost = (
            typeof document !== 'undefined' && nativeID
                ? document.getElementById(nativeID)
                : null
        ) ?? identityHostRef.current as unknown as Element | null;
        const visualBottomSlotHost = visualBottomSlotHostRef.current as unknown as Element | null;
        if (!identityHost && !visualBottomSlotHost) return undefined;
        const observer = new ResizeObserverCtor((entries) => {
            for (const entry of entries) {
                if (entry.target === identityHost) {
                    recordViewportHeight(entry.contentRect.height);
                }
                if (entry.target === visualBottomSlotHost) {
                    recordVisualBottomSlotHeight(entry.contentRect.height);
                }
            }
            emitRendererAtEndState();
        });
        if (identityHost) observer.observe(identityHost);
        if (visualBottomSlotHost) observer.observe(visualBottomSlotHost);
        return () => observer.disconnect();
    }, [emitRendererAtEndState, props.frame.rendererOptions.flashList.nativeID, recordViewportHeight, recordVisualBottomSlotHeight]);

    const handleLegendScroll = React.useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
        const state = readRendererAtEndState();
        const webScroll = webScrollableElementRef.current?.scrollTop;
        const nextScrollOffset = Platform.OS === 'web' && typeof webScroll === 'number' && Number.isFinite(webScroll)
            ? webScroll
            : event.nativeEvent.contentOffset.y;
        const previousScrollOffset = lastObservedScrollOffsetRef.current;
        lastObservedScrollOffsetRef.current = nextScrollOffset;
        const offsetMoved = previousScrollOffset !== null && Math.abs(previousScrollOffset - nextScrollOffset) >= 1;
        const browserLayoutSettleInFlight = Platform.OS === 'web'
            && Date.now() <= webTailRetargetSettleUntilRef.current;
        const movedAwayFromTail = offsetMoved
            && state
            && !state.isAtEnd
            && !state.isNearEnd
            && !state.isWithinMaintainScrollAtEndThreshold;
        if (movedAwayFromTail && browserLayoutSettleInFlight) {
            // Chromium can emit one final scroll-anchor correction after both the layout
            // notification and the scheduled frame retry. That correction is not a user
            // detach: the interaction wrappers below cancel the held intent first for a
            // real wheel/drag. Reassert from the same renderer-owned tail target.
            requestHeldTailRetarget();
        } else if (
            movedAwayFromTail
            && !browserLayoutSettleInFlight
        ) {
            maintainEndIntentRef.current = false;
        }
        props.onScroll?.(event);
        emitRendererAtEndState();
    }, [emitRendererAtEndState, props.onScroll, readRendererAtEndState, requestHeldTailRetarget]);

    const handleLegendWheel = React.useCallback((event: unknown) => {
        if (Platform.OS === 'web') releaseHeldWebTailIntent();
        props.platformInteractionProps?.onWheel?.(event);
    }, [props.platformInteractionProps, releaseHeldWebTailIntent]);

    React.useLayoutEffect(() => {
        emitRendererAtEndState();
        const state = legendListRef.current?.getState();
        if (!state || typeof state.listen !== 'function') return undefined;
        const unlisten = [
            state.listen('isAtEnd', emitRendererAtEndState),
            state.listen('isNearEnd', emitRendererAtEndState),
            state.listen('isWithinMaintainScrollAtEndThreshold', emitRendererAtEndState),
        ];
        return () => {
            for (const dispose of unlisten) dispose();
        };
    }, [
        emitRendererAtEndState,
        props.onRendererAtEndChange,
    ]);

    React.useImperativeHandle(ref, (): TranscriptListShellRef<TItem> => ({
        transcriptViewportCommandSpace: 'standard',
        clearLayoutCacheOnUpdate: () => {
            legendListRef.current?.clearCaches({ mode: 'sizes' });
        },
        notifyViewportGeometryChanged: requestHeldTailRetarget,
        computeVisibleIndices: () => {
            const state = legendListRef.current?.getState();
            if (!state) return { startIndex: 0, endIndex: 0 };
            const startIndex = toSourceIndex(state.start, dataLength, projectChronologicalIndex);
            const endIndex = toSourceIndex(state.end, dataLength, projectChronologicalIndex);
            return {
                startIndex: Math.min(startIndex, endIndex),
                endIndex: Math.max(startIndex, endIndex),
            };
        },
        getAbsoluteLastScrollOffset: () => {
            return legendListRef.current?.getState().scroll ?? 0;
        },
        getFirstVisibleIndex: () => {
            const start = legendListRef.current?.getState().start ?? 0;
            return toSourceIndex(start, dataLength, projectChronologicalIndex);
        },
        getLayout: (index) => {
            const state = legendListRef.current?.getState();
            const legendIndex = toLegendIndex(index, dataLength, projectChronologicalIndex);
            const y = state?.positionAtIndex?.(legendIndex);
            const height = state?.sizeAtIndex?.(legendIndex);
            if (typeof y !== 'number' || typeof height !== 'number') return undefined;
            if (!Number.isFinite(y) || !Number.isFinite(height)) return undefined;
            return { x: 0, y, width: 0, height };
        },
        scrollToEnd: scrollRendererToEnd,
        scrollToIndex: (params) => {
            const legendIndex = toLegendIndex(params.index, dataLength, projectChronologicalIndex);
            settleLegendScroll(legendListRef.current?.scrollToIndex({
                ...params,
                index: legendIndex,
            }), () => {
                const state = legendListRef.current?.getState();
                reportScrollToIndexFailed(props.onScrollToIndexFailed, {
                    index: params.index,
                    averageItemLength: resolveAverageItemLength(state, dataLength),
                    highestMeasuredFrameIndex: Math.max(0, dataLength - 1),
                });
            });
        },
        scrollToOffset: (params) => {
            settleLegendScroll(legendListRef.current?.scrollToOffset(params));
        },
    }), [dataLength, projectChronologicalIndex, props.onScrollToIndexFailed, requestHeldTailRetarget, scrollRendererToEnd]);

    const renderItem: LegendListProps<TItem>['renderItem'] = (info) => props.renderItem({
        item: info.item,
        index: toSourceIndex(info.index, dataLength, projectChronologicalIndex),
        separators: {
            highlight: () => undefined,
            unhighlight: () => undefined,
            updateProps: () => undefined,
        },
    });
    const visualBottomSlot = toLegendSlot(projectChronologicalIndex ? props.header : props.footer);
    React.useLayoutEffect(() => {
        if (!hasCommittedVisualBottomSlotRef.current) {
            hasCommittedVisualBottomSlotRef.current = true;
            previousVisualBottomSlotRef.current = visualBottomSlot;
            return;
        }
        const changed = previousVisualBottomSlotRef.current !== visualBottomSlot;
        previousVisualBottomSlotRef.current = visualBottomSlot;
        if (changed) requestHeldTailRetarget();
    }, [requestHeldTailRetarget, visualBottomSlot]);
    const legendVisualBottomSlot = React.useMemo<LegendListProps<TItem>['ListFooterComponent']>(() => (
        visualBottomSlot ? (
            <View ref={visualBottomSlotHostRef} onLayout={handleVisualBottomSlotLayout}>
                {visualBottomSlot}
            </View>
        ) : null
    ), [handleVisualBottomSlotLayout, visualBottomSlot]);

    const legendPlatformInteractionProps = {
        ...props.platformInteractionProps,
        onWheel: Platform.OS === 'web' ? handleLegendWheel : props.platformInteractionProps?.onWheel,
    };
    const legendProps: LegendListProps<TItem> = {
        ...legendPlatformInteractionProps,
        style: LEGEND_LIST_STYLE,
        alignItemsAtEnd: true,
        data,
        dataKey: props.dataKey,
        dataVersion: readDataVersion(props.extraData),
        estimatedItemSize: LEGEND_TRANSCRIPT_ESTIMATED_ITEM_SIZE_PX,
        extraData: props.extraData,
        getItemType: props.getItemType
            ? (item, index) => {
                const type = props.getItemType?.(
                    item,
                    toSourceIndex(index, dataLength, projectChronologicalIndex),
                    props.extraData,
                );
                return typeof type === 'number' ? String(type) : type;
            }
            : undefined,
        // Continuous tail maintenance belongs to Legend, but initial placement must respect the
        // app-owned discrete entry intent. A released/anchored entry starts away from the tail so
        // entry restore can consume its saved anchor before any at-end observation clears it.
        initialScrollAtEnd: props.frame.rendererOptions.legend.initialScrollAtEnd,
        keyExtractor: (item, index) => props.keyExtractor(
            item,
            toSourceIndex(index, dataLength, projectChronologicalIndex),
        ),
        keyboardDismissMode: props.frame.rendererOptions.flashList.keyboardDismissMode,
        keyboardShouldPersistTaps: props.frame.rendererOptions.flashList.keyboardShouldPersistTaps,
        // Shell header/footer are FRAME LIST-SPACE slots (FlashList semantics). On newest-first
        // frames FlashList renders inverted, so the shell `header` slot (data-start) appears at
        // the VISUAL BOTTOM — that is where callers put the composer keyboard-inset spacer and
        // hot tail. This adapter re-projects data to chronological standard space, so the slots
        // must be re-projected with it: header -> visual bottom (ListFooterComponent), footer ->
        // visual top (ListHeaderComponent). Without this, the inset spacer renders at the top and
        // the last row lays out under the floating composer (native occlusion, live-measured
        // ~130pt on 2026-07-08). Oldest-first frames already are standard space: no swap.
        ListFooterComponent: legendVisualBottomSlot,
        ListHeaderComponent: toLegendSlot(projectChronologicalIndex ? props.footer : props.header),
        maintainScrollAtEnd: { animated: false },
        maintainScrollAtEndThreshold: props.frame.rendererOptions.legend.maintainScrollAtEndThreshold,
        maintainVisibleContentPosition: { data: true, size: true },
        onEndReached: props.onEndReached,
        onEndReachedThreshold: props.onEndReachedThreshold,
        onItemSizeChanged: emitSynthesizedContentSize,
        onLoad: (info) => {
            emitSynthesizedContentSize();
            props.onLoad?.(info);
        },
        onMomentumScrollBegin: props.onMomentumScrollBegin,
        onMomentumScrollEnd: props.onMomentumScrollEnd,
        onScroll: handleLegendScroll,
        onScrollBeginDrag: props.onScrollBeginDrag,
        onScrollEndDrag: props.onScrollEndDrag,
        onStartReached: props.onStartReached,
        onStartReachedThreshold: props.onStartReachedThreshold,
        onViewableItemsChanged: props.onViewableItemsChanged,
        // Transcript rows still carry row-local transient UI state (hover/copy/fork affordances)
        // in addition to keyed host expansion state. Keep remount-on-reuse semantics until a
        // recycling-specific row-state audit proves every transient is key-safe.
        recycleItems: false,
        renderItem,
        scrollEventThrottle: props.frame.rendererOptions.flashList.scrollEventThrottle,
        viewabilityConfig: props.viewabilityConfig,
    };

    return (
        <View
            ref={identityHostRef}
            nativeID={props.frame.rendererOptions.flashList.nativeID}
            onLayout={handleLegendLayout}
            testID={props.frame.rendererOptions.flashList.testID}
            style={LEGEND_IDENTITY_HOST_STYLE}
        >
            {/* Layout-commit signalling for the viewport ownership stack. FlashList exposes this
                natively via its LayoutCommitObserver; Legend has no equivalent, so the adapter
                reuses the shared observer (falls back to a useLayoutEffect-per-commit shim).
                The same commit signal drives the synthesized onContentSizeChange emission. */}
            <LayoutCommitObserver
                onCommitLayoutEffect={() => {
                    emitSynthesizedContentSize();
                    props.onCommitLayoutEffect?.();
                }}
            >
                <LegendList
                    ref={legendListRef}
                    {...legendProps}
                />
            </LayoutCommitObserver>
        </View>
    );
}

const LegendListTranscriptRenderer = React.forwardRef(LegendListTranscriptRendererInner) as TranscriptListRenderer['Component'];

export const legendListRenderer: TranscriptListRenderer = {
    kind: 'legendList',
    orientation: 'standard',
    Component: LegendListTranscriptRenderer,
};
