import * as React from 'react';
import { Platform, View } from 'react-native';
import { Octicons } from '@expo/vector-icons';

import { IconAction } from '@/components/ui/buttons/IconAction';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

export type SourceControlRemoteAction = Readonly<{
    key: 'fetch' | 'pull' | 'push' | 'publish';
    iconName: 'sync' | 'arrow-down' | 'arrow-up' | 'upload';
    label: string;
    disabled: boolean;
    onPress: () => void;
    testID?: string;
}>;

export type SourceControlRemoteActionsRailProps = Readonly<{
    theme: any;
    actions: readonly SourceControlRemoteAction[];
    hint?: string | null;
}>;

/**
 * Four glyph-only buttons sat in a row, each in its own bordered box, so the chrome outweighed the
 * icons and the rail read as heavier than the file list it sits above. They use the canonical
 * `IconAction` now: no border at rest, affordance on hover.
 */
const RemoteActionButton = React.memo((props: Readonly<{
    action: SourceControlRemoteAction;
    iconColor: string;
}>) => (
    <IconAction
        testID={props.action.testID}
        accessibilityLabel={props.action.label}
        disabled={props.action.disabled}
        onPress={props.action.onPress}
    >
        <Octicons name={props.action.iconName} size={16} color={props.iconColor} />
    </IconAction>
));

RemoteActionButton.displayName = 'RemoteActionButton';

export const SourceControlRemoteActionsRail = React.memo((props: SourceControlRemoteActionsRailProps) => {
    if (props.actions.length === 0) return null;

    return (
        <View
            style={{
                paddingHorizontal: 12,
                paddingTop: 10,
                paddingBottom: 10,
                borderBottomWidth: Platform.select({ ios: 0.33, default: 1 }),
                borderBottomColor: props.theme.colors.border.default,
                backgroundColor: props.theme.colors.surface.base,
                gap: 8,
            }}
        >
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                <Text style={{ fontSize: 12, color: props.theme.colors.text.secondary, ...Typography.default('semiBold') }}>
                    {t('files.sourceControlOperations.title')}
                </Text>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 2 }}>
                    {props.actions.map((action) => (
                        <RemoteActionButton
                            key={action.key}
                            action={action}
                            iconColor={props.theme.colors.text.secondary}
                        />
                    ))}
                </View>
            </View>
            {props.hint ? (
                <Text style={{ fontSize: 11, color: props.theme.colors.text.secondary, ...Typography.default() }}>
                    {props.hint}
                </Text>
            ) : null}
        </View>
    );
});
