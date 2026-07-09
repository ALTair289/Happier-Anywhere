import { logger } from '@/ui/logger'
import { EventEmitter } from 'node:events'
import axios from 'axios';
import { Socket } from 'socket.io-client'
import { AgentState, ClientToServerEvents, MessageAckResponseSchema, MessageContent, Metadata, ServerToClientEvents, Session, SessionMessageContent, SessionMessageContentSchema, Update, UserMessage, UserMessageSchema, Usage } from '../types'
import { decodeBase64, decrypt, encodeBase64, encrypt } from '../encryption';
import {
    mergeDeliveredUserMessageSeqV1,
    mergeProviderAcceptedUserMessageSeqV1,
    mergeUserMessageDeliveryWatermarkModeV1,
    readDeliveredUserMessageSeqV1,
    readProviderAcceptedUserMessageSeqV1,
} from './deliveredUserMessageSeq';
import { backoff } from '@/utils/time';
import { LruSet } from '@/utils/collections/lru';
import { configuration } from '@/configuration';
import type { RawJSONLines } from '@/backends/claude/types';
import {
    buildClaudeJsonlLocalId,
    buildClaudeJsonlLocalIdFromMessageKey,
    buildClaudeJsonlMessageKey,
    extractClaudeJsonlMessageKeyFromLocalId,
    extractClaudeJsonlMessageKeyFromSessionContent,
    type CommittedClaudeJsonlMessageBaseline,
} from '@/backends/claude/utils/claudeJsonlMessageKey';
import { randomUUID } from 'node:crypto';
import { AsyncLock } from '@/utils/lock';
import { RpcHandlerManager } from '../rpc/RpcHandlerManager';
import { registerSessionHandlers } from '@/rpc/handlers/registerSessionHandlers';
import type { SessionRuntimeControls } from '@/rpc/handlers/sessionControls';
import { registerExecutionRunHandlers } from '@/rpc/handlers/executionRuns';
import { registerEphemeralTaskHandlers } from '@/rpc/handlers/ephemeralTasks';
import { emitSocketWithAck } from '@/session/transport/shared/socketAck';
import {
    fetchSessionSystemRecord as fetchSessionSystemRecordHttp,
    upsertSessionSystemRecord as upsertSessionSystemRecordHttp,
} from '@/session/transport/http/sessionSystemRecordsHttp';
import { createExecutionRunBackend } from '@/agent/executionRuns/runtime/createExecutionRunBackend';
import { ExecutionBudgetRegistry } from '@/daemon/executionBudget/ExecutionBudgetRegistry';
import { readCredentials, readAccountChangesCursor } from '@/persistence';
import { bootstrapAccountSettingsContext } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import { getActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { CATALOG_AGENT_IDS, type CatalogAgentId } from '@/backends/types';
import { addDiscardedCommittedMessageLocalIds } from '../queue/discardedCommittedMessageLocalIds';
import { fetchSessionSnapshotUpdateFromServer, shouldSyncSessionSnapshotOnConnect } from './snapshotSync';
import { createUserScopedSocket } from './sockets';
import { isToolTraceEnabled, recordAcpToolTraceEventIfNeeded, recordClaudeToolTraceEvents, recordCodexToolTraceEventIfNeeded } from './toolTrace';
import {
    createSessionRuntimeActivityPublisher,
    type SessionRuntimeActivityPublisher,
} from '@/session/runtimeActivity/sessionRuntimeActivityPublisher';
import {
    updateSessionAgentStateWithAck,
    updateSessionMetadataWithAck,
    updateSessionRuntimeActivityProjectionWithAck,
} from './stateUpdates';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import {
    isSessionContinuationRecoveryBlockingPendingDrain,
    readSessionUserMessageDeliveryIntentMeta,
    SESSION_RUNTIME_ACTIVITY_PROJECTION_LEASE_MS,
} from '@happier-dev/protocol';
import type {
    PrimaryTurnStatusV1,
    SessionMessageRole,
    SessionPendingQueueDeliveryTiming,
    SessionRuntimeActivitySourceClassV1,
    SessionSystemRecord,
    SessionSystemRecordNamespace,
    SessionSystemRecordUpsertRequest,
} from '@happier-dev/protocol';
import { calculateCost } from '@/utils/pricing';
import { buildAcpAgentMessageEnvelope, shouldTraceAcpMessageType } from './acpMessageEnvelope';
import { normalizeAcpSessionMessageBody, normalizeCodexSessionMessageBody } from './sessionOutboundMessageNormalization';
import {
    resolveAcpSessionMessageRole,
    resolveClaudeSessionMessageRole,
    resolveCodexSessionMessageRole,
    resolveSessionEventMessageRole,
} from './messageRole';
import { buildUsageReportFromAcpTokenCount } from './acpTokenCountUsageReport';
import {
    fetchLatestUserPermissionIntentFromEncryptedTranscript,
    fetchRecentTranscriptTextItemsForAcpImportFromServer,
} from './transcriptQueries';
import {
    discardPendingQueueV2Messages,
    enqueuePendingQueueV2MessageViaHttp,
    listPendingQueueV2LocalIdsFromServer,
    listPendingQueueV2ProviderDeliveryLocalIdsFromServer,
    materializeNextPendingQueueV2Message,
    blockPendingQueueV2Delivery,
    blockPendingQueueV2ProviderDeliveriesOnAttach,
    retryPendingQueueV2Delivery,
    reconcileAcceptedPendingQueueV2DeliveriesThroughSeq,
    resolveAcceptedPendingQueueV2Delivery,
    type PendingMaterializationDeliveryState,
    type PendingQueueDeliveryBlockedReason,
    type PendingQueueMaterializedMessage,
    type PendingQueueMaterializeNextResult,
} from './pendingQueueV2Transport';
import {
    resolvePendingQueueReconcileWhenEmpty,
    type PendingQueueReadOptions,
} from './pendingQueueReadPolicy';
import { waitForTranscriptEncryptedMessageByLocalId } from './transcriptMessageLookup';
import { catchUpSessionMessagesAfterSeq } from './sessionMessageCatchUp';
import { fetchEncryptedTranscriptMessagesPage } from '@/session/replay/fetchEncryptedTranscriptMessages';
import {
    isV2ChangesSyncEnabled,
    readSessionCatchUpAuthorization,
    runSessionChangesSyncOnConnect,
    type SessionCatchUpAuthorization,
    type SessionCatchUpRequest,
    type SessionChangesSyncReason,
} from './sessionChangesSyncOnConnect';
import { fetchChangesAccountId } from '../changes';
import { handleSessionNewMessageUpdate } from './sessionNewMessageUpdate';
import { handleSessionStateUpdate } from './sessionStateUpdateHandling';
import type { SessionSnapshotRefreshReasonInput } from './sessionSnapshotRefreshReason';
import {
    isActiveLatestTurnStatus,
    isTerminalTurnLifecycleEvent,
    latestTurnStatusForTurnLifecycleEvent,
    readLatestTurnStatusSnapshot,
    type LatestTurnStatusSnapshot,
    type SessionTurnLifecycleObserverEvent,
} from './sessionTurnStatusSnapshot';
import { createSessionSocketStaleSafetyScheduler, type SessionSocketStaleSafetyScheduler } from './sessionSocketStaleSafety';
import type { ACPMessageData, ACPProvider, SessionEventMessage } from './sessionMessageTypes';
import {
    createTurnAssistantTextSnapshotStore,
    extractTurnAssistantTextFromSessionContent,
    type TurnAssistantTextCandidate,
    type TurnAssistantTextSnapshot,
} from './turnAssistantTextSnapshot';
import { buildDaemonInitialPromptLocalId, consumeDaemonInitialPromptFromEnv } from '@/agent/runtime/daemonInitialPrompt';
import { resolveCliFeatureDecisionForServer } from '@/features/featureDecisionService';
import { createKeyedSingleFlightScheduler, type KeyedSingleFlightScheduler } from '../connection/scheduling';
import {
    createManagedConnectionSupervisor,
    DEFAULT_MANAGED_CONNECTION_POLICY,
    type ManagedConnectionState,
    type ManagedConnectionSupervisor,
    type ReadinessProbeResult,
} from '@happier-dev/connection-supervisor';
import { createLoopbackReadinessProbe } from '@/api/connection/createLoopbackReadinessProbe';
import { createSessionSocketTransport } from './connection/createSessionSocketTransport';
import { connectionState } from '@/api/offline/serverConnectionErrors';
import { isAuthenticationError, readAuthenticationStatus } from '@/api/client/httpStatusError';
import { serializeAxiosErrorForLog } from '@/api/client/serializeAxiosErrorForLog';
import { resolveServerHttpBaseUrl } from '@/session/transport/http/serverHttpBaseUrl';
import { resolveSessionControlSocketConnectTimeoutMs } from '@/session/transport/shared/sessionTimeouts';
import {
    executeExecutionRunAction,
    getExecutionRun,
    listExecutionRuns,
    sendExecutionRunMessage,
    startExecutionRun,
    stopExecutionRun,
    waitForExecutionRun,
} from '@/session/services/executionRuns';
import { normalizeExecutionRunWaitTimeoutMs } from '@/session/services/executionRunWaitTiming';
import { createEventShapeLoggerForLog } from '@/diagnostics/eventShapeForLog';
import { runSupervisedRequest } from '@/api/connection/requestSupervision/runSupervisedRequest';
import { updateMetadataBestEffort } from './sessionWritesBestEffort';
import { normalizeAgentPromptPayload } from '@/agent/core/AgentPromptPayload';
import type {
    MaterializeNextPendingResult,
    ProviderAcceptanceDeliveryOptions,
    ProviderAcceptancePendingMaterializationPolicy,
    SessionUserMessageDeliveryInfo,
    UserMessageProviderAcceptanceQuery,
} from './sessionClientPort';
import {
    CommittedUserMessageSeqTracker,
    type CommittedUserMessageSeqWaitOptions,
} from './committedUserMessageSeqTracker';
import {
    createSessionMutationOutbox,
    type SessionMutationOutbox,
} from './mutations/createSessionMutationOutbox';
import {
    createSessionEndMutation,
    createTranscriptMessageAppendMutation,
} from './mutations/sessionMutationTypes';
import { createSessionTurnLifecycle } from '@/agent/runtime/session/turn/lifecycle';
import { observeAcpLifecycleMarker } from '@/agent/runtime/session/turn/lifecycleMarkerAdapter';
import type { SessionTurnLifecycleController } from '@/agent/runtime/session/turn/types';
import { createSessionTurnMutationWriter } from '@/agent/runtime/session/turn/writer';
import { notifyDaemonConnectedServiceTurnLifecycle, notifyDaemonConnectedServiceUsageLimitWaitResumeCancel } from '@/daemon/controlClient';
import {
    applyKnownPendingQueueState,
    countMaterializablePendingRows,
    derivePendingQueueStateAfterMaterializeResult,
    readKnownPendingQueueState,
    UNKNOWN_PENDING_QUEUE_STATE,
    type KnownPendingQueueState,
    type PendingQueueState,
} from './pendingQueueState';
import {
    blocksPendingMaterializationDuringActiveTurn,
    type PendingMaterializationActiveTurnPolicy,
} from './pendingMaterializationActiveTurnPolicy';
import {
    resolvePendingQueueRuntimeActivityDeferral,
    type PendingQueueRuntimeActivityProjection,
} from '@/agent/runtime/sessionInput/pendingQueueDrainPolicy';
import type { ProviderOwnedUserMessageEchoClassifier } from './providerOwnedUserMessageEcho';

type RpcLifecycleRegistration = Readonly<{
    dispose: () => Promise<void>;
}>;

type SessionRuntimeControlKey = keyof SessionRuntimeControls;

function isExplicitCatchUpAuthorization(authorization: SessionCatchUpAuthorization | undefined): boolean {
    return authorization === 'explicit_cursor';
}

function isPositiveWatermarkCatchUpAuthorization(
    authorization: SessionCatchUpAuthorization | undefined,
    afterSeq: number | null,
): boolean {
    return (
        (authorization === 'reconnect_watermark' || authorization === 'startup_recovery')
        && afterSeq !== null
        && afterSeq > 0
    );
}

const STALE_LOCAL_ACTIVE_TURN_RECONCILE_MS = 5 * 60 * 1000;

function isProviderProgressTranscriptBody(value: unknown): boolean {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const role = (value as { role?: unknown }).role;
    return role !== 'user';
}

function readPlannedServerRestartRetryAfterMs(payload: unknown): number | undefined {
    if (!payload || typeof payload !== 'object') return undefined;
    const raw = (payload as { retryAfterMs?: unknown }).retryAfterMs;
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) return undefined;
    return Math.trunc(raw);
}

const SESSION_RUNTIME_CONTROL_KEYS = [
    'refreshGoal',
    'setGoal',
    'clearGoal',
    'listVendorPlugins',
    'listSkills',
    'startInlineReview',
    'invalidateConnectedServiceAuthTransports',
    'applyConnectedServiceAuthGeneration',
    'readConnectedServiceRuntimeIdentity',
    'enableUsageLimitWaitResume',
    'cancelUsageLimitWaitResume',
    'checkUsageLimitRecoveryNow',
    'clearTerminalComposer',
    'handleUserMessage',
    'materializeNextPendingMessageSafely',
] as const satisfies readonly SessionRuntimeControlKey[];

function copyCallableSessionRuntimeControls(
    target: Partial<SessionRuntimeControls>,
    controls: SessionRuntimeControls | Partial<SessionRuntimeControls> | null | undefined,
): void {
    if (!controls) return;
    const writableTarget = target as Record<SessionRuntimeControlKey, unknown>;
    const source = controls as Record<SessionRuntimeControlKey, unknown>;
    for (const key of SESSION_RUNTIME_CONTROL_KEYS) {
        const value = source[key];
        if (typeof value === 'function') writableTarget[key] = value;
    }
}

function clearSessionRuntimeControls(target: Partial<SessionRuntimeControls>): void {
    const writableTarget = target as Record<SessionRuntimeControlKey, unknown>;
    for (const key of SESSION_RUNTIME_CONTROL_KEYS) {
        delete writableTarget[key];
    }
}

function arePendingQueueStatesEqual(left: PendingQueueState, right: PendingQueueState): boolean {
    if (left.known !== right.known) return false;
    if (!left.known || !right.known) return true;
    return left.pendingCount === right.pendingCount
        && left.pendingBlockedCount === right.pendingBlockedCount
        && left.pendingVersion === right.pendingVersion;
}

type RuntimeActivityProjectionForPendingDrain = PendingQueueRuntimeActivityProjection & Readonly<{
    runtimeActivityObservedAt?: unknown;
    runtimeActivitySourceClass?: unknown;
}>;

function readRuntimeActivityProjectionForPendingDrain(value: unknown): RuntimeActivityProjectionForPendingDrain {
    if (!value || typeof value !== 'object') {
        return {};
    }
    const record = value as Record<string, unknown>;
    return {
        runtimeActivityActiveCount: record.runtimeActivityActiveCount,
        runtimeActivityObservedAt: record.runtimeActivityObservedAt,
        runtimeActivityExpiresAt: record.runtimeActivityExpiresAt,
        runtimeActivitySourceClass: record.runtimeActivitySourceClass,
    };
}

function hasRuntimeActivityProjectionFields(value: unknown): boolean {
    if (!value || typeof value !== 'object') return false;
    const record = value as Record<string, unknown>;
    return 'runtimeActivityActiveCount' in record
        || 'runtimeActivityObservedAt' in record
        || 'runtimeActivityExpiresAt' in record
        || 'runtimeActivitySourceClass' in record;
}

function resolveSessionSocketMachineIdForBootstrap(metadata: Metadata | null): string | undefined {
    if (!metadata || typeof metadata.machineId !== 'string') {
        return undefined;
    }
    const machineId = metadata.machineId.trim();
    return machineId.length > 0 ? machineId : undefined;
}

function readUnknownRecordProperty(value: unknown, key: string): unknown {
    if (!value || typeof value !== 'object') return undefined;
    return (value as Record<string, unknown>)[key];
}

function readHttpErrorResponseStatus(error: unknown): number | null {
    const status = axios.isAxiosError(error)
        ? error.response?.status
        : readUnknownRecordProperty(readUnknownRecordProperty(error, 'response'), 'status');
    return typeof status === 'number' && Number.isSafeInteger(status) ? status : null;
}

function readHttpErrorResponseErrorCode(error: unknown): string | null {
    const data = axios.isAxiosError(error)
        ? error.response?.data
        : readUnknownRecordProperty(readUnknownRecordProperty(error, 'response'), 'data');
    const raw = readUnknownRecordProperty(data, 'error');
    return typeof raw === 'string' && raw.trim() ? raw.trim() : null;
}

function isTerminalPendingDeliveryNotFound(error: unknown): boolean {
    return readHttpErrorResponseStatus(error) === 404
        && readHttpErrorResponseErrorCode(error) === 'not-found';
}

export function classifySessionTransportErrorToProbeResult(
    error: unknown,
): Exclude<ReadinessProbeResult, Readonly<{ status: 'ready' }>> | null {
    const statusCode = readAuthenticationStatus(error);
    if (!statusCode) return null;
    return {
        status: 'auth_failed',
        statusCode,
        errorMessage: error instanceof Error ? error.message : 'Authentication failed',
    };
}

const PENDING_DELIVERY_STATE_FEATURE_GATE_TIMEOUT_MS = 800;
const SESSION_CONNECTION_STATE_EVENT = 'session-connection-state';
const SESSION_PRESENCE_RECONNECT_REASSERT_DELAY_MS = 2_000;
const SESSION_CLIENT_RECEIVED_MESSAGE_ID_CACHE_MAX_ENTRIES = 1_000;
const SESSION_CLIENT_TOOL_CALL_CACHE_MAX_ENTRIES = 1_000;
const PENDING_QUEUE_MATERIALIZE_RETRY_INITIAL_DELAY_MS = 250;
const PENDING_QUEUE_MATERIALIZE_RETRY_MAX_DELAY_MS = 15_000;

function resolvePendingQueueMaterializeRetryDelayMs(attempt: number): number {
    const boundedAttempt = Math.max(0, Math.min(16, Math.trunc(attempt)));
    return Math.min(
        PENDING_QUEUE_MATERIALIZE_RETRY_MAX_DELAY_MS,
        PENDING_QUEUE_MATERIALIZE_RETRY_INITIAL_DELAY_MS * (2 ** boundedAttempt),
    );
}

type SessionSocketAckWriteEvent = 'update-metadata' | 'update-state' | 'update-runtime-activity';
type SessionAliveMode = 'local' | 'remote';
type SessionAlivePayload = Readonly<{
    sid: string;
    time: number;
    thinking: boolean;
    mode: SessionAliveMode;
    latestTurnStatus?: PrimaryTurnStatusV1;
    latestTurnStatusObservedAt?: number;
}>;
type SessionPresenceSnapshot = Readonly<{
    thinking: boolean;
    mode: SessionAliveMode;
}>;

function readFiniteTimestampMs(value: unknown): number | null {
    if (typeof value !== 'number' && typeof value !== 'bigint') return null;
    const numeric = typeof value === 'bigint' ? Number(value) : value;
    if (!Number.isFinite(numeric) || numeric < 0) return null;
    return Math.trunc(numeric);
}

type SessionSocketNotReadyError = Error & Readonly<{
    code: 'socket_not_connected' | 'socket_auth_failed' | 'session_closed';
    event: SessionSocketAckWriteEvent;
    retryable: boolean;
}>;

function createSessionSocketNotReadyError(params: Readonly<{
    code: SessionSocketNotReadyError['code'];
    event: SessionSocketAckWriteEvent;
    message: string;
    retryable: boolean;
}>): SessionSocketNotReadyError {
    const error = new Error(params.message) as SessionSocketNotReadyError;
    Object.defineProperty(error, 'code', { value: params.code, enumerable: true });
    Object.defineProperty(error, 'event', { value: params.event, enumerable: true });
    Object.defineProperty(error, 'retryable', { value: params.retryable, enumerable: true });
    return error;
}

export class ApiSessionClient extends EventEmitter {
    private static readonly STARTUP_MESSAGE_CATCH_UP_RETRY_DELAYS_MS = [250, 1_000, 2_500] as const;

    private readonly token: string;
    readonly sessionId: string;
    private metadata: Metadata | null;
    private metadataVersion: number;
    private agentState: AgentState | null;
    private agentStateVersion: number;
    private socket!: Socket<ServerToClientEvents, ClientToServerEvents>;
    private userSocket: Socket<ServerToClientEvents, ClientToServerEvents>;
    private pendingMessages: UserMessage[] = [];
    private pendingMessageCallback: ((message: UserMessage, info?: SessionUserMessageDeliveryInfo) => void) | null = null;
    private userMessageCallbackAttachedAtMs: number | null = null;
    readonly rpcHandlerManager: RpcHandlerManager;
    private readonly rpcLifecycleRegistrations: RpcLifecycleRegistration[] = [];
    private agentStateLock = new AsyncLock();
    private metadataLock = new AsyncLock();
    private encryptionKey: Uint8Array;
    private encryptionVariant: 'legacy' | 'dataKey';
    private readonly outboundShapeLogger = createEventShapeLoggerForLog({ logger, scope: 'session-out' });
    private sessionConnectionSupervisor: ManagedConnectionSupervisor | null = null;
    private currentConnectionState: ManagedConnectionState = {
        phase: 'idle',
        reason: null,
        attempt: 0,
        nextRetryAt: null,
        lastConnectedAt: null,
        lastDisconnectedAt: null,
        lastErrorMessage: null,
    };
    private queuedDisconnectedSessionMessages = new Map<string, { message: string | { t: 'plain'; v: unknown }; localId: string; sidechainId: string | null; messageRole?: SessionMessageRole; sessionEventType?: 'ready' }>();
    private readonly sessionEncryptionMode: 'e2ee' | 'plain';
    private disconnectedSendLogged = false;
    private latestSessionPresence: SessionPresenceSnapshot = { thinking: false, mode: 'remote' };
    private reconnectPresenceReassertTimer: ReturnType<typeof setTimeout> | null = null;
    // LocalId registries are intentionally phase-specific:
    // pendingMaterializedLocalIds: optimistic UI rows awaiting materialization.
    // committedLocalIdsAwaitingEcho: committed outbound rows awaiting socket echo.
    // pendingQueueMaterializedLocalIds: pending queue rows already emitted locally.
    // agentQueueEchoSuppressedLocalIds: local prompt echoes already handled for the live queue.
    // agentQueueDeliveredLocalIds: prompt attempts already handed to the live agent queue.
    // providerAcceptedUserMessageLocalIdsAwaitingSeq: prompt attempts accepted by provider before
    //   their socket echo assigned a durable seq.
    // passiveCommittedUserMessageLocalIds: transcript-only user writes that must not become inbound prompts.
    private readonly pendingMaterializedLocalIds = new Set<string>();
    private readonly committedLocalIdsAwaitingEcho = new Set<string>();
    private readonly pendingQueueMaterializedLocalIds = new Set<string>();
    private readonly canonicalPendingDeliveryByLocalId = new Map<string, PendingMaterializationDeliveryState>();
    private readonly agentQueueEchoSuppressedLocalIds = new Set<string>();
    private readonly agentQueueDeliveredLocalIds = new Set<string>();
    private readonly providerAcceptedUserMessageLocalIdsAwaitingSeq = new Set<string>();
    private readonly acceptedCanonicalPendingDeliveryRetryLocalIds = new Set<string>();
    private readonly acceptedCanonicalPendingDeliveryResolutionWrites = new Set<Promise<void>>();
    private readonly blockedCanonicalPendingDeliveryRetryReasonsByLocalId = new Map<string, PendingQueueDeliveryBlockedReason>();
    private providerDeliveryAttachRecoveryCompleted = false;
    private providerDeliveryAttachRecoveryInFlight: Promise<void> | null = null;
    private readonly passiveCommittedUserMessageLocalIds = new Set<string>();
    private readonly committedLocalIdCleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();
    private readonly agentQueueEchoSuppressedLocalIdCleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();
    private readonly agentQueueDeliveredLocalIdCleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();
    private readonly providerAcceptedUserMessageLocalIdCleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();
    private readonly passiveCommittedUserMessageLocalIdCleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();
    private pendingWakeSeq = 0;
    private runtimeActivityPendingWakeTimer: ReturnType<typeof setTimeout> | null = null;
    private pendingMaterializeRetryWakeTimer: ReturnType<typeof setTimeout> | null = null;
    private pendingMaterializeRetryAttempt = 0;
    private pendingQueueState: PendingQueueState = UNKNOWN_PENDING_QUEUE_STATE;
    private pendingQueueStateReconcileInFlight: Promise<boolean> | null = null;
    private lastPendingQueueStateReconcileAt = 0;
    private latestTurnStatus: LatestTurnStatusSnapshot | undefined = undefined;
    private latestTurnStatusObservedAtMs: number | null = null;
    private localActiveTurnStartedAtMs: number | null = null;
    private lastLocalActiveTurnProgressAtMs: number | null = null;
    private runtimeActivityProjection: RuntimeActivityProjectionForPendingDrain = {};
    readonly runtimeActivityPublisher: SessionRuntimeActivityPublisher = createSessionRuntimeActivityPublisher({
        nowMs: () => Date.now(),
        leaseDurationMs: SESSION_RUNTIME_ACTIVITY_PROJECTION_LEASE_MS,
        updateRuntimeActivityProjection: (projection) => this.updateRuntimeActivityProjection(projection),
        logError: (event, details) => {
            logger.debug(`[session-client] ${event}`, details);
        },
    });
    private lastTurnStatusRefreshPendingVersion: number | null = null;
    private lastBlockedTurnStatusRefreshAt = 0;
    private owedUserMessageCatchUpInFlight = false;
    private lastOwedUserMessageCatchUpAt = 0;
    private readonly pendingCommitRetryAttemptsByLocalId = new Map<string, number>();
    private userSocketDisconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private closed = false;
    private snapshotSyncInFlight: Promise<boolean> | null = null;
    private readonly toolCallCanonicalNameByProviderAndId = new Map<string, { rawToolName: string; canonicalToolName: string }>();
    private readonly permissionToolCallRawInputByProviderAndId = new Map<string, unknown>();
    private readonly toolCallInputByProviderAndId = new Map<string, unknown>();
    private readonly receivedMessageIds = new LruSet(SESSION_CLIENT_RECEIVED_MESSAGE_ID_CACHE_MAX_ENTRIES);
    private lastObservedMessageSeq = 0;
    private lastObservedUserMessageSeq = 0;
    /** Owed-delivery watermark (A-F2/D15b): highest user-row seq handed to the agent loop this process. */
    private highestDeliveredUserMessageSeq: number | null = null;
    private highestProviderAcceptedUserMessageSeq: number | null = null;
    private deliveredUserMessageSeqPersistInFlight = false;
    /**
     * A3-HIGH-1: when true (launchers wired for provider-acceptance confirmation), the watermark
     * is NOT persisted at agent-queue handoff — "queued in volatile memory" is not "delivered".
     * The seq travels with the queued message and `confirmUserMessageDeliveredToProvider` persists
     * it once the provider actually accepted the batch. Failure direction stays duplicate-attempt
     * (at-least-once, deduped), never silent loss.
     */
    private providerAcceptanceDeliveryStateRequested = false;
    private providerAcceptanceDeliveryStateFeatureEnabled = false;
    private providerAcceptancePendingMaterializationPolicy: ProviderAcceptancePendingMaterializationPolicy | null = null;
    private pendingDeliveryStateFeatureProbe: Promise<void> | null = null;
    private deliveredUserMessageWatermarkDeferredToProviderAcceptance = false;
    private readonly turnAssistantTextSnapshotStore = createTurnAssistantTextSnapshotStore({
        maxTextChars: configuration.readyNotificationAssistantTextMaxChars,
    });
    private hasConnectedOnce = false;
    /**
     * Increments on every session socket connect. Live-stream writers use this to detect
     * reconnects and resync receivers with a full snapshot before resuming delta emissions.
     */
    private ephemeralStreamConnectionEpoch = 0;
    private changesSyncInFlight: Promise<void> | null = null;
    private readonly sessionChangesCursorByAccountId = new Map<string, number>();
    private socketStaleSafetyScheduler: SessionSocketStaleSafetyScheduler | null = null;
    private accountIdPromise: Promise<string> | null = null;
    private daemonInitialPrompt: string | null = null;
    private daemonInitialPromptSeeded = false;
    private startupMessageCatchUpStarted = false;
    private startupMessageCatchUpRetryIndex = 0;
    private startupMessageCatchUpRetryTimer: ReturnType<typeof setTimeout> | null = null;
    private startupMessageCatchUpInitialAfterSeq = 0;
    private startupMessageCatchUpInitialAuthorization: SessionCatchUpAuthorization = 'startup_recovery';
    private readonly startupMessageCatchUpExplicitAfterSeq: number | null;
    private readonly startedByDaemonProcess: boolean;
    private readonly transcriptStorage: 'persisted' | 'direct';
    private readonly materializationRecoveryScheduler: KeyedSingleFlightScheduler;
    private readonly transcriptRecoveryErrorStateByLocalId = new Map<string, { lastLoggedAt: number; suppressed: number }>();
    private messageCommitQueueTail: Promise<unknown> = Promise.resolve();
    private readonly pendingSessionTurnWrites = new Set<Promise<void>>();
    private readonly pendingSessionEndWrites = new Set<Promise<void>>();
    private readonly committedUserMessageSeqTracker = new CommittedUserMessageSeqTracker();
    private readonly sessionMutationOutbox: SessionMutationOutbox;
    readonly sessionTurnLifecycle: SessionTurnLifecycleController;
    private readonly sessionRuntimeControls: Partial<SessionRuntimeControls> = {};
    private readonly baseSessionRuntimeControls: Partial<SessionRuntimeControls> = {};
    private readonly sessionRuntimeControlRegistrations = new Set<Partial<SessionRuntimeControls>>();
    private providerOwnedUserMessageEchoClassifier: ProviderOwnedUserMessageEchoClassifier | null = null;
    readonly executionRuns = {
        start: async (request: unknown) =>
            await startExecutionRun({
                ...this.getExecutionRunServiceContext(),
                request,
            }),
        list: async (request: unknown) =>
            await listExecutionRuns({
                ...this.getExecutionRunServiceContext(),
                request,
            }),
        get: async (request: unknown) =>
            await getExecutionRun({
                ...this.getExecutionRunServiceContext(),
                request,
            }),
        send: async (request: unknown) =>
            await sendExecutionRunMessage({
                ...this.getExecutionRunServiceContext(),
                request,
            }),
        stop: async (request: unknown) =>
            await stopExecutionRun({
                ...this.getExecutionRunServiceContext(),
                request,
            }),
        action: async (request: unknown) =>
            await executeExecutionRunAction({
                ...this.getExecutionRunServiceContext(),
                request,
            }),
        wait: async (request: unknown) => {
            const rawTimeoutSeconds = readUnknownRecordProperty(request, 'timeoutSeconds');

            const rawPollIntervalMs = readUnknownRecordProperty(request, 'pollIntervalMs');
            const requestPollIntervalMs =
                typeof rawPollIntervalMs === 'number' && Number.isFinite(rawPollIntervalMs) && rawPollIntervalMs > 0
                    ? Math.min(60_000, rawPollIntervalMs)
                    : null;
            const envPollIntervalRaw = (process.env.HAPPIER_SESSION_RUN_WAIT_POLL_INTERVAL_MS ?? '').trim();
            const envPollIntervalParsed = envPollIntervalRaw ? Number.parseInt(envPollIntervalRaw, 10) : NaN;
            const envPollIntervalMs =
                Number.isFinite(envPollIntervalParsed) && envPollIntervalParsed > 0 ? Math.min(60_000, envPollIntervalParsed) : 1_000;

            return await waitForExecutionRun({
                ...this.getExecutionRunServiceContext(),
                runId: String(readUnknownRecordProperty(request, 'runId') ?? ''),
                timeoutMs: normalizeExecutionRunWaitTimeoutMs(rawTimeoutSeconds),
                pollIntervalMs: requestPollIntervalMs ?? envPollIntervalMs,
            });
        },
    } as const;

