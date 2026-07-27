import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderHook, renderScreen } from '@/dev/testkit';
import { createWebDomScrollObservation } from '@/components/sessions/transcript/viewport/driver/webDomObservation';
import {
    resolveMainTranscriptListShellFrame,
    resolveReadOnlyTranscriptListShellFrame,
    resolveSidechainTranscriptListShellFrame,
} from './transcriptListShellCapabilities';
import type { TranscriptListShellRef } from './renderer/types';
import {
    resolveTranscriptListRendererBinding,
    resolveTranscriptListRendererSelection,
} from './renderer/resolveTranscriptListRenderer';
import { useMainTranscriptRendererFrameHost } from './useMainTranscriptRendererFrameHost';

type TestRow = Readonly<{ id: string }>;

let capturedFlashListProps: Record<string, unknown> | null = null;
let capturedLegendListProps: Record<string, unknown> | null = null;
let assignedFlashListRef: unknown = null;
let assignedLegendListRef: unknown = null;

vi.mock('@shopify/flash-list', () => ({
    FlashList: React.forwardRef((props: Record<string, unknown>, ref) => {
        capturedFlashListProps = props;
        const instance = {
            scrollToEnd: vi.fn(),
            scrollToIndex: vi.fn(),
            scrollToOffset: vi.fn(),
        };
        if (typeof ref === 'function') ref(instance);
        else if (ref && typeof ref === 'object') ref.current = instance;
        assignedFlashListRef = instance;
        return React.createElement('FlashList', props);
    }),
}));

vi.mock('@legendapp/list/react-native', () => ({
    LegendList: React.forwardRef((props: Record<string, unknown>, ref) => {
        capturedLegendListProps = props;
        const instance = {
            getState: () => ({
                contentLength: 0,
                isAtEnd: true,
                isNearEnd: true,
                isWithinMaintainScrollAtEndThreshold: true,
                scroll: 0,
                scrollLength: 0,
            }),
            scrollToEnd: vi.fn(() => Promise.resolve()),
            scrollToIndex: vi.fn(() => Promise.resolve()),
            scrollToOffset: vi.fn(() => Promise.resolve()),
        };
        if (typeof ref === 'function') ref(instance);
        else if (ref && typeof ref === 'object') ref.current = instance;
        assignedLegendListRef = instance;
        return React.createElement('LegendList', props);
    }),
}));

