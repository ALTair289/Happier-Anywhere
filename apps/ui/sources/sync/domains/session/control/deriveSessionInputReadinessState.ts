import type { PrimaryTurnStatusV1 } from '@happier-dev/protocol';

import {
    isFreshTimestamp,
    isTerminalPrimaryTurnStatus,
    readFreshInProgressRuntimeSignalTimestamps,
    SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS,
} from '@/sync/domains/session/attention/deriveSessionRuntimePresentationState';

export type SessionInputReadinessDisposition =
    | 'accepts_next_turn'
    | 'steer_available'
    | 'blocked'
    | 'offline';

export type SessionInputReadinessState = Readonly<{
    disposition: SessionInputReadinessDisposition;
    isInputBusy: boolean;
    canWakePendingQueue: boolean;
}>;

export type DeriveSessionInputReadinessStateInput = Readonly<{
    active?: boolean | null;
    activeAt?: number | null;
    presence?: unknown;
    thinking?: boolean | null;
    thinkingAt?: number | null;
    latestTurnStatus?: PrimaryTurnStatusV1 | null;
    latestTurnStatusObservedAt?: number | null;
    hasPendingPermissionRequests?: boolean | null;
    hasPendingUserActionRequests?: boolean | null;
    pendingRequestObservedAt?: number | null;
    inFlightSteerSupported?: boolean | null;
    inFlightSteerAvailable?: boolean | null;
}>;

export function deriveSessionInputReadinessState(
    input: DeriveSessionInputReadinessStateInput,
    nowMs: number,
): SessionInputReadinessState {
    const isOnline = input.active === true && input.presence === 'online';
    if (!isOnline) {
        return {
            disposition: 'offline',
            isInputBusy: false,
            canWakePendingQueue: false,
        };
    }

    const foregroundBusy = hasFreshForegroundRuntimeActivity(input, nowMs);
    const hasFreshPendingRequest = isFreshTimestamp(
        normalizeRuntimeStatusTimestamp(input.pendingRequestObservedAt),
        nowMs,
        SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS,
    );
    const hasRequestGate =
        (input.hasPendingPermissionRequests === true || input.hasPendingUserActionRequests === true)
        && (foregroundBusy || hasFreshPendingRequest);

    if (hasRequestGate) {
        return {
            disposition: 'blocked',
            isInputBusy: true,
            canWakePendingQueue: false,
        };
    }

    if (foregroundBusy) {
        return {
            disposition:
                input.inFlightSteerSupported === true && input.inFlightSteerAvailable === true
                    ? 'steer_available'
                    : 'blocked',
            isInputBusy: true,
            canWakePendingQueue: false,
        };
    }

    return {
        disposition: 'accepts_next_turn',
        isInputBusy: false,
        canWakePendingQueue: true,
    };
}

function hasFreshForegroundRuntimeActivity(
    input: DeriveSessionInputReadinessStateInput,
    nowMs: number,
): boolean {
    if (readFreshInProgressRuntimeSignalTimestamps(input, nowMs).length > 0) return true;

    const latestTurnStatus = input.latestTurnStatus ?? null;
    if (isTerminalPrimaryTurnStatus(latestTurnStatus)) return false;
    return input.thinking === true
        && input.active === true
        && input.presence === 'online'
        && isFreshTimestamp(
            normalizeRuntimeStatusTimestamp(input.thinkingAt),
            nowMs,
            SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS,
        );
}

function normalizeRuntimeStatusTimestamp(value: number | null | undefined): number | null {
    return typeof value === 'number' && Number.isFinite(value) && value > 0
        ? Math.trunc(value)
        : null;
}
