import * as React from 'react';
import { Pressable, View, useWindowDimensions } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useRouter } from 'expo-router';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { resolvePaneLayout } from '@/components/ui/panels/paneBreakpoints';
import { PANE_SIZING_DEFAULTS } from '@/components/appShell/panes/layout/paneSizing';
import { useDeviceType } from '@/utils/platform/responsive';
import { useLocalSetting } from '@/sync/domains/state/storage';
import * as FlashListCompat from '@/components/ui/lists/flashListCompat/FlashListCompat';
import { Icon } from '@/components/ui/icons/Icon';

const LINKED_FILE_PREFIX = '@';

export type LinkedWorkspaceFilesRowProps = Readonly<{
    sessionId: string;
    paths: readonly string[];
    fileOpenEnabled: boolean;
}>;

const stylesheet = StyleSheet.create((theme) => ({
    row: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 8,
        marginTop: 8,
    },
    chip: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.inset,
        paddingHorizontal: 10,
        paddingVertical: 6,
        borderRadius: 999,
        maxWidth: '100%',
    },
    chipPressed: {
        opacity: 0.8,
    },
    chipText: {
        color: theme.colors.text.primary,
        fontSize: 12,
        ...Typography.default('semiBold'),
    },
    chipSubtle: {
        color: theme.colors.text.secondary,
        fontSize: 12,
        ...Typography.default(),
    },
}));

const fallbackLinkedFilesMappingHelper: FlashListCompat.FlashListMappingHelper = {
    getMappingKey: (itemKey: FlashListCompat.FlashListMappingKey) => itemKey,
};

function useLinkedFilesMappingHelper(): FlashListCompat.FlashListMappingHelper {
    return typeof FlashListCompat.useMappingHelper === 'function'
        ? FlashListCompat.useMappingHelper()
        : fallbackLinkedFilesMappingHelper;
}

function getBasename(path: string): string {
    const parts = path.split('/');
    const last = parts.at(-1) ?? path;
    return last || path;
}

export const LinkedWorkspaceFilesRow = React.memo((props: LinkedWorkspaceFilesRowProps) => {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const router = useRouter();
    const { width: windowWidth } = useWindowDimensions();
    const deviceType = useDeviceType();
    const multiPaneEnabled = useLocalSetting('uiMultiPanePanelsEnabled') !== false;
    const { getMappingKey } = useLinkedFilesMappingHelper();

    const scopeId = React.useMemo(() => `session:${props.sessionId}`, [props.sessionId]);
    const pane = useAppPaneScope(scopeId);

    const openFile = React.useCallback((path: string) => {
        const layoutIfOpened = resolvePaneLayout({
            containerWidthPx: windowWidth,
            deviceType,
            multiPaneEnabled,
            rightOpen: false,
            detailsOpen: true,
            mainMinPx: PANE_SIZING_DEFAULTS.mainMinPx,
            rightMinPx: PANE_SIZING_DEFAULTS.right.minPx,
            detailsMinPx: PANE_SIZING_DEFAULTS.details.minPx,
        });

        if (layoutIfOpened.kind === 'single') {
            const href = `/session/${props.sessionId}/file?path=${encodeURIComponent(path)}`;
            router.push(href as never);
            return;
        }

        pane.openDetailsTab({
            key: `file:${path}`,
            kind: 'file',
            title: getBasename(path),
            resource: { kind: 'file', path },
        });
    }, [deviceType, multiPaneEnabled, pane, props.sessionId, router, windowWidth]);

    if (props.paths.length === 0) return null;

    return (
        <View style={styles.row}>
            {props.paths.map((path, index) => {
                const content = (
                    <>
                    <Icon name="file-text" size={14} color={theme.colors.text.secondary} />
                    <Text style={styles.chipSubtle}>{LINKED_FILE_PREFIX}</Text>
                    <Text style={styles.chipText} numberOfLines={1}>
                        {getBasename(path)}
                    </Text>
                    </>
                );
                return props.fileOpenEnabled ? (
                    <Pressable
                        key={getMappingKey(path, index)}
                        testID={`linked-workspace-file:${path}`}
                        onPress={() => openFile(path)}
                        style={({ pressed }) => [styles.chip, pressed ? styles.chipPressed : null]}
                        accessibilityRole="button"
                    >
                        {content}
                    </Pressable>
                ) : (
                    <View
                        key={getMappingKey(path, index)}
                        testID={`linked-workspace-file:${path}`}
                        style={styles.chip}
                        accessibilityRole="text"
                    >
                        {content}
                    </View>
                );
            })}
        </View>
    );
});
