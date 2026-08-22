import * as React from 'react';
import { Pressable, View, type StyleProp, type TextStyle, type ViewStyle } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import {
    getSelectableChangedFilesViewModes,
    type ChangedFilesViewMode,
} from '@/scm/scmAttribution';
import { t } from '@/text';
import { Icon, type IconName } from '@/components/ui/icons/Icon';

type ChangedFilesViewModeMenuProps = Readonly<{
    theme: any;
    changedFilesViewMode: ChangedFilesViewMode;
    showTurnViewToggle?: boolean;
    showSessionViewToggle?: boolean;
    showSelectedViewToggle?: boolean;
    onChangedFilesViewMode?: (mode: ChangedFilesViewMode) => void;
    testID?: string;
    triggerLabel?: string;
    triggerLabelColor?: string;
    triggerStyle?: StyleProp<ViewStyle>;
    triggerTextStyle?: StyleProp<TextStyle>;
    accessibilityLabel?: string;
    popoverAnchorAlign?: 'start' | 'center' | 'end';
}>;

function getModeIcon(mode: ChangedFilesViewMode): IconName {
    if (mode === 'selected') return 'file-plus';
    if (mode === 'turn') return 'clock';
    if (mode === 'session') return 'clock-counter-clockwise';
    return 'list-bullets';
}

function getModeLabel(mode: ChangedFilesViewMode): string {
    if (mode === 'selected') return t('files.toolbar.selectedForCommitView');
    if (mode === 'turn') return t('files.toolbar.turnView');
    if (mode === 'session') return t('files.toolbar.sessionView');
    return t('files.toolbar.repositoryView');
}

export const ChangedFilesViewModeMenu = React.memo((props: ChangedFilesViewModeMenuProps) => {
    const [open, setOpen] = React.useState(false);
    const selectableModes = React.useMemo(() => getSelectableChangedFilesViewModes({
        showTurnViewToggle: props.showTurnViewToggle === true,
        showSessionViewToggle: props.showSessionViewToggle === true,
        showSelectedViewToggle: props.showSelectedViewToggle === true,
    }), [props.showSelectedViewToggle, props.showSessionViewToggle, props.showTurnViewToggle]);

    const selectedMode = selectableModes.includes(props.changedFilesViewMode)
        ? props.changedFilesViewMode
        : selectableModes[0];

    const items = React.useMemo<DropdownMenuItem[]>(() => selectableModes.map((mode) => ({
        id: mode,
        title: getModeLabel(mode),
        icon: <Icon name={getModeIcon(mode)} size={14} color={props.theme.colors.text.secondary} />,
    })), [props.theme.colors.text.secondary, selectableModes]);

    const onSelect = React.useCallback((itemId: string) => {
        if (itemId !== 'repository' && itemId !== 'selected' && itemId !== 'turn' && itemId !== 'session') return;
        props.onChangedFilesViewMode?.(itemId);
    }, [props.onChangedFilesViewMode]);

    if (selectableModes.length <= 1 || !selectedMode) return null;

    const triggerLabel = props.triggerLabel ?? t('files.toolbar.view');
    const triggerLabelColor = props.triggerLabelColor ?? props.theme.colors.text.secondary;

    return (
        <DropdownMenu
            open={open}
            onOpenChange={setOpen}
            items={items}
            selectedId={selectedMode}
            onSelect={onSelect}
            search={false}
            matchTriggerWidth={false}
            maxWidthCap={220}
            placement="bottom"
            popoverAnchorAlign={props.popoverAnchorAlign ?? 'end'}
            trigger={({ toggle, open: triggerOpen }) => (
                <Pressable
                    testID={props.testID}
                    accessibilityRole="button"
                    accessibilityLabel={props.accessibilityLabel ?? t('files.toolbar.view')}
                    onPress={toggle}
                    style={({ pressed }) => [
                        // Matches `ToolbarButton`, which this trigger cannot simply be: it is the
                        // anchor the popover measures against, so it stays a Pressable here.
                        {
                            flexDirection: 'row',
                            alignItems: 'center',
                            justifyContent: 'center',
                            paddingHorizontal: 10,
                            height: 30,
                            borderRadius: 8,
                            borderWidth: StyleSheet.hairlineWidth,
                            borderColor: props.theme.colors.border.subtle,
                            backgroundColor: props.theme.colors.surface.base,
                            gap: 6,
                        },
                        props.triggerStyle,
                        { opacity: pressed ? 0.78 : 1 },
                    ]}
                >
                    <Icon name={getModeIcon(selectedMode)} size={14} color={props.theme.colors.text.secondary} />
                    <Text
                        numberOfLines={1}
                        style={[
                            {
                                minWidth: 0,
                                flexShrink: 1,
                                fontSize: 12,
                                color: triggerLabelColor,
                                ...Typography.default('semiBold'),
                            },
                            props.triggerTextStyle,
                        ]}
                    >
                        {triggerLabel}
                    </Text>
                    <View style={{ marginLeft: -2 }}>
                        <Icon name={triggerOpen ? 'caret-up' : 'caret-down'} size={14} color={props.theme.colors.text.secondary} />
                    </View>
                </Pressable>
            )}
        />
    );
});