    /**
     * Returns the latest known agentState (may be stale if socket is disconnected).
     * Useful for rebuilding in-memory caches (e.g. permission allowlists) without server changes.
     */
    getAgentStateSnapshot(): AgentState | null {
        return this.agentState;
    }

    beginTurnAssistantTextSnapshot(params?: {
        turnToken?: string;
        startSeqExclusive?: number | null;
    }): string {
        return this.turnAssistantTextSnapshotStore.beginTurn(params);
    }

    getTurnAssistantTextSnapshot(params: {
        turnToken?: string | null;
        startSeqExclusive?: number | null;
    }): TurnAssistantTextSnapshot | null {
        return this.turnAssistantTextSnapshotStore.getForTurn(params);
    }

    private getExecutionRunServiceContext() {
        return {
            token: this.token,
            sessionId: this.sessionId,
            mode: this.sessionEncryptionMode,
            ctx: {
                encryptionKey: this.encryptionKey,
                encryptionVariant: this.encryptionVariant,
            },
        } as const;
    }

    private logSendWhileDisconnected(context: string, details?: Record<string, unknown>): void {
        if (this.socket.connected || this.disconnectedSendLogged) return;
        this.disconnectedSendLogged = true;
        logger.debug(
            `[API] Socket not connected; queueing ${context} until supervised reconnect.`,
            details
        );
    }

    private isSessionSocketOnlineForAckWrite(): boolean {
        return (this.socket as Socket<ServerToClientEvents, ClientToServerEvents> | undefined)?.connected === true
            || this.currentConnectionState.phase === 'online';
    }

    private async waitForSessionSocketOnlineForAckWrite(event: SessionSocketAckWriteEvent): Promise<void> {
        if (this.isSessionSocketOnlineForAckWrite()) return;
        if (this.closed) {
            throw createSessionSocketNotReadyError({
                code: 'session_closed',
                event,
                message: `${event} session is closed`,
                retryable: false,
            });
        }

        const supervisor = this.sessionConnectionSupervisor;
        if (!supervisor) return;

        const timeoutMs = resolveSessionControlSocketConnectTimeoutMs();
        await new Promise<void>((resolve, reject) => {
            let settled = false;
            let timer: ReturnType<typeof setTimeout> | null = null;
            const cleanup = () => {
                if (timer) {
                    clearTimeout(timer);
                    timer = null;
                }
                this.off(SESSION_CONNECTION_STATE_EVENT, onStateChange);
            };
            const settle = (fn: () => void) => {
                if (settled) return;
                settled = true;
                cleanup();
                fn();
            };
            const check = () => {
                if (this.isSessionSocketOnlineForAckWrite()) {
                    settle(resolve);
                    return;
                }
                if (this.closed) {
                    settle(() => reject(createSessionSocketNotReadyError({
                        code: 'session_closed',
                        event,
                        message: `${event} session is closed`,
                        retryable: false,
                    })));
                    return;
                }
                if (this.currentConnectionState.phase === 'auth_failed') {
                    settle(() => reject(createSessionSocketNotReadyError({
                        code: 'socket_auth_failed',
                        event,
                        message: `${event} session socket authentication failed`,
                        retryable: false,
                    })));
                }
            };
            const onStateChange = () => check();

            this.on(SESSION_CONNECTION_STATE_EVENT, onStateChange);
            timer = setTimeout(() => {
                settle(() => reject(createSessionSocketNotReadyError({
                    code: 'socket_not_connected',
                    event,
                    message: `${event} socket is not connected`,
                    retryable: true,
                })));
            }, timeoutMs);
            timer.unref?.();

            void supervisor.start().catch((error) => {
                settle(() => reject(error));
            });
            check();
        });
    }

    private observeTurnAssistantTextFromSessionContent(
        content: unknown,
        params: Omit<TurnAssistantTextCandidate, 'text' | 'provider' | 'sidechainId'> & {
            provider?: string | null;
            sidechainId?: string | null;
        },
    ): void {
        const extracted = extractTurnAssistantTextFromSessionContent(content);
        if (!extracted) return;
        this.turnAssistantTextSnapshotStore.observe({
            ...params,
            text: extracted.text,
            provider: params.provider ?? extracted.provider,
            sidechainId: params.sidechainId ?? extracted.sidechainId,
        });
    }

	    constructor(token: string, session: Session) {
	        super()
	        this.token = token;
	        this.sessionId = session.id;
	        this.metadata = session.metadata;
	        this.metadataVersion = session.metadataVersion;
	        this.agentState = session.agentState;
	        this.agentStateVersion = session.agentStateVersion;
            this.pendingQueueState = readKnownPendingQueueState(session) ?? UNKNOWN_PENDING_QUEUE_STATE;
            this.latestTurnStatus = readLatestTurnStatusSnapshot(
                (session as { latestTurnStatus?: unknown }).latestTurnStatus,
            );
            this.latestTurnStatusObservedAtMs = readFiniteTimestampMs(
                (session as { latestTurnStatusObservedAt?: unknown }).latestTurnStatusObservedAt,
            );
            this.runtimeActivityProjection = readRuntimeActivityProjectionForPendingDrain(session);
            this.lastObservedMessageSeq =
                typeof session.seq === 'number' && Number.isFinite(session.seq) && session.seq >= 0
                    ? Math.trunc(session.seq)
                    : 0;
            this.startupMessageCatchUpExplicitAfterSeq =
                typeof session.initialTranscriptAfterSeq === 'number'
                && Number.isFinite(session.initialTranscriptAfterSeq)
                && session.initialTranscriptAfterSeq >= 0
                    ? Math.trunc(session.initialTranscriptAfterSeq)
                    : null;
            this.startupMessageCatchUpInitialAuthorization =
                readSessionCatchUpAuthorization(session.initialTranscriptCatchUpAuthorization)
                ?? (this.startupMessageCatchUpExplicitAfterSeq !== null ? 'explicit_cursor' : 'startup_recovery');
	        if (session.encryptionMode === 'plain') {
	            this.sessionEncryptionMode = 'plain';
	            // Plaintext sessions should not require encryption materials. Keep dummy values for
	            // legacy surfaces that still accept encryption key args; they must branch on
	            // `sessionEncryptionMode` and never encrypt/decrypt.
	            this.encryptionKey = new Uint8Array(32);
	            this.encryptionVariant = 'dataKey';
	        } else {
	            this.sessionEncryptionMode = 'e2ee';
	            this.encryptionKey = session.encryptionKey;
	            this.encryptionVariant = session.encryptionVariant;
	        }
	        this.transcriptStorage = (() => {
	            const raw = typeof process.env.HAPPIER_TRANSCRIPT_STORAGE === 'string'
	                ? process.env.HAPPIER_TRANSCRIPT_STORAGE.trim().toLowerCase()
	                : '';
	            return raw === 'direct' ? 'direct' : 'persisted';
	        })();
	        this.daemonInitialPrompt = consumeDaemonInitialPromptFromEnv();
        this.materializationRecoveryScheduler = createKeyedSingleFlightScheduler({
            delayMs: configuration.transcriptRecoveryDelayMs,
            maxConcurrent: configuration.transcriptRecoveryMaxConcurrent,
        });
        this.startedByDaemonProcess = (() => {
            const idx = process.argv.indexOf('--started-by');
            if (idx < 0) return false;
            const value = process.argv[idx + 1];
            return value === 'daemon';
        })();

        // Initialize RPC handler manager
        this.rpcHandlerManager = new RpcHandlerManager({
            scopePrefix: this.sessionId,
            encryptionKey: this.encryptionKey,
            encryptionVariant: this.encryptionVariant,
            encryptionMode: this.sessionEncryptionMode,
            logger: (msg, data) => logger.debug(msg, data)
        });
        const resolvedFlavor = typeof (this.metadata as any)?.flavor === 'string' ? String((this.metadata as any).flavor).trim() : '';
        const parentProvider: CatalogAgentId =
            (CATALOG_AGENT_IDS as readonly string[]).includes(resolvedFlavor) ? (resolvedFlavor as CatalogAgentId) : 'claude';

        this.rebuildSessionRuntimeControls();
        this.rpcLifecycleRegistrations.push(registerSessionHandlers(this.rpcHandlerManager, this.metadata.path, {
            getSessionMetadata: () => this.getMetadataSnapshot(),
            updateSessionMetadata: (handler) => this.updateMetadata(handler),
            enqueueSessionUserMessage: (request) => this.enqueueSessionUserMessage(request),
            sessionRuntimeControls: this.sessionRuntimeControls,
            // QAE-1: a user "Stop waiting" handled session-side (provider runtime
            // control or metadata fallback) must also cancel the daemon's durable
            // recovery wait state, or it resumes the session involuntarily later.
            notifyUsageLimitWaitResumeCancelled: async (request) =>
                await notifyDaemonConnectedServiceUsageLimitWaitResumeCancel(request),
        }));

        const transcriptWriter = {
            appendUserText: (text: string, meta: Record<string, unknown>) => {
                this.sendUserTextMessage(text, { meta });
            },
            appendAssistantText: (text: string, meta: Record<string, unknown>) => {
                this.sendAgentMessage(parentProvider as any, { type: 'message', message: text }, { meta });
            },
            appendUserTextCommitted: async (text: string, meta: Record<string, unknown>) => {
                await this.sendUserTextMessageCommitted(text, { localId: randomUUID(), meta });
            },
            appendAssistantTextCommitted: async (text: string, meta: Record<string, unknown>) => {
                await this.sendAgentMessageCommitted(parentProvider as any, { type: 'message', message: text }, { localId: randomUUID(), meta });
            },
        };

        const hasBudgetCaps =
            configuration.executionRunsMaxConcurrentPerSession !== null
            || configuration.ephemeralTasksMaxConcurrentPerSession !== null
            || typeof configuration.executionBudgetMaxConcurrentTotalPerSession === 'number'
            || (configuration.executionBudgetMaxConcurrentByClass && Object.keys(configuration.executionBudgetMaxConcurrentByClass).length > 0);
        const executionBudgetRegistry = hasBudgetCaps
            ? new ExecutionBudgetRegistry({
                maxConcurrentExecutionRuns: configuration.executionRunsMaxConcurrentPerSession,
                maxConcurrentEphemeralTasks: configuration.ephemeralTasksMaxConcurrentPerSession,
                ...(typeof configuration.executionBudgetMaxConcurrentTotalPerSession === 'number'
                    ? { maxConcurrentTotal: configuration.executionBudgetMaxConcurrentTotalPerSession }
                    : {}),
                ...(configuration.executionBudgetMaxConcurrentByClass
                    && Object.keys(configuration.executionBudgetMaxConcurrentByClass).length > 0
                    ? { maxConcurrentByClass: configuration.executionBudgetMaxConcurrentByClass }
                    : {}),
            })
            : undefined;

        // Always register execution-run RPC methods so callers never see "RPC method not available".
        // Feature gating is enforced inside the handler implementations.
        const streamedTranscriptSession = {
            enqueueAgentMessageCommitted: (provider: ACPProvider, body: ACPMessageData, opts: { localId: string; meta?: Record<string, unknown> }) =>
                this.enqueueAgentMessageCommitted(provider, body, opts),
            sendAgentMessageCommitted: (provider: ACPProvider, body: ACPMessageData, opts: { localId: string; meta?: Record<string, unknown> }) =>
                this.sendAgentMessageCommitted(provider, body, opts),
            sendAgentMessageEphemeral: (provider: ACPProvider, body: ACPMessageData, opts: { localId: string; createdAt: number; updatedAt?: number; meta?: Record<string, unknown>; tick?: number }) =>
                this.sendAgentMessageEphemeral(provider, body, opts),
            sendAgentMessageEphemeralDelta: (
                provider: ACPProvider,
                body: ACPMessageData,
                opts: { localId: string; tick: number; baseLength: number; createdAt: number; updatedAt?: number; meta?: Record<string, unknown> },
            ) => this.sendAgentMessageEphemeralDelta(provider, body, opts),
            getEphemeralStreamConnectionEpoch: () => this.getEphemeralStreamConnectionEpoch(),
        };

        registerExecutionRunHandlers(this.rpcHandlerManager, {
            sessionId: this.sessionId,
            cwd: this.metadata?.path ?? process.cwd(),
            serverUrl: configuration.serverUrl,
            parentProvider,
            createBackend: ({ runId, backendId, backendTarget, permissionMode, modelId, sessionConfigOptionOverrides, accountSettings, start, connectedServicesEnv, connectedServicesCleanup }) =>
                createExecutionRunBackend({
                    cwd: this.metadata?.path ?? process.cwd(),
                    ...(runId ? { runId } : {}),
                    backendId,
                    backendTarget,
                    permissionMode,
                    modelId,
                    ...(sessionConfigOptionOverrides ? { sessionConfigOptionOverrides } : {}),
                    accountSettings,
                    start,
                    ...(connectedServicesEnv ? { connectedServicesEnv } : {}),
                    ...(connectedServicesCleanup ? { connectedServicesCleanup } : {}),
                }),
            sendAcp: (provider, body, opts) => this.sendAgentMessage(provider as any, body as any, opts),
            streamedTranscriptSession,
            transcriptWriter,
            runtimeActivityPublisher: this.runtimeActivityPublisher,
            budgetRegistry: executionBudgetRegistry,
            onExecutionRunPublicStateUpdated: (run) => {
                try {
                    if (!this.socket.connected) {
                        return;
                    }
                    this.socket.emit('execution-run-updated', { sid: this.sessionId, run });
                } catch {
                    // best effort
                }
            },
            policy: {
                maxConcurrentRuns: configuration.executionRunsMaxConcurrentPerSession,
                boundedTimeoutMs: configuration.executionRunsBoundedTimeoutMs,
                reviewBoundedTimeoutMs: configuration.executionRunsReviewBoundedTimeoutMs,
                maxTurns: configuration.executionRunsMaxTurns,
                maxDepth: configuration.executionRunsMaxDepth,
            },
            resolveAccountSettings: async () => {
                const activeSettings = getActiveAccountSettingsSnapshot()?.settings ?? null;
                if (activeSettings) return activeSettings;
                const credentials = await readCredentials();
                if (!credentials) return null;
                const context = await bootstrapAccountSettingsContext({ credentials, mode: 'fast' });
                return context.settings ?? null;
            },
        });

        registerEphemeralTaskHandlers(this.rpcHandlerManager, {
          workingDirectory: this.metadata?.path ?? process.cwd(),
          createBackend: ({ backendId, permissionMode, backendTarget }) =>
            createExecutionRunBackend({
              cwd: this.metadata?.path ?? process.cwd(),
              backendId,
              permissionMode,
              ...(backendTarget ? { backendTarget } : {}),
            }),
          budgetRegistry: executionBudgetRegistry,
        });

        //
        // Create socket
        //

        // A user-scoped socket is used to observe our own materialized pending-queue messages.
        //
        // Server-side broadcasting skips the sender connection, so a session-scoped agent that emits a
        // transcript message will not receive its own "new-message" update. Without observing the
        // materialized message, the agent can't enqueue it for processing.
        //
        // A second (user-scoped) connection will still receive the broadcast, letting us safely
        // drive the normal update pipeline without server changes.
        this.userSocket = createUserScopedSocket({ token: this.token });
        this.sessionMutationOutbox = createSessionMutationOutbox({
            token: this.token,
            sessionId: this.sessionId,
            getSocket: () => this.socket as any,
            requestReconnect: (reason) => this.kickSessionSocketReconnectForDurableMutation(reason),
        });
        this.sessionTurnLifecycle = createSessionTurnLifecycle({
            sessionId: this.sessionId,
            enqueueSessionTurn: createSessionTurnMutationWriter(this.sessionMutationOutbox).enqueueSessionTurn,
            onTurnLifecycleEvent: (event, terminalStatus) => {
                this.observeTurnLifecycleForPendingDrain(event, terminalStatus);
                void this.notifyDaemonConnectedServiceTurnLifecycle(event, terminalStatus);
            },
        });

        //
        // Handlers
        //
        this.userSocket.on('update', (data: Update) => this.handleUpdate(data, { source: 'user-scoped' }));
        // Broadcast-safe session events are optional hints; ignore unless explicitly used.
        this.userSocket.on('session', () => {});

        let currentTransportSocket: typeof this.socket | null = null;
        this.sessionConnectionSupervisor = createManagedConnectionSupervisor({
            ...DEFAULT_MANAGED_CONNECTION_POLICY,
            createTransport: () => {
                const { socket, transport } = createSessionSocketTransport({
                    token: this.token,
                    sessionId: this.sessionId,
                    machineId: resolveSessionSocketMachineIdForBootstrap(this.metadata),
                });
                this.socket = socket;
                currentTransportSocket = socket;
                this.installSessionSocketEventHandlers(socket);
                return transport;
            },
            classifyTransportErrorToProbeResult: classifySessionTransportErrorToProbeResult,
            probeReadiness: createLoopbackReadinessProbe({
                serverUrl: resolveServerHttpBaseUrl(),
                token: this.token,
            }),
            onStateChange: (state) => {
                this.currentConnectionState = state;
                this.emit(SESSION_CONNECTION_STATE_EVENT, state);
            },
            onConnected: async () => {
                logger.debug('Socket connected successfully');
                this.disconnectedSendLogged = false;
                connectionState.recover();
                this.rpcHandlerManager.onSocketConnect(this.socket);

                const isReconnect = this.hasConnectedOnce;
                this.hasConnectedOnce = true;
                this.ephemeralStreamConnectionEpoch += 1;

                if (this.shouldKeepUserSocketConnected()) {
                    this.kickUserSocketConnect();
                }

                if (isReconnect) {
                    this.reassertSessionPresenceAfterReconnect();
                }

                await this.syncChangesOnConnect({ reason: isReconnect ? 'reconnect' : 'connect' }).catch((error) => {
                    logger.debug('[API] Session changes sync on connect failed (non-fatal)', {
                        error: serializeAxiosErrorForLog(error),
                    });
                });
                this.socketStaleSafetyScheduler?.start();

                if (shouldSyncSessionSnapshotOnConnect({ metadataVersion: this.metadataVersion, agentStateVersion: this.agentStateVersion })) {
                    void this.syncSessionSnapshotFromServer({ reason: 'connect' });
                }

                await this.flushQueuedSessionMessagesOnReconnect().catch((error) => {
                    logger.debug('[API] Failed to replay queued session messages on reconnect', {
                        error: serializeAxiosErrorForLog(error),
                    });
                });
                await this.sessionMutationOutbox.flush('connect').catch((error) => {
                    logger.debug('[API] Failed to flush durable session mutations on reconnect', {
                        error: serializeAxiosErrorForLog(error),
                    });
                });
            },
            onDisconnected: async ({ event }) => {
                logger.debug('[API] Socket disconnected:', event.reason ?? 'unknown');
                this.socketStaleSafetyScheduler?.stop();
                this.clearReconnectPresenceReassertTimer();
                if (this.socket === currentTransportSocket) {
                    this.rpcHandlerManager.onSocketDisconnect();
                    try {
                        this.userSocket.disconnect();
                    } catch {
                        // ignore
                    }
                }
            },
            onAuthFailed: async () => {
                this.socketStaleSafetyScheduler?.stop();
                this.clearReconnectPresenceReassertTimer();
                if (this.socket === currentTransportSocket) {
                    this.rpcHandlerManager.onSocketDisconnect();
                    try {
                        this.userSocket.disconnect();
                    } catch {
                        // ignore
                    }
                }
            },
        });

        this.socketStaleSafetyScheduler = createSessionSocketStaleSafetyScheduler({
            intervalMs: configuration.sessionSocketStaleSafetyIntervalMs,
            isOnline: () => !this.closed && (this.currentConnectionState.phase === 'online' || this.socket?.connected === true),
            runSafetyTick: () => this.runSocketStaleSafetyTick(),
        });

        void this.sessionConnectionSupervisor.start();
    }

    private rebuildSessionRuntimeControls(): void {
        clearSessionRuntimeControls(this.sessionRuntimeControls);
        copyCallableSessionRuntimeControls(this.sessionRuntimeControls, this.baseSessionRuntimeControls);
        for (const registration of this.sessionRuntimeControlRegistrations) {
            copyCallableSessionRuntimeControls(this.sessionRuntimeControls, registration);
        }
        this.sessionRuntimeControls.materializeNextPendingMessageSafely = async (opts) => {
            const result = await this.materializeNextPendingMessageSafely(opts);
            return {
                ok: true,
                didMaterialize: result.type === 'materialized',
                result,
            };
        };
    }

    setSessionRuntimeControls(controls: SessionRuntimeControls | null): void {
        clearSessionRuntimeControls(this.baseSessionRuntimeControls);
        copyCallableSessionRuntimeControls(this.baseSessionRuntimeControls, controls);
        this.rebuildSessionRuntimeControls();
    }

    registerSessionRuntimeControls(controls: Partial<SessionRuntimeControls> | null): () => void {
        const registration: Partial<SessionRuntimeControls> = {};
        copyCallableSessionRuntimeControls(registration, controls);
        if (Object.keys(registration).length === 0) {
            return () => {};
        }
        this.sessionRuntimeControlRegistrations.add(registration);
        this.rebuildSessionRuntimeControls();
        let disposed = false;
        return () => {
            if (disposed) return;
            disposed = true;
            this.sessionRuntimeControlRegistrations.delete(registration);
            this.rebuildSessionRuntimeControls();
        };
    }

    setProviderOwnedUserMessageEchoClassifier(classifier: ProviderOwnedUserMessageEchoClassifier | null): void {
        this.providerOwnedUserMessageEchoClassifier = classifier;
    }

    private debugTranscriptRecoveryFetchError(localId: string, error: unknown): void {
        const now = Date.now();
        const throttleMs = configuration.transcriptRecoveryErrorLogThrottleMs;
        const state = this.transcriptRecoveryErrorStateByLocalId.get(localId) ?? { lastLoggedAt: 0, suppressed: 0 };

        if (state.lastLoggedAt === 0 || now - state.lastLoggedAt >= throttleMs) {
            const suppressed = state.suppressed;
            state.lastLoggedAt = now;
            state.suppressed = 0;
            this.transcriptRecoveryErrorStateByLocalId.set(localId, state);
            logger.debug('[API] Failed to fetch transcript messages for pending-queue recovery', {
                localId,
                suppressedSinceLastLog: suppressed,
                error: serializeAxiosErrorForLog(error),
            });
            return;
        }

        state.suppressed += 1;
        this.transcriptRecoveryErrorStateByLocalId.set(localId, state);
    }

    private applyPendingQueueState(state: KnownPendingQueueState, opts?: { emit?: boolean }): boolean {
        const applied = applyKnownPendingQueueState(this.pendingQueueState, state);
        this.pendingQueueState = applied.state;
        this.clearPendingMaterializeRetryWakeIfDrained();
        if (applied.changed) {
            this.pendingWakeSeq += 1;
            if (opts?.emit === true && !this.closed) {
                this.emit('metadata-updated');
            }
        }
        return applied.changed;
    }

    private clearCanonicalPendingDeliveryLocalState(localId: string): boolean {
        let didClear = false;
        if (this.canonicalPendingDeliveryByLocalId.delete(localId)) didClear = true;
        if (this.acceptedCanonicalPendingDeliveryRetryLocalIds.delete(localId)) didClear = true;
        if (this.blockedCanonicalPendingDeliveryRetryReasonsByLocalId.delete(localId)) didClear = true;
        const hadMaterializedLocalId = this.hasMaterializedLocalId(localId);
        if (didClear || hadMaterializedLocalId) {
            this.clearProviderAcceptedUserMessageLocalIdAwaitingSeq(localId);
            this.deleteMaterializedLocalId(localId);
        }
        return didClear || hadMaterializedLocalId;
    }

