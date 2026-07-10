import * as React from 'react';
import { Pressable } from 'react-native';

import type { AgentInputExtraActionChip } from '@/components/sessions/agentInput/agentInputContracts';
import type { GoalActionCapabilities } from '@/components/sessions/workState/goalActionVisibility';
import { GoalIcon } from '@/components/sessions/workState/goalIcon';
import { SessionWorkStateContent } from '@/components/sessions/workState/SessionWorkStateContent';
import type {
    SessionWorkStateGoalOperationResult,
    SessionWorkStateGoalSetRequest,
} from '@/components/sessions/workState/useSessionWorkStateGoalController';
import type { SessionWorkStateSnapshot } from '@/components/sessions/workState/sessionWorkStateTypes';
import { normalizeNodeForView } from '@/components/ui/rendering/normalizeNodeForView';
import { hapticsLight } from '@/components/ui/theme/haptics';
import { t } from '@/text';

const GOAL_CHIP_KEY = 'session-goal';

/**
 * AgentInput primary-line chip that surfaces the session goal and opens the shared work-state goal
 * popover (set/edit/pause/resume/complete/clear) anchored to the chip. It is an additional entry
 * point alongside the above-input work-state badge; both share `SessionWorkStateContent` so there is
 * one editable-goal implementation.
 */
export function createGoalActionChip(params: Readonly<{
    snapshot: SessionWorkStateSnapshot | null;
    editableGoal: boolean;
    goalActionCapabilityFallback?: GoalActionCapabilities | null;
    currentObjective: string | null;
    onSetGoal?: (request: SessionWorkStateGoalSetRequest) => Promise<SessionWorkStateGoalOperationResult>;
    onClearGoal?: () => Promise<SessionWorkStateGoalOperationResult>;
}>): AgentInputExtraActionChip {
    const objective = params.currentObjective?.trim() ?? '';
    const hasGoal = objective.length > 0;
    const label = hasGoal ? objective : t('session.workState.goal.set');
    // Distinguish the empty "Set goal" affordance from an active goal for screen readers, and signal
    // a non-editable (read-only) chip via accessibilityState (G7). The label/a11y derive ONLY from
    // the narrow `currentObjective` + `editableGoal` props (not the full work-state snapshot), so
    // frequent task/workflow progress updates do not change the chip's accessible identity.
    const accessibilityLabel = hasGoal
        ? t('session.workState.goal.accessibilityCurrent', { objective })
        : t('session.workState.goal.set');

    return {
        key: GOAL_CHIP_KEY,
        controlId: 'goal',
        labelPolicy: 'auto-hide',
        collapsedContentPopover: {
            title: t('session.workState.goal.title'),
            label,
            icon: (tint: string) => normalizeNodeForView(<GoalIcon color={tint} size={16} />),
            maxWidthCap: 420,
            maxHeightCap: 520,
            // U-4: this popover hosts the goal objective textarea / budget input, so it opts in to the
            // bottom keyboard inset to keep the focused field clear of the software keyboard.
            reserveKeyboardInset: true,
            renderContent: ({ requestClose }) => (
                <SessionWorkStateContent
                    snapshot={params.snapshot}
                    editableGoal={params.editableGoal}
                    goalActionCapabilityFallback={params.goalActionCapabilityFallback ?? null}
                    requestClose={requestClose}
                    onSetGoal={params.onSetGoal}
                    onClearGoal={params.onClearGoal}
                />
            ),
        },
        render: ({ chipStyle, iconColor, chipAnchorRef, toggleCollapsedPopover }) => (
            <Pressable
                ref={chipAnchorRef}
                testID="agent-input-goal-chip"
                accessibilityRole="button"
                accessibilityLabel={accessibilityLabel}
                accessibilityState={{ disabled: !params.editableGoal }}
                onPress={() => {
                    hapticsLight();
                    toggleCollapsedPopover?.(GOAL_CHIP_KEY);
                }}
                hitSlop={{ top: 8, bottom: 10, left: 4, right: 4 }}
                style={({ pressed }) => chipStyle(Boolean(pressed))}
            >
                {normalizeNodeForView(<GoalIcon color={iconColor} />)}
            </Pressable>
        ),
    };
}
