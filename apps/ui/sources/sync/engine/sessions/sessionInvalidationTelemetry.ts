import { syncPerformanceTelemetry } from '@/sync/runtime/syncPerformanceTelemetry';

export type SessionInvalidationTelemetryReason =
    | 'socketNewSession'
    | 'socketPendingChangedMissingSession'
    | 'socketUpdateSessionMissingVisible'
    | 'socketUpdateSessionMissingUnpatchable'
    | 'socketUpdateSessionTurnsProjection'
    | 'socketMessageAttentionUnknown'
    | 'socketSharingChanged';

const REASON_FIELD_BY_REASON: Readonly<Record<SessionInvalidationTelemetryReason, string>> = {
    socketNewSession: 'reason_socketNewSession',
    socketPendingChangedMissingSession: 'reason_socketPendingChangedMissingSession',
    socketUpdateSessionMissingVisible: 'reason_socketUpdateSessionMissingVisible',
    socketUpdateSessionMissingUnpatchable: 'reason_socketUpdateSessionMissingUnpatchable',
    socketUpdateSessionTurnsProjection: 'reason_socketUpdateSessionTurnsProjection',
    socketMessageAttentionUnknown: 'reason_socketMessageAttentionUnknown',
    socketSharingChanged: 'reason_socketSharingChanged',
};

export function recordSessionInvalidationRequested(
    reason: SessionInvalidationTelemetryReason,
    fields: Readonly<Record<string, number>> = {},
): void {
    if (!syncPerformanceTelemetry.isEnabled()) return;
    syncPerformanceTelemetry.count('sync.sessions.invalidate.requested', {
        ...fields,
        [REASON_FIELD_BY_REASON[reason]]: 1,
    });
}
