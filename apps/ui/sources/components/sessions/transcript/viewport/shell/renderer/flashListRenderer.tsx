import * as React from 'react';
import type { ViewStyle } from 'react-native';

import {
    FlashList,
    LayoutCommitObserver,
    type FlashListPropsCompat,
    type FlashListRef,
} from '@/components/ui/lists/flashListCompat/FlashListCompat';

import type {
    TranscriptListRenderer,
    TranscriptListRendererProps,
    TranscriptListShellRef,
    TranscriptRendererVisibleSourceIndexRange,
} from './types';

const FLASH_LIST_STYLE = { flex: 1, minHeight: 0 } as const;
// Browser-native scroll anchoring (overflow-anchor: auto) is a second, invisible
// scrollTop writer on the transcript scroll container: under FlashList window
// reallocation with large rows it re-anchors the viewport to a mid-transcript
// node outside the app's viewport ownership system. The transcript owners must
// be the only anchor authority, so web frames opt the scroller out entirely.
// FlashList applies its `style` prop to an outer wrapper; the real scroll
// container is the internal ScrollView, which only receives `overrideProps`,
// so the opt-out style must ride through overrideProps to reach the scroller.
// (overflowAnchor is a web-only CSS property react-native-web passes through;
// it is not representable in ViewStyle, hence the narrow boundary cast.)
const WEB_SCROLL_ANCHOR_OPT_OUT_STYLE = { overflowAnchor: 'none' } as unknown as ViewStyle;

function resolveScrollerOverrideProps(
    overrideProps: Record<string, unknown> | undefined,
    disableBrowserScrollAnchoring: boolean,
): Record<string, unknown> | undefined {
    if (!disableBrowserScrollAnchoring) return overrideProps;
    return {
        ...overrideProps,
        style: [overrideProps?.style, WEB_SCROLL_ANCHOR_OPT_OUT_STYLE],
    };
}

/**
 * FlashList's recycler answers the visible window from its own layout manager and
 * THROWS while that manager is uninitialized. Both "threw" and "surface does not
 * implement it" mean the same thing to navigation visibility: no measurement yet.
 * Never `{0, 0}` — that would read as "viewing the first turn".
 */
function readFlashListVisibleSourceIndexRange<TItem>(
    list: FlashListRef<TItem> | null,
): TranscriptRendererVisibleSourceIndexRange | null {
    let window: { startIndex: number; endIndex: number } | undefined;
    try {
        window = list?.computeVisibleIndices?.();
    } catch {
        return null;
    }
    if (!window) return null;
    const { startIndex, endIndex } = window;
    if (!Number.isFinite(startIndex) || !Number.isFinite(endIndex)) return null;
    return { startIndex, endIndex };
}

/**
 * The compat handle type covers the members the app's own code declares; FlashList
 * itself also exposes `scrollToEnd`. Narrowing here (instead of widening the compat
 * type) keeps the extra surface knowledge inside the renderer that consumes it.
 */
type FlashListTailScrollCapableRef = Readonly<{
    scrollToEnd?: (params?: { animated?: boolean }) => void;
}>;

function FlashListTranscriptRendererInner<TItem>(
    props: TranscriptListRendererProps<TItem>,
    ref: React.ForwardedRef<TranscriptListShellRef<TItem>>,
): React.ReactElement {
    const rendererOptions = props.frame.rendererOptions;
    // The renderer owns its shell handle rather than leaking the library ref:
    // the shell contract is the seam, and only the renderer knows how to answer
    // it from FlashList's recycler state.
    const listRef = React.useRef<FlashListRef<TItem> | null>(null);
    React.useImperativeHandle(ref, () => ({
        scrollToIndex: (params) => listRef.current?.scrollToIndex(params),
        scrollToOffset: (params) => listRef.current?.scrollToOffset(params),
        scrollToEnd: (params) => (listRef.current as FlashListTailScrollCapableRef | null)?.scrollToEnd?.(params),
        clearLayoutCacheOnUpdate: () => listRef.current?.clearLayoutCacheOnUpdate?.(),
        computeVisibleIndices: () => listRef.current?.computeVisibleIndices?.() ?? { startIndex: 0, endIndex: 0 },
        readVisibleSourceIndexRange: () => readFlashListVisibleSourceIndexRange(listRef.current),
        getAbsoluteLastScrollOffset: () => listRef.current?.getAbsoluteLastScrollOffset?.() ?? 0,
        getFirstVisibleIndex: () => listRef.current?.getFirstVisibleIndex?.() ?? 0,
        getLayout: (index) => listRef.current?.getLayout?.(index),
        getScrollableNode: () => listRef.current?.getScrollableNode?.(),
    }), []);

    return (
        <LayoutCommitObserver onCommitLayoutEffect={props.onCommitLayoutEffect}>
            <FlashList
                ref={listRef}
                {...props.platformInteractionProps}
                style={FLASH_LIST_STYLE}
                data={props.data}
                extraData={props.extraData}
                testID={rendererOptions.identity.testID}
                nativeID={rendererOptions.identity.nativeID}
                inverted={props.frame.dataOrder === 'newest-first' ? true : undefined}
                drawDistance={rendererOptions.virtualization?.renderAheadDistancePx}
                keyExtractor={props.keyExtractor}
                getItemType={props.getItemType}
                renderItem={props.renderItem}
                overrideProps={resolveScrollerOverrideProps(
                    props.overrideProps,
                    rendererOptions.browserScrollAnchoring === 'disabled',
                )}
                scrollEventThrottle={rendererOptions.interaction.scrollEventThrottle}
                keyboardShouldPersistTaps={rendererOptions.interaction.keyboardShouldPersistTaps}
                keyboardDismissMode={rendererOptions.interaction.keyboardDismissMode}
                happierPauseOffsetCorrection={rendererOptions.offsetCorrection === 'paused'}
                maintainVisibleContentPosition={
                    rendererOptions.visibleContentMaintenance as FlashListPropsCompat<TItem>['maintainVisibleContentPosition']
                }
                onLoad={props.onLoad}
                onLayout={props.onLayout}
                onContentSizeChange={props.onContentSizeChange}
                onScroll={props.onScroll}
                onViewableItemsChanged={props.onViewableItemsChanged}
                viewabilityConfig={props.viewabilityConfig}
                onScrollBeginDrag={props.onScrollBeginDrag}
                onScrollEndDrag={props.onScrollEndDrag}
                onMomentumScrollBegin={props.onMomentumScrollBegin}
                onMomentumScrollEnd={props.onMomentumScrollEnd}
                onStartReachedThreshold={props.onStartReachedThreshold}
                onStartReached={props.onStartReached}
                onEndReachedThreshold={props.onEndReachedThreshold}
                onEndReached={props.onEndReached}
                onScrollToIndexFailed={props.onScrollToIndexFailed}
                ListHeaderComponent={props.header ?? null}
                ListFooterComponent={props.footer ?? null}
            />
        </LayoutCommitObserver>
    );
}

const FlashListTranscriptRenderer = React.forwardRef(FlashListTranscriptRendererInner) as TranscriptListRenderer['Component'];

export const flashListRenderer: TranscriptListRenderer = {
    kind: 'flashList',
    orientation: 'frame-resolved',
    Component: FlashListTranscriptRenderer,
};
