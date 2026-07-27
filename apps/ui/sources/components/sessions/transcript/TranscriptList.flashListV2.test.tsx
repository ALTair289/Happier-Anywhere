import * as React from 'react';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCapturingLegendListMock, renderScreen, standardCleanup } from '@/dev/testkit';
import {
    installTranscriptCommonModuleMocks,
    resetTranscriptCommonModuleMockState,
} from './transcriptTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let capturedFlashListProps: any = null;
let capturedLegendListProps: any = null;
let renderedFlatListCount = 0;
let transcriptListImplementationSetting: 'flash_v2' | 'flatlist_legacy' = 'flash_v2';
let platformOs: 'web' | 'ios' = 'web';
let headerHeightState = 0;
let safeAreaTopState = 0;
let renderedMessageViewProps: any[] = [];
const canonicalLegendListMock = createCapturingLegendListMock();
const CapturingLegendList = React.forwardRef<any, any>((props, ref) => {
    capturedLegendListProps = props;
    return React.createElement(canonicalLegendListMock.module.LegendList, { ...props, ref });
});
const transcriptRendererAxis = vi.hoisted(() => ({
    transcriptLegendListSpikeSurface: 'flashList' as 'flashList' | 'off',
}));

vi.mock('@/sync/sync', () => ({
    sync: {
        getSyncTuning: () => transcriptRendererAxis,
    },
}));

vi.mock('@shopify/flash-list', () => ({
    FlashList: (props: any) => {
        capturedFlashListProps = props;
        const data = Array.isArray(props.data) ? props.data : [];
        const header =
            props.ListHeaderComponent
                ? (typeof props.ListHeaderComponent === 'function'
                    ? props.ListHeaderComponent()
                    : props.ListHeaderComponent)
                : null;
        const footer =
            props.ListFooterComponent
                ? (typeof props.ListFooterComponent === 'function'
                    ? props.ListFooterComponent()
                    : props.ListFooterComponent)
                : null;
        return React.createElement(
            'FlashList',
            props,
            header,
            data.map((item: any, index: number) => {
                const key =
                    typeof props.keyExtractor === 'function'
                        ? props.keyExtractor(item, index)
                        : (item?.id ?? String(index));
                const child = typeof props.renderItem === 'function' ? props.renderItem({ item, index }) : null;
                return React.createElement('FlashListItem', { key }, child);
            }),
            footer,
        );
    },
}));

installTranscriptCommonModuleMocks({
    legendList: () => ({ LegendList: CapturingLegendList }),
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: {
                get OS() {
                    return platformOs;
                },
                select: (values: any) => values?.[platformOs] ?? values?.default,
            },
            View: (props: any) => React.createElement('View', props, props.children),
            ActivityIndicator: () => React.createElement('ActivityIndicator'),
            FlatList: (_props: any) => {
                renderedFlatListCount++;
                return React.createElement('FlatList');
            },
        });
    },
    storage: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            useSetting: (key: string) =>
                key === 'transcriptListImplementation' ? transcriptListImplementationSetting : undefined,
        });
    },
});

vi.mock('@/utils/platform/responsive', () => ({
    useHeaderHeight: () => headerHeightState,
}));

vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: safeAreaTopState, bottom: 0, left: 0, right: 0 }),
}));

vi.mock('./MessageView', () => ({
    MessageView: () => React.createElement('MessageView'),
    MessageViewWithSessionCommon: (props: any) => {
        renderedMessageViewProps.push(props);
        return React.createElement('MessageView', props);
    },
}));

vi.mock('./ChatFooter', () => ({
    ChatFooter: () => React.createElement('ChatFooter'),
}));

