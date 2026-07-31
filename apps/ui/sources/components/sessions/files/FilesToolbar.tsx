import * as React from 'react';
import { Platform, Pressable, View } from 'react-native';

import { Text, TextInput } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import {
    type ChangedFilesPresentation,
    type ChangedFilesViewMode,
} from '@/scm/scmAttribution';
import { ChangedFilesViewModeMenu } from './ChangedFilesViewModeMenu';
import { ToolbarButton } from '@/components/ui/buttons/ToolbarButton';
import { Icon } from '@/components/ui/icons/Icon';

type FilesToolbarProps = {
    theme: any;
    searchQuery: string;
    onSearchQueryChange: (value: string) => void;
    showAllRepositoryFiles: boolean;
    onShowChangedFiles: () => void;
    onShowAllRepositoryFiles: () => void;
    changedFilesCount: number;
    changedFilesViewMode: ChangedFilesViewMode;
    changedFilesPresentation: ChangedFilesPresentation;
    showTurnViewToggle?: boolean;
    showSessionViewToggle: boolean;
    onChangedFilesViewMode: (mode: ChangedFilesViewMode) => void;
    onChangedFilesPresentationChange: (mode: ChangedFilesPresentation) => void;
    scmPanelExpanded: boolean;
    onToggleScmPanel: () => void;
    onRefresh?: () => void;
    showScmToggle?: boolean;
};

export function FilesToolbar(props: FilesToolbarProps) {
    const {
        theme,
        searchQuery,
        onSearchQueryChange,
        showAllRepositoryFiles,
        onShowChangedFiles,
        onShowAllRepositoryFiles,
        changedFilesCount,
        changedFilesViewMode,
        changedFilesPresentation,
        showTurnViewToggle = false,
        showSessionViewToggle,
        onChangedFilesViewMode,
        onChangedFilesPresentationChange,
        scmPanelExpanded,
        onToggleScmPanel,
        onRefresh,
        showScmToggle = true,
    } = props;

    const Chip = (p: {
        active: boolean;
        label: string;
        icon: React.ReactNode;
        badge?: React.ReactNode;
        onPress: () => void;
    }) => (
        <ToolbarButton
            onPress={p.onPress}
            active={p.active}
            label={p.label}
            icon={p.icon}
            trailing={p.badge}
            size="md"
        />
    );

    const CountBadge = ({ count }: { count: number }) => {
        if (count <= 0) return null;
        return (
            <View
                style={{
                    minWidth: 20,
                    paddingHorizontal: 6,
                    paddingVertical: 2,
                    // The canonical badge shape: background-only, 8px radius.
                    borderRadius: 8,
                    borderWidth: 0,
                    backgroundColor: theme.colors.state.neutral.background,
                }}
            >
                <Text style={{ fontSize: 11, color: theme.colors.text.secondary, ...Typography.mono('semiBold') }}>
                    {String(count)}
                </Text>
            </View>
        );
    };

    return (
        <View
            style={{
                padding: 16,
                borderBottomWidth: Platform.select({ ios: 0.33, default: 1 }),
                borderBottomColor: theme.colors.border.default,
            }}
        >
            <View
                style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    backgroundColor: theme.colors.input.background,
                    borderRadius: 10,
                    paddingHorizontal: 12,
                    paddingVertical: 8,
                    borderWidth: 1,
                    borderColor: theme.colors.border.default,
                }}
            >
                <Icon name="magnifying-glass" size={16} color={theme.colors.text.secondary} style={{ marginRight: 8 }} />
                <TextInput
                    value={searchQuery}
                    onChangeText={onSearchQueryChange}
                    placeholder={t('files.searchPlaceholder')}
                    style={{
                        flex: 1,
                        fontSize: 16,
                        ...Typography.default(),
                    }}
                    placeholderTextColor={theme.colors.input.placeholder}
                    autoCapitalize="none"
                    autoCorrect={false}
                />
            </View>

            <View style={{ flexDirection: 'row', marginTop: 10, gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                <Chip
                    active={!showAllRepositoryFiles}
                    label={t('files.toolbar.changedFiles')}
                    icon={<Icon name="git-diff" size={14} color={theme.colors.text.secondary} />}
                    badge={!showAllRepositoryFiles ? <CountBadge count={changedFilesCount} /> : undefined}
                    onPress={onShowChangedFiles}
                />
                <Chip
                    active={showAllRepositoryFiles}
                    label={t('files.toolbar.allRepositoryFiles')}
                    icon={<Icon name="book-bookmark" size={14} color={theme.colors.text.secondary} />}
                    onPress={onShowAllRepositoryFiles}
                />

                {!showAllRepositoryFiles && changedFilesCount > 0 ? (
                    <>
                        <ChangedFilesViewModeMenu
                            theme={theme}
                            changedFilesViewMode={changedFilesViewMode}
                            showTurnViewToggle={showTurnViewToggle}
                            showSessionViewToggle={showSessionViewToggle}
                            onChangedFilesViewMode={onChangedFilesViewMode}
                        />

                        <Chip
                            active={changedFilesPresentation === 'review'}
                            label={t('files.toolbar.review')}
                            icon={<Icon name="git-diff" size={14} color={theme.colors.text.secondary} />}
                            onPress={() => onChangedFilesPresentationChange('review')}
                        />
                        <Chip
                            active={changedFilesPresentation === 'list'}
                            label={t('files.toolbar.list')}
                            icon={<Icon name="list-bullets" size={14} color={theme.colors.text.secondary} />}
                            onPress={() => onChangedFilesPresentationChange('list')}
                        />
                    </>
                ) : null}

                {showScmToggle ? (
                    <Chip
                        active={scmPanelExpanded}
                        label={t('files.toolbar.scm')}
                        icon={<Icon name="git-branch" size={14} color={theme.colors.text.secondary} />}
                        onPress={onToggleScmPanel}
                    />
                ) : null}

                {onRefresh ? (
                    <Chip
                        active={false}
                        label={t('common.refresh')}
                        icon={<Icon name="arrows-clockwise" size={14} color={theme.colors.text.secondary} />}
                        onPress={onRefresh}
                    />
                ) : null}
            </View>

            {!showAllRepositoryFiles && changedFilesCount > 0 && !showTurnViewToggle && !showSessionViewToggle && (
                <View
                    style={{
                        marginTop: 10,
                        paddingHorizontal: 10,
                        paddingVertical: 8,
                        borderRadius: 10,
                        borderWidth: 1,
                        borderColor: theme.colors.border.default,
                        backgroundColor: theme.colors.surface.inset,
                    }}
                >
                    <Text
                        style={{
                            fontSize: 11,
                            color: theme.colors.text.secondary,
                            ...Typography.default(),
                        }}
                    >
                        {t('files.attributionReliabilityLimited')}
                    </Text>
                </View>
            )}
        </View>
    );
}
