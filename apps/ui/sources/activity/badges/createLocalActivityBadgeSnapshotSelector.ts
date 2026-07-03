import { resolveActivityAttentionSessionsFromRecords } from '@/activity/attention/activityAttentionSessions';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import type { Session } from '@/sync/domains/state/storageTypes';
import type { StorageState } from '@/sync/store/types';
import {
    collectRecordIds,
    hasRecordValues,
} from '@/sync/store/sessionRecordProjection';
import {
    isFreshTimestamp,
    SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS,
} from '@/sync/domains/session/attention/deriveSessionRuntimePresentationState';
import {
    prunePendingRequestObservedAtCache,
    readCachedPendingRequestObservedAt,
    type PendingRequestObservedAtCacheEntry,
} from '@/sync/domains/session/pending/pendingRequestObservedAtCache';

import { buildActivityBadgeState } from './buildActivityBadgeState';

export type ActivityBadgeSessionOptions = Readonly<{
    showUnread: boolean;
    showPendingPermissionRequests: boolean;
    showPendingUserActionRequests: boolean;
}>;

export type LocalActivityBadgeSnapshot = Readonly<{
    count: number;
    hasLocalBadgeSource: boolean;
    isDataReady: boolean;
    showNonNumericDot: boolean;
}>;

export type LocalActivityBadgeSnapshotSelectorParams = Readonly<{
    badgesEnabled: boolean;
    friendRequestCount: number;
    hasNonNumericInboxAttention: boolean;
    sessionOptions: ActivityBadgeSessionOptions;
}>;

type SignatureCacheEntry<T> = Readonly<{
    signature: string;
    value: T;
}>;

function readNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : null;
}

function readFreshnessBit(value: unknown, nowMs: number): 0 | 1 {
    const timestamp = readNumber(value);
    return isFreshTimestamp(timestamp, nowMs, SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS) ? 1 : 0;
}

function readRequestSignature(value: unknown): string {
    if (!value || typeof value !== 'object') return '';
    const requests = value as Record<string, {
        createdAt?: unknown;
        kind?: unknown;
        tool?: unknown;
    }>;
    return collectRecordIds(requests).sort().map((requestId) => {
        const request = requests[requestId];
        return [
            requestId,
            typeof request?.tool === 'string' ? request.tool : '',
            typeof request?.kind === 'string' ? request.kind : '',
            readNumber(request?.createdAt) ?? '',
        ].join(':');
    }).join('|');
}

function readCompletedRequestSignature(value: unknown): string {
    if (!value || typeof value !== 'object') return '';
    const completed = value as Record<string, { completedAt?: unknown; createdAt?: unknown }>;
    return collectRecordIds(completed).sort().map((requestId) => {
        const request = completed[requestId];
        return [
            requestId,
            readNumber(request?.completedAt) ?? '',
            readNumber(request?.createdAt) ?? '',
        ].join(':');
    }).join('|');
}

function hasCompletedRequest(completedValue: unknown, requestId: string): boolean {
    if (!completedValue || typeof completedValue !== 'object') return false;
    const completed = completedValue as Record<string, { completedAt?: unknown } | undefined>;
    return completed[requestId]?.completedAt != null;
}

function readLatestPendingAgentRequestCreatedAt(value: unknown, completedValue: unknown): number | null {
    if (!value || typeof value !== 'object') return null;
    const requests = value as Record<string, { createdAt?: unknown } | undefined>;
    let latest: number | null = null;
    for (const requestId in requests) {
        if (!Object.prototype.hasOwnProperty.call(requests, requestId)) continue;
        if (hasCompletedRequest(completedValue, requestId)) continue;
        const createdAt = readNumber(requests[requestId]?.createdAt);
        if (createdAt === null) continue;
        latest = latest === null ? createdAt : Math.max(latest, createdAt);
    }
    return latest;
}

function hasProjectedPendingRequestCounts(session: Session): boolean {
    return typeof session.pendingPermissionRequestCount === 'number'
        || typeof session.pendingUserActionRequestCount === 'number';
}

function hasPendingAgentRequests(session: Session): boolean {
    return hasRecordValues(session.agentState?.requests ?? {});
}

