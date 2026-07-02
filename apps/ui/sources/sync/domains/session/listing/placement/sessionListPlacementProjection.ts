import { deriveSessionRuntimePresentationState } from '../../attention/deriveSessionRuntimePresentationState';
import type { SessionListAttentionPromotionReason } from '../attentionPromotion/sessionListAttentionPromotionTypes';
import { isSessionListReadyForReview } from '../sessionListReadyForReview';
import type { SessionListRenderableSession } from '../sessionListRenderable';
import {
    normalizeSessionListPlacementKey,
    normalizeSessionListWorkingRetentionKeys,
    shouldRetainSessionListWorkingPlacement,
    type SessionListWorkingRetentionKeySource,
} from './sessionListWorkingRetention';

export type SessionListPlacementKind = 'none' | 'working' | SessionListAttentionPromotionReason;

export type SessionListPlacementProjection = Readonly<{
    kind: SessionListPlacementKind;
    timestamp: number | null;
    retainedWorking: boolean;
}>;

export function projectSessionListPlacement(params: Readonly<{
    session: SessionListRenderableSession;
    nowMs: number;
    sessionKey?: string | null;
    retainedWorkingSessionKeys?: SessionListWorkingRetentionKeySource;
}>): SessionListPlacementProjection {
    const runtimeStatus = deriveSessionRuntimePresentationState(params.session, params.nowMs);
    if (runtimeStatus.freshActionRequired) {
        return createPlacement('action_required', resolveSessionListActionRequiredPlacementTimestamp(params.session));
    }
    if (runtimeStatus.freshPermissionRequired) {
        return createPlacement('permission_required', resolveSessionListActionRequiredPlacementTimestamp(params.session));
    }
    if ((params.session.pendingBlockedCount ?? 0) > 0) {
        return createPlacement('action_required', resolveSessionListActionRequiredPlacementTimestamp(params.session));
    }
    if (runtimeStatus.working) {
        return createPlacement('working', null);
    }
    if (isPrimarySessionFailure(params.session)) {
        return createPlacement(
            'failed',
            normalizePlacementTimestamp(
                params.session.lastRuntimeIssue?.occurredAt,
                params.session.latestTurnStatusObservedAt,
            ),
        );
    }
    if (isSessionListReadyForReview(params.session)) {
        return createPlacement(
            'ready',
            normalizePlacementTimestamp(
                params.session.latestReadyEventAt,
                params.session.latestTurnStatusObservedAt,
            ),
        );
    }

    const retainedWorking = shouldRetainSessionListWorkingPlacement({
        session: params.session,
        sessionKey: params.sessionKey ?? normalizeSessionListPlacementKey(null, params.session.id),
        retainedKeys: normalizeSessionListWorkingRetentionKeys(params.retainedWorkingSessionKeys),
        nowMs: params.nowMs,
    });
    return retainedWorking
        ? { kind: 'working', timestamp: null, retainedWorking: true }
        : { kind: 'none', timestamp: null, retainedWorking: false };
}

export function resolveSessionListActionRequiredPlacementTimestamp(session: Pick<
    SessionListRenderableSession,
    'pendingRequestObservedAt' | 'updatedAt' | 'createdAt'
>): number | null {
    return normalizePlacementTimestamp(
        session.pendingRequestObservedAt,
        session.updatedAt,
        session.createdAt,
    );
}

function createPlacement(
    kind: Exclude<SessionListPlacementKind, 'none'>,
    timestamp: number | null,
): SessionListPlacementProjection {
    return { kind, timestamp, retainedWorking: false };
}

function normalizePlacementTimestamp(...values: readonly unknown[]): number | null {
    for (const value of values) {
        if (typeof value === 'number' && Number.isFinite(value)) {
            return value;
        }
    }
    return null;
}

function isPrimarySessionFailure(session: SessionListRenderableSession): boolean {
    const issue = session.lastRuntimeIssue;
    return session.latestTurnStatus === 'failed'
        && issue?.v === 1
        && issue.scope === 'primary_session'
        && issue.status === 'failed'
        && shouldPromoteFailedSessionAttention(session);
}

function shouldPromoteFailedSessionAttention(session: SessionListRenderableSession): boolean {
    return session.active === true || session.hasUnreadMessages === true;
}
