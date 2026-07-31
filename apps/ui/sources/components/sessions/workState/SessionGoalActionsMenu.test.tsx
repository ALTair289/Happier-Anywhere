import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { installAgentInputCommonModuleMocks } from '@/components/sessions/agentInput/agentInputTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installAgentInputCommonModuleMocks();

// The overflow menu is built on the app's canonical `Popover` + `ActionListSection` primitives
// (mirroring the changed-files-row `⋯` pattern). Mock those boundaries so the test asserts the
// menu's own contract: actions map to items with preserved testIDs, and pressing an item fires its
// handler and closes the menu.
let capturedItems: ReadonlyArray<Record<string, any>> | null = null;

vi.mock('@/components/ui/popover', () => ({
    Popover: (props: Record<string, any>) =>
        props.open
            ? React.createElement('Popover', props, props.children({ maxHeight: 280 }))
            : null,
}));

vi.mock('@/components/ui/overlays/FloatingOverlay', () => ({
    FloatingOverlay: (props: Record<string, any>) =>
        React.createElement('FloatingOverlay', props, props.children),
}));

vi.mock('@/components/ui/lists/ActionListSection', () => ({
    ActionListSection: (props: Record<string, any>) => {
        capturedItems = props.actions;
        return React.createElement(
            'ActionListSection',
            props,
            (props.actions as ReadonlyArray<Record<string, any>>).map((action) =>
                React.createElement('Pressable', {
                    key: action.id,
                    testID: action.testID,
                    onPress: action.onPress,
                }),
            ),
        );
    },
}));

import { SessionGoalActionsMenu } from './SessionGoalActionsMenu';

const ACTIONS = [
    {
        id: 'session-goal-pause-resume',
        testID: 'session-goal-pause-resume-button',
        label: 'Pause',
        icon: 'pause-circle' as const,
        onPress: vi.fn(),
    },
    {
        id: 'session-goal-complete',
        testID: 'session-goal-complete-button',
        label: 'Complete',
        icon: 'checks' as const,
        onPress: vi.fn(),
    },
    {
        id: 'session-goal-clear',
        testID: 'session-goal-clear-button',
        label: 'Clear',
        icon: 'trash' as const,
        destructive: true,
        onPress: vi.fn(),
    },
];

describe('SessionGoalActionsMenu', () => {
    it('renders nothing when there are no actions', async () => {
        const screen = await renderScreen(<SessionGoalActionsMenu actions={[]} />);
        expect(screen.findAllByTestId('session-goal-actions-overflow')).toHaveLength(0);
    });

    it('keeps the lifecycle items hidden until the overflow trigger is pressed', async () => {
        const screen = await renderScreen(<SessionGoalActionsMenu actions={ACTIONS} />);

        expect(screen.findAllByTestId('session-goal-actions-overflow').length).toBeGreaterThan(0);
        expect(screen.findAllByTestId('session-goal-pause-resume-button')).toHaveLength(0);

        act(() => {
            screen.pressByTestId('session-goal-actions-overflow');
        });

        // Preserve the canonical testIDs the popover behavior tests + QA depend on.
        expect(screen.findAllByTestId('session-goal-pause-resume-button').length).toBeGreaterThan(0);
        expect(screen.findAllByTestId('session-goal-complete-button').length).toBeGreaterThan(0);
        expect(screen.findAllByTestId('session-goal-clear-button').length).toBeGreaterThan(0);
        expect(capturedItems?.map((item) => item.testID)).toEqual([
            'session-goal-pause-resume-button',
            'session-goal-complete-button',
            'session-goal-clear-button',
        ]);
    });

    it('fires the action handler and closes the menu when an item is pressed', async () => {
        const screen = await renderScreen(<SessionGoalActionsMenu actions={ACTIONS} />);

        act(() => {
            screen.pressByTestId('session-goal-actions-overflow');
        });
        act(() => {
            screen.pressByTestId('session-goal-complete-button');
        });

        expect(ACTIONS[1].onPress).toHaveBeenCalledTimes(1);
        // Menu closed → the items unmount again.
        expect(screen.findAllByTestId('session-goal-complete-button')).toHaveLength(0);
    });
});