function buildParamsSignature(params: LocalActivityBadgeSnapshotSelectorParams): string {
    return [
        params.badgesEnabled === true ? 1 : 0,
        Math.max(0, Math.trunc(params.friendRequestCount)),
        params.hasNonNumericInboxAttention === true ? 1 : 0,
        params.sessionOptions.showUnread === false ? 0 : 1,
        params.sessionOptions.showPendingPermissionRequests === false ? 0 : 1,
        params.sessionOptions.showPendingUserActionRequests === false ? 0 : 1,
    ].join('\u001f');
}

function buildSessionActivitySignature(session: Session): string {
    const metadata = session.metadata;
    const readState = metadata?.readStateV1;
    const agentState = session.agentState;
    return [
        session.id,
        session.active === true ? 1 : 0,
        readNumber(session.activeAt) ?? '',
        session.presence,
        session.thinking === true ? 1 : 0,
        readNumber(session.thinkingAt) ?? '',
        session.latestTurnStatus ?? '',
        readNumber(session.latestTurnStatusObservedAt) ?? '',
        readNumber(session.meaningfulActivityAt) ?? '',
        readNumber(session.seq) ?? '',
        readNumber(session.updatedAt) ?? '',
        readNumber(session.latestReadyEventSeq) ?? '',
        readNumber(session.lastViewedSessionSeq) ?? '',
        readNumber(readState?.sessionSeq) ?? '',
        readNumber(readState?.pendingActivityAt) ?? '',
        metadata?.systemSessionV1?.hidden === true ? 1 : 0,
        readNumber(session.pendingBlockedCount) ?? '',
        readNumber(session.pendingPermissionRequestCount) ?? '',
        readNumber(session.pendingUserActionRequestCount) ?? '',
        readNumber(session.pendingRequestObservedAt) ?? '',
        readRequestSignature(agentState?.requests),
        readCompletedRequestSignature(agentState?.completedRequests),
    ].join('\u001f');
}

function buildRenderableActivitySignature(renderable: SessionListRenderableSession): string {
    const metadata = renderable.metadata;
    const readState = metadata?.readStateV1;
    return [
        renderable.id,
        readNumber(renderable.seq) ?? '',
        renderable.hasUnreadMessages === true ? 1 : 0,
        renderable.metadataUnavailable === true ? 1 : 0,
        metadata?.hiddenSystemSession === true ? 1 : 0,
        readNumber(readState?.sessionSeq) ?? '',
        readNumber(readState?.pendingActivityAt) ?? '',
        renderable.active === true ? 1 : 0,
        readNumber(renderable.activeAt) ?? '',
        renderable.presence,
        renderable.thinking === true ? 1 : 0,
        readNumber(renderable.thinkingAt) ?? '',
        renderable.latestTurnStatus ?? '',
        readNumber(renderable.latestTurnStatusObservedAt) ?? '',
        readNumber(renderable.meaningfulActivityAt) ?? '',
        renderable.hasPendingPermissionRequests === true ? 1 : 0,
        renderable.hasPendingUserActionRequests === true ? 1 : 0,
        readNumber(renderable.pendingRequestObservedAt) ?? '',
        readNumber(renderable.pendingBlockedCount) ?? '',
    ].join('\u001f');
}

function buildSessionMessagesActivitySignature(
    sessionMessages: StorageState['sessionMessages'][string] | undefined,
): string {
    if (!sessionMessages) return '';
    return [
        sessionMessages.isLoaded === true ? 1 : 0,
        readNumber(sessionMessages.messagesVersion) ?? '',
        readNumber(sessionMessages.latestReadyEventSeq) ?? '',
        readNumber(sessionMessages.latestReadyEventAt) ?? '',
        sessionMessages.messageIdsOldestFirst.length,
    ].join('\u001f');
}

