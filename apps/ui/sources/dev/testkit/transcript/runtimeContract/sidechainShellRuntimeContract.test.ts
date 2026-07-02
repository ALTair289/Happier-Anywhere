import { describe, expect, it } from 'vitest';

import {
    createSidechainShellRuntimeModel,
    type SidechainShellRuntimeItem,
} from './sidechainShellRuntimeModel';

const DELETED_LEGACY_FALLBACK_CAPABILITY = ['uses', 'LegacyFallback'].join('');

function item(
    id: string,
    options: Readonly<{
        heightPx?: number;
        owns?: readonly string[];
        contains?: readonly string[];
    }> = {},
): SidechainShellRuntimeItem {
    return {
        id,
        heightPx: options.heightPx ?? 100,
        ownsMessageIds: options.owns ?? [id],
        containsMessageIds: options.contains ?? [],
    };
}

describe('sidechain shell runtime contract', () => {
    it('exposes sidechain shell capabilities with catch-up indicator and without streaming ownership', () => {
        const web = createSidechainShellRuntimeModel({
            estimatedItemSizePx: 88,
            footerHeightPx: 64,
            items: [item('m1')],
            layoutHeightPx: 250,
            platformOS: 'web',
        });
        const ios = createSidechainShellRuntimeModel({
            estimatedItemSizePx: 88,
            footerHeightPx: 64,
            items: [item('m1')],
            layoutHeightPx: 250,
            platformOS: 'ios',
        });

        expect(web.observeCapability()).toEqual({
            boundedHydration: true,
            catchUpIndicator: true,
            composerVisible: false,
            initialBottomPin: true,
            jumpToMessage: true,
            localHeightChangeRestore: true,
            nativeOlderLoadEdgeRead: true,
            olderPagination: true,
            prependGrowthRestore: true,
            readOnlyForkContext: false,
            renderer: 'flashList',
            scrollEventThrottle: 32,
            streamingFollow: false,
            webOlderLoadObservation: true,
        });
        expect(web.observeCapability()).not.toHaveProperty(DELETED_LEGACY_FALLBACK_CAPABILITY);
        expect(ios.observeCapability().scrollEventThrottle).toBe(16);
    });

    it('pins initial bottom to the last transcript item, not footer chrome, after layout/content are ready', () => {
        const model = createSidechainShellRuntimeModel({
            estimatedItemSizePx: 88,
            footerHeightPx: 64,
            items: [item('m1'), item('m2'), item('m3')],
            layoutHeightPx: 250,
            platformOS: 'web',
        });

        expect(model.requestInitialBottomPin()).toEqual({
            ok: false,
            reason: 'not_ready',
        });

        model.commitLayout();
        model.commitContent();

        expect(model.requestInitialBottomPin()).toEqual({
            ok: true,
            method: 'scroll-to-index',
            targetIndex: 2,
            targetItemId: 'm3',
            targetIsFooter: false,
            targetScrollTop: 50,
        });
        expect(model.requestInitialBottomPin()).toEqual({
            ok: false,
            reason: 'already_applied',
        });

        const fallback = createSidechainShellRuntimeModel({
            estimatedItemSizePx: 88,
            footerHeightPx: 64,
            items: [item('m1'), item('m2'), item('m3')],
            layoutHeightPx: 250,
            platformOS: 'web',
        });
        fallback.commitLayout();
        fallback.commitContent();

        expect(fallback.requestInitialBottomPin({ simulateScrollToIndexFailure: true })).toEqual({
            ok: true,
            method: 'estimated-offset-fallback',
            targetIndex: 2,
            targetItemId: 'm3',
            targetIsFooter: false,
            targetScrollTop: 114,
        });
    });

    it('suppresses the initial bottom pin after a local transcript interaction before first layout', () => {
        const model = createSidechainShellRuntimeModel({
            estimatedItemSizePx: 88,
            footerHeightPx: 64,
            items: [item('m1'), item('m2'), item('m3')],
            layoutHeightPx: 250,
            platformOS: 'web',
        });

        model.deferInitialBottomPinForLocalInteraction();
        model.commitLayout();
        model.commitContent();

        expect(model.requestInitialBottomPin()).toEqual({
            ok: false,
            reason: 'local_interaction',
        });
    });

    it('jumps by message ownership, including collapsed tool-header containment after bounded older materialization', () => {
        const model = createSidechainShellRuntimeModel({
            estimatedItemSizePx: 80,
            footerHeightPx: 40,
            items: [
                item('message-2', { owns: ['message-2'] }),
                item('message-3', { owns: ['message-3'] }),
            ],
            layoutHeightPx: 240,
            platformOS: 'web',
        });

        expect(model.jumpToMessageId('message-3')).toEqual({
            ok: true,
            alignment: 'center',
            loadedPages: 0,
            targetIndex: 1,
            targetItemId: 'message-3',
            targetScrollTop: 0,
        });

        expect(model.jumpToMessageId('tool-hidden-1', {
            olderPages: [
                [
                    item('older-message-1', { owns: ['older-message-1'] }),
                    item('tool-header-1', { contains: ['tool-hidden-1', 'tool-hidden-2'], owns: [] }),
                ],
            ],
        })).toEqual({
            ok: true,
            alignment: 'center',
            loadedPages: 1,
            targetIndex: 1,
            targetItemId: 'tool-header-1',
            targetScrollTop: 30,
        });
    });

    it('caps jump-to-message older materialization at the production sidechain load bound', () => {
        const model = createSidechainShellRuntimeModel({
            estimatedItemSizePx: 80,
            footerHeightPx: 40,
            items: [item('current-message')],
            layoutHeightPx: 240,
            platformOS: 'web',
        });
        const olderPages = Array.from({ length: 26 }, (_value, index) => [
            item(`older-page-${index + 1}`, {
                owns: index === 25 ? ['too-deep-message'] : [`older-page-${index + 1}`],
            }),
        ]);

        expect(model.jumpToMessageId('too-deep-message', { olderPages })).toEqual({
            ok: false,
            loadedPages: 25,
            reason: 'not_found',
        });
    });

    it('runs sidechain jump-to-message materialization through the shell operation', async () => {
        const model = createSidechainShellRuntimeModel({
            estimatedItemSizePx: 80,
            footerHeightPx: 40,
            items: [item('current-message')],
            layoutHeightPx: 240,
            platformOS: 'web',
        });

        await expect(model.jumpToMessageIdThroughShellOperation('target-message', {
            olderPages: [
                [item('older-message-1', { owns: ['older-message-1'] })],
                [item('target-row', { owns: ['target-message'] })],
            ],
        })).resolves.toEqual({
            ok: true,
            alignment: 'center',
            loadedPages: 2,
            targetIndex: 0,
            targetItemId: 'target-row',
            targetScrollTop: 0,
        });
    });

    it('re-arms older loading from genuine top and epsilon edge frames without letting onStartReached bypass guards', () => {
        const model = createSidechainShellRuntimeModel({
            estimatedItemSizePx: 80,
            footerHeightPx: 40,
            items: Array.from({ length: 20 }, (_value, index) => item(`message-${index}`, { heightPx: 80 })),
            layoutHeightPx: 400,
            platformOS: 'web',
        });
        model.commitLayout();
        model.commitContent();

        expect(model.observeOlderLoad({ offsetY: 0, trigger: 'edge-reached' })).toEqual({
            loadCount: 1,
            phase: 'loading',
            shouldLoad: true,
        });
        model.finishOlderLoad({ hasMore: true, loaded: 20 });
        expect(model.observeOlderLoad({ offsetY: 1, trigger: 'scroll' })).toEqual({
            loadCount: 1,
            phase: 'cooldown',
            shouldLoad: false,
        });
        expect(model.cooldownElapsed()).toEqual({
            loadCount: 1,
            phase: 'idle',
            shouldLoad: false,
        });
        expect(model.observeOlderLoad({ offsetY: 1, trigger: 'edge-reached' })).toEqual({
            loadCount: 2,
            phase: 'loading',
            shouldLoad: true,
        });

        const short = createSidechainShellRuntimeModel({
            estimatedItemSizePx: 80,
            footerHeightPx: 40,
            items: [item('only', { heightPx: 80 })],
            layoutHeightPx: 400,
            platformOS: 'web',
        });
        short.commitLayout();
        short.commitContent();
        expect(short.onStartReached()).toEqual({
            loadCount: 0,
            phase: 'idle',
            shouldLoad: false,
        });
    });

    it('uses the web older-load observation owner for exact and epsilon top frames', () => {
        const model = createSidechainShellRuntimeModel({
            estimatedItemSizePx: 80,
            footerHeightPx: 40,
            items: Array.from({ length: 20 }, (_value, index) => item(`message-${index}`, { heightPx: 80 })),
            layoutHeightPx: 400,
            platformOS: 'web',
        });
        model.commitLayout();
        model.commitContent();

        expect(model.observeWebOlderLoad({ scrollTop: 0, requestedTrigger: 'scroll' })).toEqual({
            loadCount: 1,
            phase: 'loading',
            shouldLoad: true,
        });
        model.finishOlderLoad({ hasMore: true, loaded: 20 });
        model.cooldownElapsed();
        expect(model.observeWebOlderLoad({ scrollTop: 1, requestedTrigger: 'scroll' })).toEqual({
            loadCount: 2,
            phase: 'loading',
            shouldLoad: true,
        });

        const bottom = createSidechainShellRuntimeModel({
            estimatedItemSizePx: 80,
            footerHeightPx: 40,
            items: Array.from({ length: 20 }, (_value, index) => item(`bottom-message-${index}`, { heightPx: 80 })),
            layoutHeightPx: 400,
            initialScrollTopPx: 1240,
            platformOS: 'web',
        });
        bottom.commitLayout();
        bottom.commitContent();
        expect(bottom.observeWebOlderLoad({ scrollTop: 1240, requestedTrigger: 'edge-reached' })).toEqual({
            loadCount: 0,
            phase: 'idle',
            shouldLoad: false,
        });
    });

    it('preserves web local-height-change anchors and marks programmatic write echoes as non-genuine', () => {
        const preserve = createSidechainShellRuntimeModel({
            estimatedItemSizePx: 80,
            footerHeightPx: 40,
            items: Array.from({ length: 12 }, (_value, index) => item(`message-${index}`, { heightPx: 100 })),
            layoutHeightPx: 300,
            initialScrollTopPx: 240,
            platformOS: 'web',
        });

        expect(preserve.applyWebLocalHeightChange({ growthPx: 120, mode: 'preserve-position' })).toEqual({
            echoIsGenuineUserMovement: false,
            targetScrollTop: 360,
        });

        const follow = createSidechainShellRuntimeModel({
            estimatedItemSizePx: 80,
            footerHeightPx: 40,
            items: Array.from({ length: 12 }, (_value, index) => item(`message-${index}`, { heightPx: 100 })),
            layoutHeightPx: 300,
            initialScrollTopPx: 940,
            platformOS: 'web',
        });

        expect(follow.applyWebLocalHeightChange({ growthPx: 120, mode: 'follow-bottom' })).toEqual({
            echoIsGenuineUserMovement: false,
            targetScrollTop: 1060,
        });
    });

    it('preserves web older-prepend growth and marks programmatic write echoes as non-genuine', () => {
        const model = createSidechainShellRuntimeModel({
            estimatedItemSizePx: 80,
            footerHeightPx: 0,
            items: Array.from({ length: 10 }, (_value, index) => item(`message-${index}`, { heightPx: 100 })),
            layoutHeightPx: 500,
            initialScrollTopPx: 100,
            platformOS: 'web',
        });

        expect(model.applyWebPrependGrowth({ growthPx: 300 })).toEqual({
            echoIsGenuineUserMovement: false,
            growthPx: 300,
            targetScrollTop: 400,
        });

        expect(model.applyWebPrependGrowth({ growthPx: 0 })).toEqual({
            echoIsGenuineUserMovement: false,
            growthPx: 0,
            targetScrollTop: 400,
        });
    });

    it('loads a web older page through the sidechain shell operation and preserves prepend growth', async () => {
        const model = createSidechainShellRuntimeModel({
            estimatedItemSizePx: 80,
            footerHeightPx: 0,
            items: Array.from({ length: 10 }, (_value, index) => item(`message-${index}`, { heightPx: 100 })),
            layoutHeightPx: 500,
            initialScrollTopPx: 100,
            platformOS: 'web',
        });

        await expect(model.loadOlderPage({
            items: [
                item('older-1', { heightPx: 120 }),
                item('older-2', { heightPx: 180 }),
            ],
        })).resolves.toEqual({
            echoIsGenuineUserMovement: false,
            hasMore: true,
            loaded: 2,
            status: 'loaded',
            targetScrollTop: 400,
            visualUpdateCount: 1,
        });
    });

    it('loads a web pagination older page through the sidechain shell request owner', async () => {
        const model = createSidechainShellRuntimeModel({
            estimatedItemSizePx: 80,
            footerHeightPx: 0,
            items: Array.from({ length: 10 }, (_value, index) => item(`message-${index}`, { heightPx: 100 })),
            layoutHeightPx: 500,
            initialScrollTopPx: 100,
            platformOS: 'web',
        });

        await expect(model.loadOlderPageFromPagination({
            items: [
                item('older-1', { heightPx: 120 }),
                item('older-2', { heightPx: 180 }),
            ],
        })).resolves.toEqual({
            echoIsGenuineUserMovement: false,
            hasMore: true,
            loaded: 2,
            status: 'loaded',
            targetScrollTop: 400,
            visualUpdateCount: 1,
        });
    });
});
