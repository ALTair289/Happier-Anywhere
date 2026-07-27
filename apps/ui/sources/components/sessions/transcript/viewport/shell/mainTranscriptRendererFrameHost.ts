import {
    resolveTranscriptFlashListBottomMaintenanceDecision,
    type TranscriptFlashListBottomMaintenanceResult,
} from '@/components/sessions/transcript/scroll/transcriptFlashListBottomMaintenance';
import type { TranscriptBottomFollowMode } from '@/components/sessions/transcript/scroll/transcriptBottomFollowMode';
import type { TranscriptViewportTelemetryMvcpPolicy } from '@/components/sessions/transcript/scroll/transcriptViewportTelemetry';
import {
    resolveMainTranscriptListShellFrame,
} from '@/components/sessions/transcript/viewport/shell/transcriptListShellCapabilities';
import { resolveTranscriptListRendererBinding } from '@/components/sessions/transcript/viewport/shell/renderer/resolveTranscriptListRenderer';
import type {
    TranscriptListRendererBinding,
    TranscriptListRendererSelection,
} from '@/components/sessions/transcript/viewport/shell/renderer/types';

export type MainTranscriptRendererFrameHost = Readonly<{
    binding: TranscriptListRendererBinding;
    maintainVisibleContentPosition: TranscriptFlashListBottomMaintenanceResult;
    pauseOffsetCorrection: boolean;
    telemetryMvcpPolicy: TranscriptViewportTelemetryMvcpPolicy;
}>;

const TRANSCRIPT_LEGEND_MAINTAIN_SCROLL_AT_END_THRESHOLD_DEFAULT = 0.1;

function resolveLegendMaintainScrollAtEndThreshold(params: Readonly<{
    layoutHeight: number;
    pinThresholdPx: number;
}>): number {
    if (
        Number.isFinite(params.layoutHeight) &&
        params.layoutHeight > 0 &&
        Number.isFinite(params.pinThresholdPx) &&
        params.pinThresholdPx >= 0
    ) {
        return params.pinThresholdPx / params.layoutHeight;
    }
    return TRANSCRIPT_LEGEND_MAINTAIN_SCROLL_AT_END_THRESHOLD_DEFAULT;
}

export function resolveMainTranscriptRendererFrameHost(params: Readonly<{
    autoFollowWhenPinned: boolean;
    bottomFollowMode: TranscriptBottomFollowMode;
    configuredDrawDistance?: unknown;
    hasOpenViewportTransaction: boolean;
    layoutHeight: number;
    liveRegionActive: boolean;
    nativeEntryShouldUseBottomMaintenance: boolean;
    nativeID?: string;
    pinEnabled: boolean;
    pinThresholdPx: number;
    platformOS: string;
    rendererSelection: TranscriptListRendererSelection;
    /**
     * Render-time session-entry snapshot intent. Legend's initial tail placement (and the
     * adapter's held-'end' seed) must consume THIS basis, not the live bottom-follow mode:
     * on a warm-instance session switch the mode ref still carries the previous session's
     * 'following' during the next session's first render, which mounted detached-anchored
     * entries at the tail and started a scroll war against the entry restore.
     */
    sessionEntryShouldFollowBottom: boolean;
    targetWindowActive?: boolean;
}>): MainTranscriptRendererFrameHost {
    if (params.rendererSelection.renderer.kind === 'legendList') {
        return {
            binding: resolveTranscriptListRendererBinding({
                frame: resolveMainTranscriptListShellFrame({
                    legendInitialScrollAtEnd: params.sessionEntryShouldFollowBottom,
                    listLayoutHeight: params.layoutHeight,
                    maintainScrollAtEndThreshold: resolveLegendMaintainScrollAtEndThreshold({
                        layoutHeight: params.layoutHeight,
                        pinThresholdPx: params.pinThresholdPx,
                    }),
                    nativeID: params.nativeID,
                    platformOS: params.platformOS,
                    rendererKind: 'legendList',
                }),
                selection: params.rendererSelection,
            }),
            maintainVisibleContentPosition: undefined,
            pauseOffsetCorrection: false,
            telemetryMvcpPolicy: 'none',
        };
    }

    const bottomMaintenance = resolveTranscriptFlashListBottomMaintenanceDecision({
        autoFollowWhenPinned: params.autoFollowWhenPinned,
        bottomFollowMode: params.bottomFollowMode,
        hasOpenViewportTransaction: params.hasOpenViewportTransaction,
        layoutHeight: params.layoutHeight,
        liveRegionActive: params.liveRegionActive,
        nativeEntryShouldUseBottomMaintenance: params.nativeEntryShouldUseBottomMaintenance,
        pinEnabled: params.pinEnabled,
        pinThresholdPx: params.pinThresholdPx,
        platformIsWeb: params.platformOS === 'web',
        targetWindowActive: params.targetWindowActive,
    });
    const maintainVisibleContentPosition = bottomMaintenance.maintainVisibleContentPosition;

    return {
        binding: resolveTranscriptListRendererBinding({
            frame: resolveMainTranscriptListShellFrame({
                configuredDrawDistance: params.configuredDrawDistance,
                legendInitialScrollAtEnd: params.sessionEntryShouldFollowBottom,
                listLayoutHeight: params.layoutHeight,
                maintainScrollAtEndThreshold: resolveLegendMaintainScrollAtEndThreshold({
                    layoutHeight: params.layoutHeight,
                    pinThresholdPx: params.pinThresholdPx,
                }),
                maintainVisibleContentPosition,
                nativeID: params.nativeID,
                pauseOffsetCorrection: bottomMaintenance.pauseOffsetCorrection,
                platformOS: params.platformOS,
                rendererKind: 'flashList',
            }),
            selection: params.rendererSelection,
        }),
        maintainVisibleContentPosition,
        pauseOffsetCorrection: bottomMaintenance.pauseOffsetCorrection,
        telemetryMvcpPolicy:
            params.platformOS === 'web'
                ? 'none'
                : resolveNativeTelemetryMvcpPolicy(maintainVisibleContentPosition),
    };
}

export function resolveNativeTelemetryMvcpPolicy(
    maintenance: TranscriptFlashListBottomMaintenanceResult,
): TranscriptViewportTelemetryMvcpPolicy {
    if (!maintenance) return 'default';
    if (
        'startRenderingFromBottom' in maintenance &&
        maintenance.startRenderingFromBottom === true
    ) {
        if (typeof maintenance.autoscrollToBottomThreshold === 'number') return 'autoscroll-threshold';
        return 'start-rendering-from-bottom';
    }
    return 'default';
}