function buildRuntimeFreshnessSignature(
    session: Session,
    nowMs: number,
    transcriptPendingRequestObservedAt: number | null,
): string {
    const agentState = session.agentState;
    const pendingRequestObservedAt =
        readLatestPendingAgentRequestCreatedAt(agentState?.requests, agentState?.completedRequests)
        ?? readNumber(session.pendingRequestObservedAt)
        ?? transcriptPendingRequestObservedAt;

    return [
        readFreshnessBit(session.thinkingAt, nowMs),
        readFreshnessBit(session.latestTurnStatusObservedAt, nowMs),
        readFreshnessBit(session.meaningfulActivityAt, nowMs),
        readFreshnessBit(pendingRequestObservedAt, nowMs),
    ].join(':');
}

function buildRenderableRuntimeFreshnessSignature(
    renderable: SessionListRenderableSession,
    nowMs: number,
): string {
    return [
        readFreshnessBit(renderable.thinkingAt, nowMs),
        readFreshnessBit(renderable.latestTurnStatusObservedAt, nowMs),
        readFreshnessBit(renderable.meaningfulActivityAt, nowMs),
        readFreshnessBit(renderable.pendingRequestObservedAt, nowMs),
    ].join(':');
}

function buildCachedRecordSignature<T>(
    record: Readonly<Record<string, T>>,
    cache: Map<string, SignatureCacheEntry<T>>,
    buildValueSignature: (value: T, id: string) => string,
): string {
    const ids = collectRecordIds(record).sort();
    for (const cachedId of cache.keys()) {
        if (!Object.prototype.hasOwnProperty.call(record, cachedId)) {
            cache.delete(cachedId);
        }
    }
    return ids.map((id) => {
        const value = record[id];
        const cached = cache.get(id);
        const signature = cached !== undefined && cached.value === value
            ? cached.signature
            : buildValueSignature(value, id);
        if (cached?.value !== value) {
            cache.set(id, { signature, value });
        }
        return `${id}\u001e${signature}`;
    }).join('\u001d');
}

function buildSessionMessagesRecordSignature(
    sessions: Readonly<Record<string, Session>>,
    sessionMessages: StorageState['sessionMessages'],
    cache: Map<string, SignatureCacheEntry<StorageState['sessionMessages'][string]>>,
): string {
    const ids = collectRecordIds(sessions).sort();
    for (const cachedId of cache.keys()) {
        if (!Object.prototype.hasOwnProperty.call(sessions, cachedId)) {
            cache.delete(cachedId);
        }
    }
    return ids.map((id) => {
        const value = sessionMessages[id];
        const cached = cache.get(id);
        const signature = cached !== undefined && cached.value === value
            ? cached.signature
            : buildSessionMessagesActivitySignature(value);
        if (value) {
            cache.set(id, { signature, value });
        } else {
            cache.delete(id);
        }
        return `${id}\u001e${signature}`;
    }).join('\u001d');
}

function needsTranscriptPendingFreshnessProbe(
    session: Session,
    sessionMessages: StorageState['sessionMessages'][string] | undefined,
): boolean {
    return session.active === true
        && session.presence === 'online'
        && sessionMessages?.isLoaded === true
        && readNumber(session.pendingRequestObservedAt) === null
        && !hasProjectedPendingRequestCounts(session)
        && !hasPendingAgentRequests(session);
}

function buildRuntimeFreshnessRecordSignature(
    sessions: Readonly<Record<string, Session>>,
    sessionMessages: StorageState['sessionMessages'],
    nowMs: number,
    pendingRequestObservedAtCache: Map<string, PendingRequestObservedAtCacheEntry>,
    sessionSignatureCache: ReadonlyMap<string, SignatureCacheEntry<Session>>,
    sessionMessagesSignatureCache: ReadonlyMap<string, SignatureCacheEntry<StorageState['sessionMessages'][string]>>,
): string {
    const ids = collectRecordIds(sessions).sort();
    prunePendingRequestObservedAtCache(pendingRequestObservedAtCache, new Set(ids));

    return ids.map((id) => {
        const session = sessions[id];
        const sessionMessagesForSession = sessionMessages[id];
        const sessionSignature = sessionSignatureCache.get(id)?.signature
            ?? buildSessionActivitySignature(session);
        const sessionMessagesSignature = sessionMessagesSignatureCache.get(id)?.signature
            ?? buildSessionMessagesActivitySignature(sessionMessagesForSession);
        const transcriptPendingRequestObservedAt = needsTranscriptPendingFreshnessProbe(
            session,
            sessionMessagesForSession,
        )
            ? readCachedPendingRequestObservedAt({
                cache: pendingRequestObservedAtCache,
                session,
                sessionMessages: sessionMessagesForSession,
                sessionSignature,
                sessionMessagesSignature,
            })
            : null;
        return `${id}\u001e${buildRuntimeFreshnessSignature(
            session,
            nowMs,
            transcriptPendingRequestObservedAt,
        )}`;
    }).join('\u001d');
}

