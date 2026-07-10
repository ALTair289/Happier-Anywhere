import * as React from 'react';

import { AgentInputContentPopover } from '@/components/sessions/agentInput/components/AgentInputContentPopover';

import type { GoalActionCapabilities } from './goalActionVisibility';
import { SessionWorkflowActivitySection } from './SessionWorkflowActivitySection';
import type { SessionWorkStateSnapshot } from './sessionWorkStateTypes';
import type { SessionWorkflowActivityState } from './useSessionWorkflowActivity';
import {
    useSessionWorkStateGoalController,
    type SessionWorkStateGoalOperationResult,
    type SessionWorkStateGoalSetRequest,
} from './useSessionWorkStateGoalController';

export function SessionWorkStatePopover(props: Readonly<{
    open: boolean;
    anchorRef: React.RefObject<any>;
    snapshot: SessionWorkStateSnapshot | null;
    /** UIW3: live workflow activity (headline + loaded run detail) for the Active Workflows section. */
    workflowActivity?: SessionWorkflowActivityState;
    editableGoal: boolean;
    goalActionCapabilityFallback?: GoalActionCapabilities | null;
    onRequestClose: () => void;
    onSetGoal?: (request: SessionWorkStateGoalSetRequest) => Promise<SessionWorkStateGoalOperationResult>;
    onClearGoal?: () => Promise<SessionWorkStateGoalOperationResult>;
}>) {
    const workflowSection = props.workflowActivity
        ? <SessionWorkflowActivitySection activity={props.workflowActivity} />
        : null;
    const { content, guardedRequestClose } = useSessionWorkStateGoalController({
        open: props.open,
        snapshot: props.snapshot,
        editableGoal: props.editableGoal,
        goalActionCapabilityFallback: props.goalActionCapabilityFallback ?? null,
        workflowSection,
        showEmptyGoalControls: false,
        onRequestClose: props.onRequestClose,
        onSetGoal: props.onSetGoal,
        onClearGoal: props.onClearGoal,
    });

    return (
        <AgentInputContentPopover
            open={props.open}
            anchorRef={props.anchorRef}
            onRequestClose={guardedRequestClose}
            maxWidthCap={420}
            maxHeightCap={520}
            testID="session-work-state-popover-surface"
            // U-4: the goal edit mode reveals the objective textarea inside this popover, so reserve
            // the bottom keyboard inset to keep it clear of the software keyboard.
            reserveKeyboardInset
            content={() => content}
        />
    );
}
