import type { TrackedSession } from '@/daemon/types';
import { ConnectedServiceIdSchema, type ConnectedServiceBindingsV1, type ConnectedServiceId } from '@happier-dev/protocol';
import type { ConnectedServiceCredentialRefreshResult } from '../refresh/ConnectedServiceRefreshCoordinator';
import type { AcceptedConnectedServiceAccountVerificationByServiceId } from '../accountTransitions/acceptedConnectedServiceAccountVerification';

import {
  SESSION_SWITCH_LIMIT_WINDOW_MS,
  type ConnectedServiceAuthGroupSwitchResult,
} from '../accountGroups/switching/ConnectedServiceAuthGroupSwitchCoordinator';
import { handleConnectedServiceRuntimeAuthFailure } from './handleConnectedServiceRuntimeAuthFailure';
import type { ConnectedServiceRuntimeAuthSwitchAttemptTracker } from './ConnectedServiceRuntimeAuthSwitchAttemptTracker';
import type { ConnectedServiceRuntimeFailureClassification } from './types';
import {
  createConnectedServiceSessionAuthSwitchCore,
  type ConnectedServiceSessionAuthSwitchReason,
  type ConnectedServiceSessionAuthSwitchCore,
} from './connectedServiceSessionAuthSwitchCore';
import { buildConnectedServiceSwitchContinuationAttemptId } from '../sessionAuthSwitch/buildConnectedServiceSwitchContinuationAttemptId';
import {
  isGroupRuntimeRecoverySelection,
  resolveConnectedServiceRuntimeAuthRecoverySelection,
  type RuntimeRecoverySelection,
} from './resolveConnectedServiceRuntimeAuthRecoverySelection';

type SwitchCoordinatorLike = Parameters<typeof handleConnectedServiceRuntimeAuthFailure>[0]['switchCoordinator'];
type SwitchAfterClassifiedFailureInput = Parameters<SwitchCoordinatorLike['switchAfterClassifiedFailure']>[0];
type TemporaryThrottleRecoveryLike = NonNullable<
  Parameters<typeof handleConnectedServiceRuntimeAuthFailure>[0]['temporaryThrottleRecovery']
>;
type SwitchAttemptTrackerLike = Pick<
  ConnectedServiceRuntimeAuthSwitchAttemptTracker,
  | 'resolveSwitchesThisTurn'
  | 'recordSwitchResult'
  | 'countRecordedSwitchesInWindow'
  | 'hasFreshCredentialRefreshAttempt'
  | 'recordCredentialRefreshAttempt'
  | 'clearSession'
> & Partial<Pick<
  ConnectedServiceRuntimeAuthSwitchAttemptTracker,
  | 'hasFreshSuccessfulCredentialRefreshAttempt'
  | 'recordCredentialRefreshSuccess'
>>;

type RuntimeAuthRecoveryReaderLike = Readonly<{
  readForSession(sessionId: string): ReadonlyArray<Readonly<{
    serviceId: string;
    groupId: string | null;
    profileId: string | null;
    status: 'waiting' | 'checking' | 'resumed_awaiting_proof' | 'cancelled' | 'exhausted';
    classification: Readonly<{ profileId: string | null }>;
    pendingTargetProfileId?: string | null;
    pendingTargetGeneration?: number | null;
  }>>;
}>;

type RuntimeCredentialRefreshService = Readonly<{
  refreshConnectedServiceCredentialForRuntimeAuthFailure(input: Readonly<{
    serviceId: ConnectedServiceId;
    profileId: string;
    sessionId: string;
  }>): Promise<ConnectedServiceCredentialRefreshResult>;
}>;

type RuntimeAuthSwitchContinuation = (input: Readonly<{
  tracked: TrackedSession;
  sessionId: string;
  attemptId: string;
  normalizedBindings: ConnectedServiceBindingsV1;
  serviceIds: ReadonlySet<ConnectedServiceId>;
  action: 'hot_applied' | 'restart_requested';
  switchReason?: ConnectedServiceSessionAuthSwitchReason;
}>) => Promise<void> | void;

type RuntimeAuthRecoverySuccessObserver = (input: Readonly<{
  sessionId: string;
  serviceId: string;
  groupId: string | null;
  profileId: string | null;
  status: 'switched' | 'observed_generation' | 'credential_refreshed';
  generation: number | null;
  // Provider-outcome proof carriers. The observer is a LOCAL-substep notification;
  // consumers MUST gate clearing recovery on these (post-switch account-adoption
  // verification, or a genuinely fresh candidate). A bare status is never proof.
  verificationByServiceId?: AcceptedConnectedServiceAccountVerificationByServiceId | null;
  fromProfileId?: string | null;
}>) => Promise<void> | void;

