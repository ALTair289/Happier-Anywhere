import type { TranscriptViewportTelemetryScrollReason } from '@/components/sessions/transcript/scroll/transcriptViewportTelemetry';
import type { TranscriptListShellRef } from '@/components/sessions/transcript/viewport/shell/renderer/types';

/**
 * Compatibility name used by the transcript hosts and command driver. The renderer-owned
 * shell handle is the single source of truth for imperative viewport capabilities.
 */
export type ScrollableChatListRef = TranscriptListShellRef;

/**
 * The last native index-targeted restore write the command executor issued — retained so the native
 * `onScrollToIndexFailed` fallback can re-target the same restore intent.
 */
export type LastNativeRestoreIndexCommand = Readonly<{
    index: number;
    issuedAtMs: number;
    reason: TranscriptViewportTelemetryScrollReason;
    sessionId: string;
    viewOffset?: number;
}>;