describe('transcript list shell frame contracts', () => {
    it('resolves main web and native frame facts explicitly', () => {
        const web = resolveMainTranscriptListShellFrame({
            nativeID: 'transcript-web',
            platformOS: 'web',
        });
        const native = resolveMainTranscriptListShellFrame({
            listLayoutHeight: 800,
            nativeID: 'transcript-native',
            platformOS: 'ios',
        });

        expect(web).toMatchObject({
            capability: { kind: 'main', streamingFollow: { kind: 'main' } },
            dataOrder: 'oldest-first',
            platform: 'web',
            rendererOptions: {
                continuousFollow: { endThresholdRatio: 0.1 },
                identity: { nativeID: 'transcript-web', testID: 'transcript-chat-list' },
                initialPlacement: { atEnd: true },
                interaction: { scrollEventThrottle: 32 },
            },
        });
        expect(native).toMatchObject({
            capability: { kind: 'main', streamingFollow: { kind: 'main' } },
            dataOrder: 'newest-first',
            platform: 'native',
            rendererOptions: {
                continuousFollow: { endThresholdRatio: 0.1 },
                identity: { nativeID: 'transcript-native', testID: 'transcript-chat-list' },
                initialPlacement: { atEnd: true },
                interaction: { scrollEventThrottle: 16 },
            },
        });
        expect(web.rendererOptions).not.toHaveProperty('visibleContentMaintenance');
        expect(native.rendererOptions).not.toHaveProperty('visibleContentMaintenance');
        expect(native.rendererOptions.virtualization).toBeUndefined();
    });

    it('resolves read-only and sidechain capability contracts without main-only identity', () => {
        const readOnly = resolveReadOnlyTranscriptListShellFrame({
            accessKind: 'public',
            bottomNoticeVisible: true,
            platformOS: 'web',
        });
        const sidechain = resolveSidechainTranscriptListShellFrame({ platformOS: 'ios' });

        expect(readOnly.capability).toMatchObject({
            boundedHydration: { kind: 'readOnly' },
            canApprovePermissions: false,
            canSendMessages: false,
            kind: 'readOnly',
        });
        expect(readOnly.rendererOptions.identity.nativeID).toBeUndefined();
        expect(sidechain.capability).toMatchObject({
            boundedHydration: { kind: 'sidechain' },
            initialBottomPin: true,
            kind: 'sidechain',
            olderPagination: true,
        });
        expect(sidechain.rendererOptions.identity.nativeID).toBeUndefined();
    });

    it('binds the mounted renderer and every positioning owner from one explicit surface decision', () => {
        const surfaces = [
            {
                frame: (rendererKind: 'flashList' | 'legendList') =>
                    resolveMainTranscriptListShellFrame({ platformOS: 'web', rendererKind }),
                platformOS: 'web',
            },
            {
                frame: (rendererKind: 'flashList' | 'legendList') =>
                    resolveSidechainTranscriptListShellFrame({ platformOS: 'ios', rendererKind }),
                platformOS: 'ios',
            },
            {
                frame: (rendererKind: 'flashList' | 'legendList') =>
                    resolveReadOnlyTranscriptListShellFrame({
                        accessKind: 'public',
                        bottomNoticeVisible: false,
                        platformOS: 'web',
                        rendererKind,
                    }),
                platformOS: 'web',
            },
        ];

        for (const surface of surfaces) {
            for (const transcriptLegendListSpikeSurface of ['off', 'flashList'] as const) {
                const selection = resolveTranscriptListRendererSelection({
                    platformOS: surface.platformOS,
                    transcriptLegendListSpikeSurface,
                });
                const binding = resolveTranscriptListRendererBinding({
                    frame: surface.frame(selection.renderer.kind),
                    selection,
                });
                const expectedKind =
                    transcriptLegendListSpikeSurface === 'flashList' ? 'flashList' : 'legendList';
                const expectedOwner = expectedKind === 'flashList' ? 'app' : 'renderer';

                expect(binding.renderer.kind).toBe(expectedKind);
                expect(binding.ownerPolicy).toEqual({
                    continuousFollow: expectedOwner,
                    initialBottomPosition: expectedOwner,
                    localHeightChangeRestore: expectedOwner,
                    prependRestore: expectedOwner,
                    usesNativeFlashListBottomMaintenance:
                        expectedKind === 'flashList' && surface.platformOS !== 'web',
                });
                if (expectedKind === 'legendList') {
                    expect(binding.frame.rendererOptions).not.toHaveProperty('offsetCorrection');
                    expect(binding.frame.rendererOptions).not.toHaveProperty('virtualization');
                    expect(binding.frame.rendererOptions).not.toHaveProperty('visibleContentMaintenance');
                } else {
                    expect(binding.frame.rendererOptions).toHaveProperty('offsetCorrection');
                    expect(binding.frame.rendererOptions).toHaveProperty('virtualization');
                }
            }
        }
    });

    it('keeps the Legend binding stable when only Flash maintenance revisions change', async () => {
        const selection = resolveTranscriptListRendererSelection({
            platformOS: 'ios',
            transcriptLegendListSpikeSurface: 'off',
        });
        const stableRef = <T,>(current: T) => ({ current });
        const nativeFlashListMvcpPolicyRef = stableRef<'none' | 'default'>('default');
        const nativeFlashListPauseOffsetCorrectionRef = stableRef(true);
        const baseParams = {
            autoFollowWhenPinned: true,
            bottomFollowModeRevision: 0,
            bottomFollowModeStateRef: stableRef({ dragSession: null, mode: 'following' as const }),
            chatListNativeId: 'chat-list:legend',
            configuredFlashListDrawDistance: 800,
            hasOpenEntryRestoreTransactionForSession: () => false,
            hasOpenNativePrependTransactionForSession: () => false,
            layoutHeight: 600,
            nativeEntryShouldUseBottomMaintenance: true,
            nativeFlashListMvcpPolicyRef,
            nativeFlashListPauseOffsetCorrectionRef,
            nativeInitialViewportPendingObservation: false,
            nativePrependTransactionRevision: 0,
            pinEnabled: true,
            pinThresholdPx: 72,
            platformOS: 'ios',
            rendererSelection: selection,
            sessionEntryShouldFollowBottom: true,
            shouldUseNativeHotColdSplit: false,
            targetWindowActive: false,
        } as Parameters<typeof useMainTranscriptRendererFrameHost>[0];
        const hook = await renderHook(
            (params: Parameters<typeof useMainTranscriptRendererFrameHost>[0]) =>
                useMainTranscriptRendererFrameHost(params),
            { initialProps: baseParams },
        );
        const first = hook.getCurrent();

        await hook.rerender({
            ...baseParams,
            bottomFollowModeRevision: 1,
            nativeInitialViewportPendingObservation: true,
            nativePrependTransactionRevision: 1,
        });

        expect(hook.getCurrent()).toBe(first);
        expect(nativeFlashListMvcpPolicyRef.current).toBe('default');
        expect(nativeFlashListPauseOffsetCorrectionRef.current).toBe(true);
        await hook.unmount();
    });
});

