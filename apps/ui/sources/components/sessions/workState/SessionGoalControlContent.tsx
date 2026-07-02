import * as React from 'react';
import { Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Text, TextInput } from '@/components/ui/text/Text';
import { t } from '@/text';

import { GoalBudgetDisclosure } from './GoalBudgetDisclosure';
import { GoalIcon } from './goalIcon';
import { GoalUsageMetadata } from './GoalUsageMetadata';
import { canPauseOrResumeGoal, resolveGoalActionCapabilities, resolveGoalStatusLabelKey, type GoalActionCapabilities } from './goalActionVisibility';
import type { SessionWorkStateItem } from './sessionWorkStateTypes';

type GoalSaveBudgetDraft = Readonly<{
    tokenBudgetChanged: boolean;
    tokenBudget?: number | null;
}>;

export function SessionGoalControlContent(props: Readonly<{
    goal: SessionWorkStateItem | null;
    draftObjective: string;
    onDraftObjectiveChange: (value: string) => void;
    onSave: (budgetDraft: GoalSaveBudgetDraft) => void;
    onPause: () => void;
    onResume: () => void;
    onComplete: () => void;
    onClear: () => void;
    /** Closes the whole surface from the set-first-goal form's Cancel action. */
    onCancel?: () => void;
    busy?: boolean;
    /**
     * Provider capability profile applied when there is no goal item yet (the set-first-goal form),
     * so a provider like Claude shows only edit/clear with no budget. Ignored once a goal item
     * carries its own `goalCapabilities`.
     */
    capabilityFallback?: GoalActionCapabilities | null;
}>) {
    const { theme } = useUnistyles();
    const isPaused = props.goal?.status === 'paused';
    const capabilities = resolveGoalActionCapabilities(props.goal, props.capabilityFallback);
    const canComplete = Boolean(props.goal && props.goal.status !== 'complete' && props.goal.statusReason !== 'budgetLimited');
    const showPauseResume = capabilities.canStop && canPauseOrResumeGoal(props.goal);
    const showComplete = capabilities.canStop && canComplete;
    const [editing, setEditing] = React.useState(!props.goal);
    const [budgetEnabled, setBudgetEnabled] = React.useState(typeof props.goal?.tokenBudget === 'number');
    const [draftBudget, setDraftBudget] = React.useState(
        typeof props.goal?.tokenBudget === 'number' ? String(Math.trunc(props.goal.tokenBudget)) : '',
    );
    const [budgetError, setBudgetError] = React.useState(false);

    React.useEffect(() => {
        setEditing(!props.goal);
    }, [props.goal?.id]);

    React.useEffect(() => {
        setBudgetEnabled(typeof props.goal?.tokenBudget === 'number');
        setDraftBudget(typeof props.goal?.tokenBudget === 'number' ? String(Math.trunc(props.goal.tokenBudget)) : '');
        setBudgetError(false);
    }, [props.goal?.id, props.goal?.tokenBudget]);

    const statusText = t(resolveGoalStatusLabelKey(props.goal));
    const canSave = props.draftObjective.trim().length > 0 && !props.busy;
    const cancelEdit = React.useCallback(() => {
        props.onDraftObjectiveChange(props.goal?.title ?? '');
        setBudgetEnabled(typeof props.goal?.tokenBudget === 'number');
        setDraftBudget(typeof props.goal?.tokenBudget === 'number' ? String(Math.trunc(props.goal.tokenBudget)) : '');
        setBudgetError(false);
        if (props.goal) setEditing(false);
    }, [props]);
    const budgetChanged = React.useMemo(() => {
        const currentBudget = typeof props.goal?.tokenBudget === 'number' ? Math.trunc(props.goal.tokenBudget) : null;
        if (!budgetEnabled) return currentBudget !== null;
        const trimmedBudget = draftBudget.trim();
        if (!trimmedBudget) return currentBudget !== null;
        const parsedBudget = Number(trimmedBudget);
        return currentBudget !== parsedBudget;
    }, [budgetEnabled, draftBudget, props.goal?.tokenBudget]);
    const save = React.useCallback(() => {
        setBudgetError(false);
        if (!canSave) return;
        if (!budgetEnabled) {
            props.onSave({
                tokenBudgetChanged: budgetChanged,
                ...(budgetChanged ? { tokenBudget: null } : {}),
            });
            return;
        }
        const trimmedBudget = draftBudget.trim();
        if (!/^\d+$/.test(trimmedBudget)) {
            setBudgetError(true);
            return;
        }
        const parsedBudget = Number(trimmedBudget);
        if (!Number.isSafeInteger(parsedBudget) || parsedBudget <= 0) {
            setBudgetError(true);
            return;
        }
        props.onSave({
            tokenBudgetChanged: budgetChanged,
            ...(budgetChanged ? { tokenBudget: parsedBudget } : {}),
        });
    }, [budgetChanged, budgetEnabled, canSave, draftBudget, props]);
    const saveButton = (
        <Pressable
            testID="session-goal-save-button"
            accessibilityRole="button"
            onPress={save}
            disabled={!canSave}
            style={({ pressed }) => [
                styles.primaryButton,
                {
                    backgroundColor: theme.colors.button.primary.background,
                    opacity: !canSave ? 0.42 : (pressed ? 0.88 : 1),
                },
            ]}
        >
            <Text style={[styles.actionText, { color: theme.colors.button.primary.tint }]}>
                {props.goal ? t('common.save') : t('session.workState.goal.set')}
            </Text>
        </Pressable>
    );
    const budgetDisclosure = (
        <GoalBudgetDisclosure
            budgetConfigurable={capabilities.canConfigureBudget}
            budgetEnabled={budgetEnabled}
            draftBudget={draftBudget}
            budgetError={budgetError}
            busy={props.busy}
            onBudgetEnabledChange={(enabled) => {
                setBudgetEnabled(enabled);
                setBudgetError(false);
            }}
            onDraftBudgetChange={(value) => {
                setDraftBudget(value);
                setBudgetError(false);
            }}
        />
    );

    return (
        <View style={styles.root}>
            {props.goal ? (
                <View style={styles.header}>
                    <View style={styles.heading}>
                        <Text style={[styles.title, { color: theme.colors.text.primary }]}>
                            {t('session.workState.goal.title')}
                        </Text>
                        <Text style={[styles.statusText, { color: theme.colors.text.secondary }]} numberOfLines={1}>
                            {statusText}
                        </Text>
                    </View>
                    <View style={styles.headerActions}>
                        {editing ? (
                            <>
                                <Pressable
                                    testID="session-goal-cancel-edit-button"
                                    accessibilityRole="button"
                                    onPress={cancelEdit}
                                    disabled={props.busy}
                                    style={styles.secondaryButton}
                                >
                                    <Text style={[styles.secondaryActionText, { color: theme.colors.text.secondary }]}>
                                        {t('common.cancel')}
                                    </Text>
                                </Pressable>
                                {saveButton}
                            </>
                        ) : (
                            <>
                                {showPauseResume ? (
                                    <Pressable
                                        testID="session-goal-pause-resume-button"
                                        accessibilityRole="button"
                                        onPress={isPaused ? props.onResume : props.onPause}
                                        disabled={props.busy}
                                        style={styles.headerActionButton}
                                    >
                                        <Text style={[styles.secondaryActionText, { color: theme.colors.text.secondary }]}>
                                            {isPaused ? t('session.workState.goal.resume') : t('session.workState.goal.pause')}
                                        </Text>
                                    </Pressable>
                                ) : null}
                                {showComplete ? (
                                    <Pressable
                                        testID="session-goal-complete-button"
                                        accessibilityRole="button"
                                        onPress={props.onComplete}
                                        disabled={props.busy}
                                        style={styles.headerActionButton}
                                    >
                                        <Text style={[styles.secondaryActionText, { color: theme.colors.text.secondary }]}>
                                            {t('session.workState.goal.statusComplete')}
                                        </Text>
                                    </Pressable>
                                ) : null}
                                {capabilities.canClear ? (
                                    <Pressable
                                        testID="session-goal-clear-button"
                                        accessibilityRole="button"
                                        onPress={props.onClear}
                                        disabled={props.busy}
                                        style={styles.headerActionButton}
                                    >
                                        <Text style={[styles.secondaryActionText, { color: theme.colors.state.danger.foreground }]}>
                                            {t('session.workState.goal.clear')}
                                        </Text>
                                    </Pressable>
                                ) : null}
                                {capabilities.canEdit ? (
                                    <Pressable
                                        testID="session-goal-edit-button"
                                        accessibilityRole="button"
                                        onPress={() => setEditing(true)}
                                        disabled={props.busy}
                                        style={styles.secondaryButton}
                                    >
                                        <Text style={[styles.secondaryActionText, { color: theme.colors.text.secondary }]}>
                                            {t('common.edit')}
                                        </Text>
                                    </Pressable>
                                ) : null}
                            </>
                        )}
                    </View>
                </View>
            ) : (
                <View style={styles.setHeader}>
                    <GoalIcon color={theme.colors.text.primary} size={22} />
                    <View style={styles.setHeadingText}>
                        <Text style={[styles.title, { color: theme.colors.text.primary }]}>
                            {t('session.workState.goal.setTitle')}
                        </Text>
                        <Text style={[styles.setSubtitle, { color: theme.colors.text.secondary }]}>
                            {t('session.workState.goal.setSubtitle')}
                        </Text>
                    </View>
                </View>
            )}
            {editing ? (
                <TextInput
                    testID="session-goal-objective-input"
                    value={props.draftObjective}
                    onChangeText={props.onDraftObjectiveChange}
                    multiline
                    placeholder={t('session.workState.goal.placeholder')}
                    placeholderTextColor={theme.colors.input.placeholder}
                    style={[
                        styles.input,
                        {
                            color: theme.colors.text.primary,
                            borderColor: theme.colors.border.default,
                        },
                    ]}
                />
            ) : props.goal ? (
                <View style={styles.objectiveRow}>
                    <GoalIcon color={theme.colors.text.primary} size={16} />
                    <Text style={[styles.objectiveText, { color: theme.colors.text.primary }]} numberOfLines={4}>
                        {props.goal.title}
                    </Text>
                </View>
            ) : null}
            {props.goal && !editing ? <GoalUsageMetadata goal={props.goal} /> : null}
            {editing ? budgetDisclosure : null}
            {!props.goal && editing ? (
                <View style={styles.footerActions}>
                    <Pressable
                        testID="session-goal-cancel-button"
                        accessibilityRole="button"
                        onPress={() => props.onCancel?.()}
                        disabled={props.busy}
                        style={styles.secondaryButton}
                    >
                        <Text style={[styles.secondaryActionText, { color: theme.colors.text.secondary }]}>
                            {t('common.cancel')}
                        </Text>
                    </Pressable>
                    {saveButton}
                </View>
            ) : null}
        </View>
    );
}