type RuntimeAuthRecoveryDurableSessionResolver = (input: Readonly<{
  sessionId: string;
  classification: ConnectedServiceRuntimeFailureClassification;
}>) => Promise<TrackedSession | null> | TrackedSession | null;

type RuntimeAuthRestartFailureObserver = (input: Readonly<{
  sessionId: string;
  tracked: TrackedSession;
  source: 'group_switch';
  error: unknown;
  groupSwitchResult?: ConnectedServiceAuthGroupSwitchResult;
}>) => Promise<void> | void;

type RuntimeAuthRecoveryActionRequired = Readonly<{
  status: 'recovery_action_required';
  action: Readonly<{
    kind: 'reconnect_profile' | 're_resolve_binding';
    serviceId: string;
    profileId: string;
    groupId: string | null;
    reason: ConnectedServiceRuntimeFailureClassification['kind'];
  }>;
}>;

type RuntimeAuthRecoveryInvocationSource = 'daemon_report' | 'scheduler_retry';

// A scheduler replay of a persisted recovery intent whose failing profile the live
// session no longer runs. The group already moved off the failing profile, so there
// is nothing left to recover for this intent: the scheduler removes it so the same
// recovery key can re-arm on a genuine future failure.
export type RuntimeAuthRecoverySuperseded = Readonly<{
  status: 'recovery_superseded';
  reason: 'failing_profile_inactive';
  serviceId: string;
  groupId: string;
  failingProfileId: string | null;
  activeProfileId: string | null;
}>;

type RuntimeAuthCredentialRefreshProviderOutcomeWaiting = Readonly<{
  status: 'credential_refreshed';
  restartRequested: false;
  pendingProviderOutcome: true;
}>;

const unavailableSwitchCoordinator: SwitchCoordinatorLike = {
  switchAfterClassifiedFailure: async () => ({
    status: 'no_eligible_member',
    generation: 0,
    groupExhausted: true,
    retryAtMs: null,
    excluded: [],
  }),
};

const defaultSwitchCore = createConnectedServiceSessionAuthSwitchCore();

function requestRuntimeAuthRestart(input: Readonly<{
  sessionId: string;
  tracked: TrackedSession;
  source: 'group_switch';
  restartSession?: ((tracked: TrackedSession) => Promise<void> | void) | null;
  onRestartFailure?: RuntimeAuthRestartFailureObserver | null;
  groupSwitchResult?: ConnectedServiceAuthGroupSwitchResult;
}>): boolean {
  const restartSession = input.restartSession;
  if (!restartSession) return false;
  void Promise.resolve(restartSession(input.tracked)).catch((error) => {
    void Promise.resolve(input.onRestartFailure?.({
      sessionId: input.sessionId,
      tracked: input.tracked,
      source: input.source,
      error,
      ...(input.groupSwitchResult === undefined ? {} : { groupSwitchResult: input.groupSwitchResult }),
    })).catch(() => {});
  });
  return true;
}

function createCommitOnlySwitchCoordinator(
  switchCoordinator: SwitchCoordinatorLike,
): SwitchCoordinatorLike {
  return {
    switchAfterClassifiedFailure: async (input: SwitchAfterClassifiedFailureInput) => {
      const { sessionId: _liveSessionId, ...commitOnlyInput } = input;
      return await switchCoordinator.switchAfterClassifiedFailure(commitOnlyInput);
    },
  };
}

