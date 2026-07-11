import * as React from 'react';
import {
    Image,
    Platform,
    Pressable,
    View,
    type ImageLoadEvent,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { SvgXml } from 'react-native-svg';

import { Modal } from '@/modal';
import { t } from '@/text';
import { useSessionImagePreview } from '@/components/sessions/files/content/imagePreview/useSessionImagePreview';
import {
    AttachmentImagePreviewModal,
    type AttachmentImagePreviewModalImage,
} from '@/components/sessions/attachments/preview/AttachmentImagePreviewModal';
import * as FlashListCompat from '@/components/ui/lists/flashListCompat/FlashListCompat';
import type { SessionMediaInlineImageSummary } from '@/sync/domains/sessionMedia/sessionMediaMessageMeta';

import { resolveSessionMediaImageMimeType } from './sessionMediaPresentation';

const FALLBACK_THUMBNAIL_SIZE = 84;
const MAX_THUMBNAIL_WIDTH = 220;
const MAX_THUMBNAIL_HEIGHT = 160;
const fallbackSessionMediaMappingHelper: FlashListCompat.FlashListMappingHelper = {
    getMappingKey: (itemKey: FlashListCompat.FlashListMappingKey) => itemKey,
};

function useSessionMediaMappingHelper(): FlashListCompat.FlashListMappingHelper {
    return typeof FlashListCompat.useMappingHelper === 'function'
        ? FlashListCompat.useMappingHelper()
        : fallbackSessionMediaMappingHelper;
}

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        marginTop: 2,
        marginBottom: 7,
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 8,
    },
    tile: {
        borderRadius: 12,
        overflow: 'hidden',
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.elevated,
    },
    image: {
        width: '100%',
        height: '100%',
    },
    placeholder: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: theme.colors.surface.elevated,
    },
}));

type ImageDimensions = Readonly<{
    width: number;
    height: number;
}>;

function readPositiveDimension(value: number | undefined): number | null {
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    const normalized = Math.trunc(value);
    return normalized > 0 ? normalized : null;
}

function resolveImageDimensions(value: Readonly<{ width?: number; height?: number }> | null): ImageDimensions | null {
    const width = readPositiveDimension(value?.width);
    const height = readPositiveDimension(value?.height);
    return width && height ? { width, height } : null;
}

function resolveThumbnailSize(dimensions: ImageDimensions | null): ImageDimensions {
    if (!dimensions) {
        return {
            width: FALLBACK_THUMBNAIL_SIZE,
            height: FALLBACK_THUMBNAIL_SIZE,
        };
    }

    const scale = Math.min(
        MAX_THUMBNAIL_WIDTH / dimensions.width,
        MAX_THUMBNAIL_HEIGHT / dimensions.height,
    );
    return {
        width: Math.max(1, Math.round(dimensions.width * scale)),
        height: Math.max(1, Math.round(dimensions.height * scale)),
    };
}

