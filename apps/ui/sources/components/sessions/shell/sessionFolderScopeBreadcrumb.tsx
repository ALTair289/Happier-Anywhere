import React from 'react';
import { Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import type { SessionFolderHeaderItem } from './sessionFolderShellTypes';
import { Icon } from '@/components/ui/icons/Icon';

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        paddingHorizontal: 24,
        paddingTop: 10,
        paddingBottom: 4,
        backgroundColor: theme.colors.background.canvas,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    crumbRow: {
        flex: 1,
        minWidth: 0,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 5,
    },
    crumbText: {
        fontSize: 12,
        color: theme.colors.text.secondary,
        ...Typography.default('semiBold'),
    },
    separator: {
        color: theme.colors.text.tertiary,
    },
    clearButton: {
        width: 24,
        height: 24,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: 999,
        backgroundColor: theme.colors.surface.base,
    },
}));

export function SessionFolderScopeBreadcrumb(props: Readonly<{
    breadcrumbs: readonly SessionFolderHeaderItem[];
    onClear: () => void;
    onSelectFolder: (folderId: string) => void;
    rootTitle?: string | null;
}>) {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    if (props.breadcrumbs.length === 0) return null;

    return (
        <View style={styles.container} testID="session-folder-breadcrumb">
            <View style={styles.crumbRow}>
                <Pressable
                    testID="session-folder-breadcrumb-root"
                    accessibilityRole="button"
                    accessibilityLabel={props.rootTitle ?? t('sessionsList.folders')}
                    onPress={props.onClear}
                    hitSlop={6}
                >
                    <Text style={styles.crumbText} numberOfLines={1}>
                        {props.rootTitle ?? t('sessionsList.folders')}
                    </Text>
                </Pressable>
                {props.breadcrumbs.map((folder) => (
                    <React.Fragment key={folder.folderId}>
                        <Text style={[styles.crumbText, styles.separator]}>/</Text>
                        <Pressable
                            testID={`session-folder-breadcrumb-folder-${folder.folderId}`}
                            accessibilityRole="button"
                            accessibilityLabel={folder.title}
                            onPress={() => props.onSelectFolder(folder.folderId)}
                            hitSlop={6}
                        >
                            <Text style={styles.crumbText} numberOfLines={1}>{folder.title}</Text>
                        </Pressable>
                    </React.Fragment>
                ))}
            </View>
            <Pressable
                testID="session-folder-clear-focus"
                style={styles.clearButton}
                accessibilityRole="button"
                accessibilityLabel={t('sessionsList.clearFolderFocus')}
                onPress={props.onClear}
                hitSlop={8}
            >
                <Icon name="x" size={14} color={theme.colors.text.secondary} />
            </Pressable>
        </View>
    );
}
