import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  FlashListPropsCompat,
  FlashListRef,
} from '@/components/ui/lists/flashListCompat/FlashListCompat';

type CompatTypeTestItem = Readonly<{ id: string }>;

describe('FlashListCompat', () => {
  afterEach(() => {
    vi.resetModules();
    vi.doUnmock('@shopify/flash-list');
    vi.doUnmock('@/components/ui/lists/flashListCompat/FlashListCompat');
    vi.doUnmock('react-native');
  });

  it('falls back when the FlashList module throws during import', async () => {
    vi.doUnmock('@/components/ui/lists/flashListCompat/FlashListCompat');
    vi.doMock('@shopify/flash-list', () => {
      throw new TypeError('require(...).__importStar is not a function');
    });

    const module = await import('@/components/ui/lists/flashListCompat/FlashListCompat');

    expect(module.flashListRuntime.usingFallback).toBe(true);
    expect(module.flashListRuntime.reason).toBe('flashlist_unavailable');
    expect(module.FlashList).toBeDefined();
  });

  it('exposes the FlashList v2 recycling hooks and layout observer on the compat surface', async () => {
    vi.doMock('@shopify/flash-list', () => {
      throw new TypeError('FlashList unavailable in this test runtime');
    });

    const module = await import('@/components/ui/lists/flashListCompat/FlashListCompat');

    expect(typeof module.useMappingHelper).toBe('function');
    expect(typeof module.useLayoutState).toBe('function');
    expect(typeof module.useRecyclingState).toBe('function');
    expect(module.LayoutCommitObserver).toBeDefined();
  });

  it('provides safe fallback recycling hooks and layout observer outside FlashList contexts', async () => {
    vi.doMock('@shopify/flash-list', () => {
      throw new TypeError('FlashList unavailable in this test runtime');
    });

    const module = await import('@/components/ui/lists/flashListCompat/FlashListCompat');
    const onCommitLayoutEffect = vi.fn();
    const observedValues: Array<Readonly<{
      layoutValue: number;
      mappingKey: string | number | bigint;
      recyclingValue: string;
    }>> = [];
    const LayoutCommitObserver = module.LayoutCommitObserver;

    function HookProbe() {
      const { getMappingKey } = module.useMappingHelper();
      const [layoutValue, setLayoutValue] = module.useLayoutState(1);
      const [recyclingValue, setRecyclingValue] = module.useRecyclingState('initial', ['stable']);

      React.useEffect(() => {
        setLayoutValue((value) => value + 1);
        setRecyclingValue('updated');
      }, [setLayoutValue, setRecyclingValue]);

      observedValues.push({
        layoutValue,
        mappingKey: getMappingKey('message-1', 5),
        recyclingValue,
      });

      return null;
    }

    await act(async () => {
      renderer.create(
        <LayoutCommitObserver onCommitLayoutEffect={onCommitLayoutEffect}>
          <HookProbe />
        </LayoutCommitObserver>,
      );
    });

    expect(module.flashListRuntime.usingFallback).toBe(true);
    expect(observedValues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          layoutValue: 1,
          mappingKey: 'message-1',
          recyclingValue: 'initial',
        }),
        expect.objectContaining({
          layoutValue: 2,
          mappingKey: 'message-1',
          recyclingValue: 'updated',
        }),
      ]),
    );
    expect(onCommitLayoutEffect).toHaveBeenCalled();
  });

  it('keeps FlashList v2 measurement methods optional on the compat ref type', () => {
    const fallbackRef = {
      scrollToIndex: () => undefined,
      scrollToOffset: () => undefined,
    } satisfies FlashListRef<CompatTypeTestItem>;

    expect(typeof fallbackRef.scrollToIndex).toBe('function');
  });

  it('accepts FlashList v2 scroll offsets and measurement methods on the compat ref type', () => {
    const calls: Array<{ index: number; viewOffset?: number }> = [];
    const flashListV2Ref = {
      scrollToIndex: (params: { index: number; animated?: boolean; viewPosition?: number; viewOffset?: number }) => {
        calls.push({ index: params.index, viewOffset: params.viewOffset });
      },
      scrollToOffset: () => undefined,
      computeVisibleIndices: () => ({ startIndex: 1, endIndex: 2 }),
      getFirstVisibleIndex: () => 1,
      getLayout: (index: number) => ({ x: 0, y: index * 40, width: 320, height: 40 }),
      getAbsoluteLastScrollOffset: () => 80,
    } satisfies FlashListRef<CompatTypeTestItem>;

    flashListV2Ref.scrollToIndex({ index: 2, animated: false, viewOffset: 24 });

    expect(calls).toEqual([{ index: 2, viewOffset: 24 }]);
  });

  it('accepts typed initial scroll offset params and typed onLoad payloads on props', () => {
    const loads: number[] = [];
    const props = {
      data: [],
      renderItem: () => null,
      initialScrollIndexParams: { viewOffset: 32 },
      onLoad: (info: { elapsedTimeInMs: number }) => {
        loads.push(info.elapsedTimeInMs);
      },
    } satisfies FlashListPropsCompat<CompatTypeTestItem>;

    props.onLoad?.({ elapsedTimeInMs: 42 });

    expect(props.initialScrollIndexParams.viewOffset).toBe(32);
    expect(loads).toEqual([42]);
  });

  it('accepts the Happier offset-correction pause prop on the compat surface', () => {
    const props = {
      data: [],
      renderItem: () => null,
      happierPauseOffsetCorrection: true,
    } satisfies FlashListPropsCompat<CompatTypeTestItem>;

    expect(props.happierPauseOffsetCorrection).toBe(true);
  });

  it('accepts FlashList v2 maintain-visible-content-position props on the compat surface', () => {
    const startFromBottomProps = {
      data: [],
      renderItem: () => null,
      maintainVisibleContentPosition: {
        startRenderingFromBottom: false,
        autoscrollToBottomThreshold: 0.25,
        autoscrollToTopThreshold: 0.5,
        animateAutoScrollToBottom: true,
      },
    } satisfies FlashListPropsCompat<CompatTypeTestItem>;
    const disabledFalseProps = {
      data: [],
      renderItem: () => null,
      maintainVisibleContentPosition: {
        disabled: false,
      },
    } satisfies FlashListPropsCompat<CompatTypeTestItem>;

    expect(startFromBottomProps.maintainVisibleContentPosition.startRenderingFromBottom).toBe(false);
    expect(startFromBottomProps.maintainVisibleContentPosition.animateAutoScrollToBottom).toBe(true);
    expect(disabledFalseProps.maintainVisibleContentPosition.disabled).toBe(false);
  });

  it('filters FlashList-only maintain-visible-content-position props from the fallback FlatList', async () => {
    let capturedFlatListProps: Record<string, unknown> | null = null;
    const getCapturedFlatListProps = (): Record<string, unknown> | null => capturedFlatListProps;

    vi.doUnmock('@/components/ui/lists/flashListCompat/FlashListCompat');
    vi.doMock('react-native', async (importOriginal) => {
      const actual = await importOriginal<typeof import('react-native')>();
      return {
        ...actual,
        FlatList: React.forwardRef((props: Record<string, unknown>, _ref: React.ForwardedRef<unknown>) => {
          capturedFlatListProps = props;
          return React.createElement('FlatList');
        }),
      };
    });
    vi.doMock('@shopify/flash-list', () => {
      throw new TypeError('FlashList unavailable in this test runtime');
    });

    const module = await import('@/components/ui/lists/flashListCompat/FlashListCompat');

    await act(async () => {
      renderer.create(
        <module.FlashList
          data={[]}
          renderItem={() => null}
          maintainVisibleContentPosition={{ startRenderingFromBottom: true }}
        />,
      );
    });

    expect(getCapturedFlatListProps()?.maintainVisibleContentPosition).toBeUndefined();
  });

  it('preserves React Native maintain-visible-content-position props on the fallback FlatList', async () => {
    let capturedFlatListProps: Record<string, unknown> | null = null;
    const getCapturedFlatListProps = (): Record<string, unknown> | null => capturedFlatListProps;

    vi.doUnmock('@/components/ui/lists/flashListCompat/FlashListCompat');
    vi.doMock('react-native', async (importOriginal) => {
      const actual = await importOriginal<typeof import('react-native')>();
      return {
        ...actual,
        FlatList: React.forwardRef((props: Record<string, unknown>, _ref: React.ForwardedRef<unknown>) => {
          capturedFlatListProps = props;
          return React.createElement('FlatList');
        }),
      };
    });
    vi.doMock('@shopify/flash-list', () => {
      throw new TypeError('FlashList unavailable in this test runtime');
    });

    const module = await import('@/components/ui/lists/flashListCompat/FlashListCompat');
    const mvcp = { minIndexForVisible: 0, autoscrollToTopThreshold: 10 };

    await act(async () => {
      renderer.create(
        <module.FlashList
          data={[]}
          renderItem={() => null}
          maintainVisibleContentPosition={mvcp}
        />,
      );
    });

    expect(getCapturedFlatListProps()?.maintainVisibleContentPosition).toEqual(mvcp);
  });

  it('strips FlashList-only maintain-visible-content-position keys from mixed fallback props', async () => {
    let capturedFlatListProps: Record<string, unknown> | null = null;
    const getCapturedFlatListProps = (): Record<string, unknown> | null => capturedFlatListProps;

    vi.doUnmock('@/components/ui/lists/flashListCompat/FlashListCompat');
    vi.doMock('react-native', async (importOriginal) => {
      const actual = await importOriginal<typeof import('react-native')>();
      return {
        ...actual,
        FlatList: React.forwardRef((props: Record<string, unknown>, _ref: React.ForwardedRef<unknown>) => {
          capturedFlatListProps = props;
          return React.createElement('FlatList');
        }),
      };
    });
    vi.doMock('@shopify/flash-list', () => {
      throw new TypeError('FlashList unavailable in this test runtime');
    });

    const module = await import('@/components/ui/lists/flashListCompat/FlashListCompat');

    await act(async () => {
      renderer.create(
        <module.FlashList
          data={[]}
          renderItem={() => null}
          maintainVisibleContentPosition={{
            minIndexForVisible: 0,
            autoscrollToTopThreshold: 10,
            startRenderingFromBottom: true,
            autoscrollToBottomThreshold: 0.25,
            animateAutoScrollToBottom: false,
            disabled: false,
          }}
        />,
      );
    });

    expect(getCapturedFlatListProps()?.maintainVisibleContentPosition).toEqual({
      minIndexForVisible: 0,
      autoscrollToTopThreshold: 10,
    });
  });

  it('does not expose unsupported viewPosition on initial scroll params', () => {
    const props = {
      data: [],
      renderItem: () => null,
      // @ts-expect-error FlashList 2.3.1 initialScrollIndexParams only supports viewOffset.
      initialScrollIndexParams: { viewPosition: 0.5 },
    } satisfies FlashListPropsCompat<CompatTypeTestItem>;

    expect(props.initialScrollIndexParams.viewPosition).toBe(0.5);
  });

  it('emits the FlashList onLoad payload shape from the fallback list', async () => {
    vi.doUnmock('@/components/ui/lists/flashListCompat/FlashListCompat');
    vi.doMock('@shopify/flash-list', () => {
      throw new TypeError('FlashList unavailable in this test runtime');
    });

    const module = await import('@/components/ui/lists/flashListCompat/FlashListCompat');
    const onLoad = vi.fn();

    await act(async () => {
      renderer.create(
        <module.FlashList
          data={[]}
          renderItem={() => null}
          onLoad={onLoad}
        />,
      );
    });

    expect(onLoad).toHaveBeenCalledWith({ elapsedTimeInMs: expect.any(Number) });
    expect(onLoad.mock.calls[0]?.[0]).not.toHaveProperty('fallback');
  });
});
