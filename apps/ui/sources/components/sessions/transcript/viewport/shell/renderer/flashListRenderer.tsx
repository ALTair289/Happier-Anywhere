import * as React from 'react';

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
} from './types';

const FLASH_LIST_STYLE = { flex: 1, minHeight: 0 } as const;

function FlashListTranscriptRendererInner<TItem>(
    props: TranscriptListRendererProps<TItem>,
    ref: React.ForwardedRef<TranscriptListShellRef<TItem>>,
): React.ReactElement {
    const flashListOptions = props.frame.rendererOptions.flashList;

    return (
        <LayoutCommitObserver onCommitLayoutEffect={props.onCommitLayoutEffect}>
            <FlashList
                ref={ref as React.ForwardedRef<FlashListRef<TItem>>}
                {...props.platformInteractionProps}
                style={FLASH_LIST_STYLE}
                data={props.data}
                extraData={props.extraData}
                testID={flashListOptions.testID}
                nativeID={flashListOptions.nativeID}
                inverted={flashListOptions.inverted ? true : undefined}
                drawDistance={flashListOptions.drawDistance}
                keyExtractor={props.keyExtractor}
                getItemType={props.getItemType}
                renderItem={props.renderItem}
                overrideProps={props.overrideProps}
                scrollEventThrottle={flashListOptions.scrollEventThrottle}
                keyboardShouldPersistTaps={flashListOptions.keyboardShouldPersistTaps}
                keyboardDismissMode={flashListOptions.keyboardDismissMode}
                happierPauseOffsetCorrection={flashListOptions.pauseOffsetCorrection === true}
                maintainVisibleContentPosition={
                    flashListOptions.maintainVisibleContentPosition as FlashListPropsCompat<TItem>['maintainVisibleContentPosition']
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
    Component: FlashListTranscriptRenderer,
};
