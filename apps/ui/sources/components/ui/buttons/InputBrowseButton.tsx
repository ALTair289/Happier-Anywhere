import * as React from 'react';
import { Platform, Pressable, type StyleProp, type ViewStyle } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Icon, type IconName } from '@/components/ui/icons/Icon';

const styles = StyleSheet.create((theme) => ({
    button: {
        width: 36,
        height: 36,
        borderRadius: 10,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: theme.colors.input.background,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
    },
}));

/**
 * RUX-9.3: web-only `cursor: not-allowed` style applied when the button
 * is disabled. Native platforms ignore `cursor` (no-op via Platform.select)
 * so this is a pure progressive-enhancement for browser users — the
 * standard browser affordance for "this control cannot be activated".
 * Paired with a clearly-distinct disabled opacity (0.4 vs 1.0) so the
 * user sees inactivity even before hovering.
 *
 * The cast to `ViewStyle` lets us pass the web `cursor: 'not-allowed'`
 * value without fighting RN's narrower `CursorValue` typing — at runtime
 * RN-Web forwards the property to CSS verbatim.
 */
const DISABLED_WEB_CURSOR_STYLE = Platform.select<StyleProp<ViewStyle>>({
    web: { cursor: 'not-allowed' } as unknown as ViewStyle,
    default: undefined,
});

export function InputBrowseButton(props: Readonly<{
    onPress: () => void | Promise<void>;
    disabled?: boolean;
    testID?: string;
    accessibilityLabel?: string;
    iconName?: IconName;
}>): React.ReactElement {
    const { theme } = useUnistyles();
    const isDisabled = props.disabled === true;

    return (
        <Pressable
            testID={props.testID}
            accessibilityRole="button"
            accessibilityLabel={props.accessibilityLabel}
            accessibilityState={{ disabled: isDisabled }}
            disabled={isDisabled}
            onPress={() => {
                void props.onPress();
            }}
            hitSlop={10}
            style={({ pressed }) => [
                styles.button,
                { opacity: isDisabled ? 0.4 : pressed ? 0.8 : 1 },
                // RUX-9.3: web-only "this is unclickable" cursor cue.
                isDisabled ? DISABLED_WEB_CURSOR_STYLE : undefined,
            ]}
        >
            <Icon
                name={props.iconName ?? 'folder-open'}
                size={16}
                color={theme.colors.text.secondary}
            />
        </Pressable>
    );
}
