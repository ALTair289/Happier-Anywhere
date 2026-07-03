import type { SessionViewportAnchorSnapshot } from '@/sync/sync';
import { captureWebTranscriptViewportAnchor } from '@/components/sessions/transcript/viewport/prepend/webTranscriptPrependAnchor';
import type { WebTranscriptScrollMetrics } from '@/components/sessions/transcript/webTranscriptScrollMetrics';

export type JumpSeqViewportPromotionState = Readonly<{
    anchor: SessionViewportAnchorSnapshot | null;
    isPinned: boolean;
    offsetY: number;
    shouldRestoreViewport: boolean;
}>;

export function resolveJumpSeqViewportPromotionState(params: Readonly<{
    distanceFromBottom: number;
    metrics: WebTranscriptScrollMetrics;
    pinThresholdPx: number;
}>): JumpSeqViewportPromotionState {
    const distanceFromBottom = Math.max(0, Math.trunc(params.distanceFromBottom));
    const isPinned = distanceFromBottom <= params.pinThresholdPx;
    const anchor = isPinned
        ? null
        : captureWebTranscriptViewportAnchor({ container: params.metrics.element });
    return {
        anchor: anchor ? { ...anchor, capturedAtMs: Date.now() } : null,
        isPinned,
        offsetY: distanceFromBottom,
        shouldRestoreViewport: !isPinned,
    };
}

export type JumpSeqViewportPromotionResolution =
    | Readonly<{ status: 'wrong-session' }>
    | Readonly<{ status: 'stale-anchor' }>
    | Readonly<{ status: 'needs-restorable-anchor'; scrollOffsetPx: number; state: JumpSeqViewportPromotionState }>
    | Readonly<{ status: 'promote'; scrollOffsetPx: number; state: JumpSeqViewportPromotionState }>;

export function resolveJumpSeqViewportPromotion(params: Readonly<{
    currentSessionId: string;
    distanceFromBottom: number;
    metrics: WebTranscriptScrollMetrics;
    pendingSeq: number;
    pendingSessionId: string;
    pinThresholdPx: number;
    requireRestorableAnchor?: boolean;
    resolveAnchorSeq: (anchor: SessionViewportAnchorSnapshot | null) => number | null;
    scrollOffsetPx: number;
    stampAnchor: (anchor: SessionViewportAnchorSnapshot | null) => SessionViewportAnchorSnapshot | null;
}>): JumpSeqViewportPromotionResolution {
    if (params.pendingSessionId !== params.currentSessionId) return { status: 'wrong-session' };
    let state = resolveJumpSeqViewportPromotionState(params);
    const stampedAnchor = params.stampAnchor(state.anchor);
    const stampedAnchorSeq = params.resolveAnchorSeq(stampedAnchor);
    if (stampedAnchor && stampedAnchorSeq !== null && stampedAnchorSeq !== params.pendingSeq) {
        return { status: 'stale-anchor' };
    }
    if (stampedAnchor !== state.anchor) state = { ...state, anchor: stampedAnchor };
    const scrollOffsetPx = Math.max(0, Math.trunc(params.scrollOffsetPx));
    if (params.requireRestorableAnchor === true && !state.isPinned && !state.anchor) {
        return { status: 'needs-restorable-anchor', scrollOffsetPx, state };
    }
    return { status: 'promote', scrollOffsetPx, state };
}
