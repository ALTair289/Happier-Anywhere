import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { MeterBar, type MeterTone } from '@/components/ui/lists/MeterBar';
import { Text } from '@/components/ui/text/Text';
import {
    formatTokenUsageCount,
    formatTokenUsagePercent,
    resolveTokenUsageProgressRatio,
} from '@/components/sessions/usage';
import { t } from '@/text';

import { formatGoalTimeUsed } from './goalUsageFormatting';
import type { SessionWorkStateItem } from './sessionWorkStateTypes';

/**
 * Tone for the consumed-budget meter. The meter fills as tokens are consumed (fillFraction = ratio),
 * so the tone escalates toward `danger` as the fill approaches/exceeds 1 — contract-true with the
 * MeterBar's canonical "fill = consumed/progress" semantic.
 */
function resolveBudgetTone(ratio: number): MeterTone {
    if (ratio >= 1) return 'danger';
    if (ratio >= 0.85) return 'warning';
    return 'neutral';
}

/**
 * Compact, flat active-goal usage line (Zcode-style). Renders only for an existing goal — the
 * set-first-goal form shows no usage. Time/tokens are inline metadata (no cards, no elevated
 * surfaces); a thin budget meter appears only when the goal carries a finite token budget.
 */
export function GoalUsageMetadata(props: Readonly<{ goal: SessionWorkStateItem }>) {
    const { theme } = useUnistyles();
    const usedTokens = props.goal.tokensUsed ?? 0;
    const timeSeconds = props.goal.timeUsedSeconds ?? 0;
    const tokenBudget = props.goal.tokenBudget;
    const hasBudget = typeof tokenBudget === 'number' && Number.isFinite(tokenBudget) && tokenBudget > 0;
    const hasUsage = usedTokens > 0 || timeSeconds > 0;
    const timeText = timeSeconds > 0 ? formatGoalTimeUsed(timeSeconds) : null;

    if (!hasBudget && !hasUsage) {
        // An ACTIVE goal with no usage yet (e.g. Claude, which reports usage only on completion)
        // renders nothing — "No usage yet" under a running goal reads as "nothing is happening".
        // Honest emptiness beats fake status. Non-active goals (paused/complete with genuinely no
        // usage) keep the muted fallback line.
        if (props.goal.status === 'active') {
            return null;
        }
        return (
            <Text
                testID="session-goal-usage-meta"
                accessibilityLiveRegion="none"
                style={[styles.meta, { color: theme.colors.text.secondary }]}
            >
                {t('session.workState.goal.noUsageYet')}
            </Text>
        );
    }

    if (!hasBudget) {
        const segments = [
            timeText,
            t('session.workState.goal.tokensSuffix', { count: formatTokenUsageCount(usedTokens) }),
        ].filter((segment): segment is string => Boolean(segment));
        return (
            <Text
                testID="session-goal-usage-meta"
                accessibilityLiveRegion="none"
                style={[styles.meta, { color: theme.colors.text.secondary }]}
            >
                {segments.join(' · ')}
            </Text>
        );
    }

    const ratio = resolveTokenUsageProgressRatio({ used: usedTokens, limit: tokenBudget });
    const percent = formatTokenUsagePercent(ratio * 100);
    const budgetText = t('session.workState.goal.budgetProgress', {
        used: formatTokenUsageCount(usedTokens),
        budget: formatTokenUsageCount(tokenBudget as number),
    });
    const segments = [budgetText, percent, timeText].filter((segment): segment is string => Boolean(segment));
    const budgetCaption = t('session.workState.goal.budgetCaption', {
        budget: formatTokenUsageCount(tokenBudget as number),
    });
    return (
        <View style={styles.budgetBlock}>
            <Text
                testID="session-goal-usage-meta"
                accessibilityLiveRegion="none"
                style={[styles.meta, { color: theme.colors.text.secondary }]}
            >
                {segments.join(' · ')}
            </Text>
            <MeterBar
                testID="session-goal-budget-meter"
                tone={resolveBudgetTone(ratio)}
                fillFraction={ratio}
                height={4}
                caption={
                    <Text
                        testID="session-goal-budget-caption"
                        accessibilityLiveRegion="none"
                        style={[styles.caption, { color: theme.colors.text.secondary }]}
                    >
                        {budgetCaption}
                    </Text>
                }
            />
        </View>
    );
}

const styles = StyleSheet.create(() => ({
    meta: {
        fontSize: 12,
        fontWeight: '500',
        fontVariant: ['tabular-nums'],
    },
    budgetBlock: {
        gap: 6,
    },
    caption: {
        fontSize: 12,
        lineHeight: 16,
        fontVariant: ['tabular-nums'],
    },
}));
