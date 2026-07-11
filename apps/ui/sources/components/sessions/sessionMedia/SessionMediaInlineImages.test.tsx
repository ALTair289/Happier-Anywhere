import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { invokeTestInstanceHandler, renderScreen } from '@/dev/testkit';
import { installReactNativeWebMock } from '@/dev/testkit/mocks/reactNative';
import { installUnistylesMock } from '@/dev/testkit/mocks/unistyles';
import { createTextModuleMock } from '@/dev/testkit/mocks/text';

import { installSessionAttachmentCommonModuleMocks } from '../attachments/sessionAttachmentTestHelpers';

const flashListCompatMockState = vi.hoisted(() => ({
    mappingKeyCalls: [] as Array<Readonly<{ index: number; itemKey: string | number | bigint }>>,
}));

installSessionAttachmentCommonModuleMocks({
    reactNative: installReactNativeWebMock(),
    unistyles: installUnistylesMock({
        theme: { colors: { textSecondary: '#bbb', divider: '#222', surfaceHighest: '#111' } },
    }),
    text: () => createTextModuleMock({
        translate: (key, params) => `${key}:${String(params?.name ?? '')}`,
    }),
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('@/components/sessions/attachments/preview/AttachmentImagePreviewModal', () => ({
    AttachmentImagePreviewModal: () => null,
}));

vi.mock('@/components/sessions/files/content/imagePreview/useSessionImagePreview', () => ({
    useSessionImagePreview: () => ({
        status: 'loaded',
        uri: 'blob:preview',
        svgXml: null,
        error: null,
    }),
}));

vi.mock('@/components/ui/lists/flashListCompat/FlashListCompat', () => ({
    useMappingHelper: () => ({
        getMappingKey: (itemKey: string | number | bigint, index: number) => {
            flashListCompatMockState.mappingKeyCalls.push({ itemKey, index });
            return index;
        },
    }),
}));

function flattenStyle(style: unknown): Record<string, unknown> {
    if (Array.isArray(style)) {
        return Object.assign({}, ...style.map((entry) => flattenStyle(entry)));
    }
    if (style && typeof style === 'object') return style as Record<string, unknown>;
    return {};
}

describe('SessionMediaInlineImages', () => {
    beforeEach(() => {
        flashListCompatMockState.mappingKeyCalls = [];
    });

    it('routes inline image keys through the FlashList mapping helper', async () => {
        const { SessionMediaInlineImages } = await import('./SessionMediaInlineImages');

        const media = [
            {
                id: 'media-1',
                name: 'first.png',
                path: '.happier/uploads/generated/message-1/first.png',
                mimeType: 'image/png',
                sizeBytes: 10,
                category: 'generated' as const,
                role: 'output' as const,
            },
            {
                id: 'media-2',
                name: 'second.png',
                path: '.happier/uploads/generated/message-1/second.png',
                mimeType: 'image/png',
                sizeBytes: 10,
                category: 'generated' as const,
                role: 'output' as const,
            },
        ];

        await renderScreen(
            <SessionMediaInlineImages
                sessionId="s1"
                media={media}
                onOpenPath={() => {}}
            />,
        );

        expect(flashListCompatMockState.mappingKeyCalls).toEqual([
            { itemKey: `${media[0].path}:${media[0].name}`, index: 0 },
            { itemKey: `${media[1].path}:${media[1].name}`, index: 1 },
        ]);
    });

    it('adds translated accessibility labels to generated image tiles', async () => {
        const { SessionMediaInlineImages } = await import('./SessionMediaInlineImages');

        const media = {
            id: 'media-1',
            name: 'cat.png',
            path: '.happier/uploads/generated/message-1/cat.png',
            mimeType: 'image/png',
            sizeBytes: 10,
            category: 'generated' as const,
            role: 'output' as const,
        };

        const screen = await renderScreen(
            <SessionMediaInlineImages
                sessionId="s1"
                media={[media]}
                onOpenPath={() => {}}
            />,
        );

        const tile = screen.findByTestId(`message-session-media-inline-image:${media.path}`);

        expect(tile).not.toBeNull();
        expect(tile?.props.accessibilityLabel).toBe('files.sessionMedia.generatedImageA11y:cat.png');
    });

    it('uses the generated description in the existing accessible image label', async () => {
        const { SessionMediaInlineImages } = await import('./SessionMediaInlineImages');
        const media = {
            id: 'media-description',
            name: 'diagram.png',
            description: 'Architecture diagram',
            path: '.happier/uploads/generated/message-1/diagram.png',
            mimeType: 'image/png',
            sizeBytes: 10,
            category: 'generated' as const,
            role: 'output' as const,
        };

        const screen = await renderScreen(
            <SessionMediaInlineImages sessionId="s1" media={[media]} onOpenPath={() => {}} />,
        );

        expect(screen.findByTestId(`message-session-media-inline-image:${media.path}`)?.props.accessibilityLabel)
            .toBe('files.sessionMedia.generatedImageA11y:Architecture diagram');
    });

    it('bounds generated descriptions used by assistive technology', async () => {
        const { SessionMediaInlineImages } = await import('./SessionMediaInlineImages');
        const media = {
            id: 'media-long-description',
            name: 'diagram.png',
            description: 'a'.repeat(2_000),
            path: '.happier/uploads/generated/message-1/long.png',
            mimeType: 'image/png',
            sizeBytes: 10,
            category: 'generated' as const,
            role: 'output' as const,
        };
        const screen = await renderScreen(
            <SessionMediaInlineImages sessionId="s1" media={[media]} onOpenPath={() => {}} />,
        );
        const label = screen.findByTestId(`message-session-media-inline-image:${media.path}`)?.props.accessibilityLabel;

        expect(label).toBe(`files.sessionMedia.generatedImageA11y:${'a'.repeat(512)}`);
    });

    it('uses attachment-specific accessibility labels for attachment image tiles', async () => {
        const { SessionMediaInlineImages } = await import('./SessionMediaInlineImages');

        const media = {
            id: 'media-2',
            name: 'upload.png',
            path: '.happier/uploads/messages/message-1/upload.png',
            mimeType: 'image/png',
            sizeBytes: 10,
            category: 'attachment' as const,
            role: 'input' as const,
        };

        const screen = await renderScreen(
            <SessionMediaInlineImages
                sessionId="s1"
                media={[media]}
                onOpenPath={() => {}}
            />,
        );

        const tile = screen.findByTestId(`message-session-media-inline-image:${media.path}`);

        expect(tile).not.toBeNull();
        expect(tile?.props.accessibilityLabel).toBe('files.sessionMedia.attachmentImageA11y:upload.png');
    });

    it('preserves transcript image aspect ratios when dimensions are available', async () => {
        const { SessionMediaInlineImages } = await import('./SessionMediaInlineImages');

        const media = {
            id: 'media-3',
            name: 'wide.png',
            path: '.happier/uploads/generated/message-1/wide.png',
            mimeType: 'image/png',
            sizeBytes: 10,
            width: 1600,
            height: 900,
            category: 'generated' as const,
            role: 'output' as const,
        };

        const screen = await renderScreen(
            <SessionMediaInlineImages
                sessionId="s1"
                media={[media]}
                onOpenPath={() => {}}
            />,
        );

        const tile = screen.findByTestId(`message-session-media-inline-image:${media.path}`);
        const preview = screen.findByTestId(`message-session-media-inline-image-preview:${media.path}`);

        expect(flattenStyle(tile?.props.style)).toMatchObject({
            width: 220,
            height: 124,
        });
        expect(preview?.props.resizeMode).toBe('contain');
    });

    it('preserves transcript image aspect ratios after loaded previews report dimensions', async () => {
        const { SessionMediaInlineImages } = await import('./SessionMediaInlineImages');

        const media = {
            id: 'media-4',
            name: 'tall.png',
            path: '.happier/uploads/messages/message-1/tall.png',
            mimeType: 'image/png',
            sizeBytes: 10,
            category: 'attachment' as const,
            role: 'input' as const,
        };

        const screen = await renderScreen(
            <SessionMediaInlineImages
                sessionId="s1"
                media={[media]}
                onOpenPath={() => {}}
            />,
        );

        const tileTestID = `message-session-media-inline-image:${media.path}`;
        const previewTestID = `message-session-media-inline-image-preview:${media.path}`;

        expect(flattenStyle(screen.findByTestId(tileTestID)?.props.style)).toMatchObject({
            width: 84,
            height: 84,
        });

        await act(async () => {
            invokeTestInstanceHandler(screen.findByTestId(previewTestID), 'onLoad', {
                nativeEvent: {
                    source: { width: 900, height: 1600 },
                },
            });
        });

        expect(flattenStyle(screen.findByTestId(tileTestID)?.props.style)).toMatchObject({
            width: 90,
            height: 160,
        });
    });
});
