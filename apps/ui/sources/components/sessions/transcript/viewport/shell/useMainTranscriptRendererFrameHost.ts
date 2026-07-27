import * as React from 'react';
import type { TranscriptBottomFollowModeState } from '@/components/sessions/transcript/scroll/transcriptBottomFollowMode';
import type { TranscriptViewportTelemetryMvcpPolicy } from '@/components/sessions/transcript/scroll/transcriptViewportTelemetry';
import {
    resolveMainTranscriptRendererFrameHost,
} from '@/components/sessions/transcript/viewport/shell/mainTranscriptRendererFrameHost';
import type { TranscriptListRendererSelection } from '@/components/sessions/transcript/viewport/shell/renderer/types';

type MutableRef<T> = { current: T };

export function useMainTranscriptRendererFrameHost(params: Readonly<{
    autoFollowWhenPinned: boolean;
    bottomFollowModeRevision: number;
    bottomFollowModeStateRef: MutableRef<TranscriptBottomFollowModeState>;
    chatListNativeId: string;
    configuredFlashListDrawDistance: unknown;
    hasOpenEntryRestoreTransactionForSession: () => boolean;
    hasOpenNativePrependTransactionForSession: () => boolean;
    layoutHeight: number;
    nativeEntryShouldUseBottomMaintenance: boolean;
    nativeFlashListMvcpPolicyRef: MutableRef<TranscriptViewportTelemetryMvcpPolicy>;
    nativeFlashListPauseOffsetCorrectionRef: MutableRef<boolean>;
    nativeInitialViewportPendingObservation: boolean;
    nativePrependTransactionRevision: number;
    pinEnabled: boolean;
    pinThresholdPx: number;
    platformOS: string;
    rendererSelection: TranscriptListRendererSelection;
    sessionEntryShouldFollowBottom: boolean;
    shouldUseNativeHotColdSplit: boolean;
    targetWindowActive: boolean;
}>) {
    const {
        autoFollowWhenPinned,
        bottomFollowModeRevision,
        bottomFollowModeStateRef,
        chatListNativeId,
        configuredFlashListDrawDistance,
        hasOpenEntryRestoreTransactionForSession,
        hasOpenNativePrependTransactionForSession,
        layoutHeight,
        nativeEntryShouldUseBottomMaintenance,
        nativeFlashListMvcpPolicyRef,
        nativeFlashListPauseOffsetCorrectionRef,
        nativeInitialViewportPendingObservation,
        nativePrependTransactionRevision,
        pinEnabled,
        pinThresholdPx,
        platformOS,
        rendererSelection,
        sessionEntryShouldFollowBottom,
        shouldUseNativeHotColdSplit,
        targetWindowActive,
    } = params;
    const flashBinding = rendererSelection.renderer.kind === 'flashList';
    const mainTranscriptRendererFrameHost = React.useMemo(() => {
        const bottomFollowModeState = bottomFollowModeStateRef.current;
        return resolveMainTranscriptRendererFrameHost({
            autoFollowWhenPinned,
            bottomFollowMode: bottomFollowModeState.mode,
            configuredDrawDistance: configuredFlashListDrawDistance,
            hasOpenViewportTransaction:
                hasOpenEntryRestoreTransactionForSession() || hasOpenNativePrependTransactionForSession(),
            layoutHeight,
            liveRegionActive: shouldUseNativeHotColdSplit,
            nativeEntryShouldUseBottomMaintenance,
            nativeID: chatListNativeId,
            pinEnabled,
            pinThresholdPx,
            platformOS,
            rendererSelection,
            sessionEntryShouldFollowBottom,
            targetWindowActive,
        });
    }, [
        flashBinding ? autoFollowWhenPinned : undefined,
        flashBinding ? bottomFollowModeRevision : undefined,
        flashBinding ? bottomFollowModeStateRef : undefined,
        chatListNativeId,
        flashBinding ? configuredFlashListDrawDistance : undefined,
        flashBinding ? hasOpenEntryRestoreTransactionForSession : undefined,
        flashBinding ? hasOpenNativePrependTransactionForSession : undefined,
        layoutHeight,
        flashBinding ? nativeEntryShouldUseBottomMaintenance : undefined,
        flashBinding ? nativeInitialViewportPendingObservation : undefined,
        flashBinding ? nativePrependTransactionRevision : undefined,
        flashBinding ? pinEnabled : undefined,
        pinThresholdPx,
        platformOS,
        rendererSelection,
        sessionEntryShouldFollowBottom,
        flashBinding ? shouldUseNativeHotColdSplit : undefined,
        flashBinding ? targetWindowActive : undefined,
    ]);
    React.useInsertionEffect(() => {
        if (!flashBinding) return;
        nativeFlashListMvcpPolicyRef.current = mainTranscriptRendererFrameHost.telemetryMvcpPolicy;
        nativeFlashListPauseOffsetCorrectionRef.current =
            mainTranscriptRendererFrameHost.pauseOffsetCorrection;
    }, [
        flashBinding,
        mainTranscriptRendererFrameHost.pauseOffsetCorrection,
        mainTranscriptRendererFrameHost.telemetryMvcpPolicy,
        nativeFlashListMvcpPolicyRef,
        nativeFlashListPauseOffsetCorrectionRef,
    ]);

    return mainTranscriptRendererFrameHost.binding;
}
