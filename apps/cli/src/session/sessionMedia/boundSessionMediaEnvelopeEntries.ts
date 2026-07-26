import type { SessionMediaItemV1, SessionMediaUnavailableV1 } from '@happier-dev/protocol';

export type BoundedSessionMediaEnvelopeEntries = Readonly<{
    media: SessionMediaItemV1[];
    unavailable: SessionMediaUnavailableV1[];
    droppedCount: number;
}>;

/**
 * Applies one deterministic combined-entry budget to a durable session-media envelope.
 * Persisted media wins over unavailable diagnostics because it is the usable product output.
 */
export function boundSessionMediaEnvelopeEntries(params: Readonly<{
    media: readonly SessionMediaItemV1[];
    unavailable: readonly SessionMediaUnavailableV1[];
    maxEntries: number;
}>): BoundedSessionMediaEnvelopeEntries {
    const maxEntries = Number.isFinite(params.maxEntries)
        ? Math.max(0, Math.trunc(params.maxEntries))
        : 0;
    const media = params.media.slice(0, maxEntries);
    const unavailable = params.unavailable.slice(0, Math.max(0, maxEntries - media.length));
    return {
        media,
        unavailable,
        droppedCount: params.media.length + params.unavailable.length - media.length - unavailable.length,
    };
}