export function createLocalActivityBadgeSnapshotSelector(
    params: LocalActivityBadgeSnapshotSelectorParams,
): (state: StorageState) => LocalActivityBadgeSnapshot {
    const paramsSignature = buildParamsSignature(params);
    const sessionSignatureCache = new Map<string, SignatureCacheEntry<Session>>();
    const renderableSignatureCache = new Map<string, SignatureCacheEntry<SessionListRenderableSession>>();
    const sessionMessagesSignatureCache = new Map<string, SignatureCacheEntry<StorageState['sessionMessages'][string]>>();
    const pendingRequestObservedAtCache = new Map<string, PendingRequestObservedAtCacheEntry>();
    let previousSignature: string | null = null;
    let previousSnapshot: LocalActivityBadgeSnapshot | null = null;

    return (state) => {
        const nowMs = Date.now();
        const hasLocalBadgeSource =
            hasRecordValues(state.sessions)
            || hasRecordValues(state.sessionListRenderables)
            || params.friendRequestCount > 0
            || params.hasNonNumericInboxAttention === true;
        const snapshotSignature = params.badgesEnabled
            ? [
                paramsSignature,
                state.isDataReady === true ? 1 : 0,
                hasLocalBadgeSource === true ? 1 : 0,
                buildCachedRecordSignature(state.sessions, sessionSignatureCache, buildSessionActivitySignature),
                buildCachedRecordSignature(
                    state.sessionListRenderables,
                    renderableSignatureCache,
                    buildRenderableActivitySignature,
                ),
                buildSessionMessagesRecordSignature(
                    state.sessions,
                    state.sessionMessages,
                    sessionMessagesSignatureCache,
                ),
                buildRuntimeFreshnessRecordSignature(
                    state.sessions,
                    state.sessionMessages,
                    nowMs,
                    pendingRequestObservedAtCache,
                    sessionSignatureCache,
                    sessionMessagesSignatureCache,
                ),
                buildCachedRecordSignature(
                    state.sessionListRenderables,
                    new Map(),
                    (renderable) => buildRenderableRuntimeFreshnessSignature(renderable, nowMs),
                ),
            ].join('\u001c')
            : [
                paramsSignature,
                state.isDataReady === true ? 1 : 0,
                hasLocalBadgeSource === true ? 1 : 0,
            ].join('\u001c');

        if (previousSignature === snapshotSignature && previousSnapshot) {
            return previousSnapshot;
        }

        if (!params.badgesEnabled) {
            previousSignature = snapshotSignature;
            previousSnapshot = {
                count: 0,
                hasLocalBadgeSource,
                isDataReady: state.isDataReady,
                showNonNumericDot: false,
            };
            return previousSnapshot;
        }

        const badgeSessions = resolveActivityAttentionSessionsFromRecords({
            sessionsById: state.sessions,
            sessionRowsById: state.sessionListRenderables,
        });
        const badgeState = buildActivityBadgeState({
            sessions: badgeSessions,
            numericInboxCount: params.friendRequestCount,
            hasNonNumericInboxAttention: params.hasNonNumericInboxAttention,
            sessionOptions: {
                ...params.sessionOptions,
                sessionMessagesById: state.sessionMessages,
                nowMs,
            },
        });

        previousSignature = snapshotSignature;
        previousSnapshot = {
            count: badgeState.count,
            hasLocalBadgeSource,
            isDataReady: state.isDataReady,
            showNonNumericDot: badgeState.showNonNumericDot,
        };
        return previousSnapshot;
    };
}
