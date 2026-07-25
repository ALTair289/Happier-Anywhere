export type JsonlFollowerResetReason = 'truncated' | 'replaced';

export type JsonlFollowerDrainSource = 'poll' | 'manual' | 'watcher' | 'queued';

export type JsonlFollowerMetricEvent =
    | { type: 'started' }
    | { type: 'stopped' }
    | { type: 'drain_requested'; source: JsonlFollowerDrainSource }
    | { type: 'drain_queued' }
    | { type: 'drain_started'; source: JsonlFollowerDrainSource }
    | { type: 'drain_finished'; bytesRead: number; rowsEmitted: number }
    | { type: 'bytes_read'; bytes: number }
    | { type: 'row_emitted' }
    | { type: 'file_reset'; reason: JsonlFollowerResetReason }
    | { type: 'poll_scheduled'; delayMs: number }
    | { type: 'mode_changed'; mode: 'active' | 'idle' };

export type JsonlFollowerMetrics = Readonly<{
    emit?: (event: JsonlFollowerMetricEvent) => void;
}>;

export function emitJsonlFollowerMetric(metrics: JsonlFollowerMetrics | undefined, event: JsonlFollowerMetricEvent): void {
    try {
        metrics?.emit?.(event);
    } catch {
        // Metrics are diagnostic only; follower correctness must not depend on them.
    }
}