    private clearCanonicalPendingDeliveryLocalStates(localIds: readonly string[]): boolean {
        let didClear = false;
        for (const localId of this.normalizeProviderAcceptedUserMessageLocalIds(localIds)) {
            didClear = this.clearCanonicalPendingDeliveryLocalState(localId) || didClear;
        }
        return didClear;
    }

    private async retireStaleCanonicalPendingDeliveryAfterTerminalMiss(
        localId: string,
        operation: 'accepted' | 'block' | 'retry',
        error: unknown,
    ): Promise<boolean> {
        if (!isTerminalPendingDeliveryNotFound(error)) return false;

        const didClear = this.clearCanonicalPendingDeliveryLocalState(localId);
        if (!didClear) return true;

        logger.debug('[pendingQueue] retired stale provider delivery claim after server not-found', {
            sessionId: this.sessionId,
            localId,
            operation,
        });

        let reconciled = false;
        try {
            reconciled = await this.reconcilePendingQueueState({ force: true });
        } catch (reconcileError) {
            logger.debug('[pendingQueue] stale provider delivery claim reconcile failed after terminal miss', {
                sessionId: this.sessionId,
                localId,
                operation,
                error: serializeAxiosErrorForLog(reconcileError),
            });
        }

        if (!reconciled && !this.closed) {
            this.pendingWakeSeq += 1;
            this.emit('metadata-updated');
        }
        return true;
    }

    private async resolveAcceptedCanonicalPendingDeliveries(
        localIds: readonly string[],
        acceptedSeqByLocalId?: ReadonlyMap<string, number>,
    ): Promise<void> {
        if (this.closed) return;
        const pendingLocalIds = this.normalizeProviderAcceptedUserMessageLocalIds(localIds)
            .filter((localId) => this.canonicalPendingDeliveryByLocalId.has(localId));
        if (pendingLocalIds.length === 0) return;

        const supervisor = this.sessionConnectionSupervisor;
        for (const localId of pendingLocalIds) {
            try {
                const request = () => resolveAcceptedPendingQueueV2Delivery({
                    token: this.token,
                    sessionId: this.sessionId,
                    localId,
                });
                const result = supervisor
                    ? await runSupervisedRequest({
                        supervisor,
                        requireAuth: true,
                        requireOnline: false,
                        request,
                    })
                    : await request();

                if (!this.canonicalPendingDeliveryByLocalId.has(localId)) continue;
                this.canonicalPendingDeliveryByLocalId.delete(localId);
                this.acceptedCanonicalPendingDeliveryRetryLocalIds.delete(localId);
                if (result.pendingQueueState) {
                    this.applyPendingQueueState(result.pendingQueueState, { emit: true });
                } else if (!this.closed) {
                    this.pendingWakeSeq += 1;
                    this.emit('metadata-updated');
                }
                const resolvedLocalId = result.message?.localId ?? localId;
                const resolvedSeq = typeof result.message?.seq === 'number'
                    ? result.message.seq
                    : acceptedSeqByLocalId?.get(localId) ?? null;
                this.recordCommittedUserMessageSeq(resolvedLocalId, resolvedSeq);
            } catch (error) {
                logger.debug('[pendingQueue] accepted provider delivery resolution failed', {
                    sessionId: this.sessionId,
                    localId,
                    error: serializeAxiosErrorForLog(error),
                });
                if (await this.retireStaleCanonicalPendingDeliveryAfterTerminalMiss(localId, 'accepted', error)) {
                    continue;
                }
                if (this.canonicalPendingDeliveryByLocalId.has(localId)) {
                    this.acceptedCanonicalPendingDeliveryRetryLocalIds.add(localId);
                } else {
                    this.acceptedCanonicalPendingDeliveryRetryLocalIds.delete(localId);
                }
            }
        }
    }

    private async retryAcceptedCanonicalPendingDeliveryResolutions(): Promise<void> {
        if (this.acceptedCanonicalPendingDeliveryRetryLocalIds.size === 0) return;
        const localIds = [...this.acceptedCanonicalPendingDeliveryRetryLocalIds]
            .filter((localId) => this.canonicalPendingDeliveryByLocalId.has(localId));
        for (const localId of this.acceptedCanonicalPendingDeliveryRetryLocalIds) {
            if (!this.canonicalPendingDeliveryByLocalId.has(localId)) {
                this.acceptedCanonicalPendingDeliveryRetryLocalIds.delete(localId);
            }
        }
        if (localIds.length === 0) return;
        await this.resolveAcceptedCanonicalPendingDeliveries(localIds);
    }

    private trackAcceptedCanonicalPendingDeliveryResolution(resolution: Promise<void>): void {
        const tracked = resolution.catch((error) => {
            logger.debug('[pendingQueue] accepted provider delivery resolution crashed', {
                sessionId: this.sessionId,
                error: serializeAxiosErrorForLog(error),
            });
        });
        this.acceptedCanonicalPendingDeliveryResolutionWrites.add(tracked);
        void tracked.finally(() => {
            this.acceptedCanonicalPendingDeliveryResolutionWrites.delete(tracked);
        });
    }

    private async drainAcceptedCanonicalPendingDeliveryResolutionsBeforeClose(): Promise<void> {
        while (this.acceptedCanonicalPendingDeliveryResolutionWrites.size > 0) {
            await Promise.all([...this.acceptedCanonicalPendingDeliveryResolutionWrites]);
        }
        await this.retryAcceptedCanonicalPendingDeliveryResolutions();
    }

    private async reconcileAcceptedCanonicalPendingDeliveriesThroughSeq(): Promise<void> {
        if (this.closed) return;
        if (this.pendingQueueState.known && this.pendingQueueState.pendingCount <= 0) return;
        const watermarkState = this.readDeliveredUserMessageWatermarkState();
        const maxAcceptedSeq = this.deliveredUserMessageWatermarkDeferredToProviderAcceptance
            ? watermarkState.providerAccepted
            : watermarkState.effective;
        if (maxAcceptedSeq === null || maxAcceptedSeq <= 0) return;

        const supervisor = this.sessionConnectionSupervisor;
        try {
            const request = () => reconcileAcceptedPendingQueueV2DeliveriesThroughSeq({
                token: this.token,
                sessionId: this.sessionId,
                maxAcceptedSeq,
            });
            const result = supervisor
                ? await runSupervisedRequest({
                    supervisor,
                    requireAuth: true,
                    requireOnline: false,
                    request,
                })
                : await request();
            const didClearResolvedLocalState = this.clearCanonicalPendingDeliveryLocalStates(result.resolvedLocalIds);
            if (result.pendingQueueState) {
                this.applyPendingQueueState(result.pendingQueueState, { emit: true });
            } else if (didClearResolvedLocalState && !this.closed) {
                this.pendingWakeSeq += 1;
                this.emit('metadata-updated');
            }
        } catch (error) {
            logger.debug('[pendingQueue] accepted provider delivery seq reconciliation failed', {
                sessionId: this.sessionId,
                maxAcceptedSeq,
                error: serializeAxiosErrorForLog(error),
            });
        }
    }

    async blockPendingMessageDelivery(params: Readonly<{
        localIds: readonly string[] | null | undefined;
        reason: PendingQueueDeliveryBlockedReason;
    }>): Promise<boolean> {
        return await this.blockCanonicalPendingDeliveries(params.localIds, params.reason);
    }

    async retryPendingMessageDelivery(params: Readonly<{
        localId: string | null | undefined;
    }>): Promise<boolean> {
        if (this.closed) return false;
        const localId = typeof params.localId === 'string' ? params.localId.trim() : '';
        if (!localId) return false;

        const supervisor = this.sessionConnectionSupervisor;
        try {
            const request = () => retryPendingQueueV2Delivery({
                token: this.token,
                sessionId: this.sessionId,
                localId,
            });
            const result = supervisor
                ? await runSupervisedRequest({
                    supervisor,
                    requireAuth: true,
                    requireOnline: false,
                    request,
                })
                : await request();

            if (result.pendingQueueState) {
                this.applyPendingQueueState(result.pendingQueueState, { emit: true });
            } else if (!this.closed) {
                this.pendingWakeSeq += 1;
                this.emit('metadata-updated');
            }
            logger.debug('[pendingQueue] provider delivery retry succeeded', {
                sessionId: this.sessionId,
                localId,
                ...(result.pendingQueueState
                    ? {
                        pendingCount: result.pendingQueueState.pendingCount,
                        pendingBlockedCount: result.pendingQueueState.pendingBlockedCount,
                        pendingVersion: result.pendingQueueState.pendingVersion,
                    }
                    : {}),
            });
            return true;
        } catch (error) {
            logger.debug('[pendingQueue] provider delivery retry failed', {
                sessionId: this.sessionId,
                localId,
                error: serializeAxiosErrorForLog(error),
            });
            if (await this.retireStaleCanonicalPendingDeliveryAfterTerminalMiss(localId, 'retry', error)) {
                return false;
            }
            return false;
        }
    }

    private async blockCanonicalPendingDeliveries(
        localIds: readonly string[] | null | undefined,
        reason: PendingQueueDeliveryBlockedReason,
    ): Promise<boolean> {
        if (this.closed) return false;
        const pendingLocalIds = this.normalizeProviderAcceptedUserMessageLocalIds(localIds)
            .filter((localId) => this.canonicalPendingDeliveryByLocalId.has(localId));
        if (pendingLocalIds.length === 0) return false;

        let didBlock = false;
        for (const localId of pendingLocalIds) {
            didBlock = await this.blockPendingQueueDeliveryLocalId(localId, reason, {
                canonicalOnly: true,
            }) || didBlock;
        }
        return didBlock;
    }

    private async blockPendingQueueDeliveryLocalId(
        localId: string,
        reason: PendingQueueDeliveryBlockedReason,
        opts: Readonly<{ canonicalOnly: boolean }>,
    ): Promise<boolean> {
        if (this.closed) return false;
        const wasCanonical = this.canonicalPendingDeliveryByLocalId.has(localId);
        if (opts.canonicalOnly && !wasCanonical) return false;

        const supervisor = this.sessionConnectionSupervisor;
        try {
            const request = () => blockPendingQueueV2Delivery({
                token: this.token,
                sessionId: this.sessionId,
                localId,
                reason,
            });
            const result = supervisor
                ? await runSupervisedRequest({
                    supervisor,
                    requireAuth: true,
                    requireOnline: false,
                    request,
                })
                : await request();

            if (wasCanonical && this.canonicalPendingDeliveryByLocalId.has(localId)) {
                this.canonicalPendingDeliveryByLocalId.delete(localId);
                this.blockedCanonicalPendingDeliveryRetryReasonsByLocalId.delete(localId);
            }
            if (result.pendingQueueState) {
                this.applyPendingQueueState(result.pendingQueueState, { emit: true });
            } else if (!this.closed) {
                this.pendingWakeSeq += 1;
                this.emit('metadata-updated');
            }
            logger.debug('[pendingQueue] provider delivery block succeeded', {
                sessionId: this.sessionId,
                localId,
                reason,
                canonical: wasCanonical,
                ...(result.pendingQueueState
                    ? {
                        pendingCount: result.pendingQueueState.pendingCount,
                        pendingBlockedCount: result.pendingQueueState.pendingBlockedCount,
                        pendingVersion: result.pendingQueueState.pendingVersion,
                    }
                    : {}),
            });
            return true;
        } catch (error) {
            logger.debug('[pendingQueue] provider delivery block failed', {
                sessionId: this.sessionId,
                localId,
                reason,
                    error: serializeAxiosErrorForLog(error),
                });
            if (await this.retireStaleCanonicalPendingDeliveryAfterTerminalMiss(localId, 'block', error)) {
                return false;
            }
            if (opts.canonicalOnly && this.canonicalPendingDeliveryByLocalId.has(localId)) {
                this.blockedCanonicalPendingDeliveryRetryReasonsByLocalId.set(localId, reason);
            } else {
                this.blockedCanonicalPendingDeliveryRetryReasonsByLocalId.delete(localId);
            }
            return opts.canonicalOnly && wasCanonical;
        }
    }

    private async retryBlockedCanonicalPendingDeliveryBlocks(): Promise<void> {
        if (this.blockedCanonicalPendingDeliveryRetryReasonsByLocalId.size === 0) return;
        const entries = [...this.blockedCanonicalPendingDeliveryRetryReasonsByLocalId.entries()]
            .filter(([localId]) => this.canonicalPendingDeliveryByLocalId.has(localId));
        for (const localId of this.blockedCanonicalPendingDeliveryRetryReasonsByLocalId.keys()) {
            if (!this.canonicalPendingDeliveryByLocalId.has(localId)) {
                this.blockedCanonicalPendingDeliveryRetryReasonsByLocalId.delete(localId);
            }
        }
        for (const [localId, reason] of entries) {
            await this.blockCanonicalPendingDeliveries([localId], reason);
        }
    }

    private async reconcileCanonicalPendingDeliveriesBeforeMaterialization(): Promise<boolean> {
        await this.reconcileAcceptedCanonicalPendingDeliveriesThroughSeq();
        await this.retryAcceptedCanonicalPendingDeliveryResolutions();
        await this.retryBlockedCanonicalPendingDeliveryBlocks();
        return this.canonicalPendingDeliveryByLocalId.size === 0;
    }

    async reconcilePendingQueueState(opts?: { force?: boolean }): Promise<boolean> {
        if (this.closed) return false;
        if (!opts?.force && this.pendingQueueState.known && this.pendingQueueState.pendingCount > 0) {
            return false;
        }

        const now = Date.now();
        if (
            !opts?.force
            && this.lastPendingQueueStateReconcileAt > 0
            && now - this.lastPendingQueueStateReconcileAt < configuration.pendingQueueStateReconcileThrottleMs
        ) {
            return false;
        }

        if (this.pendingQueueStateReconcileInFlight) {
            return await this.pendingQueueStateReconcileInFlight;
        }

        const run = async (): Promise<boolean> => {
            this.lastPendingQueueStateReconcileAt = Date.now();
            const before = this.pendingQueueState;
            await this.syncSessionSnapshotFromServer({ reason: 'waitForMetadataUpdate' });
            return !arePendingQueueStatesEqual(before, this.pendingQueueState);
        };

        const reconcile = run().finally(() => {
            if (this.pendingQueueStateReconcileInFlight === reconcile) {
                this.pendingQueueStateReconcileInFlight = null;
            }
        });
        this.pendingQueueStateReconcileInFlight = reconcile;
        return await reconcile;
    }

    shouldAttemptPendingMaterialization(opts: {
        activeTurnDeliveryPolicy?: PendingMaterializationActiveTurnPolicy;
        pendingQueueDeliveryTiming?: SessionPendingQueueDeliveryTiming;
    } = {}): boolean {
        if (this.canonicalPendingDeliveryByLocalId.size > 0) return false;
        if (this.isPendingMaterializationBlocked(opts)) return false;
        if (this.isPendingMaterializationDeferredForRuntimeActivity(opts).deferred) return false;
        return countMaterializablePendingRows(this.pendingQueueState) > 0;
    }

    private isPendingMaterializationBlocked(opts: {
        activeTurnDeliveryPolicy?: PendingMaterializationActiveTurnPolicy;
    } = {}): boolean {
        const activeTurnBlocked = blocksPendingMaterializationDuringActiveTurn(opts.activeTurnDeliveryPolicy);
        const localActiveTurnBlocks = this.sessionTurnLifecycle.hasActiveTurn()
            && !this.canBypassStaleLocalActiveTurnBlock();
        return (
            activeTurnBlocked
            && (
                localActiveTurnBlocks
                || isActiveLatestTurnStatus(this.latestTurnStatus)
            )
        )
            || isSessionContinuationRecoveryBlockingPendingDrain(this.metadata);
    }

    private canBypassStaleLocalActiveTurnBlock(now = Date.now()): boolean {
        if (!this.sessionTurnLifecycle.hasActiveTurn()) return false;
        if (this.latestTurnStatus === undefined || isActiveLatestTurnStatus(this.latestTurnStatus)) return false;
        return this.hasStaleLocalActiveTurnWithoutProgress(now);
    }

    private hasStaleLocalActiveTurnWithoutProgress(now = Date.now()): boolean {
        if (!this.sessionTurnLifecycle.hasActiveTurn()) return false;
        const startedAt = this.localActiveTurnStartedAtMs;
        if (startedAt === null) return false;
        const lastProgressAt = this.lastLocalActiveTurnProgressAtMs ?? startedAt;
        return now - lastProgressAt >= STALE_LOCAL_ACTIVE_TURN_RECONCILE_MS;
    }

    private isPendingMaterializationDeferredForRuntimeActivity(opts: {
        pendingQueueDeliveryTiming?: SessionPendingQueueDeliveryTiming;
    } = {}): { deferred: boolean; runtimeActivityExpiresAt: number | null } {
        if (opts.pendingQueueDeliveryTiming !== 'after_runtime_idle') {
            return { deferred: false, runtimeActivityExpiresAt: null };
        }
        const deferral = resolvePendingQueueRuntimeActivityDeferral({
            settings: { sessionPendingQueueDeliveryTiming: opts.pendingQueueDeliveryTiming },
            activity: this.runtimeActivityProjection,
            nowMs: Date.now(),
            // Expiry remains the fail-open guard even in the owning runner; elapsed or malformed activity must not strand runtime-idle delivery.
            ownerLive: true,
        });
        return {
            deferred: deferral.defer,
            runtimeActivityExpiresAt: deferral.runtimeActivityExpiresAt,
        };
    }

    private clearRuntimeActivityPendingWakeTimer(): void {
        if (!this.runtimeActivityPendingWakeTimer) return;
        clearTimeout(this.runtimeActivityPendingWakeTimer);
        this.runtimeActivityPendingWakeTimer = null;
    }

    private scheduleRuntimeActivityPendingWake(runtimeActivityExpiresAt: number | null): void {
        if (runtimeActivityExpiresAt === null) {
            this.clearRuntimeActivityPendingWakeTimer();
            return;
        }
        const delayMs = Math.max(0, runtimeActivityExpiresAt - Date.now());
        this.clearRuntimeActivityPendingWakeTimer();
        this.runtimeActivityPendingWakeTimer = setTimeout(() => {
            this.runtimeActivityPendingWakeTimer = null;
            if (this.closed) return;
            this.pendingWakeSeq += 1;
            this.emit('metadata-updated');
        }, delayMs);
        this.runtimeActivityPendingWakeTimer.unref?.();
    }

    private clearPendingMaterializeRetryWake(): void {
        if (this.pendingMaterializeRetryWakeTimer) {
            clearTimeout(this.pendingMaterializeRetryWakeTimer);
            this.pendingMaterializeRetryWakeTimer = null;
        }
        this.pendingMaterializeRetryAttempt = 0;
    }

    private clearPendingMaterializeRetryWakeIfDrained(): void {
        if (countMaterializablePendingRows(this.pendingQueueState) > 0) return;
        this.clearPendingMaterializeRetryWake();
    }

    private schedulePendingMaterializeRetryWake(
        reason: 'pending_changed' | 'materialize_failed' | 'retry_timer',
    ): void {
        if (this.closed || countMaterializablePendingRows(this.pendingQueueState) <= 0) {
            this.clearPendingMaterializeRetryWake();
            return;
        }
        if (this.pendingMaterializeRetryWakeTimer) return;

        const attempt = this.pendingMaterializeRetryAttempt;
        const delayMs = resolvePendingQueueMaterializeRetryDelayMs(attempt);
        logger.debug('[pendingQueue] materialize retry wake scheduled', {
            sessionId: this.sessionId,
            reason,
            attempt: attempt + 1,
            delayMs,
            pendingCount: this.pendingQueueState.known ? this.pendingQueueState.pendingCount : null,
            pendingVersion: this.pendingQueueState.known ? this.pendingQueueState.pendingVersion : null,
        });
        this.pendingMaterializeRetryWakeTimer = setTimeout(() => {
            this.pendingMaterializeRetryWakeTimer = null;
            if (this.closed || countMaterializablePendingRows(this.pendingQueueState) <= 0) {
                this.clearPendingMaterializeRetryWake();
                return;
            }
            this.pendingMaterializeRetryAttempt += 1;
            logger.debug('[pendingQueue] materialize retry wake', {
                sessionId: this.sessionId,
                attempt: this.pendingMaterializeRetryAttempt,
                pendingCount: this.pendingQueueState.known ? this.pendingQueueState.pendingCount : null,
                pendingVersion: this.pendingQueueState.known ? this.pendingQueueState.pendingVersion : null,
            });
            this.pendingWakeSeq += 1;
            this.emit('metadata-updated');
            this.schedulePendingMaterializeRetryWake('retry_timer');
        }, delayMs);
        this.pendingMaterializeRetryWakeTimer.unref?.();
    }

    /**
     * Canonical turn lifecycle → pending-queue drain trigger.
     *
     * Turns recorded through the canonical session turn lifecycle (e.g. Claude unified
     * terminal turns) do not flow through ACP lifecycle markers, so without this the
     * locally cached latest-turn-status snapshot can stay 'in_progress' forever after a
     * turn ends — permanently blocking pending-queue materialization until a manual
     * "Send now". Keep the snapshot truthful and, on terminal events, wake pending
     * consumers and recover a possibly lost pending-count nudge (fail-safe: a duplicate
     * wake/reconcile is harmless; a missing one strands queued messages).
     */
    private observeTurnLifecycleForPendingDrain(
        event: SessionTurnLifecycleObserverEvent,
        terminalStatus?: 'completed' | 'failed',
    ): void {
        const observedAtMs = Date.now();
        if (event === 'prompt_or_steer' || event === 'task_started') {
            if (this.localActiveTurnStartedAtMs === null || !this.sessionTurnLifecycle.hasActiveTurn()) {
                this.localActiveTurnStartedAtMs = observedAtMs;
            }
            this.lastLocalActiveTurnProgressAtMs = observedAtMs;
        }
        const mapped = latestTurnStatusForTurnLifecycleEvent(event, terminalStatus);
        if (mapped !== undefined) {
            this.latestTurnStatus = mapped;
            this.latestTurnStatusObservedAtMs = observedAtMs;
        }
        if (!isTerminalTurnLifecycleEvent(event) || this.closed) return;
        this.localActiveTurnStartedAtMs = null;
        this.lastLocalActiveTurnProgressAtMs = null;
        this.clearPendingMaterializeRetryWake();
        logger.debug('[pendingQueue] turn-end drain trigger', {
            sessionId: this.sessionId,
            event,
            terminalStatus: terminalStatus ?? null,
            pendingCount: this.pendingQueueState.known ? this.pendingQueueState.pendingCount : null,
        });
        this.pendingWakeSeq += 1;
        this.emit('metadata-updated');
        void this.reconcilePendingQueueState({ force: false }).catch(() => undefined);
        void this.catchUpOwedUserMessagesAfterTurnEnd().catch(() => undefined);
    }

    /**
     * Owed-delivery recovery at turn end (QA C-F2/A-F3 family): a user row committed into the
     * transcript while the provider turn was running can miss its socket broadcast, and nothing
     * replays it later — it stays invisible to the agent loop forever. Re-pull the transcript
     * window after the delivered/observed user-row cursor; `sessionNewMessageUpdate` echo
     * suppression and the deliveredUserMessageSeqV1 watermark absorb duplicates
     * (at-least-once delivery, never silently stuck).
     */
    private async catchUpOwedUserMessagesAfterTurnEnd(): Promise<void> {
        if (this.owedUserMessageCatchUpInFlight) return;
        const now = Date.now();
        if (
            this.lastOwedUserMessageCatchUpAt > 0
            && now - this.lastOwedUserMessageCatchUpAt < configuration.pendingQueueStateReconcileThrottleMs
        ) {
            return;
        }
        this.lastOwedUserMessageCatchUpAt = now;
        if (this.canonicalPendingDeliveryByLocalId.size > 0) {
            logger.debug('[pendingQueue] owed user-message turn-end catch-up skipped (canonical pending delivery unresolved)', {
                sessionId: this.sessionId,
                unresolvedCanonicalPendingDeliveryCount: this.canonicalPendingDeliveryByLocalId.size,
            });
            return;
        }
        const watermarkState = this.readDeliveredUserMessageWatermarkState();
        const afterSeq = Math.max(0, Math.min(
            watermarkState.effective ?? Number.MAX_SAFE_INTEGER,
            this.lastObservedUserMessageSeq,
        ));
        this.owedUserMessageCatchUpInFlight = true;
        logger.debug('[pendingQueue] owed user-message turn-end catch-up', {
            sessionId: this.sessionId,
            afterSeq,
            deliveredWatermark: watermarkState.effective,
            lastObservedUserMessageSeq: this.lastObservedUserMessageSeq,
        });
        try {
            // Explicit cursor: this is a deliberate owed-delivery replay (the watermark/observed
            // cursor authorizes delivery of rows beyond it to the agent queue).
            await this.catchUpSessionMessages({
                afterSeq,
                authorization: 'explicit_cursor',
            });
        } catch (error) {
            logger.debug('[pendingQueue] owed user-message turn-end catch-up failed (non-fatal)', {
                sessionId: this.sessionId,
                afterSeq,
                error: serializeAxiosErrorForLog(error),
            });
        } finally {
            this.owedUserMessageCatchUpInFlight = false;
        }
    }

    /**
     * Self-heal a stale 'in_progress' snapshot status: when ONLY the snapshot status
     * blocks materialization (no canonical active turn locally — e.g. a respawned
     * runner that never began the turn, or a lost turn-end signal), re-fetch the
     * server snapshot on a throttle so queued messages can never starve forever.
     */
    private async refreshStaleBlockedTurnStatusIfNeeded(): Promise<void> {
        const hasLocalActiveTurn = this.sessionTurnLifecycle.hasActiveTurn();
        const localActiveTurnIsStale = hasLocalActiveTurn && this.hasStaleLocalActiveTurnWithoutProgress();
        if (hasLocalActiveTurn && !localActiveTurnIsStale) return;
        if (!isActiveLatestTurnStatus(this.latestTurnStatus)) return;
        const now = Date.now();
        if (
            this.lastBlockedTurnStatusRefreshAt > 0
            && now - this.lastBlockedTurnStatusRefreshAt < configuration.pendingQueueStateReconcileThrottleMs
        ) {
            return;
        }
        this.lastBlockedTurnStatusRefreshAt = now;
        if (localActiveTurnIsStale) {
            logger.debug('[pendingQueue] stale local active turn snapshot reconcile', {
                sessionId: this.sessionId,
                latestTurnStatus: this.latestTurnStatus ?? null,
                localActiveTurnStartedAtMs: this.localActiveTurnStartedAtMs,
                lastLocalActiveTurnProgressAtMs: this.lastLocalActiveTurnProgressAtMs,
                staleAfterMs: STALE_LOCAL_ACTIVE_TURN_RECONCILE_MS,
            });
        }
        await this.syncSessionSnapshotFromServer({ reason: 'explicit-drain' });
    }

