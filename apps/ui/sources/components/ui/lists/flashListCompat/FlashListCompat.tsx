import * as React from 'react';
import { FlatList, type FlatListProps, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native';
import type { FlashListProps } from '@shopify/flash-list';

import { resolveFlashListRuntime, type FlashListCompatComponent } from './resolveFlashListRuntime';

export type FlashListRef<T> = Readonly<{
  scrollToIndex: (params: { index: number; animated?: boolean; viewPosition?: number; viewOffset?: number }) => void | Promise<void>;
  scrollToOffset: (params: { offset: number; animated?: boolean }) => void;
  getScrollableNode?: () => unknown;
  clearLayoutCacheOnUpdate?: () => void;
  getFirstVisibleIndex?: () => number;
  computeVisibleIndices?: () => { startIndex: number; endIndex: number };
  getLayout?: (index: number) => { x: number; y: number; width: number; height: number } | undefined;
  getAbsoluteLastScrollOffset?: () => number;
}>;

export type FlashListCompatMaintainVisibleContentPosition =
  | FlatListProps<unknown>['maintainVisibleContentPosition']
  | FlashListProps<unknown>['maintainVisibleContentPosition'];

export type FlashListPropsCompat<T> = Omit<FlatListProps<T>, 'maintainVisibleContentPosition'> & Readonly<{
  maintainVisibleContentPosition?: FlashListCompatMaintainVisibleContentPosition;
  happierPauseOffsetCorrection?: boolean;
  estimatedItemSize?: number;
  drawDistance?: number;
  overrideItemLayout?: (layout: unknown, item: T, index: number, maxColumns?: number, extraData?: unknown) => void;
  getItemType?: (item: T, index: number, extraData?: unknown) => string | number | undefined;
  initialScrollIndexParams?: Readonly<{ viewOffset?: number }>;
  onStartReached?: () => void;
  onStartReachedThreshold?: number;
  onLoad?: (info: { elapsedTimeInMs: number }) => void;
  overrideProps?: Record<string, unknown>;
}>;

function resolveFlatListMaintainVisibleContentPosition<T>(
  value: FlashListCompatMaintainVisibleContentPosition | undefined,
): FlatListProps<T>['maintainVisibleContentPosition'] | undefined {
  if (value == null) return value;
  if (typeof value !== 'object') return undefined;
  if (!('minIndexForVisible' in value)) return undefined;
  if (typeof value.minIndexForVisible !== 'number' || !Number.isFinite(value.minIndexForVisible)) {
    return undefined;
  }
  const result: NonNullable<FlatListProps<T>['maintainVisibleContentPosition']> = {
    minIndexForVisible: value.minIndexForVisible,
  };
  if (
    'autoscrollToTopThreshold' in value &&
    (typeof value.autoscrollToTopThreshold === 'number' || value.autoscrollToTopThreshold == null)
  ) {
    result.autoscrollToTopThreshold = value.autoscrollToTopThreshold;
  }
  return result;
}

export type FlashListMappingKey = string | number | bigint;

export type FlashListMappingHelper = Readonly<{
  getMappingKey: (itemKey: FlashListMappingKey, index: number) => FlashListMappingKey;
}>;

export type FlashListLayoutStateSetter<T> = (
  newValue: T | ((prevValue: T) => T),
  skipParentLayout?: boolean,
) => void;

export type FlashListLayoutStateInitialValue<T> = T | (() => T);
export type FlashListRecyclingStateInitialValue<T> = T | (() => T);

export type FlashListLayoutCommitObserverProps = Readonly<{
  children: React.ReactNode;
  onCommitLayoutEffect?: () => void;
}>;

type FlashListSupportModule = Readonly<{
  LayoutCommitObserver?: React.ComponentType<FlashListLayoutCommitObserverProps>;
  useLayoutState?: <T>(initialState: FlashListLayoutStateInitialValue<T>) => [T, FlashListLayoutStateSetter<T>];
  useMappingHelper?: () => FlashListMappingHelper;
  useRecyclingState?: <T>(
    initialState: FlashListRecyclingStateInitialValue<T>,
    deps: React.DependencyList,
    onReset?: () => void,
  ) => [T, FlashListLayoutStateSetter<T>];
}>;

const FallbackFlashListBase = React.forwardRef(function FallbackFlashListInner<T>(
  props: FlashListPropsCompat<T>,
  ref: React.ForwardedRef<FlashListRef<T>>,
) {
  const {
    estimatedItemSize: _estimatedItemSize,
    drawDistance: _drawDistance,
    overrideItemLayout: _overrideItemLayout,
    getItemType: _getItemType,
    initialScrollIndexParams: _initialScrollIndexParams,
    happierPauseOffsetCorrection: _happierPauseOffsetCorrection,
    maintainVisibleContentPosition,
    onStartReached,
    onStartReachedThreshold,
    onLoad,
    overrideProps: _overrideProps,
    onScroll,
    ...restProps
  } = props;
  const flatListMaintainVisibleContentPosition =
    resolveFlatListMaintainVisibleContentPosition<T>(maintainVisibleContentPosition);

  const startReachedRef = React.useRef(false);
  const forwardedOnScroll = React.useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    onScroll?.(event);
    if (!onStartReached) return;

    const thresholdRatio =
      typeof onStartReachedThreshold === 'number' && Number.isFinite(onStartReachedThreshold)
        ? Math.max(0, onStartReachedThreshold)
        : 0;
    const thresholdPx = Math.max(1, thresholdRatio * 100);
    const offsetY = event.nativeEvent.contentOffset?.y ?? 0;

    if (offsetY <= thresholdPx) {
      if (!startReachedRef.current) {
        startReachedRef.current = true;
        onStartReached();
      }
      return;
    }

    startReachedRef.current = false;
  }, [onScroll, onStartReached, onStartReachedThreshold]);

  React.useEffect(() => {
    onLoad?.({ elapsedTimeInMs: 0 });
  }, [onLoad]);

  return (
    <FlatList
      {...restProps}
      ref={ref as never}
      maintainVisibleContentPosition={flatListMaintainVisibleContentPosition}
      onScroll={forwardedOnScroll}
    />
  );
}) as unknown as FlashListCompatComponent;

