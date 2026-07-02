import * as React from 'react';

import type { GoalActionCapabilities } from './goalActionVisibility';
import type { SessionWorkStateSnapshot } from './sessionWorkStateTypes';
import {
    useSessionWorkStateGoalController,
    type SessionWorkStateGoalOperationResult,
    type SessionWorkStateGoalSetRequest,
} from './useSessionWorkStateGoalController';

/**
 * Goal/work-state popover body without its own popover wrapper, for hosting inside an
 * `AgentInputContentPopover` provided by a caller (e.g. the AgentInput goal chip). Shares the same
 * controller as `SessionWorkStatePopover` so both entry points stay in lockstep.
 */
export function SessionWorkStateContent(props: Readonly<{
    snapshot: SessionWorkStateSnapshot | null;
    editableGoal: boolean;
    goalActionCapabilityFallback?: GoalActionCapabilities | null;
    requestClose: () => void;
    onSetGoal?: (request: SessionWorkStateGoalSetRequest) => Promise<SessionWorkStateGoalOperationResult>;
    onClearGoal?: () => Promise<SessionWorkStateGoalOperationResult>;
}>) {
    const { content } = useSessionWorkStateGoalController({
        open: true,
        snapshot: props.snapshot,
        editableGoal: props.editableGoal,
        goalActionCapabilityFallback: props.goalActionCapabilityFallback ?? null,
        onRequestClose: props.requestClose,
        onSetGoal: props.onSetGoal,
        onClearGoal: props.onClearGoal,
    });

    return <>{content}</>;
}
