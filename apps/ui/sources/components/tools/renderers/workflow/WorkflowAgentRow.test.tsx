import React from 'react';
import { describe, expect, it } from 'vitest';
import renderer, { act } from 'react-test-renderer';

import { installWorkflowRendererCommonModuleMocks } from './workflowRendererTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installWorkflowRendererCommonModuleMocks();

async function render(props: Partial<React.ComponentProps<typeof import('./WorkflowAgentRow').WorkflowAgentRow>> = {}) {
    const { WorkflowAgentRow } = await import('./WorkflowAgentRow');
    let tree: renderer.ReactTestRenderer | undefined;
    act(() => {
        tree = renderer.create(
            <WorkflowAgentRow title="researcher" status="active" testID="row" {...props} />,
        );
    });
    return tree as renderer.ReactTestRenderer;
}

function hostMatches(tree: renderer.ReactTestRenderer, testID: string) {
    return tree.root.findAllByProps({ testID }).filter((node) => typeof node.type === 'string');
}

describe('WorkflowAgentRow', () => {
    it('announces the agent title, not the live-updating metric string (U-10)', async () => {
        const tree = await render({ tokensUsed: 1200, timeUsedSeconds: 42 });
        const row = hostMatches(tree, 'row')[0];
        expect(row?.props.accessibilityLabel).toBe('researcher');
        act(() => tree.unmount());
    });

    it('renders the metadata slot only when metrics are present', async () => {
        const withMetrics = await render({ tokensUsed: 2000 });
        expect(hostMatches(withMetrics, 'row-metrics')).toHaveLength(1);
        act(() => withMetrics.unmount());

        const withoutMetrics = await render({});
        expect(hostMatches(withoutMetrics, 'row-metrics')).toHaveLength(0);
        act(() => withoutMetrics.unmount());
    });

    it('does not render zero-valued metrics', async () => {
        const tree = await render({ tokensUsed: 0, toolCalls: 0, timeUsedSeconds: 0 });
        expect(hostMatches(tree, 'row-metrics')).toHaveLength(0);
        act(() => tree.unmount());
    });
});