function resolveInitialLayoutStateValue<T>(initialState: FlashListLayoutStateInitialValue<T>): T {
  return typeof initialState === 'function'
    ? (initialState as () => T)()
    : initialState;
}

function fallbackUseLayoutState<T>(
  initialState: FlashListLayoutStateInitialValue<T>,
): [T, FlashListLayoutStateSetter<T>] {
  const [state, setState] = React.useState<T>(() => resolveInitialLayoutStateValue(initialState));
  const setLayoutState = React.useCallback<FlashListLayoutStateSetter<T>>((newValue) => {
    setState((previousValue) => (
      typeof newValue === 'function'
        ? (newValue as (prevValue: T) => T)(previousValue)
        : newValue
    ));
  }, []);

  return [state, setLayoutState];
}

function fallbackUseRecyclingState<T>(
  initialState: FlashListRecyclingStateInitialValue<T>,
  deps: React.DependencyList,
  onReset?: () => void,
): [T, FlashListLayoutStateSetter<T>] {
  const valueRef = React.useRef<T>(resolveInitialLayoutStateValue(initialState));
  const [, setCounter] = fallbackUseLayoutState(0);

  React.useMemo(() => {
    valueRef.current = resolveInitialLayoutStateValue(initialState);
    onReset?.();
  }, deps);

  const setRecyclingState = React.useCallback<FlashListLayoutStateSetter<T>>((newValue) => {
    const nextValue = typeof newValue === 'function'
      ? (newValue as (prevValue: T) => T)(valueRef.current)
      : newValue;

    if (Object.is(nextValue, valueRef.current)) return;
    valueRef.current = nextValue;
    setCounter((previousValue) => previousValue + 1, true);
  }, [setCounter]);

  return [valueRef.current, setRecyclingState];
}

function fallbackUseMappingHelper(): FlashListMappingHelper {
  return React.useMemo(() => ({
    getMappingKey: (itemKey: FlashListMappingKey) => itemKey,
  }), []);
}

const FallbackLayoutCommitObserver = React.memo(function FallbackLayoutCommitObserver(
  props: FlashListLayoutCommitObserverProps,
) {
  React.useLayoutEffect(() => {
    props.onCommitLayoutEffect?.();
  });

  return <>{props.children}</>;
});

function loadFlashListModule(): unknown {
  return require('@shopify/flash-list') as typeof import('@shopify/flash-list');
}

function loadFlashListSupportModule(): FlashListSupportModule | null {
  try {
    return loadFlashListModule() as FlashListSupportModule;
  } catch {
    return null;
  }
}

const runtime = resolveFlashListRuntime(loadFlashListModule, FallbackFlashListBase);
const flashListSupportModule = runtime.usingFallback ? null : loadFlashListSupportModule();

export const FlashList = (runtime.usingFallback ? FallbackFlashListBase : runtime.Component) as FlashListCompatComponent;
export const flashListRuntime = runtime;
export const useLayoutState = flashListSupportModule?.useLayoutState ?? fallbackUseLayoutState;
export const useRecyclingState = flashListSupportModule?.useRecyclingState ?? fallbackUseRecyclingState;
export const useMappingHelper = flashListSupportModule?.useMappingHelper ?? fallbackUseMappingHelper;
export const LayoutCommitObserver = flashListSupportModule?.LayoutCommitObserver ?? FallbackLayoutCommitObserver;
