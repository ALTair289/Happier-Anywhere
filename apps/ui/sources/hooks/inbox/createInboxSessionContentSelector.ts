import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import type { Session } from '@/sync/domains/state/storageTypes';
import type { StorageState } from '@/sync/store/types';
import {
    isFreshTimestamp,
    SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS,
} from '@/sync/domains/session/attention/deriveSessionRuntimePresentationState';
import {
    prunePendingRequestObservedAtCache,
    readCachedPendingRequestObservedAt,
    type PendingRequestObservedAtCacheEntry,
} from '@/sync/domains/session/pending/pendingRequestObservedAtCache';
import {
    collectRecordIds,
    hasRecordValues,
} from '@/sync/store/sessionRecordProjection';
import {
    hasInboxSessionContentForRecords,
    type InboxSessionContentRecordInput,
} from './buildInboxSessionState';

type InboxSessionContentEvaluator = (input: InboxSessionContentRecordInput) => boolean;

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
        tool?: unknown;
        kind?: unknown;
        createdAt?: unknown;
    }>;
    return collectRecordIds(requests).map((requestId) => {
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
    return collectRecordIds(completed).map((requestId) => {
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

function buildSessionInboxSignature(session: Session): string {
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
        readNumber(session.latestReadyEventSeq) ?? '',
        readNumber(session.latestReadyEventAt) ?? '',
        readNumber(session.lastViewedSessionSeq) ?? '',
        readNumber(readState?.sessionSeq) ?? '',
        readNumber(readState?.pendingActivityAt) ?? '',
        metadata?.systemSessionV1?.hidden === true ? 1 : 0,
        readNumber(session.pendingCount) ?? '',
        readNumber(session.pendingPermissionRequestCount) ?? '',
        readNumber(session.pendingUserActionRequestCount) ?? '',
        readNumber(session.pendingRequestObservedAt) ?? '',
        readRequestSignature(agentState?.requests),
        readCompletedRequestSignature(agentState?.completedRequests),
    ].join('\u001f');
}

function buildSessionMessagesInboxSignature(
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

function buildRenderableInboxSignature(renderable: SessionListRenderableSession): string {
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
        readNumber(renderable.pendingCount) ?? '',
    ].join('\u001f');
}

function buildCachedRecordSignature<T>(
    record: Readonly<Record<string, T>>,
    cache: Map<string, SignatureCacheEntry<T>>,
    buildValueSignature: (value: T) => string,
): string {
    const ids = collectRecordIds(record);
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
            : buildValueSignature(value);
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
    const ids = collectRecordIds(sessions);
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
            : buildSessionMessagesInboxSignature(value);
        if (value) {
            cache.set(id, { signature, value });
        } else {
            cache.delete(id);
        }
        return `${id}\u001e${signature}`;
    }).join('\u001d');
}

function buildRuntimeFreshnessRecordSignature(
    sessions: Readonly<Record<string, Session>>,
    sessionMessages: StorageState['sessionMessages'],
    nowMs: number,
    pendingRequestObservedAtCache: Map<string, PendingRequestObservedAtCacheEntry>,
    sessionSignatureCache: ReadonlyMap<string, SignatureCacheEntry<Session>>,
    sessionMessagesSignatureCache: ReadonlyMap<string, SignatureCacheEntry<StorageState['sessionMessages'][string]>>,
): string {
    const ids = collectRecordIds(sessions);
    prunePendingRequestObservedAtCache(pendingRequestObservedAtCache, new Set(ids));

    return ids.map((id) => {
        const session = sessions[id];
        const sessionMessagesForSession = sessionMessages[id];
        const sessionSignature = sessionSignatureCache.get(id)?.signature
            ?? buildSessionInboxSignature(session);
        const sessionMessagesSignature = sessionMessagesSignatureCache.get(id)?.signature
            ?? buildSessionMessagesInboxSignature(sessionMessagesForSession);
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

export function createInboxSessionContentSelector(
    evaluateInboxSessionContent: InboxSessionContentEvaluator = hasInboxSessionContentForRecords,
): (state: StorageState) => boolean {
    const sessionSignatureCache = new Map<string, SignatureCacheEntry<Session>>();
    const renderableSignatureCache = new Map<string, SignatureCacheEntry<SessionListRenderableSession>>();
    const sessionMessagesSignatureCache = new Map<string, SignatureCacheEntry<StorageState['sessionMessages'][string]>>();
    const pendingRequestObservedAtCache = new Map<string, PendingRequestObservedAtCacheEntry>();
    let previousSignature: string | null = null;
    let previousDeltaRevision: number | null = null;
    let previousResult = false;

    return (state: StorageState): boolean => {
        const nowMs = Date.now();
        const delta = state.sessionListRenderableDelta;
        const canApplyDelta = previousSignature !== null
            && delta
            && previousDeltaRevision !== null
            && delta.revision !== previousDeltaRevision
            && delta.rebuiltSessionListViewData !== true;
        if (canApplyDelta) {
            for (const sessionId of delta.changedSessionIds) {
                const nextResult = evaluateInboxSessionContent({
                    sessionsById: state.sessions[sessionId] ? { [sessionId]: state.sessions[sessionId] } : {},
                    sessionRowsById: state.sessionListRenderables[sessionId]
                        ? { [sessionId]: state.sessionListRenderables[sessionId] }
                        : {},
                    sessionMessagesById: state.sessionMessages,
                    nowMs,
                });
                if (nextResult) {
                    previousDeltaRevision = delta.revision;
                    previousResult = true;
                    previousSignature = `${delta.revision}\u001c1`;
                    return true;
                }
            }

            if (previousResult === false) {
                previousDeltaRevision = delta.revision;
                previousSignature = `${delta.revision}\u001c0`;
                return false;
            }
        }
        const nextSignature = [
            buildCachedRecordSignature(state.sessions, sessionSignatureCache, buildSessionInboxSignature),
            buildCachedRecordSignature(
                state.sessionListRenderables,
                renderableSignatureCache,
                buildRenderableInboxSignature,
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
        ].join('\u001c');
        if (previousSignature === nextSignature) {
            return previousResult;
        }

        previousSignature = nextSignature;
        previousDeltaRevision = delta?.revision ?? null;
        previousResult = evaluateInboxSessionContent({
            sessionsById: state.sessions,
            sessionRowsById: state.sessionListRenderables,
            sessionMessagesById: state.sessionMessages,
            nowMs,
        });
        return previousResult;
    };
}
