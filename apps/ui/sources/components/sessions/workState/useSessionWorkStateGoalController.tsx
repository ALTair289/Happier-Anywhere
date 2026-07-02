import * as React from 'react';
import { ActivityIndicator, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Modal } from '@/modal';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';

import type { GoalActionCapabilities } from './goalActionVisibility';
import { SessionGoalControlContent } from './SessionGoalControlContent';
import {
    GOAL_CONFIRMATION_TIMEOUT_MS,
    goalSignature,
    isNoOpGoalMutation,
    type SessionWorkStateGoalOperationResult,
    type SessionWorkStateGoalSetRequest,
} from './sessionGoalMutationModel';
import {
    omitGoalItemFromSnapshot,
    resolveEditableGoalItem,
    resolveGoalCreationControlsVisible,
    resolveGoalManagementControlsVisible,
} from './sessionGoalSelectors';
import { SessionTaskListContent } from './SessionTaskListContent';
import type { SessionWorkStateSnapshot } from './sessionWorkStateTypes';

// Re-exported for the chip/popover/content surfaces that consume these contracts through the
// controller barrel (single import site preserved; the definitions now live in the mutation model).
export type { SessionWorkStateGoalOperationResult, SessionWorkStateGoalSetRequest };

/**
 * Single owner of the session goal/work-state popover behavior (draft, busy, mutations, dirty-close
 * guard, and content render). Both the above-input work-state badge popover and the AgentInput goal
 * chip popover consume this controller so there is exactly one editable-goal implementation (D4 —
 * single goal read/edit seam in the UI).
 */
