import type {
    PrimaryTurnStatusV1,
    SessionRuntimeActivitySourceClassV1,
} from '@happier-dev/protocol';
import {
    isSessionRuntimeActivityProjectionIdleForPendingDrain,
} from '@happier-dev/protocol';

export const SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS = 120_000;

/**
 * Bounded lifetime of the explicit client-owned "resuming" lifecycle marker.
 * A resume is initiated locally (the app calls the resume op); the marker is set at
 * initiation and cleared on the first post-attach activity. This bound guarantees a
 * crashed/never-settling resume cannot latch the indicator forever.
 */
export const SESSION_RESUMING_PRESENTATION_TIMEOUT_MS = 30_000;

export type SessionRuntimeActivityPresentationState = 'idle' | 'working' | 'backgroundActive';

export type SessionRuntimePresentationState = Readonly<{
    isOnline: boolean;
    isActive: boolean;
    hasTerminalMaterializedTurnStatus: boolean;
    terminalStatus: PrimaryTurnStatusV1 | null;
    freshThinking: boolean;
    freshInProgress: boolean;
    freshProviderRuntimeActivity: boolean;
    working: boolean;
    backgroundActive: boolean;
    activityState: SessionRuntimeActivityPresentationState;
    runtimeProjectionInProgress: boolean;
    runtimeActivelyWorking: boolean;
    freshPermissionRequired: boolean;
    freshActionRequired: boolean;
}>;

export type DeriveSessionRuntimePresentationStateInput = Readonly<{
    active?: boolean | null;
    activeAt?: number | null;
    presence?: unknown;
    thinking?: boolean | null;
    thinkingAt?: number | null;
    latestTurnStatus?: PrimaryTurnStatusV1 | null;
    latestTurnStatusObservedAt?: number | null;
    latestReadyEventAt?: number | null;
    runtimeActivityActiveCount?: number | null;
    runtimeActivityObservedAt?: number | null;
    runtimeActivityExpiresAt?: number | null;
    runtimeActivitySourceClass?: SessionRuntimeActivitySourceClassV1 | null;
    meaningfulActivityAt?: number | null;
    hasPendingPermissionRequests?: boolean | null;
    hasPendingUserActionRequests?: boolean | null;
    pendingRequestObservedAt?: number | null;
}>;

export type SessionRuntimePresenceFields = Readonly<{
    thinking: boolean;
    thinkingAt: number;
}>;

export function isFreshTimestamp(
    timestamp: number | null | undefined,
    nowMs: number,
    budgetMs: number,
): boolean {
    return typeof timestamp === 'number'
        && Number.isFinite(timestamp)
        && timestamp > 0
        && timestamp + budgetMs > nowMs;
}

export function deriveSessionRuntimePresentationState(
    input: DeriveSessionRuntimePresentationStateInput,
    nowMs: number,
): SessionRuntimePresentationState {
    const latestTurnStatus = input.latestTurnStatus ?? null;
    const freshInProgressSignals = readFreshInProgressRuntimeSignalTimestamps(input, nowMs);
    const thinkingAt = normalizeRuntimeStatusTimestamp(input.thinkingAt);
    const isOnline = input.presence === 'online';
    const isActive = input.active === true;
    const isLiveRuntime = isActive && isOnline;
    const hasTerminalMaterializedTurnStatus = isTerminalPrimaryTurnStatus(latestTurnStatus);
    const blocksLegacyThinking = isLegacyThinkingBlockedByTurnProjection(latestTurnStatus);
    const freshThinking =
        input.thinking === true
        && isLiveRuntime
        && isFreshTimestamp(thinkingAt, nowMs, SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS)
        && !blocksLegacyThinking;
    const freshInProgress = freshInProgressSignals.length > 0;
    const freshProviderRuntimeActivity = hasFreshProviderRuntimeActivity(input, nowMs);
    const freshForegroundProviderRuntimeActivity =
        freshProviderRuntimeActivity && isForegroundProviderRuntimeActivity(input, latestTurnStatus);
    const working = freshInProgress || freshThinking || freshForegroundProviderRuntimeActivity;
    const backgroundActive = !working && freshProviderRuntimeActivity;
    const pendingRequestObservedAt = normalizeRuntimeStatusTimestamp(input.pendingRequestObservedAt);
    const hasFreshPendingRequest =
        pendingRequestObservedAt !== null
        && isFreshTimestamp(pendingRequestObservedAt, nowMs, SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS);
    const activityState: SessionRuntimeActivityPresentationState = working
        ? 'working'
        : backgroundActive
            ? 'backgroundActive'
            : 'idle';
    const runtimeActivelyWorking = isLiveRuntime && working;

    return {
        isOnline,
        isActive,
        hasTerminalMaterializedTurnStatus,
        terminalStatus: hasTerminalMaterializedTurnStatus ? latestTurnStatus : null,
        freshThinking,
        freshInProgress,
        freshProviderRuntimeActivity,
        working,
        backgroundActive,
        activityState,
        runtimeProjectionInProgress: freshInProgress,
        runtimeActivelyWorking,
        freshPermissionRequired:
            input.hasPendingPermissionRequests === true
            && isLiveRuntime
            && (working || hasFreshPendingRequest),
        freshActionRequired:
            input.hasPendingUserActionRequests === true
            && isLiveRuntime
            && (working || hasFreshPendingRequest),
    };
}

