import { resolveActivityAttentionSessionsFromRecords } from '@/activity/attention/activityAttentionSessions';
import {
    createRenderableRuntimeFreshnessLedger,
    createSessionRuntimeFreshnessLedger,
    createSessionSignatureLedger,
    isBeforeFreshnessBoundary,
} from '@/activity/attention/sessionAttentionSignatureLedger';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import type { Session } from '@/sync/domains/state/storageTypes';
import type { StorageState } from '@/sync/store/types';
import { collectRecordIds } from '@/sync/store/sessionRecordProjection';
import {
    hasInboxSessionContentForRecords,
    type InboxSessionContentRecordInput,
} from './buildInboxSessionState';

type InboxSessionContentEvaluator = (input: InboxSessionContentRecordInput) => boolean;

function readNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : null;
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

type InboxSourceIdentity = Readonly<{
    sessions: StorageState['sessions'];
    sessionListRenderables: StorageState['sessionListRenderables'];
    sessionMessages: StorageState['sessionMessages'];
    deltaRevision: number | null;
}>;

export function createInboxSessionContentSelector(
    evaluateInboxSessionContent: InboxSessionContentEvaluator = hasInboxSessionContentForRecords,
): (state: StorageState) => boolean {
    const sessionLedger = createSessionSignatureLedger<Session>(buildSessionInboxSignature);
    const renderableLedger = createSessionSignatureLedger<SessionListRenderableSession>(
        buildRenderableInboxSignature,
    );
    const sessionMessagesLedger = createSessionSignatureLedger<StorageState['sessionMessages'][string] | undefined>(
        buildSessionMessagesInboxSignature,
    );
    const sessionFreshnessLedger = createSessionRuntimeFreshnessLedger();
    const renderableFreshnessLedger = createRenderableRuntimeFreshnessLedger();
    // Which sessions currently carry inbox content. The dot is `size > 0`, so a
    // wave only has to re-evaluate the sessions it actually moved — including
    // the case where the dot is already showing and the changed session has no
    // content, which previously forced a rescan of the whole account.
    const contentSessionIds = new Set<string>();
    // Whether `contentSessionIds` holds every session. Only a full derivation
    // establishes that; until it has run once, an incremental update would be
    // applied to an empty set and report no content.
    let hasSeededContentCache = false;
    let previousSignature: string | null = null;
    let previousDeltaRevision: number | null = null;
    let previousSourceIdentity: InboxSourceIdentity | null = null;
    let previousResult = false;

    const evaluateSession = (state: StorageState, sessionId: string, nowMs: number): boolean => {
        const session = state.sessions[sessionId];
        const renderable = state.sessionListRenderables[sessionId];
        if (!session && !renderable) return false;
        return evaluateInboxSessionContent({
            sessionsById: session ? { [sessionId]: session } : {},
            sessionRowsById: renderable ? { [sessionId]: renderable } : {},
            sessionMessagesById: state.sessionMessages,
            nowMs,
        });
    };

    // Every input that can move one session's inbox content is covered by exactly
    // one ledger, so the union of their change sets is the complete set of
    // sessions whose contribution can have moved this wave.
    const collectLedgerChangedSessionIds = (): readonly string[] => {
        const ids = new Set<string>();
        for (const id of sessionLedger.readChangedIds()) ids.add(id);
        for (const id of renderableLedger.readChangedIds()) ids.add(id);
        for (const id of sessionMessagesLedger.readChangedIds()) ids.add(id);
        for (const id of sessionFreshnessLedger.readChangedIds()) ids.add(id);
        for (const id of renderableFreshnessLedger.readChangedIds()) ids.add(id);
        return [...ids];
    };

    const rebuildContentSessionIds = (state: StorageState, nowMs: number): boolean => {
        hasSeededContentCache = true;
        contentSessionIds.clear();
        for (const session of resolveActivityAttentionSessionsFromRecords({
            sessionsById: state.sessions,
            sessionRowsById: state.sessionListRenderables,
        })) {
            if (evaluateSession(state, session.id, nowMs)) contentSessionIds.add(session.id);
        }
        return contentSessionIds.size > 0;
    };

    const applyContentDelta = (
        state: StorageState,
        changedSessionIds: readonly string[],
        removedSessionIds: readonly string[],
        nowMs: number,
    ): boolean => {
        for (const sessionId of removedSessionIds) {
            contentSessionIds.delete(sessionId);
        }
        for (const sessionId of changedSessionIds) {
            if (evaluateSession(state, sessionId, nowMs)) {
                contentSessionIds.add(sessionId);
            } else {
                contentSessionIds.delete(sessionId);
            }
        }
        return contentSessionIds.size > 0;
    };

    return (state: StorageState): boolean => {
        const nowMs = Date.now();
        const delta = state.sessionListRenderableDelta;
        const deltaRevision = delta?.revision ?? null;
        // Runtime freshness is the only input that moves without the store
        // moving, so every reuse path below stays inside the earliest recorded
        // freshness boundary.
        const isFreshnessStable = isBeforeFreshnessBoundary(nowMs, [
            sessionFreshnessLedger.readNextBoundaryAtMs(),
            renderableFreshnessLedger.readNextBoundaryAtMs(),
        ]);

        // A store notification that moved none of this selector's inputs cannot
        // change the dot, so it must cost O(1) rather than a derivation pass.
        if (
            previousSignature !== null
            && previousSourceIdentity !== null
            && previousSourceIdentity.sessions === state.sessions
            && previousSourceIdentity.sessionListRenderables === state.sessionListRenderables
            && previousSourceIdentity.sessionMessages === state.sessionMessages
            && previousSourceIdentity.deltaRevision === deltaRevision
            && isFreshnessStable
        ) {
            return previousResult;
        }
        previousSourceIdentity = {
            sessions: state.sessions,
            sessionListRenderables: state.sessionListRenderables,
            sessionMessages: state.sessionMessages,
            deltaRevision,
        };

        const canApplyDelta = hasSeededContentCache
            && previousSignature !== null
            && isFreshnessStable
            && delta
            && previousDeltaRevision !== null
            && delta.revision !== previousDeltaRevision
            && delta.rebuiltSessionListViewData !== true;
        if (canApplyDelta) {
            previousDeltaRevision = delta.revision;
            previousResult = applyContentDelta(
                state,
                delta.changedSessionIds,
                delta.removedSessionIds,
                nowMs,
            );
            previousSignature = `${delta.revision}${previousResult ? 1 : 0}`;
            return previousResult;
        }

        const sessionRevision = sessionLedger.sync(state.sessions, (id) => state.sessions[id]);
        const renderableRevision = renderableLedger.sync(
            state.sessionListRenderables,
            (id) => state.sessionListRenderables[id],
        );
        const sessionMessagesRevision = sessionMessagesLedger.sync(
            state.sessions,
            (id) => state.sessionMessages[id],
        );
        const sessionFreshnessRevision = sessionFreshnessLedger.sync({
            sessions: state.sessions,
            sessionMessages: state.sessionMessages,
            nowMs,
            readSessionSignature: sessionLedger.readSignature,
            readSessionMessagesSignature: sessionMessagesLedger.readSignature,
        });
        const renderableFreshnessRevision = renderableFreshnessLedger.sync(
            state.sessionListRenderables,
            nowMs,
        );
        const nextSignature = [
            sessionRevision,
            renderableRevision,
            sessionMessagesRevision,
            sessionFreshnessRevision,
            renderableFreshnessRevision,
        ].join('');
        if (previousSignature === nextSignature) {
            return previousResult;
        }

        if (previousSignature !== null) {
            const changedSessionIds = new Set<string>([
                ...sessionLedger.readChangedIds(),
                ...renderableLedger.readChangedIds(),
                ...sessionMessagesLedger.readChangedIds(),
                ...sessionFreshnessLedger.readChangedIds(),
                ...renderableFreshnessLedger.readChangedIds(),
            ]);
            previousSignature = nextSignature;
            previousDeltaRevision = deltaRevision;
            previousResult = applyContentDelta(state, [...changedSessionIds], [], nowMs);
            return previousResult;
        }

        // The ledgers just told us exactly which sessions moved, so only the very
        // first evaluation has to derive the whole account.
        const changedSessionIds = hasSeededContentCache ? collectLedgerChangedSessionIds() : null;
        previousSignature = nextSignature;
        previousDeltaRevision = deltaRevision;
        previousResult = changedSessionIds
            ? applyContentDelta(state, changedSessionIds, [], nowMs)
            : rebuildContentSessionIds(state, nowMs);
        return previousResult;
    };
}