describe('TranscriptList (FlashList v2)', () => {
    afterEach(standardCleanup);

    beforeEach(() => {
        resetTranscriptCommonModuleMockState();
        capturedFlashListProps = null;
        capturedLegendListProps = null;
        renderedFlatListCount = 0;
        transcriptListImplementationSetting = 'flash_v2';
        platformOs = 'web';
        headerHeightState = 0;
        safeAreaTopState = 0;
        renderedMessageViewProps = [];
        transcriptRendererAxis.transcriptLegendListSpikeSurface = 'flashList';
        vi.unstubAllGlobals();
        vi.stubGlobal('window', {
            localStorage: {
                getItem: (key: string) =>
                    key === 'HAPPIER_SYNC_TUNING_JSON'
                        ? JSON.stringify({ transcriptLegendListSpikeSurface: 'flashList' })
                        : null,
            },
        });
    });

    it('renders FlashList with startRenderingFromBottom enabled when selected', async () => {
        const { TranscriptList } = await import('./TranscriptList');
        await renderScreen(<TranscriptList
                    sessionId="s1"
                    datasetKey="public:s1:1"
                    metadata={null}
                    messages={[{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' } as any]}
                />);

        expect(renderedFlatListCount).toBe(0);
        expect(capturedFlashListProps).not.toBeNull();
        expect(capturedFlashListProps.maintainVisibleContentPosition?.startRenderingFromBottom).toBe(true);
        expect(renderedMessageViewProps[0]?.interaction).toEqual(expect.objectContaining({
            canApprovePermissions: false,
            canFork: false,
            canSendMessages: false,
            disableToolNavigation: true,
            permissionDisabledReason: 'public',
        }));
        expect(capturedLegendListProps).toBeNull();
    });

    it('routes public read-only transcripts to Legend only when the internal read-only flag is enabled', async () => {
        transcriptRendererAxis.transcriptLegendListSpikeSurface = 'off';

        const { TranscriptList } = await import('./TranscriptList');
        await renderScreen(<TranscriptList
                    sessionId="public-session"
                    datasetKey="public:public-session:1"
                    metadata={null}
                    messages={[
                        { kind: 'user-text', id: 'oldest', localId: null, createdAt: 1, text: 'first' } as any,
                        { kind: 'agent-text', id: 'newest', localId: null, createdAt: 2, text: 'second', isThinking: false } as any,
                    ]}
                />);

        expect(capturedFlashListProps).toBeNull();
        expect(capturedLegendListProps).toMatchObject({
            alignItemsAtEnd: true,
            dataKey: 'public:public-session:1',
            initialScrollAtEnd: true,
            maintainScrollAtEnd: { animated: false },
            maintainVisibleContentPosition: { data: true, size: true },
        });
        expect(capturedLegendListProps.data.map((item: any) => item.id)).toEqual(['oldest', 'newest']);
    });

    it('throttles web FlashList scroll events above one frame to reduce scroll-render churn', async () => {
        const { TranscriptList } = await import('./TranscriptList');
        await renderScreen(<TranscriptList
                    sessionId="s1"
                    datasetKey="public:s1:1"
                    metadata={null}
                    messages={[{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' } as any]}
                />);

        expect(capturedFlashListProps).not.toBeNull();
        expect(capturedFlashListProps.scrollEventThrottle).toBe(32);
    });

    it('keeps one-frame FlashList scroll events on iOS for native viewport maintenance', async () => {
        platformOs = 'ios';

        const { TranscriptList } = await import('./TranscriptList');
        await renderScreen(<TranscriptList
                    sessionId="s1"
                    datasetKey="public:s1:1"
                    metadata={null}
                    messages={[{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' } as any]}
                />);

        expect(capturedFlashListProps).not.toBeNull();
        expect(capturedFlashListProps.scrollEventThrottle).toBe(16);
    });

    it('renders native FlashList with inverted newest-first data', async () => {
        platformOs = 'ios';

        const { TranscriptList } = await import('./TranscriptList');
        await renderScreen(<TranscriptList
                    sessionId="s1"
                    datasetKey="public:s1:1"
                    metadata={null}
                    messages={[
                        { kind: 'user-text', id: 'oldest', localId: null, createdAt: 1, text: 'first' } as any,
                        { kind: 'agent-text', id: 'newest', localId: null, createdAt: 2, text: 'second', isThinking: false } as any,
                    ]}
                />);

        expect(capturedFlashListProps).not.toBeNull();
        expect(capturedFlashListProps.inverted).toBe(true);
        expect(capturedFlashListProps.data.map((item: any) => item.id)).toEqual(['newest', 'oldest']);
        expect(capturedFlashListProps.maintainVisibleContentPosition?.startRenderingFromBottom).toBe(true);
    });

    it('keeps drag scrolling from dismissing the keyboard on iOS', async () => {
        platformOs = 'ios';

        const { TranscriptList } = await import('./TranscriptList');
        await renderScreen(<TranscriptList
                    sessionId="s1"
                    datasetKey="public:s1:1"
                    metadata={null}
                    messages={[{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' } as any]}
                />);

        expect(capturedFlashListProps).not.toBeNull();
        expect(capturedFlashListProps.keyboardShouldPersistTaps).toBe('handled');
        expect(capturedFlashListProps.keyboardDismissMode).toBe('none');
    });

    it('does not reserve header chrome space inside the transcript list header', async () => {
        headerHeightState = 88;
        safeAreaTopState = 20;

        const { TranscriptList } = await import('./TranscriptList');
        const screen = await renderScreen(<TranscriptList
                    sessionId="s1"
                    datasetKey="public:s1:1"
                    metadata={null}
                    messages={[{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' } as any]}
                />);

        const duplicatedChromeSpacerHeight = headerHeightState + safeAreaTopState + 32;
        const duplicatedChromeSpacers = screen.findAll((node) => {
            const style = node.props?.style;
            if (Array.isArray(style)) {
                return style.some((entry) => entry?.height === duplicatedChromeSpacerHeight);
            }
            return style?.height === duplicatedChromeSpacerHeight;
        });
        expect(duplicatedChromeSpacers).toHaveLength(0);
    });

    it('keeps a compact top gutter before the first transcript row', async () => {
        const { TranscriptList } = await import('./TranscriptList');
        const screen = await renderScreen(<TranscriptList
                    sessionId="s1"
                    datasetKey="public:s1:1"
                    metadata={null}
                    messages={[{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' } as any]}
                />);

        const compactTopGutters = screen.findAll((node) => node.props?.style?.height === 12);
        expect(compactTopGutters.length).toBeGreaterThanOrEqual(1);
    });
});
