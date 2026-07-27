import type { WebTranscriptScrollMetrics } from '@/components/sessions/transcript/webTranscriptScrollMetrics';
import { isWebTranscriptScrollable } from '@/components/sessions/transcript/webTranscriptScrollMetrics';
import type { TranscriptViewportTelemetryWebTrigger } from '@/components/sessions/transcript/scroll/transcriptViewportTelemetry';
import type { TranscriptOlderPaginationSnapshot } from '@/components/sessions/transcript/pagination/useTranscriptOlderPagination';
import type {
    WebPrependTelemetryFacts,
    WebPrependTelemetryFactsInput,
} from '@/components/sessions/transcript/viewport/prepend/webPrependOwner';
import type { TranscriptNavigationRuntimeAnchor } from '@/components/sessions/transcript/viewport/visibility/transcriptNavigationRuntimeAnchors';

export function resolveWebViewportTelemetryDiagnostics(params: Readonly<{
    enabled: boolean;
    flashListContentHeight?: number;
    flashListLayoutHeight?: number;
    hotColdCounts: Readonly<{ coldCount: number; hotCount: number }>;
    items: WebPrependTelemetryFactsInput['items'];
    listContentHeight: number;
    listLayoutHeight: number;
    metrics?: WebTranscriptScrollMetrics | null;
    paginationSnapshot: TranscriptOlderPaginationSnapshot;
    paginationPhase?: TranscriptOlderPaginationSnapshot['phase'];
    paginationSuspendedReasons?: TranscriptOlderPaginationSnapshot['suspendedReasons'];
    programmaticWebWrite: boolean;
    runtimeAnchors: readonly TranscriptNavigationRuntimeAnchor[];
    scrollable?: boolean;
    trigger: TranscriptViewportTelemetryWebTrigger;
    resolveWebPrependTelemetryFacts: (params: WebPrependTelemetryFactsInput) => WebPrependTelemetryFacts;
}>): Record<string, unknown> {
    if (!params.enabled) return {};
    const metrics = params.metrics ?? null;
    const webPrependFacts = params.resolveWebPrependTelemetryFacts({ items: params.items });
    return {
        trigger: params.trigger,
        // Navigation anchors are reported as a count, not by sweeping the DOM
        // for the first visible anchor row: that third per-write anchor sweep
        // measured every mounted anchor with getBoundingClientRect. Anchor
        // visibility now lives in the navigation visibility store, derived in
        // renderer index space.
        navigationAnchorCount: params.runtimeAnchors.length,
        ...(metrics ? {
            domScrollTop: metrics.scrollTop,
            domScrollHeight: metrics.scrollHeight,
            domClientHeight: metrics.clientHeight,
        } : {}),
        flashListContentHeight: params.flashListContentHeight ?? params.listContentHeight,
        flashListLayoutHeight: params.flashListLayoutHeight ?? params.listLayoutHeight,
        scrollable: params.scrollable ?? (metrics ? isWebTranscriptScrollable(metrics, 1) : false),
        paginationPhase: params.paginationPhase ?? params.paginationSnapshot.phase,
        paginationSuspendedReasons: params.paginationSuspendedReasons ?? params.paginationSnapshot.suspendedReasons,
        coldCount: params.hotColdCounts.coldCount,
        hotCount: params.hotColdCounts.hotCount,
        ...webPrependFacts,
        programmaticWebWrite: params.programmaticWebWrite,
    };
}