function normalizeSessionId(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function findTrackedSession(
  children: ReadonlyArray<TrackedSession>,
  sessionId: string,
): TrackedSession | null {
  const normalized = normalizeSessionId(sessionId);
  if (!normalized) return null;
  return children.find((child) => normalizeSessionId(child.happySessionId) === normalized) ?? null;
}

async function resolveRuntimeAuthRecoveryTrackedSession(input: Readonly<{
  children: ReadonlyArray<TrackedSession>;
  sessionId: string;
  classification: ConnectedServiceRuntimeFailureClassification | null;
  resolveDurableSessionForRuntimeAuthRecovery?: RuntimeAuthRecoveryDurableSessionResolver | null;
}>): Promise<TrackedSession | null> {
  const tracked = findTrackedSession(input.children, input.sessionId);
  if (tracked) return tracked;
  if (!input.classification || !input.resolveDurableSessionForRuntimeAuthRecovery) return null;
  const durableTracked = await input.resolveDurableSessionForRuntimeAuthRecovery({
    sessionId: input.sessionId,
    classification: input.classification,
  });
  if (!durableTracked) return null;
  return normalizeSessionId(durableTracked.happySessionId) === normalizeSessionId(input.sessionId)
    ? durableTracked
    : null;
}

function isRuntimeCredentialFailure(classification: ConnectedServiceRuntimeFailureClassification): boolean {
  return classification.kind === 'auth_expired'
    || classification.kind === 'refresh_failed'
    || classification.kind === 'permission_denied';
}

function isReconnectRequiredRefreshResult(result: ConnectedServiceCredentialRefreshResult): boolean {
  const category = result.diagnostic.category;
  return result.status === 'credential_missing'
    || category === 'invalid_grant'
    || category === 'invalid_client'
    || category === 'provider_401'
    || category === 'provider_403'
    || category === 'missing_refresh_token';
}

function normalizeNullableProfileId(value: unknown): string | null {
  const normalized = normalizeSessionId(value);
  return normalized.length > 0 ? normalized : null;
}

function resolveAuthoritativeRecoveryProfileId(input: Readonly<{
  selection: RuntimeRecoverySelection;
  classifiedProfileId?: string | null;
}>): string {
  if (input.selection.kind === 'group') {
    return normalizeSessionId(
      input.selection.activeProfileId
      ?? input.selection.fallbackProfileId
      ?? input.classifiedProfileId
      ?? '',
    );
  }
  return normalizeSessionId(
    input.selection.profileId
    ?? input.classifiedProfileId
    ?? '',
  );
}

function buildReconnectProfileAfterRepeatedCredentialRefresh(input: Readonly<{
  classification: ConnectedServiceRuntimeFailureClassification;
  selection: RuntimeRecoverySelection;
  profileId: string;
}>): RuntimeAuthRecoveryActionRequired {
  return {
    status: 'recovery_action_required',
    action: {
      kind: 'reconnect_profile',
      serviceId: input.selection.serviceId,
      profileId: input.profileId,
      groupId: input.classification.groupId ?? (
        input.selection.kind === 'group' ? input.selection.groupId : null
      ),
      reason: input.classification.kind,
    },
  };
}

function shouldSwitchAwayAfterRepeatedCredentialRefreshFailure(
  _selection: RuntimeRecoverySelection,
): boolean {
  return false;
}

async function runRuntimeGroupSwitchRecovery(input: Readonly<{
  sessionId: string;
  selection: Extract<RuntimeRecoverySelection, Readonly<{ kind: 'group' }>>;
  classification: ConnectedServiceRuntimeFailureClassification;
  switchesThisTurn: number;
  switchCoordinator: SwitchCoordinatorLike;
  switchAttemptTracker?: SwitchAttemptTrackerLike | null;
  temporaryThrottleRecovery?: TemporaryThrottleRecoveryLike | null;
  applyLiveSession?: boolean;
}>): Promise<Awaited<ReturnType<typeof handleConnectedServiceRuntimeAuthFailure>>> {
  const effectiveSwitchesThisTurn = input.switchAttemptTracker?.resolveSwitchesThisTurn({
    sessionId: input.sessionId,
    serviceId: input.selection.serviceId,
    groupId: input.selection.groupId,
    reportedSwitchesThisTurn: input.switchesThisTurn,
  }) ?? input.switchesThisTurn;
  const sessionSwitchesThisHour = input.switchAttemptTracker?.countRecordedSwitchesInWindow({
    sessionId: input.sessionId,
    serviceId: input.selection.serviceId,
    groupId: input.selection.groupId,
    windowMs: SESSION_SWITCH_LIMIT_WINDOW_MS,
  });

  return await handleConnectedServiceRuntimeAuthFailure({
    sessionId: input.sessionId,
    selection: {
      kind: 'group',
      serviceId: input.selection.serviceId,
      groupId: input.selection.groupId,
      activeProfileId: resolveAuthoritativeRecoveryProfileId({
        selection: input.selection,
        classifiedProfileId: input.classification.profileId,
      }),
    },
    classification: {
      ...input.classification,
      groupId: input.classification.groupId ?? input.selection.groupId,
      profileId: normalizeNullableProfileId(resolveAuthoritativeRecoveryProfileId({
        selection: input.selection,
        classifiedProfileId: input.classification.profileId,
      })),
    },
    switchesThisTurn: effectiveSwitchesThisTurn,
    sessionSwitchesThisHour,
    switchCoordinator: input.applyLiveSession === false
      ? createCommitOnlySwitchCoordinator(input.switchCoordinator)
      : input.switchCoordinator,
    temporaryThrottleRecovery: input.temporaryThrottleRecovery ?? null,
  });
}

function finalizeRuntimeGroupSwitchAttempt(input: Readonly<{
  sessionId: string;
  selection: Extract<RuntimeRecoverySelection, Readonly<{ kind: 'group' }>>;
  result: Awaited<ReturnType<typeof handleConnectedServiceRuntimeAuthFailure>>;
  switchAttemptTracker?: SwitchAttemptTrackerLike | null;
}>): void {
  if (input.result.status !== 'switch_attempted') return;
  input.switchAttemptTracker?.recordSwitchResult({
    sessionId: input.sessionId,
    serviceId: input.selection.serviceId,
    groupId: input.selection.groupId,
    resultStatus: input.result.result.status,
  });
}

function maybeRestartAfterRuntimeGroupSwitch(input: Readonly<{
  sessionId: string;
  tracked: TrackedSession;
  result: ConnectedServiceAuthGroupSwitchResult;
  restartSession?: ((tracked: TrackedSession) => Promise<void> | void) | null;
  onRestartFailure?: RuntimeAuthRestartFailureObserver | null;
}>): void {
  if (input.result.status !== 'switched') return;
  if (input.result.mode !== 'spawn_next_turn') return;
  requestRuntimeAuthRestart({
    sessionId: input.sessionId,
    tracked: input.tracked,
    source: 'group_switch',
    restartSession: input.restartSession ?? null,
    onRestartFailure: input.onRestartFailure ?? null,
    groupSwitchResult: input.result,
  });
}

function resolveRuntimeGroupSwitchContinuationContext(
  result: ConnectedServiceAuthGroupSwitchResult,
): Readonly<{
  action: 'hot_applied' | 'restart_requested';
  activeProfileId: string | null;
  generation: number;
}> | null {
  if (result.status === 'observed_generation') {
    return { action: 'hot_applied', activeProfileId: result.activeProfileId, generation: result.generation };
  }
  if (result.status !== 'switched') return null;
  if (result.mode === 'hot_apply') {
    return { action: 'hot_applied', activeProfileId: result.activeProfileId, generation: result.generation };
  }
  // QA-F 2026-06-12 (session cmqb2ikma): a `spawn_next_turn` switch requests a live
  // restart-resume; arm a PENDING continuation (`restart_requested`) so the post-respawn
  // session-report resolver can drive the resume prompt / original replay. Without this the
  // respawned session resumes its provider context and then idles forever.
  if (result.mode === 'spawn_next_turn') {
    return { action: 'restart_requested', activeProfileId: result.activeProfileId, generation: result.generation };
  }
  return null;
}

async function maybeContinueAfterRuntimeGroupSwitch(input: Readonly<{
  tracked: TrackedSession;
  sessionId: string;
  selection: Extract<RuntimeRecoverySelection, Readonly<{ kind: 'group' }>>;
  result: ConnectedServiceAuthGroupSwitchResult;
  continueAfterRuntimeAuthSwitch?: RuntimeAuthSwitchContinuation | null;
}>): Promise<void> {
  if (!input.continueAfterRuntimeAuthSwitch) return;
  const continuationContext = resolveRuntimeGroupSwitchContinuationContext(input.result);
  if (!continuationContext) return;
  const { action } = continuationContext;
  const activeProfileId = normalizeSessionId(continuationContext.activeProfileId);
  if (!activeProfileId) return;

  const serviceId = input.selection.serviceId as ConnectedServiceId;
  const normalizedBindings = {
    v: 1,
    bindingsByServiceId: {
      [serviceId]: {
        source: 'connected',
        selection: 'group',
        groupId: input.selection.groupId,
        profileId: activeProfileId,
      },
    },
  } satisfies ConnectedServiceBindingsV1;
  const serviceIds = new Set<ConnectedServiceId>([serviceId]);

  await input.continueAfterRuntimeAuthSwitch({
    tracked: input.tracked,
    sessionId: input.sessionId,
    attemptId: buildConnectedServiceSwitchContinuationAttemptId({
      action,
      serviceIds,
      normalizedBindings,
      expectedGroupGenerationByServiceId: {
        [serviceId]: continuationContext.generation,
      },
    }),
    normalizedBindings,
    serviceIds,
    action,
    switchReason: 'automatic_runtime_failure',
  });
}

// A recovery driven by a failure attributed to a profile the live session is NOT
// running (e.g. a persisted stale rate-limit intent replayed by the scheduler) must
// never restart or steer the live session: the session is healthy on another group
// member, and the committed switch applies on the next natural spawn. Incident
// 2026-06-12 (cmq8y3nlx): a stale intent for an inactive profile restarted a healthy
// mid-work session on every scheduler retry, churning accounts for ~30 minutes.
function isRuntimeFailureForInactiveProfile(input: Readonly<{
  selection: Extract<RuntimeRecoverySelection, Readonly<{ kind: 'group' }>>;
  classification: ConnectedServiceRuntimeFailureClassification;
}>): boolean {
  const failingProfileId = normalizeNullableProfileId(input.classification.profileId);
  const liveActiveProfileId = normalizeNullableProfileId(input.selection.activeProfileId);
  return Boolean(failingProfileId && liveActiveProfileId && failingProfileId !== liveActiveProfileId);
}

function shouldCoalescePendingProofTargetReplay(input: Readonly<{
  runtimeAuthRecovery?: RuntimeAuthRecoveryReaderLike | null;
  sessionId: string;
  selection: Extract<RuntimeRecoverySelection, Readonly<{ kind: 'group' }>>;
  result: ConnectedServiceAuthGroupSwitchResult;
}>): boolean {
  if (!input.runtimeAuthRecovery) return false;
  if (input.result.status !== 'switched' && input.result.status !== 'observed_generation') return false;
  const targetProfileId = normalizeSessionId(input.result.activeProfileId);
  if (!targetProfileId) return false;
  // The pending proof target is the PROFILE, deliberately NOT the group generation:
  // sibling sessions thrash the shared group generation between replays (incident
  // 2026-06-12, gen 81→87), so an exact-generation match never holds and every replay
  // re-kills the live runner. A fresher generation for the same target profile is the
  // same logical switch.
  return input.runtimeAuthRecovery.readForSession(input.sessionId).some((intent) => (
    intent.serviceId === input.selection.serviceId
    && intent.groupId === input.selection.groupId
    && (intent.profileId === null || intent.profileId === targetProfileId)
    && intent.status === 'resumed_awaiting_proof'
    && intent.pendingTargetProfileId === targetProfileId
    && Boolean(intent.classification.profileId && intent.classification.profileId !== targetProfileId)
  ));
}

function hasExitedChildProcess(tracked: TrackedSession): boolean {
  const childProcess = tracked.childProcess;
  if (!childProcess) return false;
  return childProcess.exitCode !== null || childProcess.signalCode !== null;
}

function requestCredentialRefreshRelaunch(input: Readonly<{
  tracked: TrackedSession;
  restartSession?: ((tracked: TrackedSession) => Promise<void> | void) | null;
}>): boolean {
  if (!hasExitedChildProcess(input.tracked)) return false;
  const restartSession = input.restartSession;
  if (!restartSession) return false;
  void Promise.resolve(restartSession(input.tracked)).catch(() => {});
  return true;
}

async function maybeContinueAfterCredentialRefresh(input: Readonly<{
  tracked: TrackedSession;
  sessionId: string;
  selection: RuntimeRecoverySelection;
  profileId: string;
  continueAfterRuntimeAuthSwitch?: RuntimeAuthSwitchContinuation | null;
}>): Promise<void> {
  if (!input.continueAfterRuntimeAuthSwitch) return;
  const serviceId = input.selection.serviceId as ConnectedServiceId;
  const serviceIds = new Set<ConnectedServiceId>([serviceId]);
  const normalizedBindings: ConnectedServiceBindingsV1 = {
    v: 1,
    bindingsByServiceId: {
      [serviceId]: input.selection.kind === 'group'
        ? {
            source: 'connected',
            selection: 'group',
            groupId: input.selection.groupId,
            profileId: input.profileId,
          }
        : {
            source: 'connected',
            selection: 'profile',
            profileId: input.profileId,
          },
    },
  };

  await input.continueAfterRuntimeAuthSwitch({
    tracked: input.tracked,
    sessionId: input.sessionId,
    attemptId: buildConnectedServiceSwitchContinuationAttemptId({
      action: 'hot_applied',
      serviceIds,
      normalizedBindings,
    }),
    normalizedBindings,
    serviceIds,
    action: 'hot_applied',
    switchReason: 'automatic_runtime_failure',
  });
}

async function maybeRefreshCredentialBeforeRuntimeRecovery(input: Readonly<{
  sessionId: string;
  tracked: TrackedSession;
  classification: ConnectedServiceRuntimeFailureClassification;
  selection: RuntimeRecoverySelection;
  recoveryInvocationSource: RuntimeAuthRecoveryInvocationSource;
  switchAttemptTracker?: SwitchAttemptTrackerLike | null;
  credentialRefreshService?: RuntimeCredentialRefreshService | null;
  restartSession?: ((tracked: TrackedSession) => Promise<void> | void) | null;
  continueAfterRuntimeAuthSwitch?: RuntimeAuthSwitchContinuation | null;
  onRuntimeAuthRecoverySuccess?: RuntimeAuthRecoverySuccessObserver | null;
}>): Promise<
  | null
  | Readonly<{
      status: 'credential_refreshed';
      result: ConnectedServiceCredentialRefreshResult;
      restartRequested: boolean;
    }>
  | RuntimeAuthRecoveryActionRequired
  | RuntimeAuthCredentialRefreshProviderOutcomeWaiting
> {
  if (!input.credentialRefreshService || !isRuntimeCredentialFailure(input.classification)) return null;
  const profileId = resolveAuthoritativeRecoveryProfileId({
    selection: input.selection,
    classifiedProfileId: input.classification.profileId,
  });
  if (!profileId) return null;
  const serviceId = ConnectedServiceIdSchema.safeParse(input.selection.serviceId);
  if (!serviceId.success) return null;

  const attempt = {
    sessionId: input.sessionId,
    serviceId: serviceId.data,
    profileId,
    reason: input.classification.kind,
  };
  if (input.switchAttemptTracker?.hasFreshSuccessfulCredentialRefreshAttempt?.(attempt)) {
    if (input.recoveryInvocationSource === 'scheduler_retry') {
      return {
        status: 'credential_refreshed',
        restartRequested: false,
        pendingProviderOutcome: true,
      };
    }
    if (shouldSwitchAwayAfterRepeatedCredentialRefreshFailure(input.selection)) {
      return null;
    }
    return buildReconnectProfileAfterRepeatedCredentialRefresh({
      classification: input.classification,
      selection: input.selection,
      profileId,
    });
  }
  if (input.switchAttemptTracker?.hasFreshCredentialRefreshAttempt(attempt)) return null;
  input.switchAttemptTracker?.recordCredentialRefreshAttempt(attempt);

  const result = await input.credentialRefreshService.refreshConnectedServiceCredentialForRuntimeAuthFailure({
    serviceId: serviceId.data,
    profileId,
    sessionId: input.sessionId,
  });
  if (result.status === 'refreshed') {
    input.switchAttemptTracker?.recordCredentialRefreshSuccess?.(attempt);
    await input.onRuntimeAuthRecoverySuccess?.({
      sessionId: input.sessionId,
      serviceId: input.selection.serviceId,
      groupId: input.classification.groupId,
      profileId,
      status: 'credential_refreshed',
      generation: null,
    });
    const restartRequested = requestCredentialRefreshRelaunch({
      tracked: input.tracked,
      restartSession: input.restartSession ?? null,
    });
    if (restartRequested) {
      return {
        status: 'credential_refreshed',
        result,
        restartRequested: true,
      };
    }
    await maybeContinueAfterCredentialRefresh({
      tracked: input.tracked,
      sessionId: input.sessionId,
      selection: input.selection,
      profileId,
      continueAfterRuntimeAuthSwitch: input.continueAfterRuntimeAuthSwitch ?? null,
    });
    return {
      status: 'credential_refreshed',
      result,
      restartRequested: false,
    };
  }
  if (result.status === 'refresh_failed' && !isReconnectRequiredRefreshResult(result)) {
    return null;
  }
  return null;
}

async function notifyRuntimeGroupSwitchRecoverySuccess(input: Readonly<{
  onRuntimeAuthRecoverySuccess?: RuntimeAuthRecoverySuccessObserver | null;
  sessionId: string;
  selection: Extract<RuntimeRecoverySelection, Readonly<{ kind: 'group' }>>;
  result: Awaited<ReturnType<typeof handleConnectedServiceRuntimeAuthFailure>>;
}>): Promise<void> {
  if (input.result.status !== 'switch_attempted') return;
  if (input.result.result.status !== 'switched' && input.result.result.status !== 'observed_generation') return;
  // Surface the post-switch account-adoption verification (when present) so the
  // daemon's reactive proof gate can clear recovery on verified adoption. A bare
  // switched/observed_generation status without verification is NOT proof.
  const verificationByServiceId = input.result.result.verificationByServiceId ?? null;
  await input.onRuntimeAuthRecoverySuccess?.({
    sessionId: input.sessionId,
    serviceId: input.selection.serviceId,
    groupId: input.selection.groupId,
    profileId: input.result.result.activeProfileId,
    status: input.result.result.status,
    generation: input.result.result.generation,
    ...(verificationByServiceId ? { verificationByServiceId } : {}),
  });
}

export async function handleConnectedServiceRuntimeAuthFailureForSession(input: Readonly<{
  getChildren: () => ReadonlyArray<TrackedSession>;
  switchCoordinator: SwitchCoordinatorLike | null;
  switchAttemptTracker?: SwitchAttemptTrackerLike | null;
  switchCore?: ConnectedServiceSessionAuthSwitchCore | null;
  runtimeAuthRecovery?: RuntimeAuthRecoveryReaderLike | null;
  resolveDurableSessionForRuntimeAuthRecovery?: RuntimeAuthRecoveryDurableSessionResolver | null;
  temporaryThrottleRecovery?: TemporaryThrottleRecoveryLike | null;
  credentialRefreshService?: RuntimeCredentialRefreshService | null;
  restartSession?: ((tracked: TrackedSession) => Promise<void> | void) | null;
  continueAfterRuntimeAuthSwitch?: RuntimeAuthSwitchContinuation | null;
  emitSessionEvent?: (sessionId: string, event: unknown) => void;
  onRuntimeAuthRecoverySuccess?: RuntimeAuthRecoverySuccessObserver | null;
  onRuntimeAuthRestartFailure?: RuntimeAuthRestartFailureObserver | null;
  sessionId: string;
  switchesThisTurn: number;
  recoveryInvocationSource?: RuntimeAuthRecoveryInvocationSource;
  classification: ConnectedServiceRuntimeFailureClassification | null;
}>): Promise<
  | Awaited<ReturnType<typeof handleConnectedServiceRuntimeAuthFailure>>
  | Readonly<{
      status: 'credential_refreshed';
      result: ConnectedServiceCredentialRefreshResult;
      restartRequested: boolean;
    }>
  | RuntimeAuthCredentialRefreshProviderOutcomeWaiting
  | RuntimeAuthRecoverySuperseded
  | Readonly<{ status: 'session_not_found' }>
  | Readonly<{
      status: 'switch_coordinator_unavailable';
      blocker: 'CLI has no connected-service auth-group load/commit API in this branch.';
    }>
> {
  const tracked = await resolveRuntimeAuthRecoveryTrackedSession({
    children: input.getChildren(),
    sessionId: input.sessionId,
    classification: input.classification,
    resolveDurableSessionForRuntimeAuthRecovery: input.resolveDurableSessionForRuntimeAuthRecovery ?? null,
  });
  if (!tracked) {
    const classification = input.classification;
    const { selection } = classification
      ? resolveConnectedServiceRuntimeAuthRecoverySelection({
        classification,
        environmentVariables: {},
      })
      : { selection: null };
    if (classification && selection && isGroupRuntimeRecoverySelection(selection)) {
      if (!input.switchCoordinator) {
        return {
          status: 'switch_coordinator_unavailable',
          blocker: 'CLI has no connected-service auth-group load/commit API in this branch.',
        };
      }
      const switchCoordinator = input.switchCoordinator;
      const switchCore = input.switchCore ?? defaultSwitchCore;
      const result = await switchCore.run({
        sessionId: input.sessionId,
        reason: 'automatic_runtime_failure',
        execute: async () => await runRuntimeGroupSwitchRecovery({
          sessionId: input.sessionId,
          selection,
          classification,
          switchesThisTurn: input.switchesThisTurn,
          switchCoordinator,
          switchAttemptTracker: input.switchAttemptTracker ?? null,
          temporaryThrottleRecovery: input.temporaryThrottleRecovery ?? null,
          applyLiveSession: false,
        }),
      });
      finalizeRuntimeGroupSwitchAttempt({
        sessionId: input.sessionId,
        selection,
        result,
        switchAttemptTracker: input.switchAttemptTracker ?? null,
      });
      await notifyRuntimeGroupSwitchRecoverySuccess({
        onRuntimeAuthRecoverySuccess: input.onRuntimeAuthRecoverySuccess ?? null,
        sessionId: input.sessionId,
        selection,
        result,
      });
      return result;
    }
    input.switchAttemptTracker?.clearSession(input.sessionId);
    input.switchCore?.clearSession(input.sessionId);
    return { status: 'session_not_found' };
  }
  const classification = input.classification;
  if (!classification) {
    return await handleConnectedServiceRuntimeAuthFailure({
      selection: null,
      classification,
      switchesThisTurn: input.switchesThisTurn,
      switchCoordinator: input.switchCoordinator ?? unavailableSwitchCoordinator,
      temporaryThrottleRecovery: input.temporaryThrottleRecovery ?? null,
    });
  }

  const { selection } = resolveConnectedServiceRuntimeAuthRecoverySelection({
    classification,
    environmentVariables: tracked.spawnOptions?.environmentVariables ?? {},
    trackedConnectedServices: tracked.spawnOptions?.connectedServices,
    sessionMetadataConnectedServices: tracked.happySessionMetadataFromLocalWebhook?.connectedServices,
  });
  if (!selection) {
    return await handleConnectedServiceRuntimeAuthFailure({
      sessionId: input.sessionId,
      selection,
      classification,
      switchesThisTurn: input.switchesThisTurn,
      switchCoordinator: input.switchCoordinator ?? unavailableSwitchCoordinator,
      temporaryThrottleRecovery: input.temporaryThrottleRecovery ?? null,
    });
  }

  // Incident 2026-06-12 (cmq8y3nlx): a scheduler replay of a persisted intent whose failing
  // profile the live session no longer runs must be SUPERSEDED before any recovery work runs
  // (no credential refresh, no switch pipeline). Replaying the pipeline burned the per-session
  // switch budget and thrashed the shared group generation on every retry even after the live
  // restart was suppressed. In-band reports (daemon_report) are fresh evidence and unaffected;
  // a session still running the failing profile (spawned active == failing) is unaffected.
  if (
    input.recoveryInvocationSource === 'scheduler_retry'
    && isGroupRuntimeRecoverySelection(selection)
    && isRuntimeFailureForInactiveProfile({ selection, classification })
  ) {
    return {
      status: 'recovery_superseded',
      reason: 'failing_profile_inactive',
      serviceId: selection.serviceId,
      groupId: selection.groupId,
      failingProfileId: normalizeNullableProfileId(classification.profileId),
      activeProfileId: normalizeNullableProfileId(selection.activeProfileId),
    };
  }

  const switchCore = input.switchCore ?? defaultSwitchCore;
  const result = await switchCore.run({
    sessionId: input.sessionId,
    reason: 'automatic_runtime_failure',
    execute: async () => {
      const refreshed = await maybeRefreshCredentialBeforeRuntimeRecovery({
        sessionId: input.sessionId,
        tracked,
        classification,
        selection,
        recoveryInvocationSource: input.recoveryInvocationSource ?? 'daemon_report',
        switchAttemptTracker: input.switchAttemptTracker ?? null,
        credentialRefreshService: input.credentialRefreshService ?? null,
        restartSession: input.restartSession ?? null,
        continueAfterRuntimeAuthSwitch: input.continueAfterRuntimeAuthSwitch ?? null,
        onRuntimeAuthRecoverySuccess: input.onRuntimeAuthRecoverySuccess ?? null,
      });
      if (refreshed) return refreshed;

      if (!isGroupRuntimeRecoverySelection(selection)) {
        if (!input.switchCoordinator) {
          return await handleConnectedServiceRuntimeAuthFailure({
            sessionId: input.sessionId,
            selection,
            classification,
            switchesThisTurn: input.switchesThisTurn,
            switchCoordinator: unavailableSwitchCoordinator,
            temporaryThrottleRecovery: input.temporaryThrottleRecovery ?? null,
          });
        }
        return await handleConnectedServiceRuntimeAuthFailure({
          sessionId: input.sessionId,
          selection,
          classification,
          switchesThisTurn: input.switchesThisTurn,
          switchCoordinator: input.switchCoordinator,
          temporaryThrottleRecovery: input.temporaryThrottleRecovery ?? null,
        });
      }
      const groupSelection = selection;

      if (!input.switchCoordinator) {
        return {
          status: 'switch_coordinator_unavailable',
          blocker: 'CLI has no connected-service auth-group load/commit API in this branch.',
        } as const;
      }

      const switchCoordinator = input.switchCoordinator;
      return await runRuntimeGroupSwitchRecovery({
        sessionId: input.sessionId,
        selection: groupSelection,
        classification,
        switchesThisTurn: input.switchesThisTurn,
        switchCoordinator,
        switchAttemptTracker: input.switchAttemptTracker ?? null,
        temporaryThrottleRecovery: input.temporaryThrottleRecovery ?? null,
      });
    },
  });
  if (result.status === 'switch_attempted' && isGroupRuntimeRecoverySelection(selection)) {
    finalizeRuntimeGroupSwitchAttempt({
      sessionId: input.sessionId,
      selection,
      result,
      switchAttemptTracker: input.switchAttemptTracker ?? null,
    });
    await notifyRuntimeGroupSwitchRecoverySuccess({
      onRuntimeAuthRecoverySuccess: input.onRuntimeAuthRecoverySuccess ?? null,
      sessionId: input.sessionId,
      selection,
      result,
    });
    if (
      !isRuntimeFailureForInactiveProfile({ selection, classification })
      && !shouldCoalescePendingProofTargetReplay({
        runtimeAuthRecovery: input.runtimeAuthRecovery ?? null,
        sessionId: input.sessionId,
        selection,
        result: result.result,
      })
    ) {
      maybeRestartAfterRuntimeGroupSwitch({
        sessionId: input.sessionId,
        tracked,
        result: result.result,
        restartSession: input.restartSession ?? null,
        onRestartFailure: input.onRuntimeAuthRestartFailure ?? null,
      });
      await maybeContinueAfterRuntimeGroupSwitch({
        tracked,
        sessionId: input.sessionId,
        selection,
        result: result.result,
        continueAfterRuntimeAuthSwitch: input.continueAfterRuntimeAuthSwitch ?? null,
      });
    }
  }
  return result;
}
