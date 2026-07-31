import * as React from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import * as FlashListCompat from '@/components/ui/lists/flashListCompat/FlashListCompat';
import { Icon, type IconName } from '@/components/ui/icons/Icon';

export type MessageAttachmentSummary = Readonly<{
    name: string;
    path: string;
    mimeType?: string;
    sizeBytes: number;
}>;

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        marginTop: 2,
        marginBottom: 7,
        gap: 8,
    },
    row: {
        flexDirection: 'row',
        gap: 8,
    },
    attachmentChip: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        paddingHorizontal: 10,
        paddingVertical: 7,
        borderRadius: 999,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.elevated,
        maxWidth: 260,
    },
    attachmentText: {
        color: theme.colors.text.primary,
        fontSize: 12,
        fontWeight: '600',
        flexShrink: 1,
    },
    attachmentMeta: {
        color: theme.colors.text.secondary,
        fontSize: 11,
        flexShrink: 0,
    },
}));

const fallbackAttachmentsMappingHelper: FlashListCompat.FlashListMappingHelper = {
    getMappingKey: (itemKey: FlashListCompat.FlashListMappingKey) => itemKey,
};

function useAttachmentsMappingHelper(): FlashListCompat.FlashListMappingHelper {
    return typeof FlashListCompat.useMappingHelper === 'function'
        ? FlashListCompat.useMappingHelper()
        : fallbackAttachmentsMappingHelper;
}

function formatBytes(bytes: number): string {
    const value = Number.isFinite(bytes) ? bytes : 0;
    if (value < 1024) return `${Math.max(0, Math.floor(value))} B`;
    const kb = value / 1024;
    if (kb < 1024) return `${kb.toFixed(kb >= 100 ? 0 : 1)} KB`;
    const mb = kb / 1024;
    if (mb < 1024) return `${mb.toFixed(mb >= 100 ? 0 : 1)} MB`;
    const gb = mb / 1024;
    return `${gb.toFixed(gb >= 100 ? 0 : 1)} GB`;
}

function resolveAttachmentIconName(mimeType?: string): IconName {
    if (!mimeType) return 'file';
    if (mimeType.startsWith('image/')) return 'image';
    if (mimeType.startsWith('text/')) return 'file-text';
    return 'file';
}

export const AttachmentsMessageRow = React.memo(function AttachmentsMessageRow(props: Readonly<{
    attachments: readonly MessageAttachmentSummary[];
    onOpenPath?: (path: string) => void;
}>) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const { getMappingKey } = useAttachmentsMappingHelper();

    if (props.attachments.length === 0) return null;

    return (
        <View testID="message-attachments-row" style={styles.container}>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.row}>
                {props.attachments.map((a, index) => {
                    const content = (
                        <>
                        <Icon name={resolveAttachmentIconName(a.mimeType)} size={14} color={theme.colors.text.secondary} />
                        <Text numberOfLines={1} style={styles.attachmentText}>{a.name}</Text>
                        <Text style={styles.attachmentMeta}>{formatBytes(a.sizeBytes)}</Text>
                        </>
                    );
                    return props.onOpenPath ? (
                        <Pressable
                            key={getMappingKey(`${a.path}:${a.name}`, index)}
                            onPress={() => props.onOpenPath?.(a.path)}
                            style={styles.attachmentChip}
                        >
                            {content}
                        </Pressable>
                    ) : (
                        <View key={getMappingKey(`${a.path}:${a.name}`, index)} style={styles.attachmentChip}>
                            {content}
                        </View>
                    );
                })}
            </ScrollView>
        </View>
    );
});
