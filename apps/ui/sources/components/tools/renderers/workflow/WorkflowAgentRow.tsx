import { Ionicons } from '@expo/vector-icons';
import * as React from 'react';
import { Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import type { SessionWorkflowAgentStatusV1 } from '@happier-dev/protocol';

import { WorkflowAgentDetail } from './WorkflowAgentDetail';
import { WorkflowStatusIcon } from './workflowStatusIcon';

/**
 * One workflow agent row (UIW3/UIW4). Props are PRIMITIVE so this memoized row re-renders only when
 * its own status/metrics change — concurrent workflows' progress ticks must not re-render unrelated
 * rows. Status icon/colors come from the shared themed helper.
 *
 * Density (U-18): compact single-line rows (≤44pt) with a right-aligned muted metadata slot that
 * only renders when metrics are actually present. Distinct status glyphs (U-19) come from the shared
 * `WorkflowStatusIcon`. Accessibility (U-10): the Pressable announces the agent title, not the full
 * live-updating metric string.
 */

export type WorkflowAgentRowProps = Readonly<{
    title: string;
    status: SessionWorkflowAgentStatusV1;
    model?: string;
    tokensUsed?: number;
    toolCalls?: number;
    timeUsedSeconds?: number;
    resultPreview?: string;
    summary?: string;
    testID?: string;
}>;

function formatTokens(tokens: number): string {
    if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}k`;
    return String(tokens);
}

function formatDuration(seconds: number): string {
    if (seconds >= 60) {
        const m = Math.floor(seconds / 60);
        const s = Math.round(seconds % 60);
        return `${m}m ${s}s`;
    }
    return `${Math.round(seconds)}s`;
}

export const WorkflowAgentRow = React.memo<WorkflowAgentRowProps>((props) => {
    const { theme } = useUnistyles();
    const [expanded, setExpanded] = React.useState(false);
    const metricParts: string[] = [];
    if (typeof props.tokensUsed === 'number' && props.tokensUsed > 0) {
        metricParts.push(t('tools.workflowActivityView.tokens', { tokens: formatTokens(props.tokensUsed) }));
    }
    if (typeof props.toolCalls === 'number' && props.toolCalls > 0) {
        metricParts.push(t('tools.workflowActivityView.toolCalls', { count: props.toolCalls }));
    }
    if (typeof props.timeUsedSeconds === 'number' && props.timeUsedSeconds > 0) {
        metricParts.push(formatDuration(props.timeUsedSeconds));
    }
    const metrics = metricParts.join(' · ');
    const hasDetail = Boolean(props.summary || props.resultPreview);
    // Prefer the fuller narrative for the expanded body; the row itself stays compact.
    const expandedDetail = props.summary ?? props.resultPreview;
    const detailTestID = props.testID ? `${props.testID}-detail` : undefined;
    const content = (
        <View style={styles.mainRow}>
            <View style={styles.iconColumn}>
                <WorkflowStatusIcon status={props.status} size={14} />
            </View>
            <Text style={styles.title} numberOfLines={1}>
                {props.title}
            </Text>
            {metrics ? (
                <Text style={styles.metrics} numberOfLines={1} testID={props.testID ? `${props.testID}-metrics` : undefined}>
                    {metrics}
                </Text>
            ) : null}
            {hasDetail ? (
                <Ionicons
                    name={expanded ? 'chevron-up' : 'chevron-down'}
                    size={14}
                    color={theme.colors.text.secondary}
                />
            ) : null}
        </View>
    );

    if (hasDetail) {
        return (
            <Pressable
                accessibilityRole="button"
                accessibilityLabel={props.title}
                accessibilityState={{ expanded }}
                onPress={() => setExpanded((current) => !current)}
                style={[styles.row, expanded ? styles.rowExpanded : null]}
                testID={props.testID}
                hitSlop={6}
            >
                {content}
                {expanded && expandedDetail ? (
                    <WorkflowAgentDetail text={expandedDetail} detailTestID={detailTestID} />
                ) : null}
            </Pressable>
        );
    }

    return (
        <View style={styles.row} testID={props.testID} accessibilityLabel={props.title}>
            {content}
        </View>
    );
});
WorkflowAgentRow.displayName = 'WorkflowAgentRow';

const styles = StyleSheet.create((theme) => ({
    row: {
        gap: 6,
        minHeight: 32,
        paddingVertical: 5,
        paddingHorizontal: 2,
        borderRadius: 8,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: theme.colors.border.default,
    },
    rowExpanded: {
        backgroundColor: theme.colors.surface.base,
        borderBottomColor: 'transparent',
    },
    mainRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    iconColumn: {
        width: 16,
        alignItems: 'center',
    },
    title: {
        flex: 1,
        fontSize: 13,
        color: theme.colors.text.primary,
    },
    metrics: {
        fontSize: 11,
        color: theme.colors.text.tertiary,
        fontVariant: ['tabular-nums'],
    },
}));