function SessionMediaInlineImageTile(props: Readonly<{
    sessionId: string;
    media: SessionMediaInlineImageSummary;
    mimeType: string;
    imageIndex: number;
    onOpenPath: (path: string) => void;
    onOpenPreview: (index: number) => void;
    imageTestIDPrefix: string;
    previewTestIDPrefix: string;
}>): React.ReactElement {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const metadataDimensions = resolveImageDimensions(props.media);
    const [loadedDimensions, setLoadedDimensions] = React.useState<ImageDimensions | null>(null);
    const thumbnailSize = resolveThumbnailSize(metadataDimensions ?? loadedDimensions);

    React.useEffect(() => {
        setLoadedDimensions(null);
    }, [props.media.path, props.media.sha256]);

    const handleImageLoad = React.useCallback((event: ImageLoadEvent) => {
        const dimensions = resolveImageDimensions(event.nativeEvent.source);
        if (!dimensions) return;
        setLoadedDimensions((current) => (
            current?.width === dimensions.width && current.height === dimensions.height
                ? current
                : dimensions
        ));
    }, []);

    const preview = useSessionImagePreview({
        sessionId: props.sessionId,
        filePath: props.media.path,
        enabled: true,
        cacheKey: props.media.sha256 ?? null,
        mimeType: props.mimeType,
        sizeBytes: props.media.sizeBytes,
    });
    const accessibilityLabel = (() => {
        const accessibleName = (props.media.description ?? props.media.name).slice(0, 512);
        if (props.media.category === 'attachment') {
            return t('files.sessionMedia.attachmentImageA11y', { name: accessibleName });
        }
        if (props.media.category === 'tool-artifact') {
            return t('files.sessionMedia.toolArtifactImageA11y', { name: accessibleName });
        }
        return t('files.sessionMedia.generatedImageA11y', { name: accessibleName });
    })();

    return (
        <Pressable
            testID={`${props.imageTestIDPrefix}:${props.media.path}`}
            accessibilityRole="imagebutton"
            accessibilityLabel={accessibilityLabel}
            onPress={() => {
                if (preview.status === 'error') {
                    props.onOpenPath(props.media.path);
                    return;
                }
                props.onOpenPreview(props.imageIndex);
            }}
            style={[styles.tile, thumbnailSize]}
        >
            {preview.status === 'loaded' ? (
                Platform.OS !== 'web' && preview.svgXml ? (
                    // SVG stays supported, but only after the daemon preview path has read an authorized session file.
                    // Never render transcript-inline XML, provider URLs, or file:// sources here.
                    <SvgXml xml={preview.svgXml} width="100%" height="100%" />
                ) : (
                    <Image
                        testID={`${props.previewTestIDPrefix}:${props.media.path}`}
                        source={{ uri: preview.uri }}
                        resizeMode="contain"
                        onLoad={handleImageLoad}
                        style={styles.image}
                    />
                )
            ) : (
                <View style={styles.placeholder}>
                    <Ionicons
                        name={preview.status === 'error' ? 'alert-circle-outline' : 'image-outline'}
                        size={22}
                        color={theme.colors.text.secondary}
                    />
                </View>
            )}
        </Pressable>
    );
}

export const SessionMediaInlineImages = React.memo(function SessionMediaInlineImages(props: Readonly<{
    sessionId: string;
    media: readonly SessionMediaInlineImageSummary[];
    onOpenPath: (path: string) => void;
    containerTestID?: string;
    imageTestIDPrefix?: string;
    previewTestIDPrefix?: string;
}>) {
    const styles = stylesheet;
    const containerTestID = props.containerTestID ?? 'message-session-media-inline-images';
    const imageTestIDPrefix = props.imageTestIDPrefix ?? 'message-session-media-inline-image';
    const previewTestIDPrefix = props.previewTestIDPrefix ?? 'message-session-media-inline-image-preview';
    const { getMappingKey } = useSessionMediaMappingHelper();

    const images = React.useMemo(() => {
        const result: Array<Readonly<{
            media: SessionMediaInlineImageSummary;
            mimeType: string;
            modalImage: AttachmentImagePreviewModalImage;
        }>> = [];
        for (const media of props.media) {
            const mimeType = resolveSessionMediaImageMimeType(media);
            if (!mimeType) continue;
            result.push({
                media,
                mimeType,
                modalImage: {
                    kind: 'session-image',
                    title: media.name,
                    sessionId: props.sessionId,
                    filePath: media.path,
                    mimeType,
                    sizeBytes: media.sizeBytes,
                    cacheKey: media.sha256 ?? null,
                },
            });
        }
        return result;
    }, [props.media, props.sessionId]);

    if (images.length === 0) return null;

    return (
        <View testID={containerTestID} style={styles.container}>
            {images.map((entry, index) => (
                <SessionMediaInlineImageTile
                    key={getMappingKey(`${entry.media.path}:${entry.media.name}`, index)}
                    sessionId={props.sessionId}
                    media={entry.media}
                    mimeType={entry.mimeType}
                    imageIndex={index}
                    onOpenPath={props.onOpenPath}
                    imageTestIDPrefix={imageTestIDPrefix}
                    previewTestIDPrefix={previewTestIDPrefix}
                    onOpenPreview={(imageIndex) => {
                        Modal.show({
                            component: AttachmentImagePreviewModal,
                            props: {
                                images: images.map((imageEntry) => imageEntry.modalImage),
                                initialIndex: imageIndex,
                            },
                        });
                    }}
                />
            ))}
        </View>
    );
});