    private async reconcileTurnStatusBeforePendingMaterializationIfNeeded(opts: {
        activeTurnDeliveryPolicy?: PendingMaterializationActiveTurnPolicy;
    } = {}): Promise<boolean> {
        if (!this.pendingQueueState.known || countMaterializablePendingRows(this.pendingQueueState) <= 0) return true;
        if (this.isPendingMaterializationBlocked(opts)) {
            await this.refreshStaleBlockedTurnStatusIfNeeded();
            return true;
        }
        if (this.latestTurnStatus === undefined) return true;

        const pendingVersion = this.pendingQueueState.pendingVersion;
        if (
            this.lastTurnStatusRefreshPendingVersion === pendingVersion
        ) {
            return true;
        }

        const refreshed = await this.syncSessionSnapshotFromServer({ reason: 'explicit-drain' });
        if (!refreshed) {
            return false;
        }

        if (this.pendingQueueState.known && this.latestTurnStatus !== undefined) {
            this.lastTurnStatusRefreshPendingVersion = this.pendingQueueState.pendingVersion;
        }
        return true;
    }

    private syncSessionSnapshotFromServer(opts: { reason: SessionSnapshotRefreshReasonInput }): Promise<boolean> {
        if (this.closed) return Promise.resolve(false);
        if (this.snapshotSyncInFlight) return this.snapshotSyncInFlight;

        const p = (async (): Promise<boolean> => {
            try {
                const request = () => fetchSessionSnapshotUpdateFromServer({
                    token: this.token,
                    sessionId: this.sessionId,
                    encryptionKey: this.encryptionKey,
                    encryptionVariant: this.encryptionVariant,
                    currentMetadataVersion: this.metadataVersion,
                    currentAgentStateVersion: this.agentStateVersion,
                    currentMetadata: this.metadata,
                    currentAgentState: this.agentState,
                    reason: opts.reason,
                });
                const supervisor = this.sessionConnectionSupervisor;
                const update = supervisor
                    ? await runSupervisedRequest({
                        supervisor,
                        requireAuth: true,
                        requireOnline: false,
                        request,
                    })
                    : await request();

                if (this.closed) return false;

                if (update.metadata) {
                    this.metadata = update.metadata.metadata;
                    this.metadataVersion = update.metadata.metadataVersion;
                    this.emit('metadata-updated');
                }

                if (update.agentState) {
                    this.agentState = update.agentState.agentState;
                    this.agentStateVersion = update.agentState.agentStateVersion;
                }

                if ('latestTurnStatus' in update) {
                    this.latestTurnStatus = update.latestTurnStatus;
                    this.latestTurnStatusObservedAtMs = readFiniteTimestampMs(
                        (update as { latestTurnStatusObservedAt?: unknown }).latestTurnStatusObservedAt,
                    ) ?? Date.now();
                }

                if (hasRuntimeActivityProjectionFields(update)) {
                    this.applyRuntimeActivityProjectionFromServer(update);
                }

                if (update.pendingQueueState) {
                    this.applyPendingQueueState(update.pendingQueueState, { emit: true });
                }
                return true;
            } catch (error) {
                logger.debug('[API] Failed to sync session snapshot from server', {
                    reason: opts.reason,
                    error: serializeAxiosErrorForLog(error),
                });
                return false;
            }
        })();

        const inFlight = p.finally(() => {
            if (this.snapshotSyncInFlight === inFlight) {
                this.snapshotSyncInFlight = null;
            }
        });
        this.snapshotSyncInFlight = inFlight;

        return this.snapshotSyncInFlight;
    }

    private kickUserSocketConnect(): void {
        if (this.closed) return;
        if (
            !this.socket?.connected
            && this.currentConnectionState.phase !== 'online'
            && this.currentConnectionState.phase !== 'connecting'
        ) {
            return;
        }
        if (this.userSocketDisconnectTimer) {
            clearTimeout(this.userSocketDisconnectTimer);
            this.userSocketDisconnectTimer = null;
        }
        if (this.userSocket.connected) return;
        try {
            this.userSocket.connect();
        } catch {
            // ignore; transcript recovery will handle missed updates
        }
    }

    private maybeScheduleUserSocketDisconnect(): void {
        if (this.closed) return;
        if (this.shouldKeepUserSocketConnected()) return;
        if (!this.userSocket.connected) return;
        if (this.userSocketDisconnectTimer) return;

        // Short idle grace to avoid thrashing if multiple pending items get materialized back-to-back.
        this.userSocketDisconnectTimer = setTimeout(() => {
            this.userSocketDisconnectTimer = null;
            if (this.shouldKeepUserSocketConnected()) return;
            if (!this.userSocket.connected) return;
            try {
                this.userSocket.disconnect();
            } catch {
                // ignore
            }
        }, 2_000);
        this.userSocketDisconnectTimer.unref?.();
    }

    private hasMaterializedLocalId(localId: string): boolean {
        return this.pendingMaterializedLocalIds.has(localId)
            || this.committedLocalIdsAwaitingEcho.has(localId)
            || this.pendingQueueMaterializedLocalIds.has(localId);
    }

    private shouldKeepUserSocketConnected(): boolean {
        return this.pendingMessageCallback !== null
            || this.pendingMaterializedLocalIds.size > 0
            || this.committedLocalIdsAwaitingEcho.size > 0
            || this.pendingQueueMaterializedLocalIds.size > 0
            || this.queuedDisconnectedSessionMessages.size > 0;
    }

    private queueSessionMessageUntilReconnect(params: { message: string | { t: 'plain'; v: unknown }; localId: string; sidechainId: string | null; messageRole?: SessionMessageRole; sessionEventType?: 'ready' }): void {
        if (this.closed) return;
        this.queuedDisconnectedSessionMessages.set(params.localId, params);
        this.kickSessionSocketReconnectForQueuedMessage(params.localId);
    }

    private kickSessionSocketReconnectForQueuedMessage(localId: string): void {
        const supervisor = this.sessionConnectionSupervisor;
        if (!supervisor) return;
        void supervisor.start().catch((error) => {
            logger.debug('[API] Failed to restart session socket for queued message', {
                localId,
                error: serializeAxiosErrorForLog(error),
            });
        });
    }

    private kickSessionSocketReconnectForDurableMutation(reason: string): void {
        const supervisor = this.sessionConnectionSupervisor;
        if (!supervisor) return;
        void supervisor.start().catch((error) => {
            logger.debug('[API] Failed to restart session socket for durable mutation', {
                reason,
                error: serializeAxiosErrorForLog(error),
            });
        });
    }

    private async flushQueuedSessionMessagesOnReconnect(): Promise<void> {
        if (this.closed) return;
        if (!this.socket.connected) return;
        if (this.queuedDisconnectedSessionMessages.size === 0) return;

        const queued = [...this.queuedDisconnectedSessionMessages.values()];
        this.queuedDisconnectedSessionMessages.clear();
        for (const params of queued) {
            await this.enqueueMessageCommit(() =>
                this.commitSessionMessage({
                    message: params.message,
                    localId: params.localId,
                    sidechainId: params.sidechainId,
                    messageRole: params.messageRole,
                    sessionEventType: params.sessionEventType,
                    requireCommit: false,
                }),
            );
        }
    }

    private hasSelfEchoSuppressedLocalId(localId: string): boolean {
        return this.pendingMaterializedLocalIds.has(localId)
            || this.committedLocalIdsAwaitingEcho.has(localId);
    }

    private hasAgentQueueEchoSuppressedLocalId(localId: string): boolean {
        return this.agentQueueEchoSuppressedLocalIds.has(localId);
    }

    private hasAgentQueueDeliveredLocalId(localId: string): boolean {
        return this.agentQueueDeliveredLocalIds.has(localId);
    }

    private hasPassiveCommittedUserMessageLocalId(localId: string): boolean {
        return this.passiveCommittedUserMessageLocalIds.has(localId);
    }

    private hasPendingQueueMaterializedLocalId(localId: string): boolean {
        return this.pendingQueueMaterializedLocalIds.has(localId);
    }

    private markAgentQueueEchoSuppressedLocalId(localId: string): void {
        if (!localId) return;
        this.agentQueueEchoSuppressedLocalIds.add(localId);
        const existingTimer = this.agentQueueEchoSuppressedLocalIdCleanupTimers.get(localId) ?? null;
        if (existingTimer) {
            clearTimeout(existingTimer);
        }
        const timer = setTimeout(() => {
            this.agentQueueEchoSuppressedLocalIdCleanupTimers.delete(localId);
            this.agentQueueEchoSuppressedLocalIds.delete(localId);
        }, configuration.transcriptRecoveryMaxWaitMs);
        timer.unref?.();
        this.agentQueueEchoSuppressedLocalIdCleanupTimers.set(localId, timer);
    }

    private markAgentQueueDeliveredLocalId(localId: string): void {
        if (!localId) return;
        this.agentQueueDeliveredLocalIds.add(localId);
        const existingTimer = this.agentQueueDeliveredLocalIdCleanupTimers.get(localId) ?? null;
        if (existingTimer) {
            clearTimeout(existingTimer);
        }
        const timer = setTimeout(() => {
            this.agentQueueDeliveredLocalIdCleanupTimers.delete(localId);
            this.agentQueueDeliveredLocalIds.delete(localId);
        }, configuration.transcriptRecoveryMaxWaitMs);
        timer.unref?.();
        this.agentQueueDeliveredLocalIdCleanupTimers.set(localId, timer);
    }

    private markProviderAcceptedUserMessageLocalIdAwaitingSeq(localId: string): void {
        if (!localId) return;
        this.providerAcceptedUserMessageLocalIdsAwaitingSeq.add(localId);
        const existingTimer = this.providerAcceptedUserMessageLocalIdCleanupTimers.get(localId) ?? null;
        if (existingTimer) {
            clearTimeout(existingTimer);
        }
        const timer = setTimeout(() => {
            this.providerAcceptedUserMessageLocalIdCleanupTimers.delete(localId);
            this.providerAcceptedUserMessageLocalIdsAwaitingSeq.delete(localId);
        }, configuration.transcriptRecoveryMaxWaitMs);
        timer.unref?.();
        this.providerAcceptedUserMessageLocalIdCleanupTimers.set(localId, timer);
    }

    private clearProviderAcceptedUserMessageLocalIdAwaitingSeq(localId: string): void {
        this.providerAcceptedUserMessageLocalIdsAwaitingSeq.delete(localId);
        const timer = this.providerAcceptedUserMessageLocalIdCleanupTimers.get(localId) ?? null;
        if (timer) {
            clearTimeout(timer);
            this.providerAcceptedUserMessageLocalIdCleanupTimers.delete(localId);
        }
    }

    private persistProviderAcceptedCommittedUserMessageSeq(localId: string, seq: number | null): void {
        if (!localId || seq === null || !this.providerAcceptedUserMessageLocalIdsAwaitingSeq.has(localId)) {
            return;
        }
        if (this.canonicalPendingDeliveryByLocalId.has(localId)) {
            return;
        }
        this.clearProviderAcceptedUserMessageLocalIdAwaitingSeq(localId);
        this.highestProviderAcceptedUserMessageSeq = Math.max(
            this.highestProviderAcceptedUserMessageSeq ?? -1,
            seq,
        );
        this.persistDeliveredUserMessageWatermark(seq);
    }

    private recordCommittedUserMessageSeq(localId: unknown, seq: unknown): number | null {
        const committedSeq = this.committedUserMessageSeqTracker.record(
            typeof localId === 'string' ? localId : null,
            seq,
        );
        if (typeof localId === 'string') {
            this.persistProviderAcceptedCommittedUserMessageSeq(localId, committedSeq);
        }
        return committedSeq;
    }

    private markPassiveCommittedUserMessageLocalId(localId: string): void {
        if (!localId) return;
        this.passiveCommittedUserMessageLocalIds.add(localId);
        const existingTimer = this.passiveCommittedUserMessageLocalIdCleanupTimers.get(localId) ?? null;
        if (existingTimer) {
            clearTimeout(existingTimer);
        }
        const timer = setTimeout(() => {
            this.passiveCommittedUserMessageLocalIdCleanupTimers.delete(localId);
            this.passiveCommittedUserMessageLocalIds.delete(localId);
        }, configuration.transcriptRecoveryMaxWaitMs);
        timer.unref?.();
        this.passiveCommittedUserMessageLocalIdCleanupTimers.set(localId, timer);
    }

    private markCommittedLocalIdAwaitingEcho(localId: string): void {
        this.pendingMaterializedLocalIds.delete(localId);
        this.committedLocalIdsAwaitingEcho.add(localId);
        const existingTimer = this.committedLocalIdCleanupTimers.get(localId) ?? null;
        if (existingTimer) {
            clearTimeout(existingTimer);
        }
        const timer = setTimeout(() => {
            this.committedLocalIdCleanupTimers.delete(localId);
            this.committedLocalIdsAwaitingEcho.delete(localId);
            this.maybeScheduleUserSocketDisconnect();
        }, configuration.transcriptRecoveryMaxWaitMs);
        timer.unref?.();
        this.committedLocalIdCleanupTimers.set(localId, timer);
    }

    private deleteMaterializedLocalId(localId: string): void {
        this.pendingMaterializedLocalIds.delete(localId);
        this.committedLocalIdsAwaitingEcho.delete(localId);
        this.pendingQueueMaterializedLocalIds.delete(localId);
        const cleanupTimer = this.committedLocalIdCleanupTimers.get(localId) ?? null;
        if (cleanupTimer) {
            clearTimeout(cleanupTimer);
            this.committedLocalIdCleanupTimers.delete(localId);
        }
        this.materializationRecoveryScheduler.cancel(localId);
        this.transcriptRecoveryErrorStateByLocalId.delete(localId);
        this.maybeScheduleUserSocketDisconnect();
    }

    private shouldDeliverUserMessageToAgentQueueFromUpdate(
        message: UserMessage,
        update: Update,
        opts: { catchUpAfterSeq?: number; catchUpAuthorization?: SessionCatchUpAuthorization },
    ): boolean {
        const localId = typeof message.localId === 'string' ? message.localId.trim() : '';
        const msgSeq =
            update.body?.t === 'new-message'
                && typeof update.body.message.seq === 'number'
                && Number.isFinite(update.body.message.seq)
                ? Math.trunc(update.body.message.seq)
                : null;
        const logUnauthorizedCatchUpSuppression = (): boolean => {
            logger.debug('[DELIVERY-DECISION] catch-up user-message suppressed (no explicit authorization)', {
                sessionId: this.sessionId,
                updateId: update?.id,
                msgSeq,
                messageLocalId: message.localId,
                messageSource: message.meta?.source ?? null,
                catchUpAfterSeq: opts.catchUpAfterSeq,
                catchUpAuthorization: opts.catchUpAuthorization ?? null,
                callbackAttachedAtMs: this.userMessageCallbackAttachedAtMs,
                createdAtMs: message.createdAt,
                decision: false,
                reason: 'no_explicit_authorization',
            });
            return false;
        };

        const deliveryIntent = readSessionUserMessageDeliveryIntentMeta(message.meta);
        if (
            deliveryIntent === 'explicit_pending'
            && isActiveLatestTurnStatus(this.latestTurnStatus)
            && !isExplicitCatchUpAuthorization(opts.catchUpAuthorization)
        ) {
            logger.debug('[DELIVERY-DECISION] explicit pending user-message held during active turn', {
                sessionId: this.sessionId,
                updateId: update?.id,
                msgSeq,
                messageLocalId: message.localId,
                catchUpAfterSeq: opts.catchUpAfterSeq,
                catchUpAuthorization: opts.catchUpAuthorization ?? null,
                latestTurnStatus: this.latestTurnStatus ?? null,
                decision: false,
                reason: 'explicit_pending_active_turn',
            });
            return false;
        }

        if (!update?.id?.startsWith('catchup-')) return true;

        if (localId && this.canonicalPendingDeliveryByLocalId.has(localId)) {
            logger.debug('[DELIVERY-DECISION] catch-up user-message suppressed (canonical pending delivery owns row)', {
                sessionId: this.sessionId,
                updateId: update?.id,
                msgSeq,
                messageLocalId: message.localId,
                catchUpAfterSeq: opts.catchUpAfterSeq,
                catchUpAuthorization: opts.catchUpAuthorization ?? null,
                decision: false,
                reason: 'canonical_pending_delivery_unresolved',
            });
            return false;
        }

        if (message.meta?.source === 'daemon-initial-prompt') {
            const expectedLocalId = buildDaemonInitialPromptLocalId(this.sessionId);
            return Boolean(expectedLocalId && localId === expectedLocalId);
        }

        const createdAtMs =
            typeof message.createdAt === 'number' && Number.isFinite(message.createdAt)
                ? message.createdAt
                : null;
        const callbackAttachedAtMs =
            typeof this.userMessageCallbackAttachedAtMs === 'number'
            && Number.isFinite(this.userMessageCallbackAttachedAtMs)
                ? this.userMessageCallbackAttachedAtMs
                : null;
        if (
            msgSeq !== null
            && localId
            && createdAtMs !== null
            && callbackAttachedAtMs !== null
            && createdAtMs >= callbackAttachedAtMs
        ) {
            logger.debug('[DELIVERY-DECISION] catch-up user-message delivered (created after callback attachment)', {
                sessionId: this.sessionId,
                updateId: update?.id,
                msgSeq,
                messageLocalId: message.localId,
                messageSource: message.meta?.source ?? null,
                catchUpAfterSeq: opts.catchUpAfterSeq,
                catchUpAuthorization: opts.catchUpAuthorization ?? null,
                callbackAttachedAtMs,
                createdAtMs,
                decision: true,
                reason: 'post_callback_catchup_delivery',
            });
            return true;
        }

        const rawCatchUpAfterSeq = opts.catchUpAfterSeq;
        const catchUpAfterSeq =
            typeof rawCatchUpAfterSeq === 'number' && Number.isFinite(rawCatchUpAfterSeq) && rawCatchUpAfterSeq >= 0
                ? Math.trunc(rawCatchUpAfterSeq)
                : null;

        if (
            catchUpAfterSeq !== null
            && (
                isExplicitCatchUpAuthorization(opts.catchUpAuthorization)
                || isPositiveWatermarkCatchUpAuthorization(opts.catchUpAuthorization, catchUpAfterSeq)
            )
        ) {
            return msgSeq !== null && msgSeq > catchUpAfterSeq;
        }

        return logUnauthorizedCatchUpSuppression();
    }

    private handleUpdate(data: Update, opts: {
        source: 'session-scoped' | 'user-scoped';
        catchUpAfterSeq?: number;
        catchUpAuthorization?: SessionCatchUpAuthorization;
    }): void {
        try {
            this.socketStaleSafetyScheduler?.recordInboundUpdate();
            logger.debugLargeJson(`[SOCKET] [UPDATE:${opts.source}] Received update:`, data);

            if (!data.body) {
                logger.debug('[SOCKET] [UPDATE] [ERROR] No body in update!');
                return;
            }

            if (
                (data.body as any)?.t === 'message-updated'
                && (data.body as any)?.sid === this.sessionId
            ) {
                const updatedLocalId = typeof (data.body as any)?.message?.localId === 'string'
                    ? (data.body as any).message.localId
                    : null;
                if (updatedLocalId && this.hasSelfEchoSuppressedLocalId(updatedLocalId)) {
                    this.deleteMaterializedLocalId(updatedLocalId);
                }
            }

            this.recordCommittedUserMessageSeqFromUpdate(data);

            const newMessageHandlingResult = handleSessionNewMessageUpdate({
                update: data,
                sessionId: this.sessionId,
                encryptionKey: this.encryptionKey,
                encryptionVariant: this.encryptionVariant,
                receivedMessageIds: this.receivedMessageIds,
                allowReprocessReceivedMessageIds: isExplicitCatchUpAuthorization(opts.catchUpAuthorization),
                lastObservedMessageSeq: this.lastObservedMessageSeq,
                lastObservedUserMessageSeq: this.lastObservedUserMessageSeq,
                hasSelfEchoSuppressedLocalId: (localId) => this.hasSelfEchoSuppressedLocalId(localId),
                hasAgentQueueEchoSuppressedLocalId: (localId) => this.hasAgentQueueEchoSuppressedLocalId(localId),
                hasPassiveCommittedUserMessageLocalId: (localId) => this.hasPassiveCommittedUserMessageLocalId(localId),
                markAgentQueueEchoSuppressedLocalId: (localId) => this.markAgentQueueEchoSuppressedLocalId(localId),
                hasAgentQueueDeliveredLocalId: (localId) => this.hasAgentQueueDeliveredLocalId(localId),
                markAgentQueueDeliveredLocalId: (localId) => this.markAgentQueueDeliveredLocalId(localId),
                hasPendingQueueMaterializedLocalId: (localId) => this.hasPendingQueueMaterializedLocalId(localId),
                deleteMaterializedLocalId: (localId) => this.deleteMaterializedLocalId(localId),
                pendingMessageCallback: this.pendingMessageCallback,
                pendingMessages: this.pendingMessages,
                isProviderOwnedUserMessageEcho: this.providerOwnedUserMessageEchoClassifier ?? undefined,
                shouldDeliverUserMessageToAgentQueue: (message, update) =>
                    this.shouldDeliverUserMessageToAgentQueueFromUpdate(message, update, {
                        catchUpAfterSeq: opts.catchUpAfterSeq,
                        catchUpAuthorization: opts.catchUpAuthorization,
                    }),
                onUserMessageDeliveredToAgentQueue: (seq) => this.recordDeliveredUserMessageSeq(seq),
                // Echo-proven rows carried a seq through an earlier local handoff path even when
                // the current socket row is only the transcript echo. Provider-native transcript
                // rows are suppressed separately, and provider-acceptance-deferred sessions must
                // still wait for the terminal/provider confirmation before persisting the watermark.
                onUserMessageDeliveryProvenByLocalEcho: (seq) => this.recordDeliveredUserMessageSeq(seq),
                onObservedMessage: (message) => {
                    if (isProviderProgressTranscriptBody(message.body) && this.sessionTurnLifecycle.hasActiveTurn()) {
                        this.lastLocalActiveTurnProgressAtMs = message.createdAt ?? Date.now();
                    }
                    this.observeTurnAssistantTextFromSessionContent(message.body, {
                        source: 'transcript',
                        seq: message.seq,
                        localId: message.localId,
                        sidechainId: message.sidechainId,
                        observedAtMs: message.createdAt ?? Date.now(),
                    });
                },
                emit: (event, payload) => this.emit(event, payload),
                debug: (message, payload) => logger.debug(message, payload),
                debugLargeJson: (message, payload) => logger.debugLargeJson(message, payload),
            });
            if (newMessageHandlingResult.handled) {
                this.lastObservedMessageSeq = newMessageHandlingResult.lastObservedMessageSeq;
                this.lastObservedUserMessageSeq = Math.max(
                    this.lastObservedUserMessageSeq,
                    newMessageHandlingResult.lastObservedUserMessageSeq,
                );
                return;
            }

            let shouldEmitMetadataUpdated = false;
            let pendingChangedDrainTriggered = false;
            const stateUpdateResult = handleSessionStateUpdate({
                update: data,
                updateSource: opts.source,
                sessionId: this.sessionId,
                sessionEncryptionMode: this.sessionEncryptionMode,
                metadata: this.metadata,
                metadataVersion: this.metadataVersion,
                agentState: this.agentState,
                agentStateVersion: this.agentStateVersion,
                pendingWakeSeq: this.pendingWakeSeq,
                pendingQueueState: this.pendingQueueState,
                runtimeActivityProjection: this.runtimeActivityProjection,
                encryptionKey: this.encryptionKey,
                encryptionVariant: this.encryptionVariant,
                onMetadataUpdated: () => {
                    shouldEmitMetadataUpdated = true;
                },
                onPendingChangedDrainTrigger: (snapshot) => {
                    pendingChangedDrainTriggered = true;
                    logger.debug('[pendingQueue] pending-changed drain trigger', {
                        sessionId: this.sessionId,
                        updateSource: opts.source,
                        pendingCount: snapshot.pendingCount,
                        pendingBlockedCount: snapshot.pendingBlockedCount,
                        pendingVersion: snapshot.pendingVersion,
                    });
                },
                onWarning: (message) => logger.debug(message),
            });
            if (stateUpdateResult.handled) {
                this.metadata = stateUpdateResult.metadata;
                this.metadataVersion = stateUpdateResult.metadataVersion;
                this.agentState = stateUpdateResult.agentState;
                this.agentStateVersion = stateUpdateResult.agentStateVersion;
                this.pendingWakeSeq = stateUpdateResult.pendingWakeSeq;
                this.pendingQueueState = stateUpdateResult.pendingQueueState;
                if (pendingChangedDrainTriggered && countMaterializablePendingRows(this.pendingQueueState) > 0) {
                    this.schedulePendingMaterializeRetryWake('pending_changed');
                } else {
                    this.clearPendingMaterializeRetryWakeIfDrained();
                }
                this.applyRuntimeActivityProjectionFromServer(stateUpdateResult.runtimeActivityProjection);
                if (shouldEmitMetadataUpdated) {
                    this.emit('metadata-updated');
                }
                return;
            }

            // If not a user message, it might be a permission response or other message type
            this.emit('message', data.body);
        } catch (error) {
            logger.debug('[SOCKET] [UPDATE] [ERROR] Error handling update', {
                error: serializeAxiosErrorForLog(error),
            });
        }
    }

    private recordCommittedUserMessageSeqFromUpdate(data: Update): void {
        const body = data.body as any;
        if (
            body?.sid !== this.sessionId
            || (body?.t !== 'new-message' && body?.t !== 'message-updated')
        ) {
            return;
        }
        const message = body.message;
        const messageRole =
            message?.messageRole
            ?? message?.content?.v?.role
            ?? message?.content?.role
            ?? null;
        if (messageRole !== 'user') {
            return;
        }
        this.recordCommittedUserMessageSeq(message.localId, message.seq);
    }

    private async getAccountId(): Promise<string | null> {
        if (this.accountIdPromise) {
            try {
                return await this.accountIdPromise;
            } catch (error) {
                this.accountIdPromise = null;
                if (isAuthenticationError(error)) {
                    if (this.sessionConnectionSupervisor) {
                        return null;
                    }
                    throw error;
                }
                return null;
            }
        }

        const request = () => fetchChangesAccountId({ token: this.token });
        const supervisor = this.sessionConnectionSupervisor;
        const p = supervisor
            ? runSupervisedRequest({
                supervisor,
                requireAuth: true,
                requireOnline: false,
                request,
            })
            : request();

        this.accountIdPromise = p;
        try {
            return await p;
        } catch (error) {
            this.accountIdPromise = null;
            if (isAuthenticationError(error)) {
                if (supervisor) {
                    return null;
                }
                throw error;
            }
            return null;
        }
    }

    private async catchUpSessionMessages(catchUpRequest: SessionCatchUpRequest): Promise<void> {
        const request = () => catchUpSessionMessagesAfterSeq({
            token: this.token,
            sessionId: this.sessionId,
            afterSeq: catchUpRequest.afterSeq,
            onUpdate: (update) => this.handleUpdate(update, {
                source: 'session-scoped',
                catchUpAfterSeq: catchUpRequest.afterSeq,
                catchUpAuthorization: catchUpRequest.authorization,
            }),
        });
        const supervisor = this.sessionConnectionSupervisor;
        if (!supervisor) {
            await request();
            return;
        }
        await runSupervisedRequest({
            supervisor,
            requireAuth: true,
            requireOnline: false,
            request,
        });
    }

    private shouldRunStartupTranscriptCatchUp(): boolean {
        return (
            this.startedByDaemonProcess ||
            this.metadata?.startedBy === 'daemon' ||
            this.metadata?.startedFromDaemon === true
        );
    }

    private resolveStartupTranscriptCatchUpInitialCursor(): SessionCatchUpRequest {
        if (this.startupMessageCatchUpExplicitAfterSeq !== null) {
            return {
                afterSeq: this.startupMessageCatchUpExplicitAfterSeq,
                authorization: this.startupMessageCatchUpInitialAuthorization ?? 'explicit_cursor',
            };
        }

        const base = Math.max(0, Math.trunc(this.lastObservedMessageSeq));
        if (!this.shouldRunStartupTranscriptCatchUp()) {
            return { afterSeq: base, authorization: 'startup_recovery' };
        }
        const rewind = Math.max(0, Math.trunc(configuration.startupTranscriptCatchUpSeqRewind));
        if (rewind <= 0) {
            return { afterSeq: base, authorization: 'startup_recovery' };
        }
        return { afterSeq: Math.max(0, base - rewind), authorization: 'startup_recovery' };
    }

