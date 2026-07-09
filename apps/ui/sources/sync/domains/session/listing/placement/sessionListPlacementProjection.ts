import {
    deriveSessionRuntimePresentationState,
    resolveNextSessionRuntimePresentationFreshnessAtMs,
} from '../../attention/deriveSessionRuntimePresentationState';
import type { SessionListAttentionPromotionReason } from '../attentionPromotion/sessionListAttentionPromotionTypes';
import { isSessionListReadyForReview } from '../sessionListReadyForReview';
import type { SessionListRenderableSession } from '../sessionListRenderable';
import {
    normalizeSessionListPlacementKey,
    normalizeSessionListWorkingRetentionKeys,
    shouldRetainSessionListWorkingPlacement,
    type SessionListWorkingRetentionKeySource,
} from './sessionListWorkingRetention';

export type SessionListPlacementKind = 'none' | 'working' | 'background_working' | SessionListAttentionPromotionReason;

/**
 * Item-level projection of a 'working' placement: 'working' means live
 * working signals, 'working-retained' means the session is held in the
 * working group by retention while its signals are stale (rows render a
 * paused indicator for it). Both count as working placement for grouping.
 */
export type SessionListWorkingPlacementReason = 'working' | 'working-retained' | 'background-working';

export function isSessionListWorkingPlacementReason(value: unknown): value is SessionListWorkingPlacementReason {
    return value === 'working' || value === 'working-retained' || value === 'background-working';
}

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
    separateBackgroundWork?: boolean;
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
    if (runtimeStatus.backgroundActive) {
        return createPlacement(params.separateBackgroundWork === true ? 'background_working' : 'working', null);
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

/**
 * Upper bound on freshness-boundary steps when comparing two placement
 * projections over time. Each step consumes at least one expiring freshness
 * signal of one of the two sessions (a session carries at most a handful),
 * so a walk that has not settled by then is treated as divergent for safety.
 */
const MAX_PLACEMENT_DIVERGENCE_BOUNDARY_STEPS = 12;

/**
 * Whether two renderables project to different placements at `nowMs` or at
 * ANY future freshness boundary. Placement is piecewise-constant in time:
 * with retention keys out of scope it only changes when a runtime freshness
 * signal expires, and those horizons come from the canonical
 * `resolveNextSessionRuntimePresentationFreshnessAtMs` resolver. Comparing at
 * a single instant is not enough — e.g. a mid-turn `latestTurnStatusObservedAt`
 * refresh keeps the placement 'working' NOW but extends the working window,
 * and missing it would leave stale timestamps in the committed view data.
 */
export function didSessionListPlacementProjectionDiverge(params: Readonly<{
    previous: SessionListRenderableSession;
    next: SessionListRenderableSession;
    nowMs: number;
}>): boolean {
    let atMs = params.nowMs;
    for (let step = 0; step < MAX_PLACEMENT_DIVERGENCE_BOUNDARY_STEPS; step += 1) {
        const previousPlacement = projectSessionListPlacement({ session: params.previous, nowMs: atMs });
        const nextPlacement = projectSessionListPlacement({ session: params.next, nowMs: atMs });
        if (
            previousPlacement.kind !== nextPlacement.kind
            || previousPlacement.timestamp !== nextPlacement.timestamp
        ) {
            return true;
        }
        const previousBoundary = resolveNextSessionRuntimePresentationFreshnessAtMs(params.previous, atMs);
        const nextBoundary = resolveNextSessionRuntimePresentationFreshnessAtMs(params.next, atMs);
        const boundary = previousBoundary === null
            ? nextBoundary
            : nextBoundary === null
                ? previousBoundary
                : Math.min(previousBoundary, nextBoundary);
        if (boundary === null) return false;
        // Defensive only: the freshness resolver returns boundaries strictly
        // beyond atMs (expiry = fresh timestamp + budget). Treat a
        // non-advancing boundary as divergent rather than looping.
        if (boundary <= atMs) return true;
        atMs = boundary;
    }
    return true;
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
