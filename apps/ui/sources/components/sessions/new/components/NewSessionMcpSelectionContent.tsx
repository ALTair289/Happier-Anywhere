import React from 'react';
import { Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';

import type {
    DaemonMcpServersPreviewResponse,
    SessionMcpSelectionV1,
} from '@happier-dev/protocol';

import type { AgentId } from '@/agents/catalog/catalog';
import { SelectionList, resolvePopoverSelectionListHeightBehavior } from '@/components/ui/selectionList';
import { normalizeNodeForView } from '@/components/ui/rendering/normalizeNodeForView';
import { t } from '@/text';
import { useSetting } from '@/sync/domains/state/storage';
import { normalizeMcpServersSettingsV1 } from '@/sync/domains/settings/mcpServers/normalizeMcpServersSettingsV1';

import { buildNewSessionMcpSelectionListStep } from './buildNewSessionMcpSelectionListStep';
import { Icon, type IconName } from '@/components/ui/icons/Icon';

type PreviewSuccess = Extract<DaemonMcpServersPreviewResponse, { ok: true }>;

export type NewSessionMcpSelectionContentProps = Readonly<{
    machineId?: string | null;
    machineName?: string | null;
    directory: string;
    agentType: AgentId;
    hasContext: boolean;
    preview: PreviewSuccess | null;
    selection: SessionMcpSelectionV1;
    loading: boolean;
    error: string | null;
    previewUnsupported?: boolean;
    onSelectionChange: (selection: SessionMcpSelectionV1) => void;
    onRefresh: () => void;
    onOpenSettings: () => void;
    maxHeight: number;
}>;

type GroupActionButtonProps = Readonly<{
    testID: string;
    accessibilityLabel: string;
    icon: IconName;
    loading?: boolean;
    onPress: () => void;
}>;

function GroupActionButton(props: GroupActionButtonProps) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const isLoading = props.loading === true;

    return (
        <Pressable
            testID={props.testID}
            accessibilityRole="button"
            accessibilityLabel={props.accessibilityLabel}
            onPress={isLoading ? undefined : props.onPress}
            disabled={isLoading}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            style={({ pressed }) => [
                styles.groupActionButton,
                pressed ? styles.groupActionButtonPressed : null,
            ]}
        >
            {isLoading ? (
                <ActivitySpinner size="small" color={theme.colors.text.tertiary} />
            ) : (
                normalizeNodeForView(
                    <Icon name={props.icon} size={16} color={theme.colors.text.tertiary} />,
                )
            )}
        </Pressable>
    );
}

export function NewSessionMcpSelectionContent(props: NewSessionMcpSelectionContentProps) {
    const styles = stylesheet;

    const mcpServersSettingsRaw = useSetting('mcpServersSettingsV1');
    const mcpServersSettings = React.useMemo(
        () => normalizeMcpServersSettingsV1(mcpServersSettingsRaw),
        [mcpServersSettingsRaw],
    );

    const happierHeaderRightAccessory = React.useMemo(() => (
        <View style={styles.groupActions}>
            <GroupActionButton
                testID="new-session.mcp.happier.refresh"
                accessibilityLabel={t('common.refresh')}
                icon="arrow-clockwise"
                loading={props.loading}
                onPress={props.onRefresh}
            />
            <GroupActionButton
                testID="new-session.mcp.happier.open-settings"
                accessibilityLabel={t('tabs.settings')}
                icon="sliders-horizontal"
                onPress={props.onOpenSettings}
            />
        </View>
    ), [props.loading, props.onOpenSettings, props.onRefresh, styles.groupActions]);

    const detectedHeaderRightAccessory = React.useMemo(() => (
        <GroupActionButton
            testID="new-session.mcp.detected.refresh"
            accessibilityLabel={t('common.refresh')}
            icon="arrow-clockwise"
            loading={props.loading}
            onPress={props.onRefresh}
        />
    ), [props.loading, props.onRefresh]);

    const rootStep = React.useMemo(() => buildNewSessionMcpSelectionListStep({
        machineId: props.machineId,
        directory: props.directory,
        agentType: props.agentType,
        hasContext: props.hasContext,
        loading: props.loading,
        preview: props.preview,
        previewUnsupported: props.previewUnsupported,
        error: props.error,
        selection: props.selection,
        mcpServersSettings,
        happierHeaderRightAccessory,
        detectedHeaderRightAccessory,
        onSelectionChange: props.onSelectionChange,
    }), [
        detectedHeaderRightAccessory,
        happierHeaderRightAccessory,
        mcpServersSettings,
        props.agentType,
        props.directory,
        props.error,
        props.hasContext,
        props.loading,
        props.machineId,
        props.onSelectionChange,
        props.preview,
        props.previewUnsupported,
        props.selection,
    ]);

    return (
        <View style={[styles.container, { maxHeight: props.maxHeight }]}>
            <SelectionList
                testID="new-session.mcp.selection-list"
                rootStep={rootStep}
                maxHeight={props.maxHeight}
                heightBehavior={resolvePopoverSelectionListHeightBehavior()}
                keyboardHintsEnabled={false}
                onRequestClose={() => {}}
                onSelect={() => {}}
            />
        </View>
    );
}

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        width: '100%',
        backgroundColor: theme.colors.background.canvas,
        flexShrink: 1,
    },
    groupActions: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        marginLeft: 12,
        flexShrink: 0,
    },
    groupActionButton: {
        width: 28,
        height: 28,
        borderRadius: 8,
        alignItems: 'center',
        justifyContent: 'center',
    },
    groupActionButtonPressed: {
        opacity: 0.82,
    },
}));