    private scheduleNextStartupMessageCatchUpRetry(): void {
        if (this.closed) return;
        if (this.startupMessageCatchUpRetryTimer) return;
        if (!this.shouldRunStartupTranscriptCatchUp()) return;
        if (this.currentConnectionState?.phase === 'auth_failed') return;

        const delayMs = ApiSessionClient.STARTUP_MESSAGE_CATCH_UP_RETRY_DELAYS_MS[this.startupMessageCatchUpRetryIndex];
        if (typeof delayMs !== 'number') return;

        logger.debug('[API] Scheduling startup transcript catch-up retry', {
            delayMs,
            retryIndex: this.startupMessageCatchUpRetryIndex,
            startupMessageCatchUpInitialAfterSeq: this.startupMessageCatchUpInitialAfterSeq,
            startupMessageCatchUpInitialAuthorization: this.startupMessageCatchUpInitialAuthorization ?? 'startup_recovery',
            lastObservedMessageSeq: this.lastObservedMessageSeq,
        });
        this.startupMessageCatchUpRetryTimer = setTimeout(() => {
            this.startupMessageCatchUpRetryTimer = null;
            if (this.closed) return;

            this.startupMessageCatchUpRetryIndex += 1;
            logger.debug('[API] Running startup transcript catch-up retry', {
                retryIndex: this.startupMessageCatchUpRetryIndex,
                afterSeq: this.startupMessageCatchUpInitialAfterSeq,
                authorization: this.startupMessageCatchUpInitialAuthorization ?? 'startup_recovery',
            });
            void this.catchUpSessionMessages({
                afterSeq: this.startupMessageCatchUpInitialAfterSeq,
                authorization: this.startupMessageCatchUpInitialAuthorization ?? 'startup_recovery',
            })
                .catch((error) => {
                    if (isAuthenticationError(error)) {
                        logger.debug('[API] Startup transcript catch-up retry failed with terminal auth', {
                            error: serializeAxiosErrorForLog(error),
                        });
                        return false;
                    }
                    logger.debug('[API] Startup transcript catch-up retry failed (non-fatal)', {
                        error: serializeAxiosErrorForLog(error),
                    });
                    return true;
                })
                .then((shouldContinue) => {
                    if (shouldContinue !== false) {
                        this.scheduleNextStartupMessageCatchUpRetry();
                    }
                });
        }, delayMs);
        this.startupMessageCatchUpRetryTimer.unref?.();
    }

    private async runSocketStaleSafetyTick(): Promise<void> {
        if (this.closed) return;
        await this.syncChangesOnConnect({ reason: 'socket-stale-safety-tick' }).catch((error) => {
            logger.debug('[API] Session changes stale-socket safety tick failed (non-fatal)', {
                error: serializeAxiosErrorForLog(error),
            });
        });
        await this.sweepStaleProviderDeliveryClaims().catch((error) => {
            logger.debug('[pendingQueue] provider delivery stale-safety sweep failed (non-fatal)', {
                sessionId: this.sessionId,
                error: serializeAxiosErrorForLog(error),
            });
        });
    }

    private async sweepStaleProviderDeliveryClaims(): Promise<void> {
        if (this.closed || !this.shouldUseProviderDeliveryStateMaterialization()) return;

        const supervisor = this.sessionConnectionSupervisor;
        const request = () => blockPendingQueueV2ProviderDeliveriesOnAttach({
            token: this.token,
            sessionId: this.sessionId,
        });
        const result = supervisor
            ? await runSupervisedRequest({
                supervisor,
                requireAuth: true,
                requireOnline: false,
                request,
            })
            : await request();
        if (result.pendingQueueState) {
            this.applyPendingQueueState(result.pendingQueueState, { emit: true });
        }
    }

    private async syncChangesOnConnect(opts: { reason: SessionChangesSyncReason }): Promise<void> {
        const enabled = isV2ChangesSyncEnabled(process.env.HAPPY_ENABLE_V2_CHANGES);
        if (!enabled) {
            return;
        }

        if (this.closed) return;
        if (this.changesSyncInFlight) {
            await this.changesSyncInFlight.catch(() => {});
        }

        const p = runSessionChangesSyncOnConnect({
            reason: opts.reason,
            token: this.token,
            sessionId: this.sessionId,
            lastObservedMessageSeq: this.lastObservedMessageSeq,
            getAccountId: () => this.getAccountId(),
            readChangesCursor: (accountId) => this.readSessionChangesCursor(accountId),
            writeChangesCursor: (accountId, cursor) => this.writeSessionChangesCursor(accountId, cursor),
            catchUpSessionMessages: (request) => this.catchUpSessionMessages(request),
            syncSessionSnapshotFromServer: async (syncOpts) => {
                await this.syncSessionSnapshotFromServer(syncOpts);
            },
            applyPendingQueueState: (state) => this.applyPendingQueueState(state, { emit: true }),
            connectionSupervisor: this.sessionConnectionSupervisor,
            onDebug: (message, data) => logger.debug(message, data),
        });

        this.changesSyncInFlight = p;
        try {
            await p;
        } finally {
            if (this.changesSyncInFlight === p) {
                this.changesSyncInFlight = null;
            }
        }
    }

    private async readSessionChangesCursor(accountId: string): Promise<number> {
        const existing = this.sessionChangesCursorByAccountId.get(accountId);
        if (typeof existing === 'number' && Number.isSafeInteger(existing) && existing >= 0) {
            return existing;
        }

        let initialCursor = 0;
        try {
            initialCursor = await readAccountChangesCursor(accountId);
        } catch {
            initialCursor = 0;
        }
        const normalized = Number.isSafeInteger(initialCursor) && initialCursor >= 0 ? initialCursor : 0;
        this.sessionChangesCursorByAccountId.set(accountId, normalized);
        return normalized;
    }

    private async writeSessionChangesCursor(accountId: string, cursor: number): Promise<void> {
        const normalized = Number.isSafeInteger(cursor) && cursor >= 0 ? cursor : 0;
        const existing = this.sessionChangesCursorByAccountId.get(accountId) ?? 0;
        if (normalized > existing) {
            this.sessionChangesCursorByAccountId.set(accountId, normalized);
        }
    }

    private async recoverMaterializedLocalId(
        localId: string,
        opts?: { maxWaitMs?: number },
    ): Promise<
        | { status: 'recovered' }
        | { status: 'not_found' }
        | { status: 'unsupported'; error: unknown }
    > {
        let unsupportedLookupError: unknown = null;
        const found = await waitForTranscriptEncryptedMessageByLocalId({
            token: this.token,
            sessionId: this.sessionId,
            localId,
            supervisor: this.sessionConnectionSupervisor ?? undefined,
            maxWaitMs: opts?.maxWaitMs,
            onError: (error) => {
                this.debugTranscriptRecoveryFetchError(localId, error);
            },
            onUnsupported: (error) => {
                unsupportedLookupError = error;
            },
        });
        if (unsupportedLookupError) {
            return { status: 'unsupported', error: unsupportedLookupError };
        }
        if (!found) return { status: 'not_found' };

        // Prevent later user-scoped updates from double-processing this localId.
        this.deleteMaterializedLocalId(localId);

        const update: Update = {
            id: `recovered-${localId}`,
            seq: 0,
            createdAt: found.createdAt,
            body: {
                t: 'new-message',
                sid: this.sessionId,
                message: {
                    id: found.id,
                    seq: found.seq,
                    content: found.content,
                    localId: found.localId,
                    sidechainId: found.sidechainId,
                    createdAt: found.createdAt,
                    updatedAt: found.updatedAt,
                },
            },
        } as Update;

        this.handleUpdate(update, { source: 'session-scoped' });
        return { status: 'recovered' };
    }

    private scheduleMaterializationRecovery(localId: string): void {
        // Belt-and-suspenders: if we fail to observe the socket broadcast for a committed transcript row,
        // recover by scanning the transcript and re-injecting the message into the normal update pipeline.
        this.materializationRecoveryScheduler.schedule(localId, async () => {
            if (!this.hasMaterializedLocalId(localId)) return;
            await this.recoverMaterializedLocalId(localId, { maxWaitMs: configuration.transcriptRecoveryMaxWaitMs });
        });
    }

    private deliverMaterializedPendingQueueMessage(message: PendingQueueMaterializedMessage | null | undefined): boolean {
        if (!message?.id || !message.content) return false;
        const createdAt = message.createdAt ?? Date.now();
        const updatedAt = message.updatedAt ?? createdAt;
        const update: Update = {
            id: `pending-materialized-${message.id}`,
            seq: 0,
            createdAt,
            body: {
                t: 'new-message',
                sid: this.sessionId,
                message: {
                    id: message.id,
                    seq: message.seq,
                    content: message.content,
                    localId: message.localId,
                    createdAt,
                    updatedAt,
                    ...(typeof message.messageRole === 'string' ? { messageRole: message.messageRole } : {}),
                },
            },
        } as Update;
        this.handleUpdate(update, { source: 'session-scoped' });
        return true;
    }

    private readClaimedPendingQueueUserMessage(
        message: PendingQueueMaterializedMessage | null | undefined,
    ): UserMessage | null {
        if (!message?.content) return null;
        if (message.messageRole !== null && message.messageRole !== 'user') return null;
        let body: unknown;
        try {
            body = this.decodeStoredSessionMessageContent(message.content);
        } catch (error) {
            logger.debug('[pendingQueue] failed to decode provider-claimed pending message content', {
                sessionId: this.sessionId,
                localId: message.localId ?? null,
                error: serializeAxiosErrorForLog(error),
            });
            return null;
        }

        const bodyRecord = body && typeof body === 'object' ? body as Record<string, unknown> : {};
        const localId = typeof message.localId === 'string' && message.localId.length > 0
            ? message.localId
            : null;
        const bodyWithTransportFields = {
            ...bodyRecord,
            ...(localId ? { localId } : {}),
            ...(typeof message.createdAt === 'number' ? { createdAt: message.createdAt } : {}),
        };
        const parsed = UserMessageSchema.safeParse(bodyWithTransportFields);
        if (!parsed.success) {
            logger.debug('[pendingQueue] provider-claimed pending message is not a user prompt', {
                sessionId: this.sessionId,
                localId,
                issues: parsed.error.issues.map((issue) => ({
                    code: issue.code,
                    path: issue.path,
                })),
            });
            return null;
        }
        return parsed.data;
    }

    private deliverClaimedPendingQueueMessage(message: PendingQueueMaterializedMessage | null | undefined): boolean {
        const userMessage = this.readClaimedPendingQueueUserMessage(message);
        if (!userMessage) return false;
        const localId = typeof userMessage.localId === 'string' && userMessage.localId.length > 0
            ? userMessage.localId
            : null;
        if (localId) {
            if (this.hasAgentQueueDeliveredLocalId(localId)) {
                return true;
            }
            this.markAgentQueueEchoSuppressedLocalId(localId);
            this.markAgentQueueDeliveredLocalId(localId);
        }
        if (this.pendingMessageCallback) {
            this.pendingMessageCallback(userMessage, { seq: null, providerAcceptancePending: true });
        } else {
            this.pendingMessages.push(userMessage);
        }
        return true;
    }

    onUserMessage(callback: (data: UserMessage, info?: SessionUserMessageDeliveryInfo) => void) {
        logger.debug('[API] onUserMessage callback attached', {
            sessionId: this.sessionId,
            startedByDaemonProcess: this.startedByDaemonProcess,
            metadataStartedBy: this.metadata?.startedBy ?? null,
            metadataStartedFromDaemon: this.metadata?.startedFromDaemon ?? null,
        });
        this.pendingMessageCallback = callback;
        if (this.userMessageCallbackAttachedAtMs === null) {
            this.userMessageCallbackAttachedAtMs = Date.now();
        }
        if (this.userSocketDisconnectTimer) {
            clearTimeout(this.userSocketDisconnectTimer);
            this.userSocketDisconnectTimer = null;
        }
        this.kickUserSocketConnect();
        while (this.pendingMessages.length > 0) {
            // Buffered messages lost their seq attribution; null keeps the watermark behind
            // (at-least-once redelivery on resume, deduped) instead of over-covering.
            callback(this.pendingMessages.shift()!, { seq: null });
        }
        if (!this.daemonInitialPromptSeeded && typeof this.daemonInitialPrompt === 'string') {
            this.daemonInitialPromptSeeded = true;
            const initialPrompt = this.daemonInitialPrompt;
            const initialPromptLocalId = buildDaemonInitialPromptLocalId(this.sessionId);
            this.daemonInitialPrompt = null;
            void this.enqueueSessionUserMessage({
                text: initialPrompt,
                ...(initialPromptLocalId ? { localId: initialPromptLocalId } : {}),
                meta: {
                    source: 'daemon-initial-prompt',
                    sentFrom: 'cli',
                },
            });
        }

        if (!this.startupMessageCatchUpStarted) {
            this.startupMessageCatchUpStarted = true;
            this.startupMessageCatchUpRetryIndex = 0;
            const startupCursor = this.resolveStartupTranscriptCatchUpInitialCursor();
            this.startupMessageCatchUpInitialAfterSeq = startupCursor.afterSeq;
            this.startupMessageCatchUpInitialAuthorization = startupCursor.authorization;
            void this.catchUpSessionMessages({
                afterSeq: this.startupMessageCatchUpInitialAfterSeq,
                authorization: this.startupMessageCatchUpInitialAuthorization,
            })
                .catch((error) => {
                    if (isAuthenticationError(error)) {
                        logger.debug('[API] Initial transcript catch-up failed with terminal auth', {
                            error: serializeAxiosErrorForLog(error),
                        });
                        return false;
                    }
                    logger.debug('[API] Initial transcript catch-up failed (non-fatal)', {
                        error: serializeAxiosErrorForLog(error),
                    });
                    return true;
                })
                .then((shouldContinue) => {
                    if (shouldContinue !== false) {
                        this.scheduleNextStartupMessageCatchUpRetry();
                    }
                });
        }
    }

    waitForMetadataUpdate(abortSignal?: AbortSignal): Promise<boolean> {
        if (abortSignal?.aborted) {
            return Promise.resolve(false);
        }

        const startMetadataVersion = this.metadataVersion;
        const startAgentStateVersion = this.agentStateVersion;
        const startPendingWakeSeq = this.pendingWakeSeq;
        if (startMetadataVersion < 0 || startAgentStateVersion < 0) {
            void this.syncSessionSnapshotFromServer({ reason: 'waitForMetadataUpdate' });
        }
        return new Promise((resolve) => {
            let cleanedUp = false;
            const onUpdate = () => {
                cleanup();
                resolve(true);
            };
            const onAbort = () => {
                cleanup();
                resolve(false);
            };
            const onDisconnect = () => {
                cleanup();
                resolve(false);
            };
            const cleanup = () => {
                if (cleanedUp) return;
                cleanedUp = true;
                this.off('metadata-updated', onUpdate);
                abortSignal?.removeEventListener('abort', onAbort);
                this.userSocket.off('disconnect', onDisconnect);
                this.maybeScheduleUserSocketDisconnect();
            };

            this.on('metadata-updated', onUpdate);
            abortSignal?.addEventListener('abort', onAbort, { once: true });
            this.userSocket.on('disconnect', onDisconnect);

            // Ensure we can observe metadata updates even when the server broadcasts them only to user-scoped clients.
            // This keeps idle agents wakeable without requiring server changes.
            this.kickUserSocketConnect();

            if (abortSignal?.aborted) {
                onAbort();
                return;
            }

            // Avoid lost wakeups if a snapshot sync or socket event raced with handler registration.
            if (
                this.metadataVersion !== startMetadataVersion ||
                this.agentStateVersion !== startAgentStateVersion ||
                this.pendingWakeSeq !== startPendingWakeSeq
            ) {
                onUpdate();
                return;
            }
        });
    }

    /**
     * Ensure we have a decrypted metadata snapshot from the server.
     *
     * Unlike waitForMetadataUpdate(), this does not resolve early just because the socket connected.
     * It resolves only once metadataVersion is >= 0 and metadata is available (or times out).
     */
    async ensureMetadataSnapshot(opts?: { timeoutMs?: number; abortSignal?: AbortSignal }): Promise<Metadata | null> {
        const abortSignal = opts?.abortSignal;
        if (abortSignal?.aborted) return null;

        if (this.metadataVersion >= 0 && this.metadata) {
            return this.metadata;
        }

        const timeoutMs = typeof opts?.timeoutMs === 'number' ? opts.timeoutMs : 15_000;

        if (this.metadataVersion < 0) {
            void this.syncSessionSnapshotFromServer({ reason: 'waitForMetadataUpdate' });
        }

        return await new Promise((resolve) => {
            let cleanedUp = false;
            const onAbort = () => {
                cleanup();
                resolve(null);
            };
            const onDisconnect = () => {
                cleanup();
                resolve(null);
            };
            const onUpdate = () => {
                if (this.metadataVersion >= 0 && this.metadata) {
                    cleanup();
                    resolve(this.metadata);
                }
            };

            const timer = setTimeout(() => {
                cleanup();
                resolve(this.metadataVersion >= 0 ? this.metadata : null);
            }, timeoutMs);
            timer.unref?.();

            const cleanup = () => {
                if (cleanedUp) return;
                cleanedUp = true;
                clearTimeout(timer);
                this.off('metadata-updated', onUpdate);
                abortSignal?.removeEventListener('abort', onAbort);
                this.userSocket.off('disconnect', onDisconnect);
                this.maybeScheduleUserSocketDisconnect();
            };

            this.on('metadata-updated', onUpdate);
            this.userSocket.on('disconnect', onDisconnect);
            abortSignal?.addEventListener('abort', onAbort, { once: true });

            // Avoid lost wakeups if the snapshot sync raced with handler registration.
            onUpdate();
        });
    }

    /**
     * Force a session snapshot sync from the server.
     *
     * This is useful when metadata/agentState may have been updated by another client (e.g. daemon RPC)
     * and this runner needs the latest snapshot before making turn decisions (e.g. replaySeedV1).
     */
    async refreshSessionSnapshotFromServerBestEffort(opts?: { reason?: 'connect' | 'waitForMetadataUpdate' }): Promise<void> {
        const reason = opts?.reason ?? 'waitForMetadataUpdate';
        await this.syncSessionSnapshotFromServer({ reason });
    }

    private async commitSessionMessage(
        params: {
            message: string | { t: 'plain'; v: unknown };
            localId: string;
            sidechainId: string | null;
            messageRole?: SessionMessageRole;
            sessionEventType?: 'ready';
            requireCommit: boolean;
            markAsUserMessage?: boolean;
        },
    ): Promise<number | null> {
        const localId = params.localId;
        if (localId.length === 0) {
            if (params.requireCommit) {
                throw new Error('localId is required');
            }
            return null;
        }
        if (this.transcriptStorage === 'direct') {
            if (!this.socket.connected) {
                if (params.requireCommit) {
                    throw new Error('Socket not connected');
                }
                this.queueSessionMessageUntilReconnect({
                    message: params.message,
                    localId,
                    sidechainId: params.sidechainId,
                    messageRole: params.messageRole,
                    sessionEventType: params.sessionEventType,
                });
                return null;
            }

            if (!params.requireCommit) {
                this.pendingMaterializedLocalIds.add(localId);
            }

            const ack = await (async () => {
                try {
                    const raw = await emitSocketWithAck({
                        socket: this.socket as any,
                        event: 'message',
                        payload: {
                            sid: this.sessionId,
                            message: params.message,
                            localId,
                            echoToSender: true,
                            sidechainId: params.sidechainId,
                            ...(params.messageRole ? { messageRole: params.messageRole } : {}),
                            ...(params.sessionEventType ? { sessionEventType: params.sessionEventType } : {}),
                        },
                    });

                    const parsed = MessageAckResponseSchema.safeParse(raw);
                    return parsed.success ? parsed.data : null;
                } catch (error) {
                    logger.debug('[SOCKET] Direct transcript commit ack failed', {
                        localId,
                        sidechainId: params.sidechainId,
                        requireCommit: params.requireCommit,
                        error: serializeAxiosErrorForLog(error),
                    });
                    return null;
                }
            })();

            if (ack && ack.ok === true) {
                this.pendingCommitRetryAttemptsByLocalId.delete(localId);
                if (params.markAsUserMessage === true) {
                    this.markAgentQueueEchoSuppressedLocalId(ack.localId ?? localId);
                    this.markAgentQueueDeliveredLocalId(ack.localId ?? localId);
                }
                this.markCommittedLocalIdAwaitingEcho(localId);
                this.lastObservedMessageSeq = Math.max(this.lastObservedMessageSeq, ack.seq);
                if (params.markAsUserMessage === true) {
                    this.lastObservedUserMessageSeq = Math.max(this.lastObservedUserMessageSeq, ack.seq);
                    this.recordCommittedUserMessageSeq(ack.localId ?? localId, ack.seq);
                }
                return ack.seq;
            }
            if (ack && ack.ok === false) {
                this.pendingCommitRetryAttemptsByLocalId.delete(localId);
                if (!params.requireCommit) {
                    this.deleteMaterializedLocalId(localId);
                }
                logger.debug('[SOCKET] Direct transcript commit rejected', {
                    localId,
                    sidechainId: params.sidechainId,
                    requireCommit: params.requireCommit,
                    error: ack.error,
                });
                throw new Error(ack.error);
            }
            if (!params.requireCommit) {
                this.scheduleCommitRetry({ message: params.message, localId, sidechainId: params.sidechainId, messageRole: params.messageRole, sessionEventType: params.sessionEventType });
                return null;
            }
            logger.debug('[SOCKET] Direct transcript commit was not confirmed', {
                localId,
                sidechainId: params.sidechainId,
                requireCommit: params.requireCommit,
            });
            throw new Error('Message send not confirmed');
        }

        if (!this.socket.connected) {
            if (params.requireCommit) {
                throw new Error('Socket not connected');
            }
            this.queueSessionMessageUntilReconnect({
                message: params.message,
                localId,
                sidechainId: params.sidechainId,
                messageRole: params.messageRole,
                sessionEventType: params.sessionEventType,
            });
            return null;
        }

        this.pendingMaterializedLocalIds.add(localId);
        const ack = await (async () => {
            try {
                const raw = await emitSocketWithAck({
                    socket: this.socket as any,
                    event: 'message',
                    payload: {
                        sid: this.sessionId,
                        message: params.message,
                        localId,
                        echoToSender: true,
                        sidechainId: params.sidechainId,
                        ...(params.messageRole ? { messageRole: params.messageRole } : {}),
                        ...(params.sessionEventType ? { sessionEventType: params.sessionEventType } : {}),
                    },
                });

                const parsed = MessageAckResponseSchema.safeParse(raw);
                return parsed.success ? parsed.data : null;
            } catch (error) {
                logger.debug('[SOCKET] Persisted transcript commit ack failed', {
                    localId,
                    sidechainId: params.sidechainId,
                    requireCommit: params.requireCommit,
                    error: serializeAxiosErrorForLog(error),
                });
                return null;
            }
        })();

        if (ack && ack.ok === true) {
            this.pendingCommitRetryAttemptsByLocalId.delete(localId);
            if (params.markAsUserMessage === true) {
                this.markAgentQueueEchoSuppressedLocalId(ack.localId ?? localId);
                this.markAgentQueueDeliveredLocalId(ack.localId ?? localId);
            }
            this.markCommittedLocalIdAwaitingEcho(localId);
            // ACK confirms persistence. Do not inject a synthetic update here: outbound sends are not prompts.
            this.lastObservedMessageSeq = Math.max(this.lastObservedMessageSeq, ack.seq);
            if (params.markAsUserMessage === true) {
                this.lastObservedUserMessageSeq = Math.max(this.lastObservedUserMessageSeq, ack.seq);
                this.recordCommittedUserMessageSeq(ack.localId ?? localId, ack.seq);
            }
            return ack.seq;
        }

        if (ack && ack.ok === false) {
            this.pendingCommitRetryAttemptsByLocalId.delete(localId);
            this.deleteMaterializedLocalId(localId);
            logger.debug('[SOCKET] Persisted transcript commit rejected', {
                localId,
                sidechainId: params.sidechainId,
                requireCommit: params.requireCommit,
                error: ack.error,
            });
            if (params.requireCommit) {
                throw new Error(ack.error);
            }
            return null;
        }

        if (params.requireCommit) {
            const recovered = await this.recoverMaterializedLocalId(localId, { maxWaitMs: 12_000 });
            if (recovered.status === 'unsupported') {
                this.scheduleCommitRetry({
                    message: params.message,
                    localId,
                    sidechainId: params.sidechainId,
                    messageRole: params.messageRole,
                    sessionEventType: params.sessionEventType,
                });
                logger.debug('[SOCKET] Persisted transcript commit confirmation unsupported by server after ACK timeout', {
                    localId,
                    sidechainId: params.sidechainId,
                    requireCommit: params.requireCommit,
                    error: serializeAxiosErrorForLog(recovered.error),
                });
                throw new Error('Message commit confirmation unsupported by server (ACK timed out and transcript lookup route is unavailable)');
            }
            if (recovered.status !== 'recovered') {
                logger.debug('[SOCKET] Persisted transcript commit was not confirmed after ACK timeout and recovery miss', {
                    localId,
                    sidechainId: params.sidechainId,
                    requireCommit: params.requireCommit,
                });
                throw new Error('Message commit not confirmed (ACK timed out and transcript recovery failed)');
            }
            return null;
        }

        this.scheduleMaterializationRecovery(localId);
        this.scheduleCommitRetry({ message: params.message, localId, sidechainId: params.sidechainId, messageRole: params.messageRole, sessionEventType: params.sessionEventType });
        return null;
    }

    private enqueueMessageCommit<T>(fn: () => Promise<T>): Promise<T> {
        const queued = this.messageCommitQueueTail.then(fn, fn);
        this.messageCommitQueueTail = queued.then(
            () => undefined,
            () => undefined,
        );
        return queued;
    }

    private scheduleCommitRetry(params: { message: string | { t: 'plain'; v: unknown }; localId: string; sidechainId: string | null; messageRole?: SessionMessageRole; sessionEventType?: 'ready' }): void {
        const localId = params.localId;
        if (!localId) return;
        if (!this.pendingMaterializedLocalIds.has(localId)) return;

        const current = this.pendingCommitRetryAttemptsByLocalId.get(localId) ?? 0;
        const next = current + 1;
        if (next > 3) {
            return;
        }
        this.pendingCommitRetryAttemptsByLocalId.set(localId, next);

        const delayMs = 1_000 * next;
        const timer = setTimeout(() => {
            if (!this.pendingMaterializedLocalIds.has(localId)) {
                this.pendingCommitRetryAttemptsByLocalId.delete(localId);
                return;
            }
            void this.enqueueMessageCommit(() =>
                this.commitSessionMessage({
                    message: params.message,
                    localId,
                    sidechainId: params.sidechainId,
                    messageRole: params.messageRole,
                    sessionEventType: params.sessionEventType,
                    requireCommit: false,
                }),
            ).catch(() => {
                // Best-effort retry only.
            });
        }, delayMs);
        timer.unref?.();
    }

    private encryptSessionContent(content: unknown): string {
        return encodeBase64(encrypt(this.encryptionKey, this.encryptionVariant, content as any));
    }

    private buildOutboundSessionMessagePayload(content: unknown): string | { t: 'plain'; v: unknown } {
        if (this.sessionEncryptionMode === 'plain') {
            return { t: 'plain', v: content };
        }
        return this.encryptSessionContent(content);
    }

