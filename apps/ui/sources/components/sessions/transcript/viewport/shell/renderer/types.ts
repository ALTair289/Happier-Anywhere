import type * as React from 'react';
import type { FlatListProps } from 'react-native';

import type { TranscriptListShellFrame } from '@/components/sessions/transcript/viewport/shell/transcriptListShellCapabilities';

export type TranscriptListShellRef<TItem = unknown> = Readonly<{
    scrollToIndex: (params: { index: number; animated?: boolean; viewOffset?: number; viewPosition?: number }) => void | Promise<void>;
    scrollToOffset: (params: { offset: number; animated?: boolean }) => void | Promise<void>;
    scrollToEnd?: (params?: { animated?: boolean }) => void | Promise<void>;
    clearLayoutCacheOnUpdate?: () => void;
    computeVisibleIndices?: () => { startIndex: number; endIndex: number };
    getAbsoluteLastScrollOffset?: () => number;
    getFirstVisibleIndex?: () => number;
    getLayout?: (index: number) => { x: number; y: number; width: number; height: number } | undefined;
}>;

export type TranscriptListShellPlatformInteractionProps = Readonly<{
    onMouseDown?: unknown;
    onPointerDown?: unknown;
    onTouchCancel?: unknown;
    onTouchEnd?: unknown;
    onTouchMove?: unknown;
    onTouchStart?: unknown;
    onWheel?: unknown;
}>;

export type TranscriptListRendererProps<TItem> = Readonly<{
    data: readonly TItem[];
    extraData?: unknown;
    keyExtractor: NonNullable<FlatListProps<TItem>['keyExtractor']>;
    getItemType?: (item: TItem, index: number, extraData?: unknown) => string | number | undefined;
    renderItem: NonNullable<FlatListProps<TItem>['renderItem']>;
    frame: TranscriptListShellFrame;
    overrideProps?: Record<string, unknown>;
    platformInteractionProps?: TranscriptListShellPlatformInteractionProps;
    onLoad?: (info: { elapsedTimeInMs: number }) => void;
    onCommitLayoutEffect?: () => void;
    onLayout?: FlatListProps<TItem>['onLayout'];
    onContentSizeChange?: FlatListProps<TItem>['onContentSizeChange'];
    onScroll?: FlatListProps<TItem>['onScroll'];
    onViewableItemsChanged?: FlatListProps<TItem>['onViewableItemsChanged'];
    viewabilityConfig?: FlatListProps<TItem>['viewabilityConfig'];
    onScrollBeginDrag?: FlatListProps<TItem>['onScrollBeginDrag'];
    onScrollEndDrag?: FlatListProps<TItem>['onScrollEndDrag'];
    onMomentumScrollBegin?: FlatListProps<TItem>['onMomentumScrollBegin'];
    onMomentumScrollEnd?: FlatListProps<TItem>['onMomentumScrollEnd'];
    onScrollToIndexFailed?: FlatListProps<TItem>['onScrollToIndexFailed'];
    onStartReachedThreshold?: number;
    onStartReached?: () => void;
    onEndReachedThreshold?: FlatListProps<TItem>['onEndReachedThreshold'];
    onEndReached?: FlatListProps<TItem>['onEndReached'];
    header?: React.ReactNode;
    footer?: React.ReactNode;
}>;

export type TranscriptListShellProps<TItem> = TranscriptListRendererProps<TItem> & Readonly<{
    olderLoadOverlay?: React.ReactNode;
    catchUpOverlay?: React.ReactNode;
}>;

export type TranscriptListRendererComponent = <TItem>(
    props: TranscriptListRendererProps<TItem> & React.RefAttributes<TranscriptListShellRef<TItem>>,
) => React.ReactElement;

export type TranscriptListRenderer = Readonly<{
    kind: 'flashList';
    Component: TranscriptListRendererComponent;
}>;
