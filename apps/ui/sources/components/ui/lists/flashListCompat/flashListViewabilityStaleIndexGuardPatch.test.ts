import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Contract + behavior test for the local patch-package fix on @shopify/flash-list
 * (viewability stale-index guard, 2026-07-11, Sentry HAPPIER-UI-5S / HAPPIER-UI-2F).
 *
 * FlashList 2.3.2's ViewabilityHelper caches `possiblyViewableIndices` between passes.
 * When the dataset shrinks, `RVLayoutManager.modifyLayout` truncates `layouts`, but nothing
 * prunes the cached indices. The next viewability pass — typically the user's FIRST touch on
 * the list (`recordInteraction`) — re-filters the stale indices through the THROWING
 * `RecyclerViewManager.getLayout`, which raises "index out of bounds, not enough layouts".
 * In release builds that unhandled JS error becomes RCTFatal → a C++ jsi::JSError rethrown on
 * the ExceptionsManager dispatch queue → std::terminate → SIGABRT (the TestFlight crash wave
 * on build 217).
 *
 * The library already ships the bounds-safe accessor (`tryGetLayout`) and
 * `ViewabilityHelper.isItemViewable` already treats an `undefined` layout as not viewable;
 * the patch simply wires the safe accessor into `ViewabilityManager.updateViewableItems`,
 * the single choke point every viewability pass flows through.
 */

const require_ = createRequire(import.meta.url);

function resolveFlashListRoot(): string {
  const packageJsonPath = require_.resolve('@shopify/flash-list/package.json');
  return dirname(packageJsonPath);
}

type ViewableItemsChangedInfo = Readonly<{
  viewableItems: readonly { index: number | null; isViewable: boolean }[];
  changed: readonly { index: number | null; isViewable: boolean }[];
}>;

type FlashListRecyclerViewManager<T> = Readonly<{
  modifyChildrenLayout: (layoutInfo: unknown[], dataLength: number) => boolean;
  props: FlashListViewabilityProps<T>;
  updateLayoutParams: (windowSize: { height: number; width: number }, firstItemOffset: number) => void;
  updateProps: (props: FlashListViewabilityProps<T>) => void;
}>;

type FlashListViewabilityProps<T> = Readonly<{
  data: T[];
  estimatedItemSize: number;
  horizontal: boolean;
  keyExtractor: (item: T, index: number) => string;
  onViewableItemsChanged: (info: ViewableItemsChangedInfo) => void;
  overrideItemLayout: (layout: { size?: number }) => void;
  renderItem: (info: { item: T; index: number }) => unknown;
  viewabilityConfig: { itemVisiblePercentThreshold: number; minimumViewTime: number };
}>;

type FlashListRecyclerViewManagerConstructor = new <T>(
  props: FlashListViewabilityProps<T>,
) => FlashListRecyclerViewManager<T>;

type FlashListViewabilityManager = Readonly<{
  recordInteraction: () => void;
  updateViewableItems: (newViewableIndices?: number[]) => void;
}>;

type FlashListViewabilityManagerConstructor = new <T>(
  rvManager: FlashListRecyclerViewManager<T>,
) => FlashListViewabilityManager;

async function loadFlashListViewabilityHarness() {
  const recyclerViewManagerModule = (await import(
    '../../../../../node_modules/@shopify/flash-list/dist/recyclerview/RecyclerViewManager.js'
  )) as unknown as { RecyclerViewManager: FlashListRecyclerViewManagerConstructor };
  const viewabilityManagerModule = (await import(
    '../../../../../node_modules/@shopify/flash-list/dist/recyclerview/viewability/ViewabilityManager.js'
  )) as unknown as { default: FlashListViewabilityManagerConstructor };
  return {
    RecyclerViewManager: recyclerViewManagerModule.RecyclerViewManager,
    ViewabilityManager: viewabilityManagerModule.default,
  };
}

type Row = Readonly<{ id: string }>;

function makeProps(
  data: Row[],
  onViewableItemsChanged: (info: ViewableItemsChangedInfo) => void,
): FlashListViewabilityProps<Row> {
  return {
    data,
    estimatedItemSize: 80,
    horizontal: false,
    keyExtractor: (item) => item.id,
    onViewableItemsChanged,
    overrideItemLayout: (layout) => {
      layout.size = 80;
    },
    renderItem: () => null,
    viewabilityConfig: { itemVisiblePercentThreshold: 1, minimumViewTime: 0 },
  };
}

