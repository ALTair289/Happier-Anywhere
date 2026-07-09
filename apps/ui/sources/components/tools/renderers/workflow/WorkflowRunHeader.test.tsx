import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';

import type { WorkflowPhaseRollup } from '@/components/sessions/workState/sessionWorkflowActivityTypes';

import { installWorkflowRendererCommonModuleMocks } from './workflowRendererTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installWorkflowRendererCommonModuleMocks();

// Capture what WorkflowRunHeader passes to the shared MeterBar (call-site contract).
vi.mock('@/components/ui/lists/MeterBar', () => ({
    MeterBar: (props: Record<string, unknown> & { caption?: React.ReactNode }) =>
        React.createElement('MeterBarMock', props, props.caption ?? null),
}));

function makeRollup(over: Partial<WorkflowPhaseRollup> = {}): WorkflowPhaseRollup {
    return {
        total: 5,
        complete: 2,
        failed: 0,
        blocked: 0,
        active: 3,
        pending: 0,
        cancelled: 0,
        unknown: 0,
        ...over,
    };
}

async function render(props: Partial<React.ComponentProps<typeof import('./WorkflowRunHeader').WorkflowRunHeader>>) {
    const { WorkflowRunHeader } = await import('./WorkflowRunHeader');
    let tree: renderer.ReactTestRenderer | undefined;
    act(() => {
        tree = renderer.create(
            <WorkflowRunHeader
                title="Implement"
                status="active"
                statusLabel="Active"
                completedAgents={2}
                totalAgents={5}
                rollup={makeRollup()}
                tone="active"
                {...props}
            />,
        );
    });
    return { tree: tree as renderer.ReactTestRenderer };
}

describe('WorkflowRunHeader', () => {
    it('passes the progress fraction as MeterBar fillFraction (grows with completion — contract-true, not inverted)', async () => {
        const { tree } = await render({ completedAgents: 2, totalAgents: 5 });
        const meter = tree.root.findByType('MeterBarMock' as unknown as React.ComponentType);
        // 2 of 5 agents complete => fill 0.4 (consumed/progress), NOT 0.6 remaining.
        expect(meter.props.fillFraction).toBeCloseTo(0.4, 5);
        act(() => tree.unmount());
    });

    it('renders no meter when there are no agents', async () => {
        const { tree } = await render({ completedAgents: 0, totalAgents: 0, rollup: makeRollup({ total: 0, active: 0, complete: 0 }) });
        expect(() => tree.root.findByType('MeterBarMock' as unknown as React.ComponentType)).toThrow();
        act(() => tree.unmount());
    });

    it('silences the ticking summary caption from live-region announcements', async () => {
        const { tree } = await render({ summaryLine: 'Phase 2 of 3 · 3/5 agents' });
        const announced = tree.root.findAll(
            (node) => node.props?.accessibilityLiveRegion != null && node.props.accessibilityLiveRegion !== 'none',
        );
        expect(announced).toHaveLength(0);
        act(() => tree.unmount());
    });
});
