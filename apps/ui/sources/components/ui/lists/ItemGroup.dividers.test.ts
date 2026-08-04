import React from 'react';
import { describe, expect, it } from 'vitest';
import { withItemGroupDividers, withItemGroupStandaloneRows } from './ItemGroup.dividers';
import { ItemGroupRowPositionProvider } from './ItemGroupRowPosition';

type FragmentProps = {
    children?: React.ReactNode;
};

function TestItem(_props: { id: string; showDivider?: boolean }) {
    return null;
}

function collectShowDividers(node: React.ReactNode): Array<boolean | undefined> {
    const values: Array<boolean | undefined> = [];

    const walk = (n: React.ReactNode) => {
        React.Children.forEach(n, (child) => {
            if (!React.isValidElement(child)) return;
            if (child.type === React.Fragment) {
                const fragment = child as React.ReactElement<FragmentProps>;
                walk(fragment.props.children);
                return;
            }
            if (child.type === ItemGroupRowPositionProvider) {
                const provider = child as React.ReactElement<{ children?: React.ReactNode }>;
                walk(provider.props.children);
                return;
            }
            if (child.type === TestItem) {
                const element = child as React.ReactElement<{ showDivider?: boolean }>;
                values.push(element.props.showDivider);
                return;
            }
            // Ignore other element types.
        });
    };

    walk(node);
    return values;
}

describe('withItemGroupDividers', () => {
    it('drops primitive children that would become invalid View text nodes', () => {
        expect(withItemGroupDividers(null)).toBe(null);
        expect(withItemGroupDividers(undefined)).toBe(null);
        expect(withItemGroupDividers('text-only')).toBe(null);

        const children = React.createElement(
            React.Fragment,
            null,
            '\n    ',
            React.createElement(TestItem, { id: 'a' }),
            ' ',
            React.createElement(TestItem, { id: 'b' }),
            0,
        );

        const processed = withItemGroupDividers(children);
        expect(collectShowDividers(processed)).toEqual([true, false]);
    });

    it('treats fragment children as part of the divider sequence', () => {
        const children = React.createElement(
            React.Fragment,
            null,
            React.createElement(TestItem, { id: 'a' }),
            React.createElement(
                React.Fragment,
                null,
                React.createElement(TestItem, { id: 'b' }),
                React.createElement(TestItem, { id: 'c' }),
            ),
        );

        const processed = withItemGroupDividers(children);
        expect(collectShowDividers(processed)).toEqual([true, true, false]);
    });

    it('preserves explicit showDivider={false} overrides', () => {
        const children = React.createElement(
            React.Fragment,
            null,
            React.createElement(TestItem, { id: 'a', showDivider: false }),
            React.createElement(TestItem, { id: 'b' }),
            React.createElement(TestItem, { id: 'c' }),
        );

        const processed = withItemGroupDividers(children);
        expect(collectShowDividers(processed)).toEqual([false, true, false]);
    });

    it('never renders a divider on the final row even when explicitly requested', () => {
        const children = React.createElement(
            React.Fragment,
            null,
            React.createElement(TestItem, { id: 'a', showDivider: true }),
            React.createElement(TestItem, { id: 'b', showDivider: true }),
        );

        const processed = withItemGroupDividers(children);
        expect(collectShowDividers(processed)).toEqual([true, false]);
    });
});

function collectRowPositions(nodes: ReadonlyArray<React.ReactNode>) {
    return nodes.map((node) => {
        if (!React.isValidElement(node) || node.type !== ItemGroupRowPositionProvider) return null;
        return (node as React.ReactElement<{ value: unknown }>).props.value;
    });
}

describe('withItemGroupStandaloneRows', () => {
    it('gives every row both edge positions so all four corners round', () => {
        const children = React.createElement(
            React.Fragment,
            null,
            React.createElement(TestItem, { id: 'a' }),
            React.createElement(TestItem, { id: 'b' }),
            React.createElement(TestItem, { id: 'c' }),
        );

        const rows = withItemGroupStandaloneRows(children);
        expect(rows).toHaveLength(3);
        expect(collectRowPositions(rows)).toEqual([
            { isFirst: true, isLast: true },
            { isFirst: true, isLast: true },
            { isFirst: true, isLast: true },
        ]);
    });

    it('suppresses dividers because the gap between cards separates them', () => {
        const children = React.createElement(
            React.Fragment,
            null,
            React.createElement(TestItem, { id: 'a', showDivider: true }),
            React.createElement(TestItem, { id: 'b' }),
        );

        expect(collectShowDividers(withItemGroupStandaloneRows(children))).toEqual([false, false]);
    });

    it('flattens fragments and drops primitive children, matching the divider walk', () => {
        const children = React.createElement(
            React.Fragment,
            null,
            '\n   ',
            React.createElement(TestItem, { id: 'a' }),
            React.createElement(
                React.Fragment,
                null,
                React.createElement(TestItem, { id: 'b' }),
                React.createElement(TestItem, { id: 'c' }),
            ),
            0,
        );

        expect(withItemGroupStandaloneRows(children)).toHaveLength(3);
    });

    it('returns no rows when there is nothing renderable', () => {
        expect(withItemGroupStandaloneRows(null)).toEqual([]);
        expect(withItemGroupStandaloneRows('text-only')).toEqual([]);
    });
});
