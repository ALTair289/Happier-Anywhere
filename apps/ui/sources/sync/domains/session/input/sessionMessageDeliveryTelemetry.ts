import type { Session } from '@/sync/domains/state/storageTypes';
import {
    syncReliabilityTelemetry,
    type SyncReliabilityTelemetry,
} from '@/sync/runtime/syncReliabilityTelemetry';
import { deriveSessionRuntimePresentationState } from '@/sync/domains/session/attention/deriveSessionRuntimePresentationState';
import {
    isVersionSupported,
    MINIMUM_CLI_PENDING_QUEUE_V2_VERSION,
} from '@/utils/system/versionUtils';

import { DEFAULT_BUSY_STEER_SEND_POLICY, type BusySteerSendPolicy, type MessageSendMode } from '../control/submitMode';

type PendingSupportState =
    | 'supported'
    | 'unknown_session'
    | 'unknown_pending_version'
    | 'unsupported_cli_version';

function getPendingSupportState(session: Session | null): PendingSupportState {
    if (!session) {
        return 'unknown_session';
    }
    if (typeof session.pendingVersion !== 'number') {
        return 'unknown_pending_version';
    }

    const cliVersion = typeof session.metadata?.version === 'string' ? session.metadata.version.trim() : '';
    if (cliVersion && !isVersionSupported(cliVersion, MINIMUM_CLI_PENDING_QUEUE_V2_VERSION)) {
        return 'unsupported_cli_version';
    }

    return 'supported';
}

export function recordSessionMessageDeliveryDecision(params: Readonly<{
    sessionId: string;
    session: Session | null;
    selectedMode: MessageSendMode;
    decisionReason?: string | null;
    configuredMode: MessageSendMode;
    busySteerSendPolicy?: BusySteerSendPolicy;
    explicitMode?: MessageSendMode;
    forceImmediate?: boolean;
    callerSurface?: string | null;
    localId?: string | null;
    nowMs?: number;
    supportRefreshAttempted?: boolean;
    supportRefreshSucceeded?: boolean;
    telemetry?: SyncReliabilityTelemetry;
}>): void {
    const telemetry = params.telemetry ?? syncReliabilityTelemetry;
    const session = params.session;
    const runtimeStatus = deriveSessionRuntimePresentationState({
        active: session?.active,
        activeAt: session?.activeAt,
        presence: session?.presence,
        thinking: session?.thinking,
        thinkingAt: session?.thinkingAt,
        latestTurnStatus: session?.latestTurnStatus,
        latestTurnStatusObservedAt: session?.latestTurnStatusObservedAt,
        meaningfulActivityAt: session?.meaningfulActivityAt,
    }, params.nowMs ?? Date.now());
    const capabilities = session?.agentState?.capabilities;
    const requestedMode = params.explicitMode ?? params.configuredMode;
    const cliVersion = typeof session?.metadata?.version === 'string' ? session.metadata.version.trim() : '';

    telemetry.record('ui.sessionMessage.delivery.decision', {
        sessionId: params.sessionId,
        callerSurface: params.callerSurface?.trim() || 'unknown',
        requestedLocalId: typeof params.localId === 'string' && params.localId.trim().length > 0
            ? params.localId
            : null,
        mode: params.selectedMode,
        decisionReason: params.decisionReason?.trim() || 'unknown',
        configuredMode: params.configuredMode,
        explicitMode: params.explicitMode ?? 'none',
        busySteerSendPolicy: params.busySteerSendPolicy ?? DEFAULT_BUSY_STEER_SEND_POLICY,
        forceImmediate: params.forceImmediate === true,
        pendingRequested: requestedMode === 'server_pending' || requestedMode === 'interrupt',
        pendingSupportState: getPendingSupportState(session),
        supportRefreshAttempted: params.supportRefreshAttempted === true,
        supportRefreshSucceeded: params.supportRefreshSucceeded === true,
        pendingVersionPresent: typeof session?.pendingVersion === 'number',
        cliVersion: cliVersion || 'unknown',
        active: session?.active === true,
        presence: String(session?.presence ?? 'unknown'),
        busy: runtimeStatus.working === true,
        agentReady: Boolean(session && session.agentStateVersion > 0),
        controlledByUser: session?.agentState?.controlledByUser === true,
        inFlightSteerSupported: (capabilities?.inFlightSteerSupported ?? capabilities?.inFlightSteer) === true,
        inFlightSteerAvailable: (capabilities?.inFlightSteerAvailable ?? capabilities?.inFlightSteer) === true,
    });
}