export function useSessionWorkStateGoalController(params: Readonly<{
    open: boolean;
    snapshot: SessionWorkStateSnapshot | null;
    editableGoal: boolean;
    /**
     * Provider capability profile for the set-first-goal form (no goal item yet). Restricts the
     * control surface (e.g. Claude: edit/clear only, no budget). Ignored once a goal item carries
     * its own `goalCapabilities`.
     */
    goalActionCapabilityFallback?: GoalActionCapabilities | null;
    /**
     * Optional Active Workflows section (UIW3), rendered between the goal controls and the task list.
     * Owned by `SessionWorkflowActivitySection`; the goal controller only slots it so it stays focused
     * on goal editing.
     */
    workflowSection?: React.ReactNode;
    /**
     * Whether this surface is allowed to show the set-first-goal form when no goal exists yet.
     * The AgentInput goal chip is the creation affordance; the above-composer work-state popover
     * should only show goal controls once there is an actual goal to inspect/edit.
     */
    showEmptyGoalControls?: boolean;
    onRequestClose: () => void;
    onSetGoal?: (request: SessionWorkStateGoalSetRequest) => Promise<SessionWorkStateGoalOperationResult>;
    onClearGoal?: () => Promise<SessionWorkStateGoalOperationResult>;
}>): Readonly<{ content: React.ReactNode; guardedRequestClose: () => Promise<void>; dirty: boolean }> {
    const { theme } = useUnistyles();
    const goal = resolveEditableGoalItem(params.snapshot);
    const allowEmptyGoalControls = params.showEmptyGoalControls ?? true;
    const renderGoalControls = allowEmptyGoalControls
        ? resolveGoalCreationControlsVisible({ editableGoal: params.editableGoal })
        : resolveGoalManagementControlsVisible({ editableGoal: params.editableGoal, snapshot: params.snapshot });
    const taskListSnapshot = renderGoalControls ? omitGoalItemFromSnapshot(params.snapshot, goal?.id ?? null) : params.snapshot;
    const [draftObjective, setDraftObjective] = React.useState(goal?.title ?? '');
    const [busy, setBusy] = React.useState(false);
    // After an acknowledged set, hold a "setting goal…" pending state keyed by the goal signature at
    // request time, so we can detect when the work-state actually reflects the change (H4).
    const [pendingBaseline, setPendingBaseline] = React.useState<string | null>(null);
    const [errorText, setErrorText] = React.useState<string | null>(null);
    const currentSignature = goalSignature(goal);

    React.useEffect(() => {
        if (!params.open) return;
        setDraftObjective(goal?.title ?? '');
    }, [goal?.title, params.open]);

    const open = params.open;
    const onRequestClose = params.onRequestClose;
    const onSetGoal = params.onSetGoal;
    const onClearGoal = params.onClearGoal;

    // Confirmation: once the work-state signature moves off the captured baseline, the mutation has
    // been observed natively — close the popover and drop the pending state.
    React.useEffect(() => {
        if (!open || pendingBaseline === null) return;
        if (currentSignature !== pendingBaseline) {
            setPendingBaseline(null);
            onRequestClose();
        }
    }, [currentSignature, onRequestClose, open, pendingBaseline]);

    // Timeout: if confirmation never arrives, stop pretending and surface a subtle diagnostic so the
    // user is not left with a goal that may not have applied.
    React.useEffect(() => {
        if (pendingBaseline === null) return;
        const timer = setTimeout(() => {
            setPendingBaseline(null);
            setErrorText(t('session.workState.goal.pendingTimeout'));
        }, GOAL_CONFIRMATION_TIMEOUT_MS);
        return () => clearTimeout(timer);
    }, [pendingBaseline]);

    const pending = pendingBaseline !== null;
    const mutating = busy || pending;
    // While a mutation is in flight or pending confirmation the draft is committed; do not treat it
    // as unsaved work for the dirty-close guard.
    const dirty = !mutating && draftObjective.trim() !== (goal?.title ?? '').trim();

    const guardedRequestClose = React.useCallback(async () => {
        if (dirty) {
            const discard = await Modal.confirm(
                t('session.workState.dirtyCloseTitle'),
                t('session.workState.dirtyCloseBody'),
                { confirmText: t('common.discard'), destructive: true },
            );
            if (!discard) return;
        }
        onRequestClose();
    }, [dirty, onRequestClose]);

    const runGoalMutation = React.useCallback(async (request: SessionWorkStateGoalSetRequest) => {
        if (!onSetGoal) return;
        const baseline = goalSignature(goal);
        setErrorText(null);
        setBusy(true);
        const noOp = isNoOpGoalMutation(goal, request);
        try {
            const result = await onSetGoal(request);
            if (result.ok) {
                if (noOp) {
                    // No native work-state change will arrive (the source dedupes), so do not
                    // strand the popover in "setting goal…" — the request is already satisfied.
                    onRequestClose();
                } else {
                    // Keep the popover open in a pending state until the native work-state confirms.
                    setPendingBaseline(baseline);
                }
            } else {
                onRequestClose();
                Modal.alert(t('common.error'), result.error);
            }
        } finally {
            setBusy(false);
        }
    }, [goal, onRequestClose, onSetGoal]);

    const clearGoal = React.useCallback(async () => {
        if (!onClearGoal) return;
        onRequestClose();
        const confirmed = await Modal.confirm(
            t('session.workState.goal.clearTitle'),
            t('session.workState.goal.clearBody'),
            { confirmText: t('session.workState.goal.clear'), destructive: true },
        );
        if (!confirmed) return;
        setBusy(true);
        try {
            const result = await onClearGoal();
            if (!result.ok) Modal.alert(t('common.error'), result.error);
        } finally {
            setBusy(false);
        }
    }, [onClearGoal, onRequestClose]);

    const content = (
        <View
            testID="session-work-state-popover"
            style={styles.content}
        >
            {pending ? (
                <View testID="session-goal-pending" style={styles.statusRow}>
                    <ActivityIndicator size="small" color={theme.colors.text.secondary} />
                    <Text style={[styles.pendingText, { color: theme.colors.text.secondary }]}>
                        {t('session.workState.goal.pending')}
                    </Text>
                </View>
            ) : null}
            {errorText ? (
                <View
                    testID="session-goal-pending-error"
                    style={[styles.statusRow, styles.errorRow, { backgroundColor: theme.colors.surface.inset }]}
                >
                    <Text style={[styles.errorText, { color: theme.colors.state.danger.foreground }]}>
                        {errorText}
                    </Text>
                </View>
            ) : null}
            {renderGoalControls ? (
                <SessionGoalControlContent
                    goal={goal}
                    capabilityFallback={params.goalActionCapabilityFallback ?? null}
                    draftObjective={draftObjective}
                    onDraftObjectiveChange={setDraftObjective}
                    onSave={(budgetDraft) => {
                        const objective = draftObjective.trim();
                        if (!objective) return;
                        const request: {
                            objective: string;
                            status?: 'active';
                            tokenBudget?: number | null;
                            resumeInactiveWithInitialGoal: false;
                        } = { objective, resumeInactiveWithInitialGoal: false };
                        if (goal?.status === 'complete' || goal?.statusReason === 'budgetLimited') {
                            request.status = 'active';
                        }
                        if (budgetDraft.tokenBudgetChanged) {
                            request.tokenBudget = budgetDraft.tokenBudget;
                        }
                        void runGoalMutation(request);
                    }}
                    onPause={() => { void runGoalMutation({ status: 'paused' }); }}
                    onResume={() => { void runGoalMutation({ status: 'active' }); }}
                    onComplete={() => { void runGoalMutation({ status: 'complete' }); }}
                    onClear={clearGoal}
                    onCancel={onRequestClose}
                    busy={mutating}
                />
            ) : null}
            {params.workflowSection ?? null}
            <SessionTaskListContent
                snapshot={taskListSnapshot}
                primaryItemId={taskListSnapshot?.primaryItemId ?? null}
            />
        </View>
    );

    return { content, guardedRequestClose, dirty };
}

const styles = StyleSheet.create(() => ({
    content: {
        gap: 16,
        minWidth: 0,
        maxWidth: '100%',
        paddingHorizontal: 14,
        paddingTop: 12,
        paddingBottom: 14,
    },
    statusRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    errorRow: {
        borderRadius: 10,
        paddingHorizontal: 12,
        paddingVertical: 10,
    },
    pendingText: {
        fontSize: 13,
        fontWeight: '600',
    },
    errorText: {
        fontSize: 12,
        fontWeight: '600',
    },
}));
