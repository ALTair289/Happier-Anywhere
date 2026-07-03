import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

import {
    resolveMainTranscriptListShellFrame,
    resolveReadOnlyTranscriptListShellFrame,
    resolveSidechainTranscriptListShellFrame,
} from './transcriptListShellCapabilities';

const CHAT_LIST = readFileSync(new URL('../../ChatList.tsx', import.meta.url), 'utf8');
const TRANSCRIPT_LIST = readFileSync(new URL('../../TranscriptList.tsx', import.meta.url), 'utf8');
const CHAIN_TRANSCRIPT_LIST = readFileSync(new URL('../../ChainTranscriptList.tsx', import.meta.url), 'utf8');
const LIST_ORIENTATION = readFileSync(new URL('../../listOrientation.ts', import.meta.url), 'utf8');
const VIEWPORT_TYPES = readFileSync(new URL('../transcriptViewportTypes.ts', import.meta.url), 'utf8');
const VIEWPORT_TELEMETRY = readFileSync(new URL('../../scroll/transcriptViewportTelemetry.ts', import.meta.url), 'utf8');
const VIEWPORT_DRIVER_TYPES = readFileSync(new URL('../driver/types.ts', import.meta.url), 'utf8');
const TRANSCRIPT_VIEWPORT_FACTS = readFileSync(new URL('../driver/transcriptViewportFacts.ts', import.meta.url), 'utf8');
const NATIVE_INVERTED_FLASH_LIST = readFileSync(new URL('../driver/nativeInvertedFlashList.ts', import.meta.url), 'utf8');
const NATIVE_INVERTED_FLASH_LIST_FACTS = readFileSync(new URL('../driver/nativeInvertedFlashListFacts.ts', import.meta.url), 'utf8');
const NATIVE_INVERTED_FLASH_LIST_FACTS_TEST = readFileSync(new URL('../driver/nativeInvertedFlashListFacts.test.ts', import.meta.url), 'utf8');
const NATIVE_VIEWPORT_ANCHOR = readFileSync(new URL('../driver/transcriptNativeViewportAnchor.ts', import.meta.url), 'utf8');
const RENDER_WINDOW_PROJECTION = readFileSync(new URL('../window/resolveTranscriptRenderWindowProjection.ts', import.meta.url), 'utf8');
const SIDECHAIN_OLDER_LOAD_OBSERVATION = readFileSync(new URL('./sidechainOlderLoadObservation.ts', import.meta.url), 'utf8');
const FLASH_LIST_RUNTIME_MODEL = readFileSync(new URL('../../../../../dev/testkit/transcript/runtimeContract/flashListRuntimeModel.ts', import.meta.url), 'utf8');
const VIEWPORT_COMMAND_PERFORMER = readFileSync(new URL('../performTranscriptViewportCommand.ts', import.meta.url), 'utf8');
const COMMAND_HOST_URL = new URL('../driver/commandHost.ts', import.meta.url);
const COMMAND_HOST = existsSync(COMMAND_HOST_URL) ? readFileSync(COMMAND_HOST_URL, 'utf8') : '';
const NATIVE_PASSIVE_SCROLL_POLICY = readFileSync(new URL('../nativePassiveScrollPolicy.ts', import.meta.url), 'utf8');
const BOTTOM_MAINTENANCE = readFileSync(new URL('../../scroll/transcriptFlashListBottomMaintenance.ts', import.meta.url), 'utf8');
const NATIVE_SCROLL_FOLLOW_INTENT = readFileSync(new URL('../lifecycle/nativeScrollFollowIntent.ts', import.meta.url), 'utf8');
const NATIVE_SCROLL_FOLLOW_INTENT_TEST = readFileSync(new URL('../lifecycle/nativeScrollFollowIntent.test.ts', import.meta.url), 'utf8');
const NATIVE_SCROLL_FOLLOW_INTENT_RELEASE = readFileSync(new URL('../lifecycle/nativeScrollFollowIntentRelease.ts', import.meta.url), 'utf8');
const NATIVE_SCROLL_FOLLOW_INTENT_RELEASE_TEST = readFileSync(new URL('../lifecycle/nativeScrollFollowIntentRelease.test.ts', import.meta.url), 'utf8');
const LIFECYCLE_HOST = readFileSync(new URL('../lifecycle/lifecycleHost.ts', import.meta.url), 'utf8');
const LIFECYCLE_SCROLL_OBSERVATION_APPLIER = readFileSync(
    new URL('../lifecycle/lifecycleHostScrollObservationApplier.ts', import.meta.url),
    'utf8',
);
const SCROLL_INGRESS_OBSERVATION = readFileSync(
    new URL('../lifecycle/scrollIngressObservation.ts', import.meta.url),
    'utf8',
);
const SCROLL_INGRESS_DRIVER = readFileSync(new URL('../driver/scrollIngress.ts', import.meta.url), 'utf8');
const LAYOUT_CONTENT_SIZE_OBSERVATION_APPLIER_URL = new URL(
    '../lifecycle/layoutContentSizeObservationApplier.ts',
    import.meta.url,
);
const LAYOUT_CONTENT_SIZE_OBSERVATION_APPLIER = existsSync(LAYOUT_CONTENT_SIZE_OBSERVATION_APPLIER_URL)
    ? readFileSync(LAYOUT_CONTENT_SIZE_OBSERVATION_APPLIER_URL, 'utf8')
    : '';
const TRANSCRIPT_MEASUREMENT_HOST_URL = new URL('../../measurement/transcriptMeasurementHost.ts', import.meta.url);
const TRANSCRIPT_MEASUREMENT_HOST = existsSync(TRANSCRIPT_MEASUREMENT_HOST_URL)
    ? readFileSync(TRANSCRIPT_MEASUREMENT_HOST_URL, 'utf8')
    : '';
const MAIN_TRANSCRIPT_RENDERER_FRAME_HOST_URL = new URL('./mainTranscriptRendererFrameHost.ts', import.meta.url);
const MAIN_TRANSCRIPT_RENDERER_FRAME_HOST = existsSync(MAIN_TRANSCRIPT_RENDERER_FRAME_HOST_URL)
    ? readFileSync(MAIN_TRANSCRIPT_RENDERER_FRAME_HOST_URL, 'utf8')
    : '';
const TRANSCRIPT_DIR_URL = new URL('../../', import.meta.url);
const SHELL_DIR_URL = new URL('./', import.meta.url);
const SHELL_DIR_PATH = fileURLToPath(SHELL_DIR_URL);
const TRANSCRIPT_LIST_SHELL_URL = new URL('./TranscriptListShell.tsx', import.meta.url);
const FLASH_LIST_RENDERER_URL = new URL('./renderer/flashListRenderer.tsx', import.meta.url);
const RESOLVE_TRANSCRIPT_LIST_RENDERER_URL = new URL('./renderer/resolveTranscriptListRenderer.ts', import.meta.url);
const TRANSCRIPT_RENDERER_SURFACE_URL = new URL('./renderer/transcriptRendererSurface.ts', import.meta.url);
const TRANSCRIPT_LIST_SHELL = readFileSync(TRANSCRIPT_LIST_SHELL_URL, 'utf8');
const FLASH_LIST_RENDERER = existsSync(FLASH_LIST_RENDERER_URL)
    ? readFileSync(FLASH_LIST_RENDERER_URL, 'utf8')
    : '';
const RESOLVE_TRANSCRIPT_LIST_RENDERER = existsSync(RESOLVE_TRANSCRIPT_LIST_RENDERER_URL)
    ? readFileSync(RESOLVE_TRANSCRIPT_LIST_RENDERER_URL, 'utf8')
    : '';
const TRANSCRIPT_RENDERER_SURFACE = existsSync(TRANSCRIPT_RENDERER_SURFACE_URL)
    ? readFileSync(TRANSCRIPT_RENDERER_SURFACE_URL, 'utf8')
    : '';
const SIDECHAIN_INITIAL_BOTTOM_PIN = readFileSync(new URL('./sidechainInitialBottomPin.ts', import.meta.url), 'utf8');
const SIDECHAIN_JUMP_TO_MESSAGE = readFileSync(new URL('./sidechainJumpToMessage.ts', import.meta.url), 'utf8');
const DELETED_LEGACY_FALLBACK_CAPABILITY = ['uses', 'LegacyFallback'].join('');
const LEGEND_LIST_PACKAGE_NAME = ['@legendapp', 'list'].join('/');
const FLASH_LIST_COMPAT_IMPORT_PATH = '@/components/ui/lists/flashListCompat/FlashListCompat';

let capturedFlashListProps: any = null;
let assignedRef: any = null;

function readExportedTypeBody(source: string, typeName: string): string {
    const match = source.match(new RegExp(`export type ${typeName} = ([\\s\\S]*?);`));
    expect(match?.[1]).toBeTruthy();
    return match?.[1] ?? '';
}