    private decodeStoredSessionMessageContent(content: SessionMessageContent): unknown {
        if (content.t === 'plain') return content.v;
        return decrypt(this.encryptionKey, this.encryptionVariant, decodeBase64(content.c));
    }

    private commitSessionMessageBestEffort(params: {
        message: string | { t: 'plain'; v: unknown };
        localId: string;
        sidechainId: string | null;
        messageRole?: SessionMessageRole;
        sessionEventType?: 'ready';
        logErrorMessage: string;
        markAsUserMessage?: boolean;
    }): void {
        void this.enqueueMessageCommit(() =>
            this.commitSessionMessage({
                message: params.message,
                localId: params.localId,
                sidechainId: params.sidechainId,
                messageRole: params.messageRole,
                sessionEventType: params.sessionEventType,
                requireCommit: false,
                markAsUserMessage: params.markAsUserMessage,
            }),
        ).catch((error) => {
            logger.debug(params.logErrorMessage, {
                localId: params.localId,
                error: serializeAxiosErrorForLog(error),
            });
        });
    }

    private buildUserTextMessageContent(text: string, meta?: Record<string, unknown>): MessageContent {
        return {
            role: 'user',
            content: { type: 'text', text },
            meta: {
                sentFrom: 'cli',
                source: 'cli',
                ...(meta && typeof meta === 'object' ? meta : {}),
            },
        };
    }

    private buildPendingQueueUserTextMessageBody(params: {
        text: string;
        localId: string;
        meta: Record<string, unknown>;
    }): Parameters<typeof enqueuePendingQueueV2MessageViaHttp>[0]['body'] {
        const content = this.buildUserTextMessageContent(params.text, params.meta);
        const payload = this.buildOutboundSessionMessagePayload(content);
        if (typeof payload === 'string') {
            return {
                localId: params.localId,
                ciphertext: payload,
                messageRole: 'user',
            };
        }
        return {
            localId: params.localId,
            content: payload,
            messageRole: 'user',
        };
    }

    private async enqueueProviderAcceptedUserPrompt(params: {
        text: string;
        localId: string;
        meta: Record<string, unknown>;
    }): Promise<void> {
        const body = this.buildPendingQueueUserTextMessageBody(params);
        const request = () => enqueuePendingQueueV2MessageViaHttp({
            token: this.token,
            sessionId: this.sessionId,
            body,
        });
        const supervisor = this.sessionConnectionSupervisor;
        if (supervisor) {
            await runSupervisedRequest({
                supervisor,
                requireAuth: true,
                requireOnline: false,
                request,
            });
        } else {
            await request();
        }

        // This RPC means "send now", but provider-acceptance sessions must still commit
        // through the pending claim/accept path. The direct materialize attempt keeps the
        // existing immediacy while leaving the row durable if the runtime cannot accept it yet.
        if (!await this.reconcileCanonicalPendingDeliveriesBeforeMaterialization()) return;
        await this.runMaterializeNextPendingMessageInner();
    }

    /**
     * Send message to session
     * @param body - Message body (can be MessageContent or raw content for agent messages)
     */
    sendClaudeSessionMessage(body: RawJSONLines, meta?: Record<string, unknown>) {
        if (isToolTraceEnabled()) {
            recordClaudeToolTraceEvents({ sessionId: this.sessionId, body });
        }

        this.outboundShapeLogger.log('claude:raw-jsonl', body);

        const sidechainId = (() => {
            const raw = (body as any)?.sidechainId;
            if (typeof raw !== 'string') return null;
            const trimmed = raw.trim();
            return trimmed.length > 0 ? trimmed : null;
        })();

        let content: MessageContent;

        // Check if body is already a MessageContent (has role property)
        if (
            body.type === 'user' &&
            typeof body.message.content === 'string' &&
            body.isSidechain !== true &&
            body.isMeta !== true
        ) {
            content = this.buildUserTextMessageContent(body.message.content, meta);
        } else {
            // Wrap Claude messages in the expected format
            content = {
                role: 'agent',
                content: {
                    type: 'output',
                    data: body  // This wraps the entire Claude message
                },
                meta: {
                    sentFrom: 'cli',
                    source: 'cli',
                    ...(meta && typeof meta === 'object' ? meta : {}),
                }
            };
        }

        this.outboundShapeLogger.log('claude:session-content', content);
        logger.debugLargeJson('[SOCKET] Sending message through socket:', content)

        this.logSendWhileDisconnected('Claude session message', { type: body.type });

        const payload = this.buildOutboundSessionMessagePayload(content);
        const localId = buildClaudeJsonlLocalId(body);
        this.observeTurnAssistantTextFromSessionContent(content, {
            source: 'ephemeral',
            localId,
            sidechainId,
            provider: 'claude',
        });
        this.commitSessionMessageBestEffort({
            message: payload,
            localId,
            sidechainId,
            messageRole: resolveClaudeSessionMessageRole(body),
            logErrorMessage: '[SOCKET] Failed to commit Claude session message (non-fatal)',
        });

        // Track usage from assistant messages
        if (body.type === 'assistant' && body.message?.usage) {
            try {
                this.sendUsageData(body.message.usage, body.message.model);
            } catch (error) {
                logger.debug('[SOCKET] Failed to send usage data:', serializeAxiosErrorForLog(error));
            }
        }

        // Update metadata with summary if this is a summary message
        if (body.type === 'summary' && 'summary' in body && 'leafUuid' in body) {
            updateMetadataBestEffort(
                this,
                (metadata) => ({
                    ...metadata,
                    summary: {
                        text: body.summary,
                        updatedAt: Date.now()
                    }
                }),
                '[SOCKET]',
                'summary_message',
            );
        }
    }