const styles = StyleSheet.create(() => ({
    root: {
        gap: 12,
        minWidth: 0,
        maxWidth: '100%',
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
        flexWrap: 'wrap',
    },
    heading: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        flex: 1,
    },
    setHeader: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: 10,
    },
    setHeadingText: {
        flex: 1,
        gap: 4,
        minWidth: 0,
    },
    setSubtitle: {
        fontSize: 12,
        fontWeight: '400',
        lineHeight: 16,
    },
    title: {
        fontSize: 14,
        fontWeight: '700',
    },
    statusText: {
        fontSize: 12,
        fontWeight: '600',
    },
    objectiveRow: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: 8,
    },
    objectiveText: {
        flex: 1,
        fontSize: 14,
        fontWeight: '400',
        lineHeight: 19,
    },
    input: {
        minHeight: 96,
        borderWidth: StyleSheet.hairlineWidth,
        borderRadius: 10,
        paddingHorizontal: 12,
        paddingVertical: 10,
        textAlignVertical: 'top',
        fontSize: 14,
        backgroundColor: 'transparent',
    },
    headerActions: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 14,
        flexShrink: 0,
        flexWrap: 'wrap',
    },
    headerActionButton: {
        minHeight: 34,
        justifyContent: 'center',
    },
    footerActions: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'flex-end',
        gap: 12,
        minHeight: 40,
    },
    primaryButton: {
        minHeight: 40,
        minWidth: 92,
        borderRadius: 999,
        paddingHorizontal: 16,
        justifyContent: 'center',
        alignItems: 'center',
    },
    secondaryButton: {
        minHeight: 40,
        justifyContent: 'center',
        paddingHorizontal: 4,
    },
    actionText: {
        fontSize: 13,
        fontWeight: '700',
    },
    secondaryActionText: {
        fontSize: 13,
        fontWeight: '700',
    },
}));
