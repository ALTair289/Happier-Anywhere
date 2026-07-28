import * as React from 'react';
import { View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import type { SessionMediaUnavailableSummary } from '@/sync/domains/sessionMedia/sessionMediaMessageMeta';

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        marginTop: 4,
        marginBottom: 7,
        gap: 6,
    },
    item: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        paddingHorizontal: 10,
        paddingVertical: 8,
        borderRadius: 10,
        borderWidth: 1,
        borderColor: theme.colors.state.danger.border,
        backgroundColor: theme.colors.surface.elevated,
    },
    label: {
        flexShrink: 1,
        color: theme.colors.text.secondary,
        fontSize: 13,
    },
}));

export const SessionMediaUnavailableItems = React.memo(function SessionMediaUnavailableItems(props: Readonly<{
    items: readonly SessionMediaUnavailableSummary[];
}>): React.ReactElement | null {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    if (props.items.length === 0) return null;

    return (
        <View testID="message-session-media-unavailable" style={styles.container}>
            {props.items.map((item) => (
                <View
                    key={item.id}
                    testID={`message-session-media-unavailable:${item.id}`}
                    accessibilityRole="text"
                    accessibilityLabel={t('files.sessionMedia.imageUnavailable')}
                    style={styles.item}
                >
                    <Ionicons
                        name="alert-circle-outline"
                        size={18}
                        color={theme.colors.state.danger.foreground}
                    />
                    <Text style={styles.label}>{t('files.sessionMedia.imageUnavailable')}</Text>
                </View>
            ))}
        </View>
    );
});