    recordClaudeJsonlMessageConsumed(body: RawJSONLines, meta?: Record<string, unknown>): void {
        const key = buildClaudeJsonlMessageKey(body);
        if (!key) return;
        const rawSidechainId = (body as Record<string, unknown>).sidechainId;
        const sidechainId = typeof rawSidechainId === 'string' && rawSidechainId.trim().length > 0
            ? rawSidechainId.trim()
            : null;
        const content = {
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'progress',
                    marker: 'claude_jsonl_consumed_marker',
                    reason: 'prompt_echo_suppressed',
                },
            },
            meta: {
                sentFrom: 'cli',
                source: 'cli',
                happier: { kind: 'claude_jsonl_consumed_marker.v1' },
                ...(meta && typeof meta === 'object' ? meta : {}),
            },
        };

        this.commitSessionMessageBestEffort({
            message: this.buildOutboundSessionMessagePayload(content),
            localId: buildClaudeJsonlLocalIdFromMessageKey(key),
            sidechainId,
            messageRole: 'event',
            logErrorMessage: '[SOCKET] Failed to commit Claude JSONL consumed marker (non-fatal)',
        });
    }

    sendCodexMessage(body: any) {
        const normalizedBody = normalizeCodexSessionMessageBody({
            body,
            toolCallCanonicalNameByProviderAndId: this.toolCallCanonicalNameByProviderAndId,
            maxToolCallCacheEntries: SESSION_CLIENT_TOOL_CALL_CACHE_MAX_ENTRIES,
            debug: (message, data) => logger.debug(message, data),
        });

        let content = {
            role: 'agent',
            content: {
                type: 'codex',
                data: normalizedBody  // This wraps the entire Codex message
            },
            meta: {
                sentFrom: 'cli',
                source: 'cli',
            }
        };

        recordCodexToolTraceEventIfNeeded({ sessionId: this.sessionId, body: normalizedBody });
        
        this.logSendWhileDisconnected('Codex message', { type: normalizedBody?.type });

        const payload = this.buildOutboundSessionMessagePayload(content);
        const localId = randomUUID();
        this.observeTurnAssistantTextFromSessionContent(content, {
            source: 'ephemeral',
            localId,
            sidechainId: null,
            provider: 'codex',
        });
        this.commitSessionMessageBestEffort({
            message: payload,
            localId,
            sidechainId: null,
            messageRole: resolveCodexSessionMessageRole(normalizedBody),
            logErrorMessage: '[SOCKET] Failed to commit Codex message (non-fatal)',
        });

        // Best-effort: allow ACP providers to report token usage via a token_count message.
        if (normalizedBody?.type === 'token_count') {
            try {
                const report = buildUsageReportFromAcpTokenCount({
                    provider: 'codex',
                    sessionId: this.sessionId,
                    body: normalizedBody,
                });
                if (report && this.socket.connected) {
                    this.socket.emit('usage-report', report);
            }
            } catch (error) {
                logger.debug('[SOCKET] Failed to send token_count usage report (non-fatal)', serializeAxiosErrorForLog(error));
            }
        }
    }

    private prepareAcpAgentMessage(params: {
        provider: ACPProvider;
        body: ACPMessageData;
        meta?: Record<string, unknown>;
        localId?: string;
    }): {
        normalizedBody: ACPMessageData;
        content: ReturnType<typeof buildAcpAgentMessageEnvelope>;
        localId: string;
        sidechainId: string | null;
    } {
        const normalizedBody = normalizeAcpSessionMessageBody({
            provider: params.provider,
            body: params.body,
            toolCallCanonicalNameByProviderAndId: this.toolCallCanonicalNameByProviderAndId,
            permissionToolCallRawInputByProviderAndId: this.permissionToolCallRawInputByProviderAndId,
            toolCallInputByProviderAndId: this.toolCallInputByProviderAndId,
            maxToolCallCacheEntries: SESSION_CLIENT_TOOL_CALL_CACHE_MAX_ENTRIES,
        });
        const localId = typeof params.localId === 'string' && params.localId.length > 0 ? params.localId : randomUUID();
        const sidechainId = (() => {
            const raw = normalizedBody.sidechainId;
            if (typeof raw !== 'string') return null;
            const trimmed = raw.trim();
            return trimmed ? trimmed : null;
        })();
        const content = buildAcpAgentMessageEnvelope({
            provider: params.provider,
            body: normalizedBody,
            meta: params.meta,
        });
        return { normalizedBody, content, localId, sidechainId };
    }

    /**
     * Send a generic agent message to the session using ACP (Agent Communication Protocol) format.
     * Works for any agent type (Gemini, Codex, Claude, etc.) - CLI normalizes to unified ACP format.
     * 
     * @param provider - The agent provider sending the message (e.g., 'gemini', 'codex', 'claude')
     * @param body - The message payload (type: 'message' | 'reasoning' | 'tool-call' | 'tool-result')
     */
    sendAgentMessage(
        provider: ACPProvider,
        body: ACPMessageData,
        opts?: { localId?: string; meta?: Record<string, unknown> },
    ) {
        const lifecycleMarker = observeAcpLifecycleMarker({
            lifecycle: this.sessionTurnLifecycle,
            provider,
            body,
        });
        if (lifecycleMarker.pendingWrite) {
            this.trackSessionTurnWrite(
                lifecycleMarker.pendingWrite,
                lifecycleMarker.body.type === 'task_started'
                    ? { latestTurnStatus: 'in_progress' }
                    : {},
            );
        }
        const { normalizedBody, content, localId, sidechainId } = this.prepareAcpAgentMessage({
            provider,
            body: lifecycleMarker.body,
            meta: opts?.meta,
            localId: opts?.localId,
        });

        if (shouldTraceAcpMessageType(normalizedBody.type, { includeTaskComplete: true })) {
            recordAcpToolTraceEventIfNeeded({
                sessionId: this.sessionId,
                provider,
                body: normalizedBody,
                localId,
            });
        }

        this.outboundShapeLogger.log(`acp:${provider}:${normalizedBody.type}`, normalizedBody);
        
        logger.debug(`[SOCKET] Sending ACP message from ${provider}:`, { type: normalizedBody.type, hasMessage: 'message' in normalizedBody });
        this.logSendWhileDisconnected(`${provider} ACP message`, { type: normalizedBody.type });
        const payload = this.buildOutboundSessionMessagePayload(content);
        this.observeTurnAssistantTextFromSessionContent(content, {
            source: 'ephemeral',
            localId,
            sidechainId,
            provider,
        });
        this.commitSessionMessageBestEffort({
            message: payload,
            localId,
            sidechainId,
            messageRole: resolveAcpSessionMessageRole(normalizedBody),
            logErrorMessage: '[SOCKET] Failed to commit agent message (non-fatal)',
        });

        // Best-effort: allow ACP providers to report token usage via a token_count message.
        if (normalizedBody.type === 'token_count') {
            try {
                const report = buildUsageReportFromAcpTokenCount({
                    provider,
                    sessionId: this.sessionId,
                    body: normalizedBody,
                });
                if (report && this.socket.connected) {
                    this.socket.emit('usage-report', report);
            }
            } catch (error) {
                logger.debug('[SOCKET] Failed to send token_count usage report (non-fatal)', serializeAxiosErrorForLog(error));
            }
        }
    }

    sendAgentMessageEphemeral(
        provider: ACPProvider,
        body: ACPMessageData,
        opts: { localId: string; createdAt: number; updatedAt?: number; meta?: Record<string, unknown>; tick?: number },
    ): void {
        if (!this.socket.connected) return;

        const { normalizedBody, content, localId, sidechainId } = this.prepareAcpAgentMessage({
            provider,
            body,
            meta: opts.meta,
            localId: opts.localId,
        });
        const payload = this.buildOutboundSessionMessagePayload(content);
        const createdAt =
            typeof opts.createdAt === 'number' && Number.isFinite(opts.createdAt)
                ? Math.max(0, Math.trunc(opts.createdAt))
                : Date.now();
        const streamSegmentMeta = opts.meta?.happierStreamSegmentV1;
        const metaUpdatedAt =
            streamSegmentMeta
            && typeof streamSegmentMeta === 'object'
            && typeof (streamSegmentMeta as Record<string, unknown>).updatedAtMs === 'number'
            && Number.isFinite((streamSegmentMeta as Record<string, unknown>).updatedAtMs)
                ? Math.trunc((streamSegmentMeta as Record<string, unknown>).updatedAtMs as number)
                : undefined;
        const updatedAt =
            typeof opts.updatedAt === 'number' && Number.isFinite(opts.updatedAt)
                ? Math.max(createdAt, Math.trunc(opts.updatedAt))
                : typeof metaUpdatedAt === 'number'
                    ? Math.max(createdAt, metaUpdatedAt)
                    : Math.max(createdAt, Date.now());
        this.observeTurnAssistantTextFromSessionContent(content, {
            source: 'ephemeral',
            localId,
            sidechainId,
            provider,
            observedAtMs: updatedAt,
        });

        try {
            this.socket.emit('transcript-stream-segment', {
                sid: this.sessionId,
                message: {
                    localId,
                    messageRole: resolveAcpSessionMessageRole(normalizedBody),
                    ...(sidechainId ? { sidechainId } : {}),
                    ...(typeof opts.tick === 'number' && Number.isFinite(opts.tick) && opts.tick >= 0
                        ? { tick: Math.trunc(opts.tick) }
                        : {}),
                    content: payload,
                    createdAt,
                    updatedAt,
                },
            });
        } catch {
            // Ephemeral stream updates are best effort.
        }
    }

    /**
     * Emit a live transcript delta tick: `body` carries ONLY the text appended since the previous
     * live emission for this segment. Full-snapshot checkpoints still flow through
     * `sendAgentMessageEphemeral`; receivers that cannot chain a delta drop it and resync on the
     * next checkpoint. The delta content goes through the same envelope/encryption choke point as
     * snapshots (`prepareAcpAgentMessage` + `buildOutboundSessionMessagePayload`).
     */
    sendAgentMessageEphemeralDelta(
        provider: ACPProvider,
        body: ACPMessageData,
        opts: { localId: string; tick: number; baseLength: number; createdAt: number; updatedAt?: number; meta?: Record<string, unknown> },
    ): void {
        if (!this.socket.connected) return;

        const { normalizedBody, content, localId, sidechainId } = this.prepareAcpAgentMessage({
            provider,
            body,
            meta: opts.meta,
            localId: opts.localId,
        });
        const payload = this.buildOutboundSessionMessagePayload(content);
        const createdAt =
            typeof opts.createdAt === 'number' && Number.isFinite(opts.createdAt)
                ? Math.max(0, Math.trunc(opts.createdAt))
                : Date.now();
        const updatedAt =
            typeof opts.updatedAt === 'number' && Number.isFinite(opts.updatedAt)
                ? Math.max(createdAt, Math.trunc(opts.updatedAt))
                : Math.max(createdAt, Date.now());

        // Intentionally no observeTurnAssistantTextFromSessionContent here: delta bodies carry only
        // appended chars, and the turn-assistant-text snapshot expects full text. Full-snapshot
        // checkpoints (<= 1s apart) keep the turn snapshot fresh through sendAgentMessageEphemeral.

        try {
            this.socket.emit('transcript-stream-segment-delta', {
                sid: this.sessionId,
                message: {
                    localId,
                    messageRole: resolveAcpSessionMessageRole(normalizedBody),
                    ...(sidechainId ? { sidechainId } : {}),
                    tick: Math.max(1, Math.trunc(opts.tick)),
                    baseLength: Math.max(0, Math.trunc(opts.baseLength)),
                    content: payload,
                    createdAt,
                    updatedAt,
                },
            });
        } catch {
            // Ephemeral stream updates are best effort.
        }
    }

    getEphemeralStreamConnectionEpoch(): number {
        return this.ephemeralStreamConnectionEpoch;
    }

    sendUserTextMessage(text: string, opts?: { localId?: string; meta?: Record<string, unknown> }) {
        const content = this.buildUserTextMessageContent(text, opts?.meta);

        this.logSendWhileDisconnected('User text message', { length: text.length });
        const payload = this.buildOutboundSessionMessagePayload(content);
        const localId = typeof opts?.localId === 'string' && opts.localId.length > 0 ? opts.localId : randomUUID();
        const meta = opts?.meta ?? null;
        const metaSource = typeof (meta as any)?.source === 'string' ? String((meta as any).source) : null;
        const metaSentFrom = typeof (meta as any)?.sentFrom === 'string' ? String((meta as any).sentFrom) : null;
        const shouldSuppressAgentQueueEcho =
            metaSource === 'cli'
            || metaSentFrom === 'cli';
        if (shouldSuppressAgentQueueEcho) {
            // Prevent our own CLI-originating outbound user messages from being treated as inbound prompts
            // if/when the server echoes the transcript update back to this runner.
            this.markAgentQueueEchoSuppressedLocalId(localId);
        }
        this.commitSessionMessageBestEffort({
            message: payload,
            localId,
            sidechainId: null,
            messageRole: 'user',
            markAsUserMessage: true,
            logErrorMessage: '[SOCKET] Failed to commit user message (non-fatal)',
        });
    }

    async sendUserTextMessageCommitted(
        text: string,
        opts: { localId: string; meta?: Record<string, unknown> },
    ): Promise<void> {
        const content = this.buildUserTextMessageContent(text, opts.meta);
        const payload = this.buildOutboundSessionMessagePayload(content);
        // Suppress agent-queue delivery for our own committed user messages; these are writes, not prompts.
        this.markPassiveCommittedUserMessageLocalId(opts.localId);
        await this.enqueueMessageCommit(() =>
            this.commitSessionMessage({
                message: payload,
                localId: opts.localId,
                sidechainId: null,
                messageRole: 'user',
                requireCommit: true,
                markAsUserMessage: true,
            }),
        );
    }

    private async notifyDaemonConnectedServiceTurnLifecycle(
        event: 'prompt_or_steer' | 'task_started' | 'assistant_message_end' | 'turn_cancelled',
        terminalStatus?: 'completed' | 'failed',
    ): Promise<void> {
        if (!this.startedByDaemonProcess) return;
        try {
            const result = await notifyDaemonConnectedServiceTurnLifecycle({
                sessionId: this.sessionId,
                event,
                ...(terminalStatus ? { terminalStatus } : {}),
            });
            if (result?.error) {
                logger.debug('[SESSION CLIENT] Failed to notify daemon connected-service turn lifecycle (non-fatal)', {
                    sessionId: this.sessionId,
                    event,
                    error: result.error,
                });
            }
        } catch (error) {
            logger.debug('[SESSION CLIENT] Connected-service turn lifecycle notify threw (non-fatal)', {
                sessionId: this.sessionId,
                event,
                error: serializeAxiosErrorForLog(error),
            });
        }
    }

    async enqueueSessionUserMessage(params: Readonly<{
        text: string;
        localId?: string;
        meta?: Record<string, unknown>;
    }>): Promise<Readonly<{ providerAcceptancePending?: boolean }> | void> {
        const text = String(params.text ?? '');
        if (text.length === 0) return;
        const localId = typeof params.localId === 'string' && params.localId.length > 0 ? params.localId : randomUUID();

        const rawMeta: Record<string, unknown> = params.meta && typeof params.meta === 'object' ? { ...params.meta } : {};
        const normalizedPayload = normalizeAgentPromptPayload({ text, meta: rawMeta });
        const meta: Record<string, unknown> = normalizedPayload.meta && typeof normalizedPayload.meta === 'object'
            ? { ...normalizedPayload.meta }
            : {};
        if (typeof meta.source !== 'string' || meta.source.trim().length === 0) {
            meta.source = 'ui';
        }
        if (typeof meta.sentFrom !== 'string' || meta.sentFrom.trim().length === 0) {
            meta.sentFrom = 'ui';
        }

        if (this.startedByDaemonProcess) {
            await this.notifyDaemonConnectedServiceTurnLifecycle('prompt_or_steer');
        }

        await this.ensureProviderAcceptanceDeliveryStateFeatureEnabled();
        if (this.deliveredUserMessageWatermarkDeferredToProviderAcceptance) {
            await this.enqueueProviderAcceptedUserPrompt({ text, localId, meta });
            return { providerAcceptancePending: true };
        }

        // Deliver immediately to the agent queue: this RPC is a prompt input, not a passive transcript write.
        // Repeated RPC attempts with the same localId still commit through the transcript path below,
        // but only the first attempt should feed the running agent within the recovery window.
        const prompt = {
            role: 'user',
            content: { type: 'text', text },
            localId,
            meta,
            createdAt: Date.now(),
        } satisfies UserMessage;
        if (!this.hasAgentQueueDeliveredLocalId(localId)) {
            // Mark before invoking the callback: the runner may synchronously re-enter session
            // handling and observe a transcript echo for this same localId before this RPC returns.
            this.markAgentQueueEchoSuppressedLocalId(localId);
            this.markAgentQueueDeliveredLocalId(localId);
            if (this.pendingMessageCallback) {
                this.pendingMessageCallback(prompt, { seq: null });
            } else {
                this.pendingMessages.push(prompt);
            }
        }

        this.sendUserTextMessage(text, { localId, meta });
    }

    async enqueueAgentMessageCommitted(
        provider: ACPProvider,
        body: ACPMessageData,
        opts: { localId: string; meta?: Record<string, unknown> },
    ): Promise<Readonly<{ persisted: boolean; delivered: boolean }>> {
        const { normalizedBody, content, localId, sidechainId } = this.prepareAcpAgentMessage({
            provider,
            body,
            meta: opts?.meta,
            localId: opts.localId,
        });

        if (shouldTraceAcpMessageType(normalizedBody.type)) {
            recordAcpToolTraceEventIfNeeded({ sessionId: this.sessionId, provider, body: normalizedBody, localId });
        }

        const payload = this.buildOutboundSessionMessagePayload(content);
        const streamSegmentMeta = opts.meta?.happierStreamSegmentV1;
        const metaRecord = streamSegmentMeta && typeof streamSegmentMeta === 'object'
            ? streamSegmentMeta as Record<string, unknown>
            : null;
        const createdAt =
            metaRecord && typeof metaRecord.startedAtMs === 'number' && Number.isFinite(metaRecord.startedAtMs)
                ? Math.max(0, Math.trunc(metaRecord.startedAtMs))
                : Date.now();
        const updatedAt =
            metaRecord && typeof metaRecord.updatedAtMs === 'number' && Number.isFinite(metaRecord.updatedAtMs)
                ? Math.max(createdAt, Math.trunc(metaRecord.updatedAtMs))
                : createdAt;
        const result = await this.sessionMutationOutbox.enqueueTranscriptMessage(createTranscriptMessageAppendMutation({
            sessionId: this.sessionId,
            localId,
            content: payload,
            sidechainId,
            messageRole: resolveAcpSessionMessageRole(normalizedBody),
            createdAt,
            updatedAt,
        }));
        if (result.delivered) {
            this.observeTurnAssistantTextFromSessionContent(content, {
                source: 'committed',
                localId,
                sidechainId,
                provider,
            });
        }
        return result;
    }

    async sendAgentMessageCommitted(
        provider: ACPProvider,
        body: ACPMessageData,
        opts: { localId: string; meta?: Record<string, unknown> },
    ): Promise<void> {
        const { normalizedBody, content, localId, sidechainId } = this.prepareAcpAgentMessage({
            provider,
            body,
            meta: opts?.meta,
            localId: opts.localId,
        });

        if (shouldTraceAcpMessageType(normalizedBody.type)) {
            recordAcpToolTraceEventIfNeeded({ sessionId: this.sessionId, provider, body: normalizedBody, localId });
        }

        const payload = this.buildOutboundSessionMessagePayload(content);
        const seq = await this.enqueueMessageCommit(() =>
            this.commitSessionMessage({ message: payload, localId, sidechainId, messageRole: resolveAcpSessionMessageRole(normalizedBody), requireCommit: true }),
        );
        this.observeTurnAssistantTextFromSessionContent(content, {
            source: 'committed',
            seq,
            localId,
            sidechainId,
            provider,
        });
    }

    async fetchRecentTranscriptTextItemsForAcpImport(opts?: { take?: number }): Promise<Array<{ role: 'user' | 'agent'; text: string }>> {
        const request = () => fetchRecentTranscriptTextItemsForAcpImportFromServer({
            token: this.token,
            sessionId: this.sessionId,
            encryptionKey: this.encryptionKey,
            encryptionVariant: this.encryptionVariant,
            take: opts?.take,
        });
        const supervisor = this.sessionConnectionSupervisor;
        if (!supervisor) {
            return request();
        }
        return runSupervisedRequest({
            supervisor,
            requireAuth: true,
            requireOnline: false,
            request,
        });
    }

    async fetchCommittedClaudeJsonlMessageBaseline(opts?: { take?: number }): Promise<CommittedClaudeJsonlMessageBaseline> {
        const take = typeof opts?.take === 'number' && Number.isFinite(opts.take) && opts.take > 0
            ? Math.trunc(opts.take)
            : 5_000;
        const request = async (): Promise<CommittedClaudeJsonlMessageBaseline> => {
            const keys = new Set<string>();
            let remaining = take;
            let beforeSeq: number | undefined;
            let complete = true;
            let oldestCoveredAtMs: number | null = null;
            const observeRowCoverage = (createdAt: unknown): void => {
                const createdAtMs = typeof createdAt === 'number' && Number.isFinite(createdAt)
                    ? createdAt
                    : typeof createdAt === 'string'
                        ? Date.parse(createdAt)
                        : Number.NaN;
                if (!Number.isFinite(createdAtMs)) return;
                if (oldestCoveredAtMs === null || createdAtMs < oldestCoveredAtMs) {
                    oldestCoveredAtMs = createdAtMs;
                }
            };
            while (remaining > 0) {
                const page = await fetchEncryptedTranscriptMessagesPage({
                    token: this.token,
                    sessionId: this.sessionId,
                    limit: Math.min(500, remaining),
                    ...(typeof beforeSeq === 'number' ? { beforeSeq } : {}),
                    scope: 'all',
                    roles: ['user', 'agent', 'event'],
                });
                for (const row of page.messages) {
                    observeRowCoverage(row.createdAt);
                    const keyFromLocalId = typeof row.localId === 'string'
                        ? extractClaudeJsonlMessageKeyFromLocalId(row.localId)
                        : null;
                    if (keyFromLocalId) {
                        keys.add(keyFromLocalId);
                        continue;
                    }
                    const parsedContent = SessionMessageContentSchema.safeParse(row.content);
                    if (!parsedContent.success) continue;
                    try {
                        const decoded = this.decodeStoredSessionMessageContent(parsedContent.data);
                        const keyFromContent = extractClaudeJsonlMessageKeyFromSessionContent(decoded);
                        if (keyFromContent) keys.add(keyFromContent);
                    } catch (error) {
                        logger.debug('[API] Failed to decode committed Claude transcript row for resume dedupe', {
                            seq: row.seq,
                            error: serializeAxiosErrorForLog(error),
                        });
                    }
                }
                remaining -= page.messages.length;
                if (!page.hasMore || page.nextBeforeSeq === null || page.messages.length === 0) break;
                if (remaining <= 0) {
                    // The take budget ran out while the server still had older rows: the baseline
                    // window is PARTIAL, and rows older than `oldestCoveredAtMs` cannot be proven
                    // uncommitted (Lane N4).
                    complete = false;
                    break;
                }
                beforeSeq = page.nextBeforeSeq;
            }
            return { keys, complete, oldestCoveredAtMs };
        };
        const supervisor = this.sessionConnectionSupervisor;
        if (!supervisor) {
            return request();
        }
        return runSupervisedRequest({
            supervisor,
            requireAuth: true,
            requireOnline: false,
            request,
        });
    }

    async fetchLatestUserPermissionIntentFromTranscript(opts?: { take?: number }): Promise<{ intent: import('../types').PermissionMode; updatedAt: number } | null> {
        const request = () => fetchLatestUserPermissionIntentFromEncryptedTranscript({
            token: this.token,
            sessionId: this.sessionId,
            encryptionKey: this.encryptionKey,
            encryptionVariant: this.encryptionVariant,
            take: opts?.take,
        });
        const supervisor = this.sessionConnectionSupervisor;
        if (!supervisor) {
            return request();
        }
        return runSupervisedRequest({
            supervisor,
            requireAuth: true,
            requireOnline: false,
            request,
        });
    }

    sendSessionEvent(event: SessionEventMessage, id?: string) {
        const content = {
            role: 'agent',
            content: {
                id: id ?? randomUUID(),
                type: 'event',
                data: event
            }
        };

        this.logSendWhileDisconnected('session event', { eventType: event.type });

        const payload = this.buildOutboundSessionMessagePayload(content);
        const localId = randomUUID();
        this.commitSessionMessageBestEffort({
            message: payload,
            localId,
            sidechainId: null,
            messageRole: resolveSessionEventMessageRole(),
            sessionEventType: event.type === 'ready' ? 'ready' : undefined,
            logErrorMessage: '[SOCKET] Failed to commit session event (non-fatal)',
        });
    }

    /**
     * Send a ping message to keep the connection alive
     */
    keepAlive(thinking: boolean, mode: SessionAliveMode) {
        if (process.env.DEBUG) { // too verbose for production
            logger.debug(`[API] Sending keep alive message: ${thinking}`);
        }
        this.latestSessionPresence = { thinking, mode };
        const payload = this.createSessionAlivePayload(this.latestSessionPresence);

        if (thinking) {
            void this.sessionTurnLifecycle.touchActiveTurn({ observedAt: payload.time }).catch((error) => {
                logger.debug('[API] Failed to touch active session turn from keepalive (non-fatal)', {
                    error: serializeAxiosErrorForLog(error),
                });
            });
        }

        // Idle keep-alive remains volatile, while reconnect replay is non-volatile and includes
        // the latest primary-turn snapshot so missed terminal writes self-heal.
        this.emitSessionAlive(payload, { volatileWhenIdle: true });
    }

    private createSessionAlivePayload(presence: SessionPresenceSnapshot): SessionAlivePayload {
        const payload: SessionAlivePayload = {
            sid: this.sessionId,
            time: Date.now(),
            thinking: presence.thinking,
            mode: presence.mode,
        };
        if (this.latestTurnStatus !== undefined && this.latestTurnStatus !== null) {
            return {
                ...payload,
                latestTurnStatus: this.latestTurnStatus,
                latestTurnStatusObservedAt: this.latestTurnStatusObservedAtMs ?? payload.time,
            };
        }
        return payload;
    }

    private emitSessionAlive(
        payload: SessionAlivePayload,
        options: Readonly<{ volatileWhenIdle: boolean }>,
    ): boolean {
        if ((this.socket as Socket<ServerToClientEvents, ClientToServerEvents> | undefined)?.connected !== true) {
            return false;
        }

        if (payload.thinking || !options.volatileWhenIdle) {
            this.socket.emit('session-alive', payload);
            return true;
        }

        const volatileEmit = (this.socket as any)?.volatile?.emit;
        if (typeof volatileEmit === 'function') {
            volatileEmit.call((this.socket as any).volatile, 'session-alive', payload);
            return true;
        }

        this.socket.emit('session-alive', payload);
        return true;
    }

    private replayLatestSessionPresenceAfterReconnect(): boolean {
        return this.emitSessionAlive(this.createSessionAlivePayload(this.latestSessionPresence), {
            volatileWhenIdle: false,
        });
    }

    private reassertSessionPresenceAfterReconnect(): void {
        this.clearReconnectPresenceReassertTimer();
        this.replayLatestSessionPresenceAfterReconnect();
        this.reconnectPresenceReassertTimer = setTimeout(() => {
            this.reconnectPresenceReassertTimer = null;
            if (this.closed) return;
            this.replayLatestSessionPresenceAfterReconnect();
        }, SESSION_PRESENCE_RECONNECT_REASSERT_DELAY_MS);
        this.reconnectPresenceReassertTimer.unref?.();
    }

    private clearReconnectPresenceReassertTimer(): void {
        if (!this.reconnectPresenceReassertTimer) return;
        clearTimeout(this.reconnectPresenceReassertTimer);
        this.reconnectPresenceReassertTimer = null;
    }

    /**
     * Whether the canonical session turn lifecycle currently has an open (non-terminal) turn.
     * Used by terminal-runtime arbiters to bound their own turn-state heuristics (Lane N2).
     */
    hasActiveCanonicalTurn(): boolean {
        return this.sessionTurnLifecycle.hasActiveTurn();
    }

    /**
     * Send session death message
     */
    sendSessionDeath(): Promise<void> {
        this.trackSessionTurnWrite(
            this.sessionTurnLifecycle.endSession(),
            { latestTurnStatus: 'cancelled' },
        );
        const trackedSessionEndWrite = this.sessionMutationOutbox.enqueueSessionEnd(createSessionEndMutation({
            sessionId: this.sessionId,
        })).catch((error) => {
            logger.debug('[API] Failed to enqueue session-end mutation (non-fatal)', {
                error: serializeAxiosErrorForLog(error),
            });
        });
        this.pendingSessionEndWrites.add(trackedSessionEndWrite);
        void trackedSessionEndWrite.finally(() => {
            this.pendingSessionEndWrites.delete(trackedSessionEndWrite);
        });
        return trackedSessionEndWrite;
    }

    /**
     * Send usage data to the server
     */
    sendUsageData(usage: Usage, model?: string) {
        // Calculate total tokens
        const totalTokens = usage.input_tokens + usage.output_tokens + (usage.cache_creation_input_tokens || 0) + (usage.cache_read_input_tokens || 0);

        const costs = calculateCost(usage, model);

        // Transform Claude usage format to backend expected format
        const usageReport = {
            key: 'claude-session',
            sessionId: this.sessionId,
            tokens: {
                total: totalTokens,
                input: usage.input_tokens,
                output: usage.output_tokens,
                cache_creation: usage.cache_creation_input_tokens || 0,
                cache_read: usage.cache_read_input_tokens || 0
            },
            cost: {
                total: costs.total,
                input: costs.input,
                output: costs.output
            }
        }
        logger.debugLargeJson('[SOCKET] Sending usage data:', usageReport)
        if (!this.socket.connected) {
            return;
        }
        this.socket.emit('usage-report', usageReport);
    }

    /**
     * Update session metadata
     * @param handler - Handler function that returns the updated metadata
     */
    /**
     * Owed-delivery watermark persistence (A-F2/D15b). Best-effort: failures keep the watermark
     * behind, which only widens redelivery (never loses messages).
     */
    private recordDeliveredUserMessageSeq(seq: number): void {
        if (!Number.isInteger(seq) || seq < 0) return;
        if (this.deliveredUserMessageWatermarkDeferredToProviderAcceptance) {
            // Volatile custody only (queue residency, parked locals): wait for provider acceptance.
            this.highestDeliveredUserMessageSeq = Math.max(this.highestDeliveredUserMessageSeq ?? -1, seq);
            return;
        }
        this.persistDeliveredUserMessageWatermark(seq);
    }

    /**
     * A3-HIGH-1: opt in by launchers whose consumption path confirms provider acceptance.
     * Callers can separately choose whether pending rows stay claimed until provider acceptance
     * (terminal/TUI paste flows) or commit at materialization time (request/response runtimes
     * whose successful API call is provider acceptance).
     */
    deferDeliveredUserMessageWatermarkToProviderAcceptance(options?: ProviderAcceptanceDeliveryOptions): void {
        const pendingMaterialization = options?.pendingMaterialization ?? 'claimUntilProviderAccept';
        this.providerAcceptancePendingMaterializationPolicy = pendingMaterialization;
        this.providerAcceptanceDeliveryStateRequested = pendingMaterialization === 'claimUntilProviderAccept';
        if (this.providerAcceptanceDeliveryStateRequested) {
            void this.ensureProviderAcceptanceDeliveryStateFeatureEnabled();
            return;
        }
        this.activateProviderAcceptanceWatermarkMode();
    }

    private async ensureProviderAcceptanceDeliveryStateFeatureEnabled(): Promise<void> {
        if (this.shouldUseProviderDeliveryStateMaterialization()) return;
        if (!this.providerAcceptanceDeliveryStateRequested) return;
        if (!this.pendingDeliveryStateFeatureProbe) {
            this.pendingDeliveryStateFeatureProbe = this.activateProviderAcceptanceDeliveryStateIfSupported();
        }
        await this.pendingDeliveryStateFeatureProbe;
    }

    private async activateProviderAcceptanceDeliveryStateIfSupported(): Promise<void> {
        try {
            const resolved = await resolveCliFeatureDecisionForServer({
                featureId: 'sharing.pendingDeliveryState',
                env: process.env,
                serverUrl: resolveServerHttpBaseUrl(),
                timeoutMs: PENDING_DELIVERY_STATE_FEATURE_GATE_TIMEOUT_MS,
            });
            if (resolved.decision.state !== 'enabled') {
                logger.debug('[pendingQueue] provider delivery-state feature unavailable; using commit-at-materialize delivery custody', {
                    sessionId: this.sessionId,
                    state: resolved.decision.state,
                });
                this.activateProviderAcceptanceWatermarkMode();
                return;
            }
        } catch (error) {
            logger.debug('[pendingQueue] provider delivery-state feature probe failed; using commit-at-materialize delivery custody', {
                sessionId: this.sessionId,
                error: serializeAxiosErrorForLog(error),
            });
            this.activateProviderAcceptanceWatermarkMode();
            return;
        }
        this.providerAcceptanceDeliveryStateFeatureEnabled = true;
        this.activateProviderAcceptanceWatermarkMode();
        if (!this.deliveredUserMessageWatermarkDeferredToProviderAcceptance) return;
        if (this.closed) return;
        if (this.shouldUseProviderDeliveryStateMaterialization()) {
            void this.blockInheritedProviderDeliveryClaimsOnAttach();
        }
    }

    private activateProviderAcceptanceWatermarkMode(): void {
        if (this.closed) return;
        if (this.deliveredUserMessageWatermarkDeferredToProviderAcceptance) return;
        this.deliveredUserMessageWatermarkDeferredToProviderAcceptance = true;
        void this.updateMetadata((metadata) =>
            mergeUserMessageDeliveryWatermarkModeV1(metadata, 'providerAcceptance').metadata,
        ).catch((error) => {
            logger.debug('[API] Failed to persist user-message delivery watermark mode (best-effort)', error);
        });
    }

    private shouldUseProviderDeliveryStateMaterialization(): boolean {
        return this.deliveredUserMessageWatermarkDeferredToProviderAcceptance
            && this.providerAcceptanceDeliveryStateFeatureEnabled
            && this.providerAcceptancePendingMaterializationPolicy === 'claimUntilProviderAccept';
    }

    private async blockInheritedProviderDeliveryClaimsOnAttach(): Promise<void> {
        if (this.closed || this.providerDeliveryAttachRecoveryCompleted) return;
        if (this.providerDeliveryAttachRecoveryInFlight) {
            await this.providerDeliveryAttachRecoveryInFlight;
            return;
        }
        const run = async (): Promise<void> => {
            const supervisor = this.sessionConnectionSupervisor;
            const request = () => blockPendingQueueV2ProviderDeliveriesOnAttach({
                token: this.token,
                sessionId: this.sessionId,
            });
            const result = supervisor
                ? await runSupervisedRequest({
                    supervisor,
                    requireAuth: true,
                    requireOnline: false,
                    request,
                })
                : await request();
            if (result.pendingQueueState) {
                this.applyPendingQueueState(result.pendingQueueState, { emit: true });
            }
            this.providerDeliveryAttachRecoveryCompleted = true;
        };

        const recovery = run().catch((error) => {
            logger.debug('[pendingQueue] provider delivery attach recovery failed', {
                sessionId: this.sessionId,
                error: serializeAxiosErrorForLog(error),
            });
        }).finally(() => {
            if (this.providerDeliveryAttachRecoveryInFlight === recovery) {
                this.providerDeliveryAttachRecoveryInFlight = null;
            }
        });
        this.providerDeliveryAttachRecoveryInFlight = recovery;
        await recovery;
    }

    private async recoverInheritedProviderDeliveryClaimsBeforeMaterialization(): Promise<void> {
        if (!this.shouldUseProviderDeliveryStateMaterialization()) return;
        if (this.providerDeliveryAttachRecoveryCompleted) return;
        if (countMaterializablePendingRows(this.pendingQueueState) <= 0) return;
        await this.blockInheritedProviderDeliveryClaimsOnAttach();
    }

    private normalizeProviderAcceptedUserMessageLocalIds(localIds: readonly string[] | null | undefined): string[] {
        const seen = new Set<string>();
        const normalized: string[] = [];
        for (const value of localIds ?? []) {
            const localId = typeof value === 'string' ? value.trim() : '';
            if (!localId || seen.has(localId)) continue;
            seen.add(localId);
            normalized.push(localId);
        }
        return normalized;
    }

    /**
     * Persist the owed-delivery watermark for a batch the provider actually accepted (or that
     * otherwise provably left local volatile custody). Local ids let this join provider acceptance
     * with a later server echo when the batch reached the provider before its durable seq existed.
     */
    confirmUserMessageDeliveredToProvider(
        seq: number | null | undefined,
        opts?: { localIds?: readonly string[] | null },
    ): void {
        const localIds = this.normalizeProviderAcceptedUserMessageLocalIds(opts?.localIds);
        const suppliedAcceptedSeq = typeof seq === 'number' ? seq : null;
        let highestAcceptedSeq = localIds.length === 0 ? suppliedAcceptedSeq : null;
        const acceptedCanonicalPendingLocalIds = new Set<string>();
        const acceptedCanonicalPendingSeqByLocalId = new Map<string, number>();

        for (const localId of localIds) {
            const committedSeq = this.committedUserMessageSeqTracker.get(localId);
            if (this.canonicalPendingDeliveryByLocalId.has(localId)) {
                acceptedCanonicalPendingLocalIds.add(localId);
                this.markProviderAcceptedUserMessageLocalIdAwaitingSeq(localId);
                const fallbackSeq = committedSeq ?? suppliedAcceptedSeq;
                if (fallbackSeq !== null) {
                    acceptedCanonicalPendingSeqByLocalId.set(localId, fallbackSeq);
                }
                continue;
            }
            if (committedSeq !== null) {
                highestAcceptedSeq = Math.max(highestAcceptedSeq ?? -1, committedSeq);
                this.clearProviderAcceptedUserMessageLocalIdAwaitingSeq(localId);
            } else {
                this.markProviderAcceptedUserMessageLocalIdAwaitingSeq(localId);
                if (suppliedAcceptedSeq !== null) {
                    highestAcceptedSeq = Math.max(highestAcceptedSeq ?? -1, suppliedAcceptedSeq);
                }
            }
        }

        if (highestAcceptedSeq !== null) {
            this.highestProviderAcceptedUserMessageSeq = Math.max(
                this.highestProviderAcceptedUserMessageSeq ?? -1,
                highestAcceptedSeq,
            );
            this.persistDeliveredUserMessageWatermark(highestAcceptedSeq);
        }

        if (acceptedCanonicalPendingLocalIds.size > 0) {
            this.trackAcceptedCanonicalPendingDeliveryResolution(
                this.resolveAcceptedCanonicalPendingDeliveries(
                    [...acceptedCanonicalPendingLocalIds],
                    acceptedCanonicalPendingSeqByLocalId,
                ),
            );
        }
    }

    hasUserMessageProviderAcceptance(query: UserMessageProviderAcceptanceQuery): boolean {
        const providerAccepted = this.readDeliveredUserMessageWatermarkState().providerAccepted;
        const explicitSeqs = new Set<number>();
        for (const seq of query.userMessageSeqs ?? []) {
            if (Number.isInteger(seq) && seq >= 0) {
                explicitSeqs.add(seq);
            }
        }
        const scalarSeq = Number.isInteger(query.userMessageSeq) && query.userMessageSeq! >= 0
            ? query.userMessageSeq!
            : null;
        if (providerAccepted !== null) {
            if (explicitSeqs.size > 0) {
                return [...explicitSeqs].every((seq) => seq <= providerAccepted);
            } else if (scalarSeq !== null && scalarSeq <= providerAccepted) {
                return true;
            }
        } else if (explicitSeqs.size > 0) {
            return false;
        }

        for (const localId of this.normalizeProviderAcceptedUserMessageLocalIds(query.localIds)) {
            if (this.providerAcceptedUserMessageLocalIdsAwaitingSeq.has(localId)) return true;
            const committedSeq = this.committedUserMessageSeqTracker.get(localId);
            if (committedSeq !== null && providerAccepted !== null && committedSeq <= providerAccepted) {
                return true;
            }
        }

        return false;
    }

    private readDeliveredUserMessageWatermarkState(): Readonly<{
        persisted: number | null;
        inMemory: number | null;
        effective: number | null;
        providerAccepted: number | null;
    }> {
        const persisted = readDeliveredUserMessageSeqV1(this.metadata as unknown as Record<string, unknown> | null);
        const persistedProviderAccepted = readProviderAcceptedUserMessageSeqV1(this.metadata as unknown as Record<string, unknown> | null);
        const inMemory = this.highestDeliveredUserMessageSeq;
        const providerAccepted = this.deliveredUserMessageWatermarkDeferredToProviderAcceptance
            ? Math.max(
                persistedProviderAccepted ?? -1,
                this.highestProviderAcceptedUserMessageSeq ?? -1,
            )
            : Math.max(
                persistedProviderAccepted ?? -1,
                persisted ?? -1,
                this.highestProviderAcceptedUserMessageSeq ?? -1,
                inMemory ?? -1,
            );
        const effective = this.deliveredUserMessageWatermarkDeferredToProviderAcceptance
            ? providerAccepted
            : Math.max(persisted ?? -1, inMemory ?? -1);
        return {
            persisted,
            inMemory,
            effective: effective >= 0 ? effective : null,
            providerAccepted: providerAccepted >= 0 ? providerAccepted : null,
        };
    }

    private persistDeliveredUserMessageWatermark(seq: number): void {
        if (!Number.isInteger(seq) || seq < 0) return;
        if (this.deliveredUserMessageWatermarkDeferredToProviderAcceptance) {
            this.highestProviderAcceptedUserMessageSeq = Math.max(
                this.highestProviderAcceptedUserMessageSeq ?? -1,
                seq,
            );
        }
        this.highestDeliveredUserMessageSeq = Math.max(this.highestDeliveredUserMessageSeq ?? -1, seq);
        void this.persistDeliveredUserMessageSeq();
    }

    private readDeliveredUserMessagePersistTarget(): number | null {
        const target = this.deliveredUserMessageWatermarkDeferredToProviderAcceptance
            ? this.highestProviderAcceptedUserMessageSeq
            : this.highestDeliveredUserMessageSeq;
        return target !== null && Number.isInteger(target) && target >= 0 ? target : null;
    }

    private canPersistDeliveredUserMessageTarget(target: number): boolean {
        if (!this.deliveredUserMessageWatermarkDeferredToProviderAcceptance) return true;
        return (this.highestProviderAcceptedUserMessageSeq ?? -1) >= target;
    }

    private async persistDeliveredUserMessageSeq(): Promise<void> {
        if (this.deliveredUserMessageSeqPersistInFlight) return;
        const target = this.readDeliveredUserMessagePersistTarget();
        if (target === null) return;
        if (!this.canPersistDeliveredUserMessageTarget(target)) return;
        this.deliveredUserMessageSeqPersistInFlight = true;
        let persistedTarget = false;
        try {
            await this.updateMetadata((metadata) => {
                if (!this.canPersistDeliveredUserMessageTarget(target)) return metadata;
                persistedTarget = true;
                if (!this.deliveredUserMessageWatermarkDeferredToProviderAcceptance) {
                    return mergeDeliveredUserMessageSeqV1(metadata, target).metadata;
                }
                const withLegacyDeliveredCursor = mergeDeliveredUserMessageSeqV1(metadata, target).metadata;
                return mergeProviderAcceptedUserMessageSeqV1(withLegacyDeliveredCursor, target).metadata;
            });
        } catch (error) {
            logger.debug('[API] Failed to persist delivered user-message watermark (best-effort)', error);
            return;
        } finally {
            this.deliveredUserMessageSeqPersistInFlight = false;
        }
        // A newer delivery may have arrived while the write was in flight; converge.
        const nextTarget = this.readDeliveredUserMessagePersistTarget();
        if (
            nextTarget !== null
            && this.canPersistDeliveredUserMessageTarget(nextTarget)
            && (nextTarget > target || (nextTarget === target && !persistedTarget))
        ) {
            void this.persistDeliveredUserMessageSeq();
        }
    }

    updateMetadata(handler: (metadata: Metadata) => Metadata): Promise<void> {
        return this.metadataLock.inLock(async () => {
            await this.waitForSessionSocketOnlineForAckWrite('update-metadata');
            await updateSessionMetadataWithAck({
                socket: this.socket as any,
                sessionId: this.sessionId,
                sessionEncryptionMode: this.sessionEncryptionMode,
                encryptionKey: this.encryptionKey,
                encryptionVariant: this.encryptionVariant,
                getMetadata: () => this.metadata,
                setMetadata: (metadata) => {
                    this.metadata = metadata;
                },
                getMetadataVersion: () => this.metadataVersion,
                setMetadataVersion: (version) => {
                    this.metadataVersion = version;
                },
                syncSessionSnapshotFromServer: async () => {
                    await this.syncSessionSnapshotFromServer({ reason: 'waitForMetadataUpdate' });
                },
                handler,
            });
        });
    }

    updateRuntimeActivityProjection(projection: Readonly<{
        runtimeActivityActiveCount: number;
        runtimeActivityObservedAt: number | null;
        runtimeActivityExpiresAt: number | null;
        runtimeActivitySourceClass: SessionRuntimeActivitySourceClassV1 | null;
    }>): Promise<void> {
        this.runtimeActivityProjection = projection;
        if (projection.runtimeActivityExpiresAt === null) {
            this.clearRuntimeActivityPendingWakeTimer();
        }
        return this.waitForSessionSocketOnlineForAckWrite('update-runtime-activity').then(() => updateSessionRuntimeActivityProjectionWithAck({
            socket: this.socket as any,
            sessionId: this.sessionId,
            runtimeActivityActiveCount: projection.runtimeActivityActiveCount,
            runtimeActivityObservedAt: projection.runtimeActivityObservedAt,
            runtimeActivityExpiresAt: projection.runtimeActivityExpiresAt,
            runtimeActivitySourceClass: projection.runtimeActivitySourceClass,
        }));
    }

    private applyRuntimeActivityProjectionFromServer(projectionLike: unknown): void {
        const projection = readRuntimeActivityProjectionForPendingDrain(projectionLike);
        this.runtimeActivityProjection = projection;
        if (projection.runtimeActivityExpiresAt === null) {
            this.clearRuntimeActivityPendingWakeTimer();
        }
    }

    getStoredContentEncryptionContext(): Readonly<{
        mode: 'e2ee' | 'plain';
        ctx?: Readonly<{ encryptionKey: Uint8Array; encryptionVariant: 'legacy' | 'dataKey' }>;
    }> {
        if (this.sessionEncryptionMode === 'plain') {
            return { mode: 'plain' };
        }
        return {
            mode: 'e2ee',
            ctx: {
                encryptionKey: this.encryptionKey,
                encryptionVariant: this.encryptionVariant,
            },
        };
    }

    async upsertSessionSystemRecord(request: SessionSystemRecordUpsertRequest): Promise<void> {
        await upsertSessionSystemRecordHttp({
            token: this.token,
            sessionId: this.sessionId,
            namespace: request.namespace,
            kind: request.kind,
            localId: request.localId,
            content: request.content,
        });
    }

    async fetchSessionSystemRecord(params: Readonly<{
        namespace: SessionSystemRecordNamespace;
        localId: string;
    }>): Promise<SessionSystemRecord | null> {
        return fetchSessionSystemRecordHttp({
            token: this.token,
            sessionId: this.sessionId,
            namespace: params.namespace,
            localId: params.localId,
        });
    }

    /**
     * Update session agent state
     * @param handler - Handler function that returns the updated agent state
     */
    updateAgentState(handler: (metadata: AgentState) => AgentState): Promise<void> {
        logger.debugLargeJson('Updating agent state', this.agentState);
        return this.agentStateLock.inLock(async () => {
            await this.waitForSessionSocketOnlineForAckWrite('update-state');
            await updateSessionAgentStateWithAck({
                socket: this.socket as any,
                sessionId: this.sessionId,
                sessionEncryptionMode: this.sessionEncryptionMode,
                encryptionKey: this.encryptionKey,
                encryptionVariant: this.encryptionVariant,
                getAgentState: () => this.agentState,
                setAgentState: (agentState) => {
                    this.agentState = agentState;
                },
                getAgentStateVersion: () => this.agentStateVersion,
                setAgentStateVersion: (version) => {
                    this.agentStateVersion = version;
                },
                syncSessionSnapshotFromServer: async () => {
                    await this.syncSessionSnapshotFromServer({ reason: 'waitForMetadataUpdate' });
                },
                handler,
            });
        });
    }

    private trackSessionTurnWrite(
        update: Promise<void>,
        record: Readonly<{ latestTurnStatus?: PrimaryTurnStatusV1 }>,
    ): void {
        if (record.latestTurnStatus !== undefined) {
            this.latestTurnStatus = record.latestTurnStatus;
            this.latestTurnStatusObservedAtMs = Date.now();
        }
        const tracked = update.catch((error) => {
            logger.debug('[API] Failed to update primary turn runtime state (non-fatal)', {
                latestTurnStatus: record.latestTurnStatus ?? null,
                error: serializeAxiosErrorForLog(error),
            });
        });
        this.pendingSessionTurnWrites.add(tracked);
        void tracked.finally(() => {
            this.pendingSessionTurnWrites.delete(tracked);
        });
    }

    private async drainBestEffortSessionWrites(): Promise<void> {
        await Promise.all([
            this.messageCommitQueueTail.catch(() => undefined),
            this.sessionMutationOutbox.flush('flush').catch(() => undefined),
            ...[...this.pendingSessionTurnWrites].map((update) => update.catch(() => undefined)),
        ]);
    }

    private async drainPendingLifecycleWritesBeforeClose(): Promise<void> {
        await Promise.all([
            ...[...this.pendingSessionTurnWrites].map((update) => update.catch(() => undefined)),
            ...[...this.pendingSessionEndWrites].map((update) => update.catch(() => undefined)),
        ]);
    }

    /**
     * Wait for socket buffer to flush
     */
    async flush(): Promise<void> {
        await this.drainBestEffortSessionWrites();
        if (!this.socket.connected) {
            return;
        }
        return new Promise((resolve) => {
            let settled = false;
            let timer: ReturnType<typeof setTimeout> | null = null;
            const finish = () => {
                if (settled) {
                    return;
                }
                settled = true;
                if (timer) {
                    clearTimeout(timer);
                }
                resolve();
            };
            this.socket.emit('ping', () => {
                finish();
            });
            timer = setTimeout(() => {
                finish();
            }, 10000);
            timer.unref?.();
        });
    }

    /**
     * Read-only snapshot of the currently known session metadata (decrypted).
     *
     * This is useful for spawn-time decisions that depend on previous metadata values
     * (e.g. session-scoped feature toggles) without requiring a metadata write.
     */
    getMetadataSnapshot(): Metadata | null {
        return this.metadata;
    }

    /**
     * Read-only snapshot of the last transcript message seq observed by this client.
     *
     * Used for provider integrations that need to distinguish "fresh" sessions from sessions that
     * already contain imported history or prior user prompts (e.g. resume history import).
     */
    getLastObservedMessageSeq(): number {
        return this.lastObservedMessageSeq;
    }

    getLastObservedUserMessageSeq(): number {
        return this.lastObservedUserMessageSeq;
    }

    getCommittedUserMessageSeq(localId: string): number | null {
        return this.committedUserMessageSeqTracker.get(localId);
    }

    waitForCommittedUserMessageSeq(
        localId: string,
        options?: CommittedUserMessageSeqWaitOptions,
    ): Promise<number | null> {
        return this.committedUserMessageSeqTracker.wait(localId, options);
    }

    async close() {
        logger.debug('[API] socket.close() called');
        this.socketStaleSafetyScheduler?.stop();
        if (this.startupMessageCatchUpRetryTimer) {
            clearTimeout(this.startupMessageCatchUpRetryTimer);
            this.startupMessageCatchUpRetryTimer = null;
        }
        if (this.userSocketDisconnectTimer) {
            clearTimeout(this.userSocketDisconnectTimer);
            this.userSocketDisconnectTimer = null;
        }
        this.clearReconnectPresenceReassertTimer();
        this.clearRuntimeActivityPendingWakeTimer();
        this.clearPendingMaterializeRetryWake();
        await this.drainPendingLifecycleWritesBeforeClose();
        await this.rpcHandlerManager.waitForIdle();
        await this.disposeRpcLifecycleRegistrations();
        await this.drainAcceptedCanonicalPendingDeliveryResolutionsBeforeClose();
        await this.blockUnresolvedCanonicalPendingDeliveriesBeforeClose();
        await this.blockDurableProviderDeliveriesBeforeClose();
        this.closed = true;
        this.pendingMaterializedLocalIds.clear();
        this.committedLocalIdsAwaitingEcho.clear();
        this.pendingQueueMaterializedLocalIds.clear();
        this.canonicalPendingDeliveryByLocalId.clear();
        this.committedUserMessageSeqTracker.clear();
        this.agentQueueEchoSuppressedLocalIds.clear();
        this.agentQueueDeliveredLocalIds.clear();
        this.providerAcceptedUserMessageLocalIdsAwaitingSeq.clear();
        this.acceptedCanonicalPendingDeliveryRetryLocalIds.clear();
        this.acceptedCanonicalPendingDeliveryResolutionWrites.clear();
        this.blockedCanonicalPendingDeliveryRetryReasonsByLocalId.clear();
        this.passiveCommittedUserMessageLocalIds.clear();
        this.queuedDisconnectedSessionMessages.clear();
        for (const timer of this.committedLocalIdCleanupTimers.values()) {
            clearTimeout(timer);
        }
        this.committedLocalIdCleanupTimers.clear();
        for (const timer of this.agentQueueEchoSuppressedLocalIdCleanupTimers.values()) {
            clearTimeout(timer);
        }
        this.agentQueueEchoSuppressedLocalIdCleanupTimers.clear();
        for (const timer of this.agentQueueDeliveredLocalIdCleanupTimers.values()) {
            clearTimeout(timer);
        }
        this.agentQueueDeliveredLocalIdCleanupTimers.clear();
        for (const timer of this.providerAcceptedUserMessageLocalIdCleanupTimers.values()) {
            clearTimeout(timer);
        }
        this.providerAcceptedUserMessageLocalIdCleanupTimers.clear();
        for (const timer of this.passiveCommittedUserMessageLocalIdCleanupTimers.values()) {
            clearTimeout(timer);
        }
        this.passiveCommittedUserMessageLocalIdCleanupTimers.clear();
        this.pendingCommitRetryAttemptsByLocalId.clear();
        await this.sessionMutationOutbox.close();
        try {
            this.userSocket.close();
        } catch {
            // ignore
        }
        await this.sessionConnectionSupervisor?.stop();
    }

    private async blockUnresolvedCanonicalPendingDeliveriesBeforeClose(): Promise<void> {
        const localIds = [...this.canonicalPendingDeliveryByLocalId.keys()];
        for (const localId of localIds) {
            if (this.acceptedCanonicalPendingDeliveryRetryLocalIds.has(localId)) {
                logger.debug('[pendingQueue] skipping provider-accepted delivery block during close after resolution retry failed', {
                    sessionId: this.sessionId,
                    localId,
                });
                continue;
            }
            await this.blockPendingQueueDeliveryLocalId(localId, 'runtime_disposed_before_delivery', {
                canonicalOnly: true,
            });
        }
    }

    private async blockDurableProviderDeliveriesBeforeClose(): Promise<void> {
        if (!this.deliveredUserMessageWatermarkDeferredToProviderAcceptance) return;
        if (countMaterializablePendingRows(this.pendingQueueState) <= 0) return;

        let localIds: string[];
        const supervisor = this.sessionConnectionSupervisor;
        try {
            const request = () => listPendingQueueV2ProviderDeliveryLocalIdsFromServer({
                token: this.token,
                sessionId: this.sessionId,
            });
            localIds = supervisor
                ? await runSupervisedRequest({
                    supervisor,
                    requireAuth: true,
                    requireOnline: false,
                    request,
                })
                : await request();
        } catch (error) {
            logger.debug('[pendingQueue] provider delivery close recovery lookup failed', {
                sessionId: this.sessionId,
                error: serializeAxiosErrorForLog(error),
            });
            return;
        }

        for (const localId of localIds) {
            if (this.acceptedCanonicalPendingDeliveryRetryLocalIds.has(localId)) {
                logger.debug('[pendingQueue] skipping durable provider delivery block during close after accepted resolution retry failed', {
                    sessionId: this.sessionId,
                    localId,
                });
                continue;
            }
            await this.blockPendingQueueDeliveryLocalId(localId, 'runtime_disposed_before_delivery', {
                canonicalOnly: false,
            });
        }
    }

    private async disposeRpcLifecycleRegistrations(): Promise<void> {
        const registrations = this.rpcLifecycleRegistrations.splice(0);
        await Promise.all(registrations.map(async (registration) => {
            try {
                await registration.dispose();
            } catch (error) {
                logger.debug('[API] Failed to dispose RPC lifecycle registration', {
                    error: serializeAxiosErrorForLog(error),
                });
            }
        }));
    }

    private installSessionSocketEventHandlers(socket: Socket<ServerToClientEvents, ClientToServerEvents>): void {
        socket.on('server:restarting', (payload: unknown) => {
            this.sessionConnectionSupervisor?.reportProbeResult?.({
                status: 'retry_later',
                retryAfterMs: readPlannedServerRestartRetryAfterMs(payload),
                reason: 'server_restarting',
                errorMessage: 'Server restart in progress',
            });
        });

        socket.on(SOCKET_RPC_EVENTS.REQUEST, async (data: { method: string, params: unknown }, callback: (response: unknown) => void) => {
            callback(await this.rpcHandlerManager.handleRequest(data));
        });

        socket.on('connect_error', (error) => {
            logger.debug('[API] Socket connection error:', {
                error: serializeAxiosErrorForLog(error),
            });
        });

        socket.on('update', (data: Update) => this.handleUpdate(data, { source: 'session-scoped' }));
        socket.on('session', () => {});
        socket.on('error', (error) => {
            logger.debug('[API] Socket error:', {
                error: serializeAxiosErrorForLog(error),
            });
        });
    }

    async listPendingMessageQueueV2LocalIds(): Promise<string[]> {
        const request = () => listPendingQueueV2LocalIdsFromServer({
            token: this.token,
            sessionId: this.sessionId,
        });
        const supervisor = this.sessionConnectionSupervisor;
        if (!supervisor) {
            return request();
        }
        return runSupervisedRequest({
            supervisor,
            requireAuth: true,
            requireOnline: false,
            request,
        });
    }

    async peekPendingMessageQueueV2Count(opts?: PendingQueueReadOptions): Promise<number> {
        const policy = resolvePendingQueueReconcileWhenEmpty(opts, 'force');
        if (!this.pendingQueueState.known) {
            await this.reconcilePendingQueueState({ force: true });
        } else if (this.pendingQueueState.pendingCount <= 0) {
            if (policy === 'force') {
                await this.reconcilePendingQueueState({ force: true });
            } else if (policy === 'throttled') {
                await this.reconcilePendingQueueState({ force: false });
            }
        }

        if (this.pendingQueueState.known && this.pendingQueueState.pendingCount <= 0) {
            return this.pendingQueueMaterializedLocalIds.size;
        }

        if (!this.pendingQueueState.known) {
            return this.pendingQueueMaterializedLocalIds.size;
        }

        const localIds = await this.listPendingMessageQueueV2LocalIds();
        // Include materialized-but-not-yet-observed messages as "pending-ish" work.
        // These are messages we already removed from the server pending queue but haven't
        // seen broadcast into the transcript yet; switching modes during this window can
        // silently drop user intent in non-interactive (no TTY) flows.
        return localIds.length + this.pendingQueueMaterializedLocalIds.size;
    }

    async discardPendingMessageQueueV2All(opts: { reason: 'switch_to_local' | 'manual' }): Promise<number> {
        const localIds = await this.listPendingMessageQueueV2LocalIds();
        if (localIds.length === 0) return 0;
        const request = () => discardPendingQueueV2Messages({
            token: this.token,
            sessionId: this.sessionId,
            localIds,
            reason: opts.reason,
        });
        const supervisor = this.sessionConnectionSupervisor;
        if (!supervisor) {
            return request();
        }
        return runSupervisedRequest({
            supervisor,
            requireAuth: true,
            requireOnline: false,
            request,
        });
    }

    async discardCommittedMessageLocalIds(opts: { localIds: string[]; reason: 'switch_to_local' | 'manual' }): Promise<number> {
        if (!this.socket.connected) {
            return 0;
        }
        if (!this.metadata) {
            return 0;
        }

        const localIds = opts.localIds.filter((id) => typeof id === 'string' && id.length > 0);
        if (localIds.length === 0) {
            return 0;
        }

        let addedCount = 0;

        await this.metadataLock.inLock(async () => {
            await backoff(async () => {
                const current = this.metadata as unknown as Record<string, unknown>;

                const existingRaw = (current as any).discardedCommittedMessageLocalIds;
                const existing = Array.isArray(existingRaw) ? existingRaw.filter((v) => typeof v === 'string') : [];
                const existingSet = new Set(existing);
                const uniqueNew = localIds.filter((id) => !existingSet.has(id));
                if (uniqueNew.length === 0) {
                    addedCount = 0;
                    return;
                }

                const nextMetadata = addDiscardedCommittedMessageLocalIds(current, uniqueNew);
                const metadataPayload =
                    this.sessionEncryptionMode === 'plain'
                        ? JSON.stringify(nextMetadata)
                        : encodeBase64(encrypt(this.encryptionKey, this.encryptionVariant, nextMetadata));
                const answer = await emitSocketWithAck<any>({
                    socket: this.socket as any,
                    event: 'update-metadata',
                    payload: {
                        sid: this.sessionId,
                        expectedVersion: this.metadataVersion,
                        metadata: metadataPayload,
                    },
                });

                if (answer.result === 'success') {
                    this.metadata =
                        this.sessionEncryptionMode === 'plain'
                            ? JSON.parse(String(answer.metadata ?? 'null'))
                            : decrypt(this.encryptionKey, this.encryptionVariant, decodeBase64(answer.metadata));
                    this.metadataVersion = answer.version;
                    addedCount = uniqueNew.length;
                    return;
                }

                if (answer.result === 'version-mismatch') {
                    if (answer.version > this.metadataVersion) {
                        this.metadataVersion = answer.version;
                        this.metadata =
                            this.sessionEncryptionMode === 'plain'
                                ? JSON.parse(String(answer.metadata ?? 'null'))
                                : decrypt(this.encryptionKey, this.encryptionVariant, decodeBase64(answer.metadata));
                    }
                    throw new Error('Metadata version mismatch');
                }

                // Hard error - ignore
                addedCount = 0;
            });
        });

        return addedCount;
    }

    /**
     * Drain one server-backed queued message (pending queue V2).
     *
     * Legacy queue-handoff rows are committed into SessionMessage before delivery. Provider-
     * acceptance rows are claimed without a transcript commit, delivered directly to the runtime,
     * and resolved into the transcript only when the provider proves custody.
     */
    private async runMaterializeNextPendingMessageInner(opts: {
        pendingQueueDeliveryTiming?: SessionPendingQueueDeliveryTiming;
    } = {}): Promise<{
        didMaterialize: boolean;
        result: MaterializeNextPendingResult;
    }> {
        const supervisor = this.sessionConnectionSupervisor;
        if (!supervisor) {
            return { didMaterialize: false, result: { type: 'no_pending' } };
        }
        let materializeResult: PendingQueueMaterializeNextResult;
        try {
            materializeResult = await runSupervisedRequest({
                supervisor,
                requireAuth: true,
                requireOnline: false,
                request: async () => materializeNextPendingQueueV2Message({
                    token: this.token,
                    sessionId: this.sessionId,
                    socket: this.socket,
                    knownPendingVersion: this.pendingQueueState.known ? this.pendingQueueState.pendingVersion : undefined,
                    deliveryStateOptIn: this.shouldUseProviderDeliveryStateMaterialization(),
                    deliveryTiming: opts.pendingQueueDeliveryTiming,
                }),
            });
        } catch (error) {
            if (isAuthenticationError(error)) {
                throw error;
            }
            logger.debug('[pendingQueue] materialize request failed', {
                sessionId: this.sessionId,
                error: serializeAxiosErrorForLog(error),
            });
            this.schedulePendingMaterializeRetryWake('materialize_failed');
            return { didMaterialize: false, result: { type: 'no_pending' } };
        }
        const pendingStateUpdate = derivePendingQueueStateAfterMaterializeResult({
            current: this.pendingQueueState,
            didMaterialize: materializeResult.didMaterialize,
            authoritativeState: materializeResult.pendingQueueState ?? null,
        });
        this.pendingQueueState = pendingStateUpdate.state;
        this.clearPendingMaterializeRetryWakeIfDrained();
        if (pendingStateUpdate.changed) {
            this.pendingWakeSeq += 1;
        }

        if (!materializeResult.didMaterialize) {
            if (materializeResult.deferredReason === 'runtime_activity_active') {
                return { didMaterialize: false, result: { type: 'deferred', reason: 'runtime_activity_active' } };
            }
            logger.debug('[pendingQueue] materialize result', {
                sessionId: this.sessionId,
                didMaterialize: false,
                pendingCount: this.pendingQueueState.known ? this.pendingQueueState.pendingCount : undefined,
                pendingVersion: this.pendingQueueState.known ? this.pendingQueueState.pendingVersion : undefined,
            });
            return { didMaterialize: false, result: { type: 'no_pending' } };
        }

        const materializedLocalId = materializeResult.message?.localId ?? materializeResult.localId ?? null;
        const materializedMessage = materializeResult.message && !materializeResult.message.localId && materializedLocalId
            ? { ...materializeResult.message, localId: materializedLocalId }
            : materializeResult.message ?? null;
        const materializedProviderClaimState =
            materializeResult.didWrite === false
            && materializedMessage
            && materializedMessage.deliveryStateMalformed !== true
            && typeof materializedMessage.localId === 'string'
            && materializedMessage.localId.length > 0
            && materializedMessage.seq === null
                ? { mode: 'provider' as const, unresolved: true as const }
                : null;
        const explicitUnresolvedProviderDeliveryState =
            materializedMessage?.deliveryState?.unresolved === true
                ? materializedMessage.deliveryState
                : null;
        const inferredProviderDeliveryState =
            materializedProviderClaimState
            && !explicitUnresolvedProviderDeliveryState
                ? materializedProviderClaimState
                : null;
        const unresolvedProviderDeliveryState =
            explicitUnresolvedProviderDeliveryState
                ? explicitUnresolvedProviderDeliveryState
                : inferredProviderDeliveryState;

        if (materializedMessage?.deliveryStateMalformed) {
            logger.debug('[pendingQueue] materialize result ignored malformed pending delivery state', {
                sessionId: this.sessionId,
                localId: materializedLocalId,
                messageSeq: materializedMessage?.seq ?? null,
            });
            if (materializedLocalId) {
                await this.blockPendingQueueDeliveryLocalId(materializedLocalId, 'unknown', {
                    canonicalOnly: false,
                });
            }
            return { didMaterialize: false, result: { type: 'no_pending' } };
        }

        if (
            materializedMessage
            && unresolvedProviderDeliveryState
            && materializedMessage.localId
        ) {
            if (this.canonicalPendingDeliveryByLocalId.has(materializedMessage.localId)) {
                logger.debug('[pendingQueue] materialize result suppressed for already-unresolved provider delivery state', {
                    sessionId: this.sessionId,
                    localId: materializedMessage.localId,
                    messageSeq: materializedMessage.seq,
                });
                return { didMaterialize: false, result: { type: 'no_pending' } };
            }
            this.canonicalPendingDeliveryByLocalId.set(
                materializedMessage.localId,
                unresolvedProviderDeliveryState,
            );
        } else if (
            materializedMessage?.deliveryState?.unresolved === false
            && materializedMessage.localId
        ) {
            this.canonicalPendingDeliveryByLocalId.delete(materializedMessage.localId);
        }

        const isProviderDeliveryHandoff =
            unresolvedProviderDeliveryState?.unresolved === true;
        if (materializedLocalId) {
            this.pendingQueueMaterializedLocalIds.add(materializedLocalId);
        }
        const deliveredMaterializedMessage = isProviderDeliveryHandoff
            ? this.deliverClaimedPendingQueueMessage(materializedMessage)
            : this.deliverMaterializedPendingQueueMessage(materializedMessage);
        logger.debug('[pendingQueue] materialize result', {
            sessionId: this.sessionId,
            didMaterialize: true,
            localId: materializedLocalId,
            didWrite: materializeResult.didWrite,
            messageSeq: materializedMessage?.seq ?? null,
            messageSeqKind: materializedMessage
                ? materializedMessage.seq === null
                    ? 'null'
                    : typeof materializedMessage.seq
                : 'missing',
            messageRole: materializedMessage?.messageRole ?? null,
            deliveredMaterializedMessage,
            providerDeliveryStateUnresolved: materializedMessage?.deliveryState?.unresolved ?? null,
            providerDeliveryStateMalformed: materializedMessage?.deliveryStateMalformed === true,
            providerDeliveryStateInferred: inferredProviderDeliveryState !== null,
            pendingCount: this.pendingQueueState.known ? this.pendingQueueState.pendingCount : undefined,
            pendingVersion: this.pendingQueueState.known ? this.pendingQueueState.pendingVersion : undefined,
        });

        if (
            isProviderDeliveryHandoff
            && materializedMessage?.localId
            && !deliveredMaterializedMessage
        ) {
            await this.blockCanonicalPendingDeliveries([materializedMessage.localId], 'invalid_prompt_text');
        }

        if (materializeResult.didWrite && materializedLocalId && !deliveredMaterializedMessage) {
            // Best-effort: recover if we miss socket broadcasts for the committed transcript row.
            this.scheduleMaterializationRecovery(materializedLocalId);
        }
        if (
            materializeResult.didWrite
            && materializedMessage?.messageRole === 'user'
            && materializedMessage.localId
        ) {
            this.recordCommittedUserMessageSeq(
                materializedMessage.localId,
                materializedMessage.seq,
            );
        }

        const message = materializedMessage;
        if (
            message
            && typeof message.localId === 'string'
            && message.localId.length > 0
            && (
                (
                    typeof message.seq === 'number'
                    && Number.isSafeInteger(message.seq)
                    && message.seq >= 0
                )
                || (
                    isProviderDeliveryHandoff
                    && message.seq === null
                    && deliveredMaterializedMessage
                )
            )
        ) {
            return {
                didMaterialize: true,
                result: {
                    type: 'materialized',
                    localId: message.localId,
                    seq: typeof message.seq === 'number' ? message.seq : null,
                    content: message.content ?? null,
                    ...(typeof message.createdAt === 'number' ? { createdAt: message.createdAt } : {}),
                    ...(typeof message.updatedAt === 'number' ? { updatedAt: message.updatedAt } : {}),
                    ...(unresolvedProviderDeliveryState ? { deliveryState: unresolvedProviderDeliveryState } : {}),
                },
            };
        }

        return { didMaterialize: true, result: { type: 'no_pending' } };
    }

    async materializeNextPendingMessageSafely(opts: {
        reconcileWhenEmpty?: 'force' | 'throttled' | 'skip';
        activeTurnDeliveryPolicy?: PendingMaterializationActiveTurnPolicy;
        pendingQueueDeliveryTiming?: SessionPendingQueueDeliveryTiming;
    } = {}): Promise<MaterializeNextPendingResult> {
        const supervisorState = this.sessionConnectionSupervisor?.getState();
        if (supervisorState?.phase === 'auth_failed') {
            return { type: 'deferred', reason: 'supervisor_auth_failed' };
        }
        if (supervisorState && supervisorState.phase === 'shutting_down') {
            return { type: 'deferred', reason: 'supervisor_offline' };
        }
        if (supervisorState && supervisorState.phase !== 'online') {
            // Degraded socket phases (connecting/offline/idle) must NOT hard-defer: the
            // materialize transport falls back to HTTP (requireOnline:false), and daemon/server
            // churn can wedge the socket supervisor out of 'online' for long stretches while HTTP
            // still works — hard-deferring here silently strands queued messages forever
            // (QA C-F2/A-F3, live runner pid-98509). Fail-safe is a periodic failed attempt,
            // never a silent stuck queue; transport-level failures are handled below.
            logger.debug('[pendingQueue] materializing with degraded session socket supervisor', {
                sessionId: this.sessionId,
                phase: supervisorState.phase,
            });
        }
        await this.ensureProviderAcceptanceDeliveryStateFeatureEnabled();
        if (!await this.reconcileCanonicalPendingDeliveriesBeforeMaterialization()) {
            return { type: 'no_pending' };
        }

        const policy = resolvePendingQueueReconcileWhenEmpty(opts, 'skip');
        if (!this.pendingQueueState.known) {
            await this.reconcilePendingQueueState({ force: true });
        } else if (countMaterializablePendingRows(this.pendingQueueState) <= 0) {
            if (policy === 'force') {
                await this.reconcilePendingQueueState({ force: true });
            } else if (policy === 'throttled') {
                await this.reconcilePendingQueueState({ force: false });
            }
        }
        await this.recoverInheritedProviderDeliveryClaimsBeforeMaterialization();
        if (countMaterializablePendingRows(this.pendingQueueState) <= 0) {
            this.clearPendingMaterializeRetryWake();
            return { type: 'no_pending' };
        }
        const refreshedTurnStatus = await this.reconcileTurnStatusBeforePendingMaterializationIfNeeded({
            activeTurnDeliveryPolicy: opts.activeTurnDeliveryPolicy,
        });
        if (!refreshedTurnStatus) {
            this.logPendingMaterializationSkip('turn_status_refresh_failed');
            return { type: 'no_pending' };
        }
        if (countMaterializablePendingRows(this.pendingQueueState) <= 0) {
            this.clearPendingMaterializeRetryWake();
            return { type: 'no_pending' };
        }
        if (this.isPendingMaterializationBlocked({ activeTurnDeliveryPolicy: opts.activeTurnDeliveryPolicy })) {
            this.logPendingMaterializationSkip('blocked', {
                activeTurnDeliveryPolicy: opts.activeTurnDeliveryPolicy,
            });
            return { type: 'no_pending' };
        }
        const runtimeActivityDeferral = this.isPendingMaterializationDeferredForRuntimeActivity(opts);
        if (runtimeActivityDeferral.deferred) {
            this.scheduleRuntimeActivityPendingWake(runtimeActivityDeferral.runtimeActivityExpiresAt);
            this.logPendingMaterializationSkip('runtime_activity_active', {
                activeTurnDeliveryPolicy: opts.activeTurnDeliveryPolicy,
            });
            return { type: 'deferred', reason: 'runtime_activity_active' };
        }

        const inner = await this.runMaterializeNextPendingMessageInner({
            pendingQueueDeliveryTiming: opts.pendingQueueDeliveryTiming,
        });
        return inner.result;
    }

    /**
     * Known-positive pending count with no materialization attempt is the silent-stuck
     * shape (QA A-F3/C-F2); log why the drain was skipped so it is diagnosable from
     * runner logs without instrumented builds.
     */
    private logPendingMaterializationSkip(
        reason: 'blocked' | 'runtime_activity_active' | 'turn_status_refresh_failed',
        opts: { activeTurnDeliveryPolicy?: PendingMaterializationActiveTurnPolicy } = {},
    ): void {
        logger.debug('[pendingQueue] materialization skipped', {
            sessionId: this.sessionId,
            reason,
            activeTurnDeliveryPolicy: opts.activeTurnDeliveryPolicy ?? 'block',
            hasCanonicalActiveTurn: this.sessionTurnLifecycle.hasActiveTurn(),
            latestTurnStatus: this.latestTurnStatus ?? null,
            continuationRecoveryBlocked: isSessionContinuationRecoveryBlockingPendingDrain(this.metadata),
            pendingCount: this.pendingQueueState.known ? this.pendingQueueState.pendingCount : null,
            pendingVersion: this.pendingQueueState.known ? this.pendingQueueState.pendingVersion : null,
        });
    }

    async popPendingMessage(): Promise<boolean> {
        if (!await this.reconcileCanonicalPendingDeliveriesBeforeMaterialization()) {
            return false;
        }
        if (countMaterializablePendingRows(this.pendingQueueState) <= 0) {
            await this.reconcilePendingQueueState({ force: !this.pendingQueueState.known });
        }
        if (countMaterializablePendingRows(this.pendingQueueState) <= 0) {
            return false;
        }
        const refreshedTurnStatus = await this.reconcileTurnStatusBeforePendingMaterializationIfNeeded();
        if (!refreshedTurnStatus) {
            return false;
        }
        if (countMaterializablePendingRows(this.pendingQueueState) <= 0) {
            return false;
        }
        if (this.isPendingMaterializationBlocked()) {
            return false;
        }

        const inner = await this.runMaterializeNextPendingMessageInner();
        return inner.didMaterialize;
    }
}