function readHookBody(source: string, hookName: string, hookKind: 'useCallback' | 'useMemo'): string {
    const match = source.match(new RegExp(`const ${hookName} = React\\.${hookKind}\\(\\([^)]*\\) => \\{([\\s\\S]*?)\\n    \\}, \\[`));
    expect(match?.[1]).toBeTruthy();
    return match?.[1] ?? '';
}

function readProductionSources(rootUrl: URL): Array<Readonly<{ relativePath: string; source: string }>> {
    const rootPath = fileURLToPath(rootUrl);
    if (!existsSync(rootPath)) return [];

    const results: Array<Readonly<{ relativePath: string; source: string }>> = [];
    const visit = (dirPath: string): void => {
        for (const name of readdirSync(dirPath)) {
            const childPath = `${dirPath}/${name}`;
            const stat = statSync(childPath);
            if (stat.isDirectory()) {
                visit(childPath);
                continue;
            }
            if (!/\.(?:ts|tsx)$/.test(name) || /\.test\./.test(name)) continue;
            results.push({
                relativePath: relative(rootPath, childPath).replaceAll('\\', '/'),
                source: readFileSync(childPath, 'utf8'),
            });
        }
    };

    visit(rootPath);
    return results;
}

vi.mock('@shopify/flash-list', () => ({
    FlashList: React.forwardRef((props: any, ref: any) => {
        capturedFlashListProps = props;
        const instance = {
            scrollToIndex: vi.fn(),
            scrollToOffset: vi.fn(),
            scrollToEnd: vi.fn(),
        };
        if (typeof ref === 'function') ref(instance);
        else if (ref && typeof ref === 'object') ref.current = instance;
        assignedRef = instance;
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
            data.map((item: any, index: number) =>
                React.createElement(
                    'FlashListItem',
                    { key: props.keyExtractor?.(item, index) ?? item.id ?? index },
                    props.renderItem?.({ item, index }),
                ),
            ),
            footer,
        );
    }),
}));