describe('TranscriptListShell executable renderer contracts', () => {
    beforeEach(() => {
        capturedFlashListProps = null;
        capturedLegendListProps = null;
        assignedFlashListRef = null;
        assignedLegendListRef = null;
    });

    it('forwards caller-owned callbacks and data to the FlashList escape hatch', async () => {
        const { TranscriptListShell } = await import('./TranscriptListShell');
        const listRef = React.createRef<TranscriptListShellRef<TestRow>>();
        const onScroll = vi.fn();
        const keyExtractor = (item: { id: string }) => item.id;
        const selection = resolveTranscriptListRendererSelection({
            platformOS: 'web',
            transcriptLegendListSpikeSurface: 'flashList',
        });
        const rendererBinding = resolveTranscriptListRendererBinding({
            frame: resolveSidechainTranscriptListShellFrame({
                platformOS: 'web',
                rendererKind: selection.renderer.kind,
            }),
            selection,
        });

        await renderScreen(
            <TranscriptListShell<TestRow>
                ref={listRef}
                data={[{ id: 'row-1' }]}
                dataKey="session-test"
                webDomObservation={createWebDomScrollObservation()}
                keyExtractor={keyExtractor}
                onScroll={onScroll}
                renderItem={({ item }) => React.createElement('Row', item)}
                rendererBinding={rendererBinding}
            />,
        );

        expect(rendererBinding.ownerPolicy.initialBottomPosition).toBe('app');
        expect(listRef.current).not.toBe(assignedFlashListRef);
        listRef.current?.scrollToIndex({ index: 3, animated: false });
        listRef.current?.scrollToOffset({ offset: 120, animated: true });
        listRef.current?.scrollToEnd?.({ animated: false });
        expect(assignedFlashListRef?.scrollToIndex).toHaveBeenCalledWith({ index: 3, animated: false });
        expect(assignedFlashListRef?.scrollToOffset).toHaveBeenCalledWith({ offset: 120, animated: true });
        expect(assignedFlashListRef?.scrollToEnd).toHaveBeenCalledWith({ animated: false });
        expect(capturedFlashListProps).toMatchObject({
            data: [{ id: 'row-1' }],
            inverted: undefined,
            keyExtractor,
            onScroll,
            scrollEventThrottle: 32,
        });
        expect(capturedLegendListProps).toBeNull();
    });

    it('adapts native newest-first shell data into chronological Legend data and standard commands', async () => {
        const { TranscriptListShell } = await import('./TranscriptListShell');
        const listRef = React.createRef<TranscriptListShellRef<TestRow>>();
        const selection = resolveTranscriptListRendererSelection({
            platformOS: 'ios',
            transcriptLegendListSpikeSurface: 'off',
        });
        const rendererBinding = resolveTranscriptListRendererBinding({
            frame: resolveMainTranscriptListShellFrame({
                nativeID: 'transcript-native',
                platformOS: 'ios',
                rendererKind: selection.renderer.kind,
            }),
            selection,
        });

        await renderScreen(
            <TranscriptListShell<TestRow>
                ref={listRef}
                data={[{ id: 'newest' }, { id: 'oldest' }]}
                dataKey="session-test"
                webDomObservation={createWebDomScrollObservation()}
                keyExtractor={(item) => item.id}
                renderItem={({ item }) => React.createElement('Row', item)}
                rendererBinding={rendererBinding}
            />,
        );

        expect(rendererBinding.ownerPolicy.initialBottomPosition).toBe('renderer');
        expect(capturedFlashListProps).toBeNull();
        expect(capturedLegendListProps).toMatchObject({
            data: [{ id: 'oldest' }, { id: 'newest' }],
            initialScrollAtEnd: true,
            scrollEventThrottle: 16,
        });
        expect(listRef.current).toMatchObject({ transcriptViewportCommandSpace: 'standard' });
        expect(assignedLegendListRef).toBeTruthy();
    });
});
