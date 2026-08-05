import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { installUiListsCommonModuleMocks } from './uiListsTestHelpers';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const shared = vi.hoisted(() => ({
    windowWidth: 1280,
}));

installUiListsCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        const base = await createReactNativeWebMock();
        return {
            ...base,
            Dimensions: { get: () => ({ width: shared.windowWidth, height: 900, scale: 2, fontScale: 1 }) },
            useWindowDimensions: () => ({ width: shared.windowWidth, height: 900 }),
        };
    },
});

// The column CONTAINER is stubbed so the assertions can read the distribution
// structurally; the real width→count math is unit-tested in itemGroupColumnLayout.
vi.mock('@/components/ui/lists/ItemGroupColumns', async () => {
    const { createPassThroughModule } = await import('@/dev/testkit/mocks/components');
    return createPassThroughModule(['ItemGroupColumns', 'ItemGroupColumn']);
});

vi.mock('@/constants/Typography', () => ({
    Typography: { default: () => ({}), eyebrow: () => ({}) },
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: any) => React.createElement('Text', props, props.children),
}));

function Row(props: { id: string; showDivider?: boolean }) {
    return React.createElement('RowStub', props);
}

type Screen = Awaited<ReturnType<typeof renderScreen>>;

function flattenStyle(style: unknown): Record<string, unknown> {
    if (Array.isArray(style)) return Object.assign({}, ...style.map((entry) => flattenStyle(entry)));
    if (style && typeof style === 'object') return style as Record<string, unknown>;
    return {};
}

function readRowIds(screen: Screen): string[] {
    return screen.findAllByType('RowStub' as never).map((row) => row.props.id as string);
}

function readShowDividers(screen: Screen): Array<boolean | undefined> {
    return screen.findAllByType('RowStub' as never).map((row) => row.props.showDivider as boolean | undefined);
}

function readColumnStackIds(screen: Screen): string[][] {
    return screen
        .findAllByType('ItemGroupColumn' as never)
        .map((column) => column.findAllByType('RowStub' as never).map((row) => row.props.id as string));
}

async function renderGroup(children: React.ReactNode, columns?: 1 | 2 | 3) {
    const { ItemGroup } = await import('./ItemGroup');
    return await renderScreen(
        <ItemGroup title="Group" columns={columns}>
            {children}
        </ItemGroup>,
    );
}

const THREE_ROWS = (
    <>
        <Row id="a" />
        <Row id="b" />
        <Row id="c" />
    </>
);

describe('ItemGroup columns', () => {
    it('renders one shared card with dividers when no column count is requested', async () => {
        shared.windowWidth = 1280;
        const screen = await renderGroup(THREE_ROWS);

        expect(readRowIds(screen)).toEqual(['a', 'b', 'c']);
        expect(readShowDividers(screen)).toEqual([true, true, false]);
        expect(readColumnStackIds(screen)).toEqual([]);
    });

    it('collapses to the single-column layout on a narrow window even when columns are requested', async () => {
        shared.windowWidth = 420;
        const screen = await renderGroup(THREE_ROWS, 2);

        expect(readRowIds(screen)).toEqual(['a', 'b', 'c']);
        expect(readShowDividers(screen)).toEqual([true, true, false]);
        expect(readColumnStackIds(screen)).toEqual([]);
    });

    it('accounts for both horizontal insets before opening a second column', async () => {
        // The two cards need 652px after the default 16px inset on each side.
        shared.windowWidth = 668;
        const screen = await renderGroup(THREE_ROWS, 2);

        expect(readColumnStackIds(screen)).toEqual([]);
    });

    it('keeps a lone row full width instead of stranding it in a half-width card', async () => {
        shared.windowWidth = 1280;
        const screen = await renderGroup(<Row id="only" />, 2);

        expect(readRowIds(screen)).toEqual(['only']);
        expect(readColumnStackIds(screen)).toEqual([]);
    });

    it('distributes rows round-robin across column stacks on a wide window', async () => {
        shared.windowWidth = 1280;
        const screen = await renderGroup(THREE_ROWS, 2);

        expect(readColumnStackIds(screen)).toEqual([['a', 'c'], ['b']]);
    });

    it('insets the columns grid inside its own width, so two columns never outgrow one card', async () => {
        shared.windowWidth = 1280;
        const { Platform } = await import('react-native');
        const { ITEM_GROUP_CONTENT_MARGIN_HORIZONTAL_PX } = await import('./itemGroupSpacing');
        const contentMargin = Platform.select(ITEM_GROUP_CONTENT_MARGIN_HORIZONTAL_PX);

        const screen = await renderGroup(THREE_ROWS, 2);
        const grid = screen.findAllByType('ItemGroupColumns' as never)[0];

        // The grid root is `width: '100%'`. A horizontal MARGIN sits outside that
        // resolved width, so the grid would occupy 100% + 2*margin and overflow
        // the single card's box. The inset has to be padding, which is inside it.
        expect(grid?.props.paddingHorizontal).toBe(contentMargin);
        expect(flattenStyle(grid?.props.style)).not.toHaveProperty('marginHorizontal');
    });

    it('drops dividers in the multi-column layout because each row is its own card', async () => {
        shared.windowWidth = 1280;
        const screen = await renderGroup(THREE_ROWS, 2);

        expect(readShowDividers(screen)).toEqual([false, false, false]);
    });

    it('keeps the group title and footer outside the columns', async () => {
        shared.windowWidth = 1280;
        const { ItemGroup } = await import('./ItemGroup');
        const screen = await renderScreen(
            <ItemGroup title="Group title" footer="Group footer" columns={2}>
                {THREE_ROWS}
            </ItemGroup>,
        );

        const texts = screen.findAllByType('Text' as never).map((node) => node.props.children);
        expect(texts).toContain('Group title');
        expect(texts).toContain('Group footer');
    });
});
