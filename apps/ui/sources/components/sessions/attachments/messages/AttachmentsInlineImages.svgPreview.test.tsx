import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { installReactNativeWebMock } from '@/dev/testkit/mocks/reactNative';
import { installUnistylesMock } from '@/dev/testkit/mocks/unistyles';
import { installSessionAttachmentCommonModuleMocks } from '../sessionAttachmentTestHelpers';

installSessionAttachmentCommonModuleMocks({
    reactNative: installReactNativeWebMock({
        Platform: {
            OS: 'ios',
            select: (values: { ios?: unknown; default?: unknown } | undefined) => values?.ios ?? values?.default ?? null,
        },
    }),
    unistyles: installUnistylesMock({
        theme: { colors: { textSecondary: '#bbb', divider: '#222', surfaceHighest: '#111' } },
    }),
});

vi.mock('react-native-svg', () => ({
    SvgXml: (props: Record<string, unknown>) => React.createElement('SvgXml', props),
    SvgAst: (props: Record<string, unknown>) => React.createElement('SvgAst', props),
    parse: (_xml: string, middleware?: (root: {
        tag: string;
        props: Record<string, unknown>;
        children: [];
        parent: null;
        Tag: () => null;
    }) => unknown) => {
        const root = { tag: 'svg', props: {}, children: [] as [], parent: null, Tag: () => null };
        middleware?.(root);
        return root;
    },
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('@/components/sessions/attachments/preview/AttachmentImagePreviewModal', () => ({
    AttachmentImagePreviewModal: () => null,
}));

vi.mock('@/components/sessions/files/content/imagePreview/useSessionImagePreview', () => ({
    useSessionImagePreview: () => ({
        status: 'loaded',
        uri: 'data:image/svg+xml;base64,PHN2Zy8+',
        svgXml: '<svg/>',
        error: null,
    }),
}));

describe('AttachmentsInlineImages (svg previews)', () => {
    it('renders a validated SvgAst preview for svg attachments on native', async () => {
        const { AttachmentsInlineImages } = await import('./AttachmentsInlineImages');

        const screen = await renderScreen(
            <AttachmentsInlineImages
                sessionId="s1"
                attachments={[
                    {
                        name: 'icon.svg',
                        path: 'icon.svg',
                        mimeType: 'image/svg+xml',
                        sizeBytes: 12,
                        sha256: 'hash',
                    },
                ]}
                onOpenPath={() => {}}
                fileOpenEnabled
                mediaPreviewEnabled
            />,
        );

        expect(screen.tree.findAllByType('SvgAst').length).toBe(1);
        expect(screen.tree.findAllByType('SvgXml').length).toBe(0);
    });
});