describe('flash-list viewability stale-index guard patch', () => {
  it('keeps the patch file carrying the viewability guard for the installed version', () => {
    const flashListRoot = resolveFlashListRoot();
    const pkg = JSON.parse(readFileSync(join(flashListRoot, 'package.json'), 'utf8')) as {
      version: string;
    };
    const patchPath = resolve(
      __dirname,
      '../../../../../patches',
      `@shopify+flash-list+${pkg.version}.patch`,
    );
    expect(existsSync(patchPath), `expected patch file at ${patchPath}`).toBe(true);

    const patchContent = readFileSync(patchPath, 'utf8');
    expect(patchContent).toContain('HAPPIER PATCH(flash-list-viewability-stale-index-guard)');
    expect(patchContent).toContain('dist/recyclerview/viewability/ViewabilityManager.js');
  });

  it('ships an installed ViewabilityManager that resolves layouts through the bounds-safe accessor', () => {
    const flashListRoot = resolveFlashListRoot();
    const distViewabilityManager = readFileSync(
      join(flashListRoot, 'dist/recyclerview/viewability/ViewabilityManager.js'),
      'utf8',
    );

    expect(distViewabilityManager).toContain(
      'HAPPIER PATCH(flash-list-viewability-stale-index-guard)',
    );
    expect(distViewabilityManager).toContain('tryGetLayout');
    // The throwing accessor must be gone from the viewability path entirely.
    expect(distViewabilityManager).not.toMatch(/rvManager\.getLayout\(/);
  });

  it('does not throw when the first interaction re-checks stale indices after the dataset shrank', async () => {
    const { RecyclerViewManager, ViewabilityManager } = await loadFlashListViewabilityHarness();

    const reported: ViewableItemsChangedInfo[] = [];
    const onViewableItemsChanged = (info: ViewableItemsChangedInfo) => {
      reported.push(info);
    };

    const threeRows: Row[] = [{ id: 'row-1' }, { id: 'row-2' }, { id: 'row-3' }];
    const manager = new RecyclerViewManager<Row>(makeProps(threeRows, onViewableItemsChanged));
    manager.updateProps(makeProps(threeRows, onViewableItemsChanged));
    manager.updateLayoutParams({ width: 400, height: 800 }, 0);
    manager.modifyChildrenLayout([], threeRows.length);

    const viewability = new ViewabilityManager(manager);
    // A visible-indices pass while all three rows exist caches possiblyViewableIndices=[0,1,2].
    viewability.updateViewableItems([0, 1, 2]);

    // The dataset shrinks: RVLayoutManager.modifyLayout truncates layouts to length 1 while the
    // helper's cached indices still reference rows 1 and 2.
    const oneRow: Row[] = [{ id: 'row-1' }];
    manager.updateProps(makeProps(oneRow, onViewableItemsChanged));
    manager.modifyChildrenLayout([], oneRow.length);

    // Only reports emitted after the shrink are under test; the pre-shrink report legitimately
    // referenced all three rows.
    reported.length = 0;

    // The user's first touch triggers recordInteraction → updateViewableItems() with NO fresh
    // indices, re-filtering the stale cache. Unpatched, this throws
    // "index out of bounds, not enough layouts" and crashes release builds.
    expect(() => viewability.recordInteraction()).not.toThrow();

    // Every index reported as VIEWABLE must be within the shrunk dataset. (Tokens with
    // isViewable=false in `changed` legitimately carry the old index of a row that left the
    // viewport — that is the RN viewability contract, not a stale-index leak.)
    for (const info of reported) {
      for (const token of info.viewableItems) {
        expect(token.index).not.toBeNull();
        expect(token.index as number).toBeLessThan(oneRow.length);
      }
      for (const token of info.changed) {
        if (token.isViewable) {
          expect(token.index).not.toBeNull();
          expect(token.index as number).toBeLessThan(oneRow.length);
        }
      }
    }
  });

  it('keeps in-bounds viewability reporting intact after the guard', async () => {
    const { RecyclerViewManager, ViewabilityManager } = await loadFlashListViewabilityHarness();

    const reported: ViewableItemsChangedInfo[] = [];
    const rows: Row[] = [{ id: 'row-1' }, { id: 'row-2' }];
    const manager = new RecyclerViewManager<Row>(
      makeProps(rows, (info) => {
        reported.push(info);
      }),
    );
    manager.updateProps(manager.props);
    manager.updateLayoutParams({ width: 400, height: 800 }, 0);
    manager.modifyChildrenLayout([], rows.length);

    const viewability = new ViewabilityManager(manager);
    viewability.updateViewableItems([0, 1]);

    expect(reported.length).toBeGreaterThan(0);
    const lastReport = reported[reported.length - 1];
    expect(lastReport.viewableItems.map((token) => token.index)).toEqual([0, 1]);
  });
});