describe('transcript list shell frame', () => {
    it('does not expose the deleted legacy fallback capability bit', () => {
        const frames = [
            resolveMainTranscriptListShellFrame({ platformOS: 'web' }),
            resolveMainTranscriptListShellFrame({ platformOS: 'ios' }),
            resolveReadOnlyTranscriptListShellFrame({
                accessKind: 'public',
                bottomNoticeVisible: true,
                platformOS: 'web',
            }),
            resolveSidechainTranscriptListShellFrame({ platformOS: 'web' }),
        ];

        for (const frame of frames) {
            expect(frame.capability).not.toHaveProperty(DELETED_LEGACY_FALLBACK_CAPABILITY);
        }
        expect(CHAT_LIST).not.toContain(DELETED_LEGACY_FALLBACK_CAPABILITY);
        expect(TRANSCRIPT_LIST).not.toContain(DELETED_LEGACY_FALLBACK_CAPABILITY);
        expect(readFileSync(new URL('./transcriptListShellCapabilities.ts', import.meta.url), 'utf8'))
            .not
            .toContain(DELETED_LEGACY_FALLBACK_CAPABILITY);
    });

    it('keeps sidechain shell helpers out of raw list command execution', () => {
        for (const source of [SIDECHAIN_INITIAL_BOTTOM_PIN, SIDECHAIN_JUMP_TO_MESSAGE]) {
            expect(source).not.toMatch(/\.scrollTo(?:Index|Offset)\s*\(/);
            expect(source).not.toMatch(/scrollTo(?:Index|Offset)\?:/);
        }
    });

    it('resolves main web as the standard streaming-follow shell frame', () => {
        expect(resolveMainTranscriptListShellFrame({
            nativeID: 'transcript-dom-id',
            platformOS: 'web',
        })).toMatchObject({
            dataOrder: 'oldest-first',
            renderer: 'flashList',
            rendererOptions: {
                flashList: {
                    inverted: false,
                    keyboardDismissMode: 'none',
                    keyboardShouldPersistTaps: 'handled',
                    nativeID: 'transcript-dom-id',
                    scrollEventThrottle: 32,
                    testID: 'transcript-chat-list',
                },
            },
            capability: {
                catchUpIndicator: true,
                entryRestore: true,
                kind: 'main',
                jumpToSeq: true,
                olderPagination: true,
                selection: true,
                streamingFollow: { kind: 'main' },
            },
        });
    });

    it('resolves main native as the canonical inverted streaming-follow shell frame', () => {
        const maintainVisibleContentPosition = { startRenderingFromBottom: true } as const;

        const frame = resolveMainTranscriptListShellFrame({
            listLayoutHeight: 800,
            maintainVisibleContentPosition,
            nativeID: 'transcript-native-id',
            platformOS: 'ios',
        });

        expect(frame).toMatchObject({
            dataOrder: 'newest-first',
            renderer: 'flashList',
            rendererOptions: {
                flashList: {
                    drawDistance: 800,
                    inverted: true,
                    keyboardDismissMode: 'none',
                    keyboardShouldPersistTaps: 'handled',
                    nativeID: 'transcript-native-id',
                    scrollEventThrottle: 16,
                    testID: 'transcript-chat-list',
                },
            },
            capability: {
                catchUpIndicator: true,
                entryRestore: true,
                kind: 'main',
                jumpToSeq: true,
                olderPagination: true,
                selection: true,
                streamingFollow: { kind: 'main' },
            },
        });
        expect(frame.capability).not.toHaveProperty('boundedHydration');
        expect(frame.rendererOptions.flashList.maintainVisibleContentPosition).toBe(maintainVisibleContentPosition);
    });

    it('resolves main native drawDistance from explicit tuning or a clamped viewport default', () => {
        expect(resolveMainTranscriptListShellFrame({
            listLayoutHeight: 0,
            platformOS: 'ios',
        }).rendererOptions.flashList.drawDistance).toBe(600);
        expect(resolveMainTranscriptListShellFrame({
            listLayoutHeight: 2000,
            platformOS: 'ios',
        }).rendererOptions.flashList.drawDistance).toBe(1200);
        expect(resolveMainTranscriptListShellFrame({
            configuredDrawDistance: 1600,
            listLayoutHeight: 800,
            platformOS: 'ios',
        }).rendererOptions.flashList.drawDistance).toBe(1600);
        expect(resolveMainTranscriptListShellFrame({
            configuredDrawDistance: 1600,
            listLayoutHeight: 800,
            platformOS: 'web',
        }).rendererOptions.flashList.drawDistance).toBeUndefined();
    });

    it('keeps read-only and sidechain frames free of main identity props', () => {
        const readOnly = resolveReadOnlyTranscriptListShellFrame({
            accessKind: 'public',
            bottomNoticeVisible: true,
            platformOS: 'web',
        });
        const sidechain = resolveSidechainTranscriptListShellFrame({ platformOS: 'web' });

        expect(readOnly).toMatchObject({
            dataOrder: 'oldest-first',
            renderer: 'flashList',
            rendererOptions: {
                flashList: {
                    inverted: false,
                    keyboardDismissMode: 'none',
                    keyboardShouldPersistTaps: 'handled',
                },
            },
            capability: {
                accessKind: 'public',
                boundedHydration: { kind: 'readOnly' },
                kind: 'readOnly',
            },
        });
        expect(readOnly.rendererOptions.flashList.testID).toBeUndefined();
        expect(readOnly.rendererOptions.flashList.nativeID).toBeUndefined();

        expect(sidechain).toMatchObject({
            dataOrder: 'oldest-first',
            renderer: 'flashList',
            rendererOptions: {
                flashList: {
                    inverted: false,
                    keyboardDismissMode: 'none',
                    keyboardShouldPersistTaps: 'handled',
                    scrollEventThrottle: 32,
                },
            },
            capability: {
                boundedHydration: { kind: 'sidechain' },
                kind: 'sidechain',
            },
        });
        expect(sidechain.rendererOptions.flashList.testID).toBeUndefined();
        expect(sidechain.rendererOptions.flashList.nativeID).toBeUndefined();
    });

    it('keeps all lane-0 renderer surfaces resolving to FlashList for every spike flag value', async () => {
        const { resolveTranscriptListRenderer } = await import('./renderer/resolveTranscriptListRenderer');
        const { resolveTranscriptRendererSurface } = await import('./renderer/transcriptRendererSurface');
        const frames = [
            {
                frame: resolveMainTranscriptListShellFrame({ platformOS: 'ios' }),
                surface: 'main',
            },
            {
                frame: resolveReadOnlyTranscriptListShellFrame({
                    accessKind: 'public',
                    bottomNoticeVisible: false,
                    platformOS: 'web',
                }),
                surface: 'readOnly',
            },
            {
                frame: resolveSidechainTranscriptListShellFrame({ platformOS: 'web' }),
                surface: 'sidechain',
            },
        ] as const;

        for (const { frame, surface } of frames) {
            expect(resolveTranscriptRendererSurface(frame)).toBe(surface);
            for (const transcriptLegendListSpikeSurface of ['off', 'readOnly', 'sidechain', 'main'] as const) {
                expect(resolveTranscriptListRenderer({
                    frame,
                    transcriptLegendListSpikeSurface,
                }).kind).toBe('flashList');
            }
        }
    });

    it('does not add Legend imports anywhere under transcript production sources', () => {
        for (const { relativePath, source } of readProductionSources(TRANSCRIPT_DIR_URL)) {
            expect(source, relativePath).not.toContain(LEGEND_LIST_PACKAGE_NAME);
            expect(source, relativePath).not.toMatch(/\bLegendList\b/);
        }
    });
});

describe('TranscriptListShell', () => {
    beforeEach(() => {
        capturedFlashListProps = null;
        assignedRef = null;
    });

    it('renders the caller-owned FlashList frame without taking viewport decisions', async () => {
        const { TranscriptListShell } = await import('./TranscriptListShell');
        const listRef = { current: null as any };
        const getItemType = vi.fn((item: { type: string }) => item.type);
        const keyExtractor = vi.fn((item: { id: string }) => item.id);
        const renderItem = vi.fn(({ item }: { item: { id: string } }) =>
            React.createElement('Row', { id: item.id }),
        );
        const onLayout = vi.fn();
        const onContentSizeChange = vi.fn();
        const onScroll = vi.fn();
        const onStartReached = vi.fn();
        const onEndReached = vi.fn();

        const screen = await renderScreen(
            <TranscriptListShell
                ref={listRef}
                data={[{ id: 'row-1', type: 'message' }]}
                extraData={3}
                keyExtractor={keyExtractor}
                getItemType={getItemType}
                renderItem={renderItem}
                frame={resolveSidechainTranscriptListShellFrame({ platformOS: 'web' })}
                onLayout={onLayout}
                onContentSizeChange={onContentSizeChange}
                onScroll={onScroll}
                onStartReachedThreshold={0.5}
                onStartReached={onStartReached}
                onEndReachedThreshold={0.75}
                onEndReached={onEndReached}
                header={React.createElement('HeaderSlot')}
                footer={React.createElement('FooterSlot')}
                olderLoadOverlay={React.createElement('OlderOverlay')}
                catchUpOverlay={React.createElement('CatchUpOverlay')}
            />,
        );

        expect(listRef.current).toBe(assignedRef);
        expect(capturedFlashListProps).toMatchObject({
            data: [{ id: 'row-1', type: 'message' }],
            extraData: 3,
            scrollEventThrottle: 32,
            keyboardShouldPersistTaps: 'handled',
            keyboardDismissMode: 'none',
            onLayout,
            onContentSizeChange,
            onScroll,
            onStartReachedThreshold: 0.5,
            onStartReached,
            onEndReachedThreshold: 0.75,
            onEndReached,
        });
        expect(capturedFlashListProps.testID).toBeUndefined();
        expect(capturedFlashListProps.nativeID).toBeUndefined();
        expect(capturedFlashListProps.inverted).toBeUndefined();
        expect(capturedFlashListProps.keyExtractor).toBe(keyExtractor);
        expect(capturedFlashListProps.getItemType).toBe(getItemType);
        expect(capturedFlashListProps.renderItem).toBe(renderItem);
        expect(capturedFlashListProps.estimatedItemSize).toBeUndefined();
        expect(capturedFlashListProps.overrideProps).toBeUndefined();
        expect(screen.findByType('HeaderSlot' as any)).toBeTruthy();
        expect(screen.findByType('FooterSlot' as any)).toBeTruthy();
        expect(screen.findByType('OlderOverlay' as any)).toBeTruthy();
        expect(screen.findByType('CatchUpOverlay' as any)).toBeTruthy();
    });

    it('forwards main frame identity and inversion to FlashList', async () => {
        const { TranscriptListShell } = await import('./TranscriptListShell');

        await renderScreen(
            <TranscriptListShell
                data={[{ id: 'newest' }, { id: 'oldest' }]}
                keyExtractor={(item: { id: string }) => item.id}
                renderItem={({ item }: { item: { id: string } }) => React.createElement('Row', { id: item.id })}
                frame={resolveMainTranscriptListShellFrame({
                    nativeID: 'transcript-native-id',
                    platformOS: 'ios',
                })}
            />,
        );

        expect(capturedFlashListProps).toMatchObject({
            data: [{ id: 'newest' }, { id: 'oldest' }],
            drawDistance: 600,
            inverted: true,
            nativeID: 'transcript-native-id',
            scrollEventThrottle: 16,
            testID: 'transcript-chat-list',
        });
    });

    it('passes optional main FlashList callbacks and platform interactions through without taking ownership', async () => {
        const { TranscriptListShell } = await import('./TranscriptListShell');
        const overrideProps = { scrollViewProps: { testOnly: true } };
        const platformInteractionProps = {
            onMouseDown: vi.fn(),
            onMomentumScrollBegin: vi.fn(),
            onPointerDown: vi.fn(),
            onTouchStart: vi.fn(),
            onWheel: vi.fn(),
        };
        const onLoad = vi.fn();
        const onViewableItemsChanged = vi.fn();
        const viewabilityConfig = { itemVisiblePercentThreshold: 1 };
        const onScrollBeginDrag = vi.fn();
        const onScrollEndDrag = vi.fn();
        const onMomentumScrollBegin = vi.fn();
        const onMomentumScrollEnd = vi.fn();
        const onScrollToIndexFailed = vi.fn();

        await renderScreen(
            <TranscriptListShell
                data={[{ id: 'row-1' }]}
                keyExtractor={(item: { id: string }) => item.id}
                renderItem={({ item }: { item: { id: string } }) => React.createElement('Row', { id: item.id })}
                frame={resolveMainTranscriptListShellFrame({ platformOS: 'ios' })}
                overrideProps={overrideProps}
                platformInteractionProps={platformInteractionProps}
                onLoad={onLoad}
                onViewableItemsChanged={onViewableItemsChanged}
                viewabilityConfig={viewabilityConfig}
                onScrollBeginDrag={onScrollBeginDrag}
                onScrollEndDrag={onScrollEndDrag}
                onMomentumScrollBegin={onMomentumScrollBegin}
                onMomentumScrollEnd={onMomentumScrollEnd}
                onScrollToIndexFailed={onScrollToIndexFailed}
            />,
        );

        expect(capturedFlashListProps.overrideProps).toBe(overrideProps);
        expect(capturedFlashListProps.onLoad).toBe(onLoad);
        expect(capturedFlashListProps.onViewableItemsChanged).toBe(onViewableItemsChanged);
        expect(capturedFlashListProps.viewabilityConfig).toBe(viewabilityConfig);
        expect(capturedFlashListProps.onScrollBeginDrag).toBe(onScrollBeginDrag);
        expect(capturedFlashListProps.onScrollEndDrag).toBe(onScrollEndDrag);
        expect(capturedFlashListProps.onMomentumScrollBegin).toBe(onMomentumScrollBegin);
        expect(capturedFlashListProps.onMomentumScrollEnd).toBe(onMomentumScrollEnd);
        expect(capturedFlashListProps.onScrollToIndexFailed).toBe(onScrollToIndexFailed);
        expect(capturedFlashListProps.onMouseDown).toBe(platformInteractionProps.onMouseDown);
        expect(capturedFlashListProps.onPointerDown).toBe(platformInteractionProps.onPointerDown);
        expect(capturedFlashListProps.onTouchStart).toBe(platformInteractionProps.onTouchStart);
        expect(capturedFlashListProps.onWheel).toBe(platformInteractionProps.onWheel);
    });

    it('keeps the layout commit callback host-owned while the shell owns the renderer wrapper', async () => {
        const { TranscriptListShell } = await import('./TranscriptListShell');
        const onCommitLayoutEffect = vi.fn();

        await renderScreen(
            <TranscriptListShell
                data={[{ id: 'row-1' }]}
                keyExtractor={(item: { id: string }) => item.id}
                renderItem={({ item }: { item: { id: string } }) => React.createElement('Row', { id: item.id })}
                frame={resolveMainTranscriptListShellFrame({ platformOS: 'ios' })}
                onCommitLayoutEffect={onCommitLayoutEffect}
            />,
        );

        expect(onCommitLayoutEffect).toHaveBeenCalled();
    });

    it('renders through the shell renderer adapter instead of owning FlashList inline', () => {
        expect(existsSync(FLASH_LIST_RENDERER_URL)).toBe(true);
        expect(existsSync(RESOLVE_TRANSCRIPT_LIST_RENDERER_URL)).toBe(true);
        expect(existsSync(TRANSCRIPT_RENDERER_SURFACE_URL)).toBe(true);
        expect(TRANSCRIPT_LIST_SHELL).toContain('resolveTranscriptListRenderer');
        expect(TRANSCRIPT_LIST_SHELL).not.toContain(FLASH_LIST_COMPAT_IMPORT_PATH);
        expect(TRANSCRIPT_LIST_SHELL).not.toMatch(/<FlashList\b/);
        expect(TRANSCRIPT_LIST_SHELL).not.toMatch(/<LayoutCommitObserver\b/);
        expect(FLASH_LIST_RENDERER).toContain(FLASH_LIST_COMPAT_IMPORT_PATH);
        expect(FLASH_LIST_RENDERER).toMatch(/<FlashList\b/);
        expect(FLASH_LIST_RENDERER).toMatch(/<LayoutCommitObserver\b/);
        expect(RESOLVE_TRANSCRIPT_LIST_RENDERER).toContain('flashListRenderer');
        expect(TRANSCRIPT_RENDERER_SURFACE).toContain('readOnly');
        expect(TRANSCRIPT_RENDERER_SURFACE).toContain('sidechain');
        expect(TRANSCRIPT_RENDERER_SURFACE).toContain('main');
    });

    it('keeps FlashList and LayoutCommitObserver imports confined to the FlashList renderer adapter', () => {
        const shellSources = readProductionSources(SHELL_DIR_URL);
        const flashListCompatImporters = shellSources
            .filter(({ source }) => source.includes(FLASH_LIST_COMPAT_IMPORT_PATH))
            .map(({ relativePath }) => relativePath);
        const layoutCommitObserverUsers = shellSources
            .filter(({ source }) => /\bLayoutCommitObserver\b/.test(source))
            .map(({ relativePath }) => relativePath);

        expect(flashListCompatImporters).toEqual(['renderer/flashListRenderer.tsx']);
        expect(layoutCommitObserverUsers).toEqual(['renderer/flashListRenderer.tsx']);
    });

    it('routes main ChatList rendering through TranscriptListShell after the shell surface is widened', () => {
        expect(CHAT_LIST).toMatch(/<TranscriptListShell<ChatTranscriptListItem>/);
        expect(CHAT_LIST).not.toMatch(/<FlashList\b/);
        expect(CHAT_LIST).not.toMatch(/<LayoutCommitObserver\b/);
        expect(CHAT_LIST).toContain('frame={mainTranscriptListShellFrame}');
        expect(CHAT_LIST).toContain('onCommitLayoutEffect={recordLayoutCommitObserved}');
        expect(CHAT_LIST).toContain('platformInteractionProps={mainTranscriptListShellPlatformInteractionProps}');
        expect(CHAT_LIST).toContain('header={mainTranscriptListShellEdgeSlots.listHeaderNode}');
        expect(CHAT_LIST).toContain('footer={mainTranscriptListShellEdgeSlots.listFooterNode}');
        expect(CHAT_LIST).toContain('olderLoadOverlay={mainTranscriptListOlderLoadOverlay}');
        expect(CHAT_LIST).toContain('catchUpOverlay={mainTranscriptListCatchUpOverlay}');
        expect(CHAT_LIST).not.toContain('testID="transcript-chat-list"');
        expect(CHAT_LIST).not.toContain('nativeID={chatListNativeId}');
    });

    it('keeps transcript surfaces from importing or choosing concrete renderers inline', () => {
        const surfaceSources = [
            ['ChatList.tsx', CHAT_LIST],
            ['TranscriptList.tsx', TRANSCRIPT_LIST],
            ['ChainTranscriptList.tsx', CHAIN_TRANSCRIPT_LIST],
        ] as const;

        for (const [fileName, source] of surfaceSources) {
            expect(source, fileName).not.toContain(LEGEND_LIST_PACKAGE_NAME);
            expect(source, fileName).not.toContain(FLASH_LIST_COMPAT_IMPORT_PATH);
            expect(source, fileName).not.toMatch(/from ['"]@shopify\/flash-list['"]/);
            expect(source, fileName).not.toMatch(/<FlashList\b/);
            expect(source, fileName).not.toMatch(/<LayoutCommitObserver\b/);
            expect(source, fileName).not.toMatch(/\brenderer\s*===/);
            expect(source, fileName).not.toMatch(/\bswitch\s*\([^)]*renderer/);
        }
    });

    it('does not consume transcriptListImplementation as a runtime renderer switch', () => {
        expect(CHAT_LIST).not.toContain("useSetting('transcriptListImplementation')");
        expect(CHAT_LIST).not.toContain('setting: transcriptListImplementation');
        expect(CHAT_LIST).not.toContain('listImplementation: transcriptListImplementation');
        expect(TRANSCRIPT_LIST).not.toContain("useSetting('transcriptListImplementation')");
        expect(TRANSCRIPT_LIST).not.toContain('listImplementation: transcriptListImplementation');
        expect(CHAIN_TRANSCRIPT_LIST).not.toContain("useSetting('transcriptListImplementation')");
        expect(CHAIN_TRANSCRIPT_LIST).not.toContain('listImplementation: transcriptListImplementation');
        for (const [fileName, source] of [
            ['TranscriptListShell.tsx', TRANSCRIPT_LIST_SHELL],
            ['mainTranscriptRendererFrameHost.ts', MAIN_TRANSCRIPT_RENDERER_FRAME_HOST],
            ['renderer/flashListRenderer.tsx', FLASH_LIST_RENDERER],
            ['renderer/resolveTranscriptListRenderer.ts', RESOLVE_TRANSCRIPT_LIST_RENDERER],
        ] as const) {
            expect(source, fileName).not.toContain('transcriptListImplementation');
            expect(source, fileName).not.toContain('listImplementation');
        }
    });

    it('delegates viewport command execution through the command host', () => {
        expect(COMMAND_HOST).toBeTruthy();
        expect(COMMAND_HOST).toContain('performTranscriptViewportCommand');
        expect(COMMAND_HOST).toContain('performWebDomPrependAnchorRestoreCommand');
        expect(CHAT_LIST).toContain('createTranscriptViewportCommandHost');
        expect(CHAT_LIST).toContain('commandHost.execute');
        expect(CHAT_LIST).toContain('commandHost.executeWithAnimation');
        expect(CHAT_LIST).not.toContain("viewport/performTranscriptViewportCommand");
        expect(CHAT_LIST).not.toMatch(/from ['"]@\/components\/sessions\/transcript\/viewport\/driver\/webDom['"]/);
        expect(CHAT_LIST).not.toContain('performTranscriptViewportCommand(commandToPerform, {');
        expect(CHAT_LIST).not.toContain('performWebDomPrependAnchorRestoreCommand(commandToPerform, {');
        expect(CHAT_LIST).not.toContain('executeViewportCommandWithPerform');
        expect(CHAT_LIST).not.toContain('withTranscriptViewportCommandAnimation');
    });

    it('delegates entry restore transaction ownership to the entry restore owner', () => {
        expect(CHAT_LIST).toContain('createEntryRestoreOwner');
        expect(CHAT_LIST).not.toContain('currentWriteContext(');
        expect(CHAT_LIST).not.toContain('EntryRestoreOwnerWriteContext');
        expect(CHAT_LIST).not.toContain('type EntryRestoreWriteContext');
        expect(CHAT_LIST).not.toContain('createEntryRestoreTransaction(');
        expect(CHAT_LIST).not.toContain('resolveEntryRestoreCloseEffects(');
        expect(CHAT_LIST).not.toContain('resolveEntryRestoreDisposeEffects(');
        expect(CHAT_LIST).not.toContain('const attemptEntryRestore = React.useCallback');
        expect(CHAT_LIST).not.toContain('entryRestoreTransactionRef');
        expect(CHAT_LIST).not.toContain('entryRestoreWriteContextRef');
    });

    it('delegates prepend transaction ownership to prepend owners', () => {
        expect(CHAT_LIST).toContain('createNativePrependOwner');
        expect(CHAT_LIST).toContain('createWebPrependOwner');
        expect(CHAT_LIST).not.toContain('viewport/prepend/observePrependOutcome');
        expect(CHAT_LIST).not.toContain('viewport/prepend/prependTransaction');
        expect(CHAT_LIST).not.toContain('viewport/prepend/prependFallbackQuietGate');
        expect(CHAT_LIST).not.toContain('resolveNativePrependCloseEffects(');
        expect(CHAT_LIST).not.toContain('createPrependTransaction(');
        expect(CHAT_LIST).not.toContain('createPrependFallbackQuietGate(');
        expect(CHAT_LIST).not.toContain('observePrependOutcome(');
        expect(CHAT_LIST).not.toContain('nativePrependTransactionRef');
        expect(CHAT_LIST).not.toContain('nativePrependCommitArmedRef');
        expect(CHAT_LIST).not.toContain('nativePrependLayoutTimeoutRef');
        expect(CHAT_LIST).not.toContain('nativePrependQuietGateRef');
        expect(CHAT_LIST).not.toContain('nativePrependQuietTimerRef');
        expect(CHAT_LIST).not.toContain('nativePrependCorrectorNudgeRef');
        expect(CHAT_LIST).not.toContain('finishNativePrependTransactionRef');
        expect(CHAT_LIST).not.toContain('const beginNativePrependTransaction = React.useCallback');
        expect(CHAT_LIST).not.toContain('const computeNativePrependObservation = React.useCallback');
        expect(CHAT_LIST).not.toContain('const forwardNativePrependObservation = React.useCallback');
        expect(CHAT_LIST).not.toContain('const observeNativePrependTransaction = React.useCallback');
        expect(CHAT_LIST).not.toContain('pendingWebPrependAnchorRef');
        expect(CHAT_LIST).not.toContain('inFlightWebPrependAnchorRef');
        expect(CHAT_LIST).not.toContain('pendingWebPrependIndexRecoveryRef');
        expect(CHAT_LIST).not.toContain('scheduledWebPrependIndexRecoveryRef');
        expect(CHAT_LIST).not.toContain('webPrependRestoreWindowExpiryTimeoutRef');
        expect(CHAT_LIST).not.toContain('const scheduleWebPrependRestoreWindowExpiry = React.useCallback');
        expect(CHAT_LIST).not.toContain('const recordWebPrependRestoreOutcome = React.useCallback');
        expect(CHAT_LIST).not.toContain('const attemptPendingWebPrependIndexRecovery = React.useCallback');
    });

    it('starts viewport lifecycle ownership at the lifecycle host seam', () => {
        expect(CHAT_LIST).toContain('createTranscriptLifecycleHost');
        expect(CHAT_LIST).toContain('createTranscriptLifecycleHost({');
        expect(CHAT_LIST).toContain('lifecycle: viewportLifecycle');
    });

    it('routes host-covered lifecycle planning through the lifecycle host', () => {
        expect(CHAT_LIST).not.toContain("viewport/lifecycle/sessionEntryRenderResetEffects");
        expect(CHAT_LIST).not.toContain("viewport/lifecycle/sessionEntryViewport");
        expect(CHAT_LIST).not.toContain("viewport/lifecycle/explicitJumpTakeover");
        expect(CHAT_LIST).not.toContain("viewport/lifecycle/explicitReturnToLiveTail");
        expect(CHAT_LIST).not.toContain("viewport/lifecycle/followBottomIntentTakeover");
        expect(CHAT_LIST).not.toContain("viewport/lifecycle/localTranscriptInteractionAutoPinDeferral");
        expect(CHAT_LIST).not.toContain("viewport/lifecycle/nativeTouchReleaseLiveTail");
    });

    it('routes native gesture lifecycle planning through the lifecycle host', () => {
        expect(CHAT_LIST).not.toContain("viewport/lifecycle/nativeUserScrollTakeover");
        expect(CHAT_LIST).not.toContain("viewport/lifecycle/nativeTouchIntent");
        expect(CHAT_LIST).not.toContain('const applyNativeUserScrollTakeoverApplyEffects = React.useCallback');
        expect(CHAT_LIST).not.toContain('const beginNativeBottomFollowGestureIntent = React.useCallback');
    });

    it('routes measured native pin and content-growth planning through the lifecycle host', () => {
        const flushPendingNativeMountSettleBottomPinBody = readHookBody(
            CHAT_LIST,
            'flushPendingNativeMountSettleBottomPin',
            'useCallback',
        );

        expect(CHAT_LIST).toContain('lifecycleHost.planMeasuredNativeLiveTailPin');
        expect(CHAT_LIST).toContain('lifecycleHost.planNativeMountSettlePendingPinFlush');
        expect(CHAT_LIST).toContain('lifecycleHost.planContentGrowthLiveTailCommand');
        expect(flushPendingNativeMountSettleBottomPinBody).toContain(
            'lifecycleHost.planNativeMountSettlePendingPinFlush',
        );
        expect(CHAT_LIST).not.toContain('resolveNativeInvertedFollowBottomPinDecision');
        expect(CHAT_LIST).not.toContain('resolveNativeMeasuredBottomPinPreAutoFollowDecision');
        expect(CHAT_LIST).not.toContain('resolveNativeAutomaticPinSameOffsetDecision');
        expect(CHAT_LIST).not.toContain('resolveNativeStreamAppendContentVersionDecision');
        expect(CHAT_LIST).not.toContain('resolveNativeMeasuredBottomPinPreflightDecision');
        expect(CHAT_LIST).not.toContain('resolveNativeMeasuredBottomPinMetricsDecision');
        expect(CHAT_LIST).not.toContain('resolveNativeMeasuredBottomPinCommandResultPlan');
        expect(CHAT_LIST).not.toContain('resolveNativePendingMountSettleBottomPinFlushDecision');
        expect(flushPendingNativeMountSettleBottomPinBody).not.toMatch(
            /\bresolveNativePendingMountSettleBottomPinFlushDecision\s*\(/,
        );
        expect(CHAT_LIST).not.toContain('resolveContentGrowthLiveTailCommandApplyEffect');
    });

    it('routes native stream-append offset escape release through the lifecycle host', () => {
        expect(CHAT_LIST).toContain('lifecycleHost.planNativeOffsetEscapeRelease');
        expect(LIFECYCLE_HOST).toContain('planNativeOffsetEscapeRelease');
        expect(LIFECYCLE_HOST).toContain('resolveNativeOffsetEscapeReleaseDecision');
        expect(CHAT_LIST).not.toContain("viewport/lifecycle/nativeOffsetEscapeRelease");
        expect(CHAT_LIST).not.toContain('resolveNativeOffsetEscapeReleaseDecision');
        expect(CHAT_LIST).not.toContain('resolveNativeOffsetReleaseLiveTailStateEffects');
    });

    it('routes native confirmation ownership through the lifecycle host', () => {
        const forbiddenImports = [
            ['viewport/lifecycle/nativeExplicitJump', 'Confirmation'].join(''),
            ['viewport/lifecycle/nativeEntrySettle', 'Confirmation'].join(''),
        ];
        const forbiddenSymbols = [
            ['createNativeExplicitJump', 'ConfirmationState'].join(''),
            ['resolveNativeExplicitJump', 'ConfirmationEffects'].join(''),
            ['createNativeEntrySettle', 'ConfirmationState'].join(''),
            ['resolveNativeEntrySettle', 'ConfirmationEffects'].join(''),
            ['NativeExplicitJump', 'ConfirmationState'].join(''),
            ['NativeEntrySettle', 'ConfirmationState'].join(''),
            'pendingNativeExplicitJumpConfirmRef',
            'pendingNativeEntrySettleConfirmRef',
        ];

        expect(CHAT_LIST).toContain('lifecycleHost.armNativeExplicitJumpConfirmation');
        expect(CHAT_LIST).toContain('lifecycleHost.clearNativeExplicitJumpConfirmation');
        expect(CHAT_LIST).toContain('lifecycleHost.armNativeEntrySettleConfirmation');
        expect(CHAT_LIST).toContain('lifecycleHost.resetNativeEntrySettleConfirmation');
        expect(CHAT_LIST).toContain('lifecycleHost.observeNativeScrollConfirmation');
        expect(LIFECYCLE_HOST).toContain('createNativeConfirmationOwner');
        expect(LIFECYCLE_HOST).toContain('observeNativeScrollConfirmation');
        for (const forbiddenImport of forbiddenImports) {
            expect(CHAT_LIST).not.toContain(forbiddenImport);
        }
        for (const forbiddenSymbol of forbiddenSymbols) {
            expect(CHAT_LIST).not.toContain(forbiddenSymbol);
        }
    });

    it('routes content-growth live-tail scheduling policy through the bottom-follow write scheduler', () => {
        expect(CHAT_LIST).toContain('requestBottomFollowScheduledWrite');
        expect(CHAT_LIST).toContain('planBottomFollowWriteSchedulerEvent');
        expect(CHAT_LIST).not.toContain('lifecycleHost.planContentGrowthLiveTailPinSchedule');
        expect(CHAT_LIST).not.toContain('lifecycleHost.planContentGrowthLiveTailScheduledPinFire');
        expect(LIFECYCLE_HOST).not.toContain('planContentGrowthLiveTailPinSchedule');
        expect(LIFECYCLE_HOST).not.toContain('planContentGrowthLiveTailScheduledPinFire');
        expect(LIFECYCLE_HOST).not.toContain('contentGrowthLiveTailScheduler');
    });

    it('routes measurement and layout-cache host policy through the measurement host', () => {
        expect(CHAT_LIST).toContain('createTranscriptMeasurementHost');
        expect(CHAT_LIST).toContain('measurementHost.observeRowLayoutMutation');
        expect(CHAT_LIST).toContain('measurementHost.observeContentSizeChange');
        expect(TRANSCRIPT_MEASUREMENT_HOST).toContain('requestGlobalLayoutInvalidation');
        expect(TRANSCRIPT_MEASUREMENT_HOST).toContain('clear-layout-cache');
        expect(TRANSCRIPT_MEASUREMENT_HOST).toContain('hasNativeContentMeasurementForSession');

        expect(CHAT_LIST).not.toContain('createTranscriptMeasurementReconciler({');
        expect(CHAT_LIST).not.toContain('measurementReconciler.requestGlobalLayoutInvalidation(');
        expect(CHAT_LIST).not.toContain('listRef.current?.clearLayoutCacheOnUpdate');
        expect(CHAT_LIST).not.toContain('layoutInvalidationCommitTokenRef');
        expect(CHAT_LIST).not.toContain('nativeContentMeasurementSessionRef');
        expect(CHAT_LIST).not.toContain('lastMeasuredContentActivityKeyRef');
        expect(CHAT_LIST).not.toContain('const resolveMeasuredContentHeight');
    });

    it('routes scroll-observation arbitration through the lifecycle host', () => {
        expect(CHAT_LIST).toContain('observeTranscriptScrollIngress');
        expect(SCROLL_INGRESS_OBSERVATION).toContain('lifecycleHost.observeScroll');
        expect(CHAT_LIST).toContain('applyTranscriptLifecycleScrollObservationPlan');
        expect(LIFECYCLE_SCROLL_OBSERVATION_APPLIER).toContain('nativePassiveScrollObservationEffect');
        expect(LIFECYCLE_SCROLL_OBSERVATION_APPLIER).toContain('nativeBottomFollowCompletionEffects');
        expect(LIFECYCLE_SCROLL_OBSERVATION_APPLIER).toContain('nativeUserScrollTakeoverEffects');
        expect(CHAT_LIST).not.toContain("viewport/lifecycle/nativeScrollFactsObservation");
        expect(CHAT_LIST).not.toContain("viewport/lifecycle/webScrollFactsObservation");
        expect(CHAT_LIST).not.toContain("viewport/lifecycle/nativeScrollFollowIntent");
        expect(CHAT_LIST).not.toContain("viewport/lifecycle/nativeScrollAwayGestureLiveTailBail");
        expect(CHAT_LIST).not.toContain("viewport/lifecycle/nativeScrollPassiveDriftBail");
        expect(CHAT_LIST).not.toContain("viewport/lifecycle/nativeScrollReadOnlyVisibleBottom");
        expect(CHAT_LIST).not.toContain("viewport/lifecycle/nativeScrollAcceptedViewportPaint");
        expect(CHAT_LIST).not.toContain("viewport/lifecycle/webScrollFallbackFollowIntent");
        expect(CHAT_LIST).not.toContain("viewport/lifecycle/webScrollObservationGenericEffect");
        expect(CHAT_LIST).not.toContain("viewport/lifecycle/nativeObservedViewportStateGenericEffect");
        expect(CHAT_LIST).not.toContain("viewport/lifecycle/nativeScrollReleaseLiveTailGenericEffect");
        expect(CHAT_LIST).not.toContain("viewport/lifecycle/genericScrollObservationViewportState");
        expect(CHAT_LIST).not.toContain('shouldIgnoreNativePassiveViewportScroll');
        expect(CHAT_LIST).not.toContain('shouldRecordNativePassiveUnpinnedMovement');
        expect(CHAT_LIST).not.toContain('resolveNativeScrollObservationAnchorCaptureSuppression');
        expect(CHAT_LIST).not.toContain('resolveNativeBottomFollowCompletionEffects');
        expect(CHAT_LIST).not.toContain('type NativeBottomFollowCompletionEffect');
        expect(CHAT_LIST).not.toContain('scrollObservationPlan.nativePassiveScrollObservationEffect');
        expect(CHAT_LIST).not.toContain('scrollObservationPlan.nativeBottomFollowCompletionEffects');
        expect(CHAT_LIST).not.toContain('scrollObservationPlan.nativeUserScrollTakeoverEffects');
        expect(CHAT_LIST).not.toContain('passiveObservationEffect?.consumeAfterBottomCompletion');
        expect(CHAT_LIST).not.toContain('const updateNativeBottomFollowModeFromScrollObservation');
        expect(CHAT_LIST).not.toContain('const observeWebGenuineScrollMovementWithLifecycle');
        expect(CHAT_LIST).not.toContain('const observeWebBottomFollowFactsWithLifecycle');
        expect(CHAT_LIST).not.toContain('const applyNativeScrollPassiveDriftBailObservation');
        expect(CHAT_LIST).not.toContain('const applyNativeScrollReadOnlyVisibleBottomObservation');
        expect(LIFECYCLE_HOST).toContain('shouldIgnoreNativePassiveViewportScroll');
        expect(LIFECYCLE_HOST).toContain('shouldRecordNativePassiveUnpinnedMovement');
        expect(LIFECYCLE_HOST).toContain('resolveNativeScrollObservationAnchorCaptureSuppression');
    });

    it('does not pass list implementation through the viewport driver deps contract', () => {
        expect(VIEWPORT_DRIVER_TYPES).not.toContain('listImplementation:');
        expect(VIEWPORT_COMMAND_PERFORMER).not.toContain('listImplementation');
        expect(COMMAND_HOST).not.toContain('listImplementation');
    });

    it('does not pass list orientation through the viewport driver deps contract', () => {
        expect(VIEWPORT_DRIVER_TYPES).not.toContain('TranscriptListOrientation');
        expect(VIEWPORT_DRIVER_TYPES).not.toContain('listOrientationRef');
        expect(COMMAND_HOST).not.toContain('TranscriptListOrientation');
        expect(COMMAND_HOST).not.toContain('listOrientationRef');
    });

    it('does not pass list orientation into native invalid-scroll filtering', () => {
        const invalidScrollPolicyCallSource = CHAT_LIST.match(
            /resolveShouldIgnoreNativeInvalidScrollObservation\(\{([\s\S]*?)\n\s+\}\);/,
        )?.[1];
        expect(invalidScrollPolicyCallSource).toBeTruthy();
        expect(NATIVE_PASSIVE_SCROLL_POLICY).not.toContain('TranscriptListOrientation');
        expect(NATIVE_PASSIVE_SCROLL_POLICY).not.toContain('orientation:');
        expect(invalidScrollPolicyCallSource).not.toContain('orientation: listOrientationRef.current');
        expect(CHAT_LIST).not.toContain('orientation: listOrientationRef.current');
    });

    it('keeps main FlashList renderer-frame policy in the shell host', () => {
        const bottomMaintenanceCallSource = MAIN_TRANSCRIPT_RENDERER_FRAME_HOST.match(
            /resolveTranscriptFlashListBottomMaintenanceDecision\(\{([\s\S]*?)\n\s+\}\);/,
        )?.[1];
        expect(bottomMaintenanceCallSource).toBeTruthy();

        expect(MAIN_TRANSCRIPT_RENDERER_FRAME_HOST).toContain('resolveNativeTelemetryMvcpPolicy');
        expect(MAIN_TRANSCRIPT_RENDERER_FRAME_HOST).toContain('resolveMainTranscriptListShellFrame');
        expect(CHAT_LIST).toContain('resolveMainTranscriptRendererFrameHost');
        expect(CHAT_LIST).not.toMatch(
            /import\s+\{[\s\S]*resolveTranscriptFlashListBottomMaintenance[\s\S]*\}\s+from\s+['"]@\/components\/sessions\/transcript\/scroll\/transcriptFlashListBottomMaintenance['"]/,
        );
        expect(CHAT_LIST).not.toMatch(/\bresolveTranscriptFlashListBottomMaintenance\s*\(/);
        expect(CHAT_LIST).not.toMatch(/\bfunction\s+resolveNativeTelemetryMvcpPolicy\b/);
        expect(CHAT_LIST).not.toContain('sync.getSyncTuning().transcriptFlashListDrawDistance');
        expect(CHAT_LIST).not.toMatch(
            /import\s+\{[\s\S]*resolveMainTranscriptListShellFrame[\s\S]*\}\s+from\s+['"]@\/components\/sessions\/transcript\/viewport\/shell\/transcriptListShellCapabilities['"]/,
        );
        expect(CHAT_LIST).not.toMatch(/\bresolveMainTranscriptListShellFrame\s*\(/);
        expect(BOTTOM_MAINTENANCE).not.toContain('TranscriptListOrientation');
        expect(BOTTOM_MAINTENANCE).not.toContain('orientation:');
        expect(bottomMaintenanceCallSource).not.toContain('TranscriptListOrientation');
        expect(bottomMaintenanceCallSource).not.toContain('orientation:');
        expect(bottomMaintenanceCallSource).not.toContain('orientation: listOrientation');
    });

    it('keeps main shell layout/content-size observation ordering in the lifecycle applier', () => {
        const layoutStart = CHAT_LIST.indexOf('onLayout={(e: LayoutChangeEvent) => {');
        const contentSizeStart = CHAT_LIST.indexOf('onContentSizeChange={(_: number, h: number) => {');
        const scrollStart = CHAT_LIST.indexOf('onScroll={(e: NativeSyntheticEvent<NativeScrollEvent>) => {');
        expect(layoutStart).toBeGreaterThan(0);
        expect(contentSizeStart).toBeGreaterThan(layoutStart);
        expect(scrollStart).toBeGreaterThan(contentSizeStart);

        const layoutBody = CHAT_LIST.slice(layoutStart, contentSizeStart);
        const contentSizeBody = CHAT_LIST.slice(contentSizeStart, scrollStart);

        expect(LAYOUT_CONTENT_SIZE_OBSERVATION_APPLIER).toContain('applyTranscriptLayoutObservation');
        expect(LAYOUT_CONTENT_SIZE_OBSERVATION_APPLIER).toContain('applyTranscriptContentSizeObservation');
        expect(CHAT_LIST).toContain('applyTranscriptLayoutObservation');
        expect(CHAT_LIST).toContain('applyTranscriptContentSizeObservation');

        for (const staleLayoutOwner of [
            'observeMountSettleMetrics',
            'pinNativeInitialFollowBottomViewportIfReady',
            'observeNativePrependOwner',
            'observeWebPrependOwner',
            'runEntryRestoreAttempt',
            'verifyNativeSliceEntryRestoreTransaction',
            'requestAutomaticLiveTailPin',
        ]) {
            expect(layoutBody).not.toContain(staleLayoutOwner);
        }

        for (const staleContentSizeOwner of [
            'nativeContentMaterializationAutoPinRef.current',
            'releaseNativeBottomFollowIfFlashListOffsetEscaped',
            'recordViewportTelemetryEvent',
            'observeMountSettleMetrics',
            'pinNativeInitialFollowBottomViewportIfReady',
            'observeNativePrependOwner',
            'observeWebPrependOwner',
            'runEntryRestoreAttempt',
            'verifyNativeSliceEntryRestoreTransaction',
            'requestAutomaticLiveTailPin',
        ]) {
            expect(contentSizeBody).not.toContain(staleContentSizeOwner);
        }
    });

    it('keeps bottom-follow decision resolvers out of ChatList while preserving mode state typing', () => {
        expect(CHAT_LIST).not.toContain('resolveTranscriptBottomFollowIntent');
        expect(CHAT_LIST).not.toContain('resolveTranscriptBottomFollowMode');
        expect(CHAT_LIST).toContain('TranscriptBottomFollowModeState');
        expect(CHAT_LIST).toContain('React.useRef<TranscriptBottomFollowModeState>');
        expect(CHAT_LIST).toContain("TranscriptBottomFollowModeState['mode']");
    });

    it('keeps native inverted fact-source dependencies native-only and orientation-free', () => {
        const nativeFactSourceConstruction = CHAT_LIST.match(
            /createNativeInvertedFlashListFactSource\(\{([\s\S]*?)\n\s+\}\);/,
        )?.[1];
        const nativeFactSources = [
            TRANSCRIPT_VIEWPORT_FACTS,
            NATIVE_INVERTED_FLASH_LIST_FACTS,
            NATIVE_INVERTED_FLASH_LIST_FACTS_TEST,
        ].join('\n');

        expect(nativeFactSourceConstruction).toBeTruthy();
        expect(nativeFactSources).not.toContain('readOrientation');
        expect(nativeFactSources).not.toContain('TranscriptListOrientation');
        expect(nativeFactSources).not.toMatch(/orientation:\s*['"]standard['"]/);
        expect(nativeFactSources).not.toMatch(/\bstandard:\s+.*(?:fact|offset|range|edge)/i);
        expect(nativeFactSourceConstruction).not.toContain('readOrientation');
        expect(nativeFactSourceConstruction).not.toContain('listOrientationRef');
    });

    it('keeps native inverted raw scroll math owned by the native driver', () => {
        const retiredRawScrollHelpers = [
            'toCanonicalScrollOffset',
            'fromCanonicalScrollOffset',
            'resolveBottomRawScrollOffset',
            'resolveBottomRawScrollCommandOffset',
        ];
        const nativeDriverSources = [
            NATIVE_INVERTED_FLASH_LIST,
            NATIVE_INVERTED_FLASH_LIST_FACTS,
            FLASH_LIST_RUNTIME_MODEL,
        ].join('\n');

        for (const helperName of retiredRawScrollHelpers) {
            expect(LIST_ORIENTATION).not.toMatch(new RegExp(`export function ${helperName}\\b`));
            expect(nativeDriverSources).not.toMatch(new RegExp(`${helperName}[\\s\\S]*from ['"]@/components/sessions/transcript/listOrientation['"]`));
        }
        expect(nativeDriverSources).toContain('nativeInvertedRawScroll');
    });

    it('does not read list orientation to report native telemetry orientation', () => {
        const nativeTelemetryStart = CHAT_LIST.indexOf(
            'const resolveNativeTelemetryDiagnostics = React.useCallback',
        );
        const nativeTelemetryEnd = CHAT_LIST.indexOf(
            'const resolveViewportTelemetryMode',
            nativeTelemetryStart,
        );
        expect(nativeTelemetryStart).toBeGreaterThanOrEqual(0);
        expect(nativeTelemetryEnd).toBeGreaterThan(nativeTelemetryStart);
        const nativeTelemetrySource = CHAT_LIST.slice(nativeTelemetryStart, nativeTelemetryEnd);

        expect(nativeTelemetrySource).not.toContain('listOrientationRef');
        expect(nativeTelemetrySource).not.toMatch(/orientation:\s*TranscriptViewportTelemetryListOrientation/);
        expect(nativeTelemetrySource).not.toMatch(/\?\s*'inverted'\s*:\s*'standard'/);
        expect(nativeTelemetrySource).not.toContain('resolveBottomRawScrollOffset');
        expect(nativeTelemetrySource).toContain("orientation: 'inverted'");
    });

    it('does not keep a duplicate mutable host orientation ref in main ChatList', () => {
        expect(CHAT_LIST).toContain(
            'const listOrientation: TranscriptListOrientation = transcriptListPresentation.orientation;',
        );
        expect(CHAT_LIST).not.toContain('listOrientationRef');
    });

    it('keeps native observed-offset normalization behind the native fact seam while web DOM stays identity-owned', () => {
        const reachedEdgeResolverStart = CHAT_LIST.indexOf(
            'const resolveViewportReachedEdge = React.useCallback',
        );
        const reachedEdgeResolverEnd = CHAT_LIST.indexOf(
            'const observeNativeStreamAppendOffsetEscape',
            reachedEdgeResolverStart,
        );
        expect(reachedEdgeResolverStart).toBeGreaterThanOrEqual(0);
        expect(reachedEdgeResolverEnd).toBeGreaterThan(reachedEdgeResolverStart);
        const reachedEdgeResolverSource = CHAT_LIST.slice(
            reachedEdgeResolverStart,
            reachedEdgeResolverEnd,
        );

        expect(CHAT_LIST).not.toContain('const resolveCanonicalScrollOffset = React.useCallback');
        expect(CHAT_LIST).not.toContain('resolveNativeInvertedBottomRawOffset');
        expect(CHAT_LIST).toContain('const resolveNativeObservedScrollOffset = React.useCallback');
        expect(CHAT_LIST).toContain('observeTranscriptScrollIngress');
        expect(TRANSCRIPT_VIEWPORT_FACTS).toContain('resolveObservedOffset');
        expect(NATIVE_INVERTED_FLASH_LIST_FACTS).toContain('resolveObservedOffset(rawOffsetY');
        expect(NATIVE_INVERTED_FLASH_LIST_FACTS_TEST).toContain('resolveObservedOffset(300');
        expect(SCROLL_INGRESS_DRIVER).toContain('toNativeInvertedCanonicalOffset');
        expect(SCROLL_INGRESS_DRIVER).toContain('getWebTranscriptDistanceFromBottom(metrics)');
        expect(reachedEdgeResolverSource).toMatch(
            /if\s*\(\s*Platform\.OS\s*===\s*'web'\s*\)\s*return\s+edge\s*===\s*'start'\s*\?\s*'older'\s*:\s*'newer';/,
        );
        expect(CHAT_LIST).not.toContain('const rawObservedOffsetY = liveWebMetrics ? liveWebMetrics.scrollTop');
        expect(SIDECHAIN_OLDER_LOAD_OBSERVATION).not.toContain('readNativeAbsoluteScrollOffset');
        expect(SIDECHAIN_OLDER_LOAD_OBSERVATION).not.toContain('ScrollableChatListRef');
        expect(SIDECHAIN_OLDER_LOAD_OBSERVATION).not.toContain('scrollableExtent - params.offsetY');
        expect(SIDECHAIN_OLDER_LOAD_OBSERVATION).toContain('nativeObservedOffset');
    });

    it('keeps native viewport-anchor raw offset reads behind the guarded native read owner', () => {
        expect(NATIVE_VIEWPORT_ANCHOR).toContain('readNativeAbsoluteScrollOffset');
        expect(NATIVE_VIEWPORT_ANCHOR).not.toMatch(/\.\s*getAbsoluteLastScrollOffset\s*\(\s*\)/);
    });

    it('deletes the active runtime list implementation axis while telemetry owns historical labels', () => {
        const runtimeImplementationType = ['TranscriptViewportList', 'Implementation'].join('');
        const deletedRuntimeConstant = /\bconst\s+\w*ListImplementation\s*=/;
        const activeRuntimeGate = /\b\w*ListImplementation\s*(?:===|!==)\s*'flash_v2'/;
        const telemetryImplementationType = readExportedTypeBody(
            VIEWPORT_TELEMETRY,
            'TranscriptViewportTelemetryListImplementation',
        );

        expect(CHAT_LIST).not.toMatch(deletedRuntimeConstant);
        expect(CHAT_LIST).not.toMatch(activeRuntimeGate);
        expect(VIEWPORT_TYPES).not.toContain(`export type ${runtimeImplementationType}`);
        expect(VIEWPORT_TELEMETRY)
            .not
            .toContain(`TranscriptViewportTelemetryListImplementation = ${runtimeImplementationType}`);
        expect(telemetryImplementationType).toContain("'flash_v2'");
        expect(telemetryImplementationType).toContain("'flatlist_legacy'");
        expect(telemetryImplementationType).toContain("'web-fallback'");
        expect(VIEWPORT_TELEMETRY).toContain("'flatlist_legacy'");
        expect(VIEWPORT_TELEMETRY).toContain("'web-fallback'");
    });

    it('does not resolve telemetry list implementation from runtime state', () => {
        const deletedResolver = ['resolveTranscriptViewportTelemetryList', 'Implementation'].join('');

        expect(CHAT_LIST).not.toContain(deletedResolver);
        expect(VIEWPORT_TELEMETRY).not.toContain(deletedResolver);
    });

    it('does not keep the retired legacy index writer in telemetry production code', () => {
        expect(VIEWPORT_TELEMETRY).not.toContain('legacy-scroll-to-index');
    });

    it('does not keep stale native-standard guards after native inversion became canonical', () => {
        const nativeGestureIntentSource = readHookBody(
            CHAT_LIST,
            'recordNativeGestureTakeover',
            'useCallback',
        );
        const hotColdSegmentsSource = RENDER_WINDOW_PROJECTION;
        const nativeHotTailPinSource = readHookBody(
            CHAT_LIST,
            'pinNativeLiveTailForHotTailHeight',
            'useCallback',
        );

        expect(nativeGestureIntentSource).not.toMatch(
            /if\s*\(\s*listOrientationRef\.current\s*!==\s*'inverted'\s*\)\s*\{\s*wantsPinnedRef\.current\s*=\s*false;\s*isPinnedRef\.current\s*=\s*false;\s*\}/,
        );
        expect(hotColdSegmentsSource).not.toContain(
            "platformIsWeb || (hotTailItemCount > 0 && listOrientation === 'inverted')",
        );
        expect(hotColdSegmentsSource).not.toMatch(
            /native standard orientation guard|standard-native|flash_v2 STANDARD/i,
        );
        expect(nativeHotTailPinSource).not.toContain("listOrientationRef.current !== 'inverted'");
        expect(CHAT_LIST).not.toMatch(
            /Platform\.OS === 'web'\s*&&\s*listOrientationRef\.current !== 'inverted'\s*&&\s*typeof effectiveScrollOffset === 'number'\s*\?\s*resolveWebDomOlderLoadObservationTrigger/,
        );
        expect(SCROLL_INGRESS_OBSERVATION).toContain('resolveWebDomOlderLoadObservationTrigger');
        expect(CHAT_LIST).not.toContain('resolveWebDomOlderLoadObservationTrigger');
    });

    it('does not keep an explicit native jump-to-bottom orientation gate', () => {
        const jumpToBottomSource = readHookBody(CHAT_LIST, 'jumpToBottom', 'useCallback');

        expect(jumpToBottomSource).not.toContain('listOrientationRef');
        expect(jumpToBottomSource).not.toMatch(
            /usesNativeFlashListBottomMaintenance\s*&&\s*listOrientationRef\.current\s*===\s*'inverted'/,
        );
        expect(jumpToBottomSource).not.toMatch(
            /listOrientationRef\.current\s*===\s*'inverted'\s*&&\s*usesNativeFlashListBottomMaintenance/,
        );
    });

    it('routes explicit jump-to-bottom through one command-host write path', () => {
        const jumpToBottomSource = readHookBody(CHAT_LIST, 'jumpToBottom', 'useCallback');

        expect(jumpToBottomSource).not.toContain("tryPinToBottomDom('jump-to-bottom')");
    });

    it('does not keep a native touch-escape orientation gate', () => {
        const nativeTouchIntentSource = readHookBody(
            CHAT_LIST,
            'recordNativeTranscriptTouchIntent',
            'useCallback',
        );
        const gestureIntentIndex = nativeTouchIntentSource.indexOf('recordNativeGestureTakeover();');
        const lifecyclePlanIndex = nativeTouchIntentSource.indexOf(
            'const plan = lifecycleHost.planNativeTouchRelease({',
            gestureIntentIndex,
        );
        const lifecycleCommitIndex = nativeTouchIntentSource.indexOf(
            'commitBottomFollowModeState(plan.state.bottomFollowState);',
            lifecyclePlanIndex,
        );
        const touchReleaseIndex = nativeTouchIntentSource.indexOf(
            'applyNativeTouchReleaseLiveTailStateEffects(plan.nativeTouchReleaseStateEffects);',
            lifecycleCommitIndex,
        );
        const rearmResetIndex = nativeTouchIntentSource.indexOf(
            'applyNativeBottomFollowRearmResetEffects(plan.nativeBottomFollowRearmResetEffects);',
            touchReleaseIndex,
        );

        expect(nativeTouchIntentSource).not.toContain('listOrientationRef');
        expect(gestureIntentIndex).toBeGreaterThanOrEqual(0);
        expect(lifecyclePlanIndex).toBeGreaterThan(gestureIntentIndex);
        expect(lifecycleCommitIndex).toBeGreaterThan(lifecyclePlanIndex);
        expect(touchReleaseIndex).toBeGreaterThan(lifecycleCommitIndex);
        expect(rearmResetIndex).toBeGreaterThan(touchReleaseIndex);
    });

    it('does not keep native follow-intent orientation compatibility inputs', () => {
        const nativeFollowIntentCallStart = LIFECYCLE_HOST.indexOf(
            'const followIntent = resolveNativeScrollFollowIntent({',
        );
        expect(nativeFollowIntentCallStart).toBeGreaterThanOrEqual(0);
        const nativeFollowIntentCallEnd = LIFECYCLE_HOST.indexOf('});', nativeFollowIntentCallStart);
        expect(nativeFollowIntentCallEnd).toBeGreaterThan(nativeFollowIntentCallStart);
        const nativeFollowIntentCallSource = LIFECYCLE_HOST.slice(
            nativeFollowIntentCallStart,
            nativeFollowIntentCallEnd,
        );

        expect(CHAT_LIST).not.toContain('resolveNativeScrollFollowIntent(');
        expect(NATIVE_SCROLL_FOLLOW_INTENT_RELEASE).not.toContain('NativeScrollFollowIntentListOrientation');
        expect(NATIVE_SCROLL_FOLLOW_INTENT_RELEASE).not.toContain('listOrientation:');
        expect(NATIVE_SCROLL_FOLLOW_INTENT).not.toContain('NativeScrollFollowIntentListOrientation');
        expect(NATIVE_SCROLL_FOLLOW_INTENT).not.toContain('listOrientation:');
        expect(nativeFollowIntentCallSource).not.toContain('listOrientation:');
        expect(NATIVE_SCROLL_FOLLOW_INTENT_RELEASE_TEST).not.toMatch(/standard-orientation|listOrientation:\s*'standard'/);
        expect(NATIVE_SCROLL_FOLLOW_INTENT_TEST).not.toContain('listOrientation:');
    });

    it('routes native automatic pin ownership through lifecycle host without list orientation', () => {
        expect(CHAT_LIST).not.toContain('resolveNativeAutomaticPinOwnership(');
        const nativeAutomaticPinOwnershipCallSource = LIFECYCLE_HOST.match(
            /resolveNativeAutomaticPinOwnership\(\{([\s\S]*?)\n\s+\}\);/,
        )?.[1];
        expect(nativeAutomaticPinOwnershipCallSource).toBeTruthy();
        expect(nativeAutomaticPinOwnershipCallSource).not.toContain('listOrientation');
    });
});