export function readFreshInProgressRuntimeSignalTimestamps(
    input: DeriveSessionRuntimePresentationStateInput,
    nowMs: number,
): readonly number[] {
    const latestTurnStatus = input.latestTurnStatus ?? null;
    const latestTurnStatusObservedAt = normalizeRuntimeStatusTimestamp(input.latestTurnStatusObservedAt);
    if (latestTurnStatus !== 'in_progress' || latestTurnStatusObservedAt === null) return [];

    const timestamps: number[] = [];
    if (isFreshTimestamp(latestTurnStatusObservedAt, nowMs, SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS)) {
        timestamps.push(latestTurnStatusObservedAt);
    }
    const activeAt = normalizeRuntimeStatusTimestamp(input.activeAt);
    if (
        input.active === true
        && input.presence === 'online'
        && activeAt !== null
        && activeAt >= latestTurnStatusObservedAt
        && isFreshTimestamp(activeAt, nowMs, SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS)
    ) {
        timestamps.push(activeAt);
    }
    return timestamps;
}

export function readSessionRuntimePresentationFreshnessTimestamps(
    input: DeriveSessionRuntimePresentationStateInput,
    nowMs: number,
): readonly number[] {
    const runtimeStatus = deriveSessionRuntimePresentationState(input, nowMs);
    const timestamps: number[] = [];
    if (runtimeStatus.freshThinking) {
        const thinkingAt = normalizeRuntimeStatusTimestamp(input.thinkingAt);
        if (thinkingAt !== null) timestamps.push(thinkingAt);
    }
    timestamps.push(...readFreshInProgressRuntimeSignalTimestamps(input, nowMs));
    if (runtimeStatus.freshPermissionRequired || runtimeStatus.freshActionRequired) {
        const pendingRequestObservedAt = normalizeRuntimeStatusTimestamp(input.pendingRequestObservedAt);
        if (pendingRequestObservedAt !== null) timestamps.push(pendingRequestObservedAt);
    }
    if (runtimeStatus.freshProviderRuntimeActivity) {
        const runtimeActivityExpiresAt = normalizeRuntimeStatusTimestamp(input.runtimeActivityExpiresAt);
        if (runtimeActivityExpiresAt !== null && !isLiveRuntimeOwner(input)) {
            timestamps.push(Math.max(1, runtimeActivityExpiresAt - SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS));
        }
    }
    return timestamps;
}

export function resolveNextSessionRuntimePresentationFreshnessAtMs(
    input: DeriveSessionRuntimePresentationStateInput,
    nowMs: number,
): number | null {
    const expirations: number[] = [];
    for (const timestamp of readSessionRuntimePresentationFreshnessTimestamps(input, nowMs)) {
        if (!isFreshTimestamp(timestamp, nowMs, SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS)) continue;
        expirations.push(Math.trunc(timestamp) + SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS);
    }
    if (expirations.length === 0) return null;
    return Math.min(...expirations);
}

export function resolveSessionRuntimePresenceFields(
    input: Pick<DeriveSessionRuntimePresentationStateInput,
        'thinking' | 'thinkingAt' | 'latestTurnStatus' | 'latestTurnStatusObservedAt'>,
): SessionRuntimePresenceFields {
    const thinkingAt = normalizeRuntimeStatusTimestamp(input.thinkingAt) ?? 0;
    const latestTurnStatus = input.latestTurnStatus ?? null;
    if (isTerminalPrimaryTurnStatus(latestTurnStatus)) {
        return {
            thinking: false,
            thinkingAt: normalizeRuntimeStatusTimestamp(input.latestTurnStatusObservedAt) ?? thinkingAt,
        };
    }
    return {
        thinking: input.thinking === true,
        thinkingAt,
    };
}

export function isTerminalPrimaryTurnStatus(status: PrimaryTurnStatusV1 | null): boolean {
    return status === 'completed' || status === 'cancelled' || status === 'failed';
}

function isLegacyThinkingBlockedByTurnProjection(latestTurnStatus: PrimaryTurnStatusV1 | null): boolean {
    return isTerminalPrimaryTurnStatus(latestTurnStatus);
}

function normalizeRuntimeStatusTimestamp(value: number | null | undefined): number | null {
    return typeof value === 'number' && Number.isFinite(value) && value > 0
        ? Math.trunc(value)
        : null;
}

function normalizeRuntimeActivityActiveCount(value: number | null | undefined): number {
    return typeof value === 'number' && Number.isFinite(value)
        ? Math.max(0, Math.trunc(value))
        : 0;
}

function hasFreshProviderRuntimeActivity(
    input: DeriveSessionRuntimePresentationStateInput,
    nowMs: number,
): boolean {
    if (normalizeRuntimeActivityActiveCount(input.runtimeActivityActiveCount) <= 0) return false;
    return !isSessionRuntimeActivityProjectionIdleForPendingDrain(input, nowMs, {
        ownerLive: isLiveRuntimeOwner(input),
    });
}

function isLiveRuntimeOwner(input: DeriveSessionRuntimePresentationStateInput): boolean {
    return input.active === true && input.presence === 'online';
}

function isForegroundProviderRuntimeActivity(
    input: DeriveSessionRuntimePresentationStateInput,
    latestTurnStatus: PrimaryTurnStatusV1 | null,
): boolean {
    return !(
        input.runtimeActivitySourceClass === 'provider_detached_task'
        && isTerminalPrimaryTurnStatus(latestTurnStatus)
    );
}
