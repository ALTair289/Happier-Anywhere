import type { TranscriptViewportTelemetryScrollReason } from '@/components/sessions/transcript/scroll/transcriptViewportTelemetry';
import type { WebTranscriptScrollMetrics } from '@/components/sessions/transcript/webTranscriptScrollMetrics';

export type WebViewportResizeObservation =
    | Readonly<{
        previousWebMetrics: WebTranscriptScrollMetrics;
        reason: Extract<TranscriptViewportTelemetryScrollReason, 'viewport-resized'>;
    }>
    | null;

export function resolveWebViewportResizeObservation(input: Readonly<{
    nextMetrics: WebTranscriptScrollMetrics | null;
    previousMetrics: WebTranscriptScrollMetrics | null;
}>): WebViewportResizeObservation {
    if (!input.previousMetrics || !input.nextMetrics) return null;
    if (input.previousMetrics.element !== input.nextMetrics.element) return null;
    if (input.previousMetrics.clientHeight === input.nextMetrics.clientHeight) return null;
    if (input.nextMetrics.scrollHeight <= 0) return null;
    return {
        previousWebMetrics: input.previousMetrics,
        reason: 'viewport-resized',
    };
}
