import { describe, expect, it } from 'vitest';

import { resolveMainTranscriptRendererFrameHost } from './mainTranscriptRendererFrameHost';
import { resolveTranscriptListRendererSelection } from './renderer/resolveTranscriptListRenderer';

const flashSelection = resolveTranscriptListRendererSelection({
    platformOS: 'ios',
    transcriptLegendListSpikeSurface: 'flashList',
});
const webFlashSelection = resolveTranscriptListRendererSelection({
    platformOS: 'web',
    transcriptLegendListSpikeSurface: 'flashList',
});
const legendSelection = resolveTranscriptListRendererSelection({
    platformOS: 'ios',
    transcriptLegendListSpikeSurface: 'off',
});

const baseParams = {
    autoFollowWhenPinned: true,
    bottomFollowMode: 'following' as const,
    configuredDrawDistance: undefined,
    hasOpenViewportTransaction: false,
    layoutHeight: 600,
    liveRegionActive: false,
    nativeEntryShouldUseBottomMaintenance: true,
    nativeID: 'main-transcript-native-id',
    pinEnabled: true,
    pinThresholdPx: 72,
    platformOS: 'ios',
    rendererSelection: flashSelection,
    sessionEntryShouldFollowBottom: true,
};

describe('main transcript renderer frame host', () => {
    it('omits MVCP and native drawDistance on web', () => {
        const host = resolveMainTranscriptRendererFrameHost({
            ...baseParams,
            platformOS: 'web',
            rendererSelection: webFlashSelection,
        });

        expect(host.binding.frame).toMatchObject({
            dataOrder: 'oldest-first',
            rendererOptions: {
                identity: {
                    nativeID: 'main-transcript-native-id',
                },
                initialPlacement: {
                    atEnd: true,
                },
                continuousFollow: { endThresholdRatio: 72 / 600 },
                virtualization: { renderAheadDistancePx: undefined },
            },
        });
        expect(host.maintainVisibleContentPosition).toBeUndefined();
        expect(host.telemetryMvcpPolicy).toBe('none');
    });

    it('withholds Legend initial tail placement for a released entry so entry restore consumes the saved anchor first', () => {
        const host = resolveMainTranscriptRendererFrameHost({
            ...baseParams,
            bottomFollowMode: 'released',
            platformOS: 'web',
            rendererSelection: legendSelection,
            sessionEntryShouldFollowBottom: false,
        });

        expect(host.binding.frame.rendererOptions.initialPlacement.atEnd).toBe(false);
        expect(host.binding.frame.rendererOptions).not.toHaveProperty('visibleContentMaintenance');
        expect(host.maintainVisibleContentPosition).toBeUndefined();
    });

    it('derives Legend initial tail placement from the session-entry snapshot, not the live follow mode', () => {
        // On a warm-instance session switch the bottom-follow mode ref still carries the
        // PREVIOUS session's 'following' state during the first render of the next session.
        // Seeding Legend initialScrollAtEnd (and the adapter's held-'end' intent) from that
        // stale mode mounts the detached-entry session at the tail and starts a scroll war
        // against the entry-anchor restore (USER-REALITY-DIVERGENCE RC-3).
        const staleFollowingHost = resolveMainTranscriptRendererFrameHost({
            ...baseParams,
            bottomFollowMode: 'following',
            platformOS: 'web',
            rendererSelection: legendSelection,
            sessionEntryShouldFollowBottom: false,
        });
        expect(staleFollowingHost.binding.frame.rendererOptions.initialPlacement.atEnd).toBe(false);

        const pinnedEntryHost = resolveMainTranscriptRendererFrameHost({
            ...baseParams,
            bottomFollowMode: 'released',
            platformOS: 'web',
            rendererSelection: legendSelection,
            sessionEntryShouldFollowBottom: true,
        });
        expect(pinnedEntryHost.binding.frame.rendererOptions.initialPlacement.atEnd).toBe(true);
    });

    it('arms native MVCP threshold while following and hands it to the main shell frame', () => {
        const host = resolveMainTranscriptRendererFrameHost(baseParams);

        expect(host.maintainVisibleContentPosition).toEqual({
            animateAutoScrollToBottom: false,
            autoscrollToBottomThreshold: 72 / 600,
            startRenderingFromBottom: true,
        });
        expect(host.binding.frame).toMatchObject({
            dataOrder: 'newest-first',
            rendererOptions: {
                identity: {
                    nativeID: 'main-transcript-native-id',
                },
                continuousFollow: { endThresholdRatio: 72 / 600 },
                virtualization: { renderAheadDistancePx: 600 },
                visibleContentMaintenance: host.maintainVisibleContentPosition,
            },
        });
        expect(host.telemetryMvcpPolicy).toBe('autoscroll-threshold');
    });

    it('keeps native offset correction armed without threshold while released or escaping when no carve is active', () => {
        for (const bottomFollowMode of ['released', 'escaping'] as const) {
            const host = resolveMainTranscriptRendererFrameHost({
                ...baseParams,
                bottomFollowMode,
            });

            expect(host.maintainVisibleContentPosition).toEqual({
                startRenderingFromBottom: true,
            });
            expect(host.binding.frame.rendererOptions.visibleContentMaintenance)
                .toBe(host.maintainVisibleContentPosition);
            expect(host.telemetryMvcpPolicy).toBe('start-rendering-from-bottom');
        }
    });

    it('withholds the native bottom threshold while following with an active live-region carve', () => {
        const host = resolveMainTranscriptRendererFrameHost({
            ...baseParams,
            liveRegionActive: true,
        });

        expect(host.maintainVisibleContentPosition).toEqual({
            startRenderingFromBottom: true,
        });
        expect(host.binding.frame.rendererOptions.visibleContentMaintenance)
            .toBe(host.maintainVisibleContentPosition);
        expect(host.telemetryMvcpPolicy).toBe('start-rendering-from-bottom');
    });

    it('keeps native MVCP stable and pauses only JS offset correction while released with an active live-region carve (NQA-F4)', () => {
        const host = resolveMainTranscriptRendererFrameHost({
            ...baseParams,
            bottomFollowMode: 'released',
            liveRegionActive: true,
        });

        // NQA-F4: the native MVCP object must not flap to {disabled:true}; the carve release
        // window is represented by a separate FlashList JS correction pause flag.
        expect(host.maintainVisibleContentPosition).toEqual({ startRenderingFromBottom: true });
        expect(host.binding.frame.rendererOptions.visibleContentMaintenance)
            .toBe(host.maintainVisibleContentPosition);
        expect(host.binding.frame.rendererOptions.offsetCorrection).toBe('paused');
        expect(host.telemetryMvcpPolicy).toBe('start-rendering-from-bottom');
    });

    it('keeps explicit native drawDistance unchanged and otherwise uses the clamped viewport default', () => {
        expect(resolveMainTranscriptRendererFrameHost({
            ...baseParams,
            configuredDrawDistance: 1600,
            layoutHeight: 800,
        }).binding.frame.rendererOptions.virtualization?.renderAheadDistancePx).toBe(1600);

        expect(resolveMainTranscriptRendererFrameHost({
            ...baseParams,
            layoutHeight: 2400,
        }).binding.frame.rendererOptions.virtualization?.renderAheadDistancePx).toBe(1200);
    });
});
