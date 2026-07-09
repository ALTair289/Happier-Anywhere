import React from 'react';
import { describe, expect, it } from 'vitest';
import renderer, { act } from 'react-test-renderer';

import type { SessionWorkflowAgentStatusV1 } from '@happier-dev/protocol';

import { installWorkflowRendererCommonModuleMocks } from './workflowRendererTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installWorkflowRendererCommonModuleMocks();

async function iconNameFor(status: SessionWorkflowAgentStatusV1): Promise<string | null> {
    const { WorkflowStatusIcon } = await import('./workflowStatusIcon');
    let tree: renderer.ReactTestRenderer | undefined;
    act(() => {
        tree = renderer.create(<WorkflowStatusIcon status={status} />);
    });
    const root = (tree as renderer.ReactTestRenderer).root;
    const icons = root.findAllByType('Ionicons' as unknown as React.ComponentType);
    const name = icons.length > 0 ? (icons[0]!.props as { name?: string }).name ?? null : null;
    act(() => (tree as renderer.ReactTestRenderer).unmount());
    return name;
}

describe('WorkflowStatusIcon glyph mapping', () => {
    it('maps distinct terminal glyphs so queued/done/failed are visually distinguishable (U-19)', async () => {
        // Queued/pending = a static muted dot, NOT a spinner.
        expect(await iconNameFor('pending')).toBe('ellipse-outline');
        // Done = a success check.
        expect(await iconNameFor('complete')).toBe('checkmark-circle');
        // Failed = a danger cross.
        expect(await iconNameFor('failed')).toBe('close-circle');
        // Blocked = a caution glyph.
        expect(await iconNameFor('blocked')).toBe('alert-circle');
    });

    it('renders a spinner (not a static Ionicon) while an agent is actively running', async () => {
        // Running agents must be visually distinct from queued ones — the running glyph is the app
        // ActivitySpinner, so there is no static Ionicon in the tree.
        expect(await iconNameFor('active')).toBeNull();
    });
});
