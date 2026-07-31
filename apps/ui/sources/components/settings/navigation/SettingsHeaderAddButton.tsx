import * as React from 'react';
import { Pressable } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { Icon } from '@/components/ui/icons/Icon';

export type SettingsHeaderAddButtonProps = Readonly<{
    onPress: () => void;
    accessibilityLabel: string;
    disabled?: boolean;
    testID?: string;
    /** Header tint passed by the navigator's `headerRight` render slot. */
    tintColor?: string;
}>;

/**
 * Canonical header-right "+" action for settings stack screens. Mirrors the
 * save-button affordance in `McpServerEditorScreen` (Pressable + Ionicon, header
 * foreground tint, pressed/disabled opacity) so add-actions look consistent
 * across the settings stack. Wired per-screen via `navigation.setOptions`.
 */
export const SettingsHeaderAddButton = React.memo(function SettingsHeaderAddButton(
    props: SettingsHeaderAddButtonProps,
) {
    const { theme } = useUnistyles();
    const color = props.tintColor ?? theme.colors.chrome.header.foreground;
    return (
        <Pressable
            testID={props.testID}
            onPress={props.onPress}
            disabled={props.disabled}
            accessibilityRole="button"
            accessibilityLabel={props.accessibilityLabel}
            hitSlop={12}
            style={({ pressed }) => ({
                opacity: props.disabled ? 0.35 : pressed ? 0.7 : 1,
                padding: 4,
            })}
        >
            <Icon name="plus" size={24} color={color} />
        </Pressable>
    );
});
