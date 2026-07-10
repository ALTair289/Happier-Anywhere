import { createHash } from 'node:crypto';

import {
  SESSION_CONTINUATION_RECOVERY_METADATA_KEY,
  SessionContinuationRecoveryV1Schema,
  type SessionContinuationRecoveryAttemptV1,
  type SessionContinuationRecoveryIdentityV1,
  type SessionContinuationReplayModeV1,
  type SessionContinuationRecoveryV1,
  type SessionContinuationResumePromptModeV1,
} from '@happier-dev/protocol';

import { buildContinuationResumePrompt } from './continuationResumePrompt';

export type ContinuationStore = Readonly<{
  read: (sessionId: string) => Promise<unknown | null> | unknown | null;
  write: (sessionId: string, state: unknown) => Promise<void> | void;
}>;

type SessionContinuationRecoveryControllerDeps = Readonly<{
  nowMs: () => number;
  providerActivityTimeoutMs?: number;
  store: ContinuationStore;
  /**
   * Account-level custom resume prompt text, consulted at send time when an
   * attempt's effective resume prompt mode is `custom`.
   */
  readCustomResumePrompt?: () => string | null | undefined;
}>;

type BeginContinuationAttemptInput = Readonly<{
  sessionId: string;
  attemptId: string;
  failureAtMs: number;
  resumePromptMode: SessionContinuationResumePromptModeV1;
  replayMode?: SessionContinuationReplayModeV1;
  recoveryIdentity?: SessionContinuationRecoveryIdentityV1;
  continuationRequired?: boolean;
}>;

type ResolveContinuationAttemptInput = BeginContinuationAttemptInput & Readonly<{
  exactProviderContextAvailable: boolean;
  hasUserMessageAfterFailure: () => Promise<boolean> | boolean;
  sendContinuationPrompt: (input: { prompt: string; localId: string }) => Promise<void> | void;
  canRetryOriginalUserMessage?: (input: { failureAtMs: number }) =>
    | Promise<'allowed' | 'blocked_provider_activity' | 'unknown'>
    | 'allowed'
    | 'blocked_provider_activity'
    | 'unknown';
  retryOriginalUserMessage?: (input: { localId: string }) => Promise<void> | void;
}>;

type ResolveContinuationAttemptResult = Readonly<{
  status:
    | 'awaiting_provider_activity'
    | 'provider_activity_observed'
    | 'provider_activity_timeout'
    | 'already_awaiting_provider_activity'
    | 'already_observed_provider_activity'
    | 'already_sent'
    | 'suppressed_no_interrupted_turn'
    | 'suppressed_newer_user_input'
    | 'retry_required'
    | 'continuity_failed';
}>;

export function isContinuationRecoveryAwaitingProviderActivityStatus(status: string): boolean {
  return status === 'awaiting_provider_activity'
    || status === 'already_awaiting_provider_activity';
}

const terminalStatuses = new Set<SessionContinuationRecoveryAttemptV1['status']>([
  'provider_activity_observed',
  'provider_activity_timeout',
  'sent',
  'suppressed_no_interrupted_turn',
  'suppressed_newer_user_input',
  'retry_required',
  'continuity_failed',
]);
const DEFAULT_PROVIDER_ACTIVITY_TIMEOUT_MS = 5 * 60_000;

function createEmptyRecovery(): SessionContinuationRecoveryV1 {
  return {
    v: 1,
    attemptsById: {},
  };
}

function cloneAttempt(attempt: SessionContinuationRecoveryAttemptV1): SessionContinuationRecoveryAttemptV1 {
  return {
    ...attempt,
    ...(attempt.recoveryIdentity ? { recoveryIdentity: { ...attempt.recoveryIdentity } } : {}),
  };
}

function cloneRecovery(recovery: SessionContinuationRecoveryV1): SessionContinuationRecoveryV1 {
  return {
    v: 1,
    attemptsById: Object.fromEntries(
      Object.entries(recovery.attemptsById).map(([attemptId, attempt]) => [
        attemptId,
        cloneAttempt(attempt),
      ]),
    ),
  };
}

function parseRecovery(value: unknown): SessionContinuationRecoveryV1 | null {
  const direct = SessionContinuationRecoveryV1Schema.safeParse(value);
  if (direct.success) return direct.data;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const nested = (value as Record<string, unknown>)[SESSION_CONTINUATION_RECOVERY_METADATA_KEY];
    const parsedNested = SessionContinuationRecoveryV1Schema.safeParse(nested);
    if (parsedNested.success) return parsedNested.data;
  }
  return null;
}

function selectNewestAttempt(
  left: SessionContinuationRecoveryAttemptV1 | undefined,
  right: SessionContinuationRecoveryAttemptV1 | undefined,
): SessionContinuationRecoveryAttemptV1 | undefined {
  if (!left) return right;
  if (!right) return left;
  return right.updatedAtMs > left.updatedAtMs ? right : left;
}

function mergeRecoveryStates(
  left: SessionContinuationRecoveryV1 | null,
  right: SessionContinuationRecoveryV1 | null,
): SessionContinuationRecoveryV1 | null {
  if (!left) return right ? cloneRecovery(right) : null;
  if (!right) return cloneRecovery(left);
  const attemptsById: SessionContinuationRecoveryV1['attemptsById'] = {};
  const attemptIds = new Set([
    ...Object.keys(left.attemptsById),
    ...Object.keys(right.attemptsById),
  ]);
  for (const attemptId of attemptIds) {
    const selected = selectNewestAttempt(left.attemptsById[attemptId], right.attemptsById[attemptId]);
    if (selected) attemptsById[attemptId] = cloneAttempt(selected);
  }
  return { v: 1, attemptsById };
}

export function createSessionContinuationRecoveryOverlayStore(params: Readonly<{
  durableStore: ContinuationStore;
}>): ContinuationStore {
  const cache = new Map<string, SessionContinuationRecoveryV1>();
  return {
    async read(sessionId) {
      const durable = parseRecovery(await params.durableStore.read(sessionId));
      const cached = cache.get(sessionId) ?? null;
      return mergeRecoveryStates(durable, cached) ?? null;
    },
    async write(sessionId, state) {
      await params.durableStore.write(sessionId, state);
      const parsed = parseRecovery(state);
      if (parsed) {
        cache.set(sessionId, cloneRecovery(parsed));
      } else {
        cache.delete(sessionId);
      }
    },
  };
}

async function readRecovery(store: ContinuationStore, sessionId: string): Promise<SessionContinuationRecoveryV1> {
  const stored = await store.read(sessionId);
  const parsed = parseRecovery(stored);
  if (parsed) return parsed;
  return createEmptyRecovery();
}

async function writeRecovery(
  store: ContinuationStore,
  sessionId: string,
  recovery: SessionContinuationRecoveryV1,
): Promise<void> {
  await store.write(sessionId, recovery);
}

function buildAttempt(
  input: BeginContinuationAttemptInput,
  status: SessionContinuationRecoveryAttemptV1['status'],
  updatedAtMs: number,
  extra?: Readonly<Pick<SessionContinuationRecoveryAttemptV1, 'sentAtMs' | 'errorCode'>>,
): SessionContinuationRecoveryAttemptV1 {
  return {
    v: 1,
    attemptId: input.attemptId,
    status,
    failureAtMs: input.failureAtMs,
    updatedAtMs,
    resumePromptMode: input.resumePromptMode,
    ...(input.replayMode === undefined ? {} : { replayMode: input.replayMode }),
    ...(input.recoveryIdentity === undefined ? {} : { recoveryIdentity: input.recoveryIdentity }),
    ...(input.continuationRequired === undefined ? {} : { continuationRequired: input.continuationRequired }),
    ...(extra?.sentAtMs === undefined ? {} : { sentAtMs: extra.sentAtMs }),
    ...(extra?.errorCode === undefined ? {} : { errorCode: extra.errorCode }),
  };
}

function resolveTerminalStatus(
  status: SessionContinuationRecoveryAttemptV1['status'],
): ResolveContinuationAttemptResult | null {
  if (status === 'sent') return { status: 'already_sent' };
  if (status === 'provider_activity_observed') return { status: 'already_observed_provider_activity' };
  if (status === 'provider_activity_timeout') return { status };
  if (status === 'suppressed_no_interrupted_turn') return { status };
  if (status === 'suppressed_newer_user_input') return { status };
  if (status === 'retry_required') return { status };
  if (status === 'continuity_failed') return { status };
  return null;
}

function resolveProviderActivityTimeoutMs(deps: SessionContinuationRecoveryControllerDeps): number {
  const configured = deps.providerActivityTimeoutMs;
  if (typeof configured !== 'number' || !Number.isFinite(configured)) {
    return DEFAULT_PROVIDER_ACTIVITY_TIMEOUT_MS;
  }
  return Math.max(1_000, Math.trunc(configured));
}

function isProviderActivityWaitExpired(input: Readonly<{
  attempt: SessionContinuationRecoveryAttemptV1;
  nowMs: number;
  timeoutMs: number;
}>): boolean {
  if (input.attempt.status !== 'awaiting_provider_activity') return false;
  if (input.attempt.sentAtMs === undefined) return false;
  return input.nowMs - input.attempt.sentAtMs >= input.timeoutMs;
}

function resolveContinuationRequired(input: Readonly<{
  existing?: SessionContinuationRecoveryAttemptV1 | null;
  fallback?: boolean;
}>): boolean {
  if (input.existing?.continuationRequired === false) return false;
  if (input.existing?.continuationRequired === true) return true;
  return input.fallback !== false;
}

function buildContinuationPromptLocalId(input: Readonly<{
  sessionId: string;
  attemptId: string;
}>): string {
  const digest = createHash('sha256')
    .update(input.sessionId)
    .update('\0')
    .update(input.attemptId)
    .digest('hex')
    .slice(0, 32);
  return `connected-service-continuation:${digest}`;
}

function buildOriginalUserMessageRetryLocalId(input: Readonly<{
  sessionId: string;
  attemptId: string;
}>): string {
  const digest = createHash('sha256')
    .update(input.sessionId)
    .update('\0')
    .update(input.attemptId)
    .digest('hex')
    .slice(0, 32);
  return `connected-service-original-retry:${digest}`;
}

function isSameRecoveryIdentity(
  left: SessionContinuationRecoveryIdentityV1 | undefined,
  right: SessionContinuationRecoveryIdentityV1 | undefined,
): boolean {
  if (!left || !right) return false;
  if (left.serviceId !== right.serviceId) return false;
  if (left.selectionKind !== right.selectionKind) return false;
  if (right.groupId !== undefined && (left.groupId ?? null) !== right.groupId) return false;
  if (right.profileId !== undefined && (left.profileId ?? null) !== right.profileId) return false;
  if (right.failureFingerprint !== undefined && (left.failureFingerprint ?? null) !== right.failureFingerprint) return false;
  if (right.targetGeneration !== undefined && (left.targetGeneration ?? null) !== right.targetGeneration) return false;
  return true;
}

function shouldRecordProviderActivityForAttempt(input: Readonly<{
  attempt: SessionContinuationRecoveryAttemptV1;
  activityAtMs: number;
  recoveryIdentity?: SessionContinuationRecoveryIdentityV1;
}>): boolean {
  if (input.attempt.status !== 'awaiting_provider_activity') return false;
  if (input.attempt.sentAtMs !== undefined && input.activityAtMs < input.attempt.sentAtMs) {
    return false;
  }
  if (!input.recoveryIdentity) return !input.attempt.recoveryIdentity;
  return isSameRecoveryIdentity(input.attempt.recoveryIdentity, input.recoveryIdentity);
}

/**
 * Per-session read-modify-write serializer. Every recovery transition for a given session runs to
 * completion (fresh read → mutate → durable write) before the next transition for that session
 * begins, so no transition can observe a stale whole-map snapshot and clobber another's write.
 * Distinct sessions never block each other. Settled per-session chains are evicted so the map does
 * not grow without bound over a long-lived daemon.
 */
function createSessionMutationSerializer() {
  const tails = new Map<string, Promise<void>>();
  return function serialize<T>(sessionId: string, task: () => Promise<T>): Promise<T> {
    const prior = tails.get(sessionId) ?? Promise.resolve();
    const run = prior.then(task, task);
    const settled = run.then(() => undefined, () => undefined);
    tails.set(sessionId, settled);
    void settled.then(() => {
      if (tails.get(sessionId) === settled) tails.delete(sessionId);
    });
    return run;
  };
}

function activeSendKey(sessionId: string, attemptId: string): string {
  return `${sessionId} ${attemptId}`;
}

type ResolveClaim =
  | { kind: 'return'; value: ResolveContinuationAttemptResult }
  | {
      kind: 'send';
      attemptInput: BeginContinuationAttemptInput;
      replayMode: SessionContinuationReplayModeV1;
    };

export function createSessionContinuationRecoveryController(
  deps: SessionContinuationRecoveryControllerDeps,
) {
  const providerActivityTimeoutMs = resolveProviderActivityTimeoutMs(deps);
  const serialize = createSessionMutationSerializer();
  // In-process ownership of sends that are between their atomic `sending` claim and finalize.
  // Distinguishes "another owner in THIS process is mid-send for this exact attempt" (observe the
  // claim, never re-send) from "a persisted `sending` row with no live owner" (a prior daemon
  // claimed then died before recording the send — re-drive it with the same deterministic handoff
  // id). Cross-process/cross-controller de-duplication remains anchored by the deterministic
  // handoff localId at the transport.
  const activeSends = new Set<string>();

  /**
   * The single mutation owner. Runs `mutator` inside the per-session serializer against a freshly
   * read recovery map, and persists it only when the mutator returns a next state.
   */
  function mutateRecovery<T>(
    sessionId: string,
    mutator: (recovery: SessionContinuationRecoveryV1) =>
      | { recovery?: SessionContinuationRecoveryV1; result: T }
      | Promise<{ recovery?: SessionContinuationRecoveryV1; result: T }>,
  ): Promise<T> {
    return serialize(sessionId, async () => {
      const recovery = await readRecovery(deps.store, sessionId);
      const outcome = await mutator(recovery);
      if (outcome.recovery) {
        await writeRecovery(deps.store, sessionId, outcome.recovery);
      }
      return outcome.result;
    });
  }

  function attemptInputFromExisting(
    sessionId: string,
    attempt: SessionContinuationRecoveryAttemptV1,
  ): BeginContinuationAttemptInput {
    return {
      sessionId,
      attemptId: attempt.attemptId,
      failureAtMs: attempt.failureAtMs,
      resumePromptMode: attempt.resumePromptMode,
      replayMode: attempt.replayMode,
      recoveryIdentity: attempt.recoveryIdentity,
      continuationRequired: attempt.continuationRequired,
    };
  }

  async function resolveAttempt(input: ResolveContinuationAttemptInput): Promise<ResolveContinuationAttemptResult> {
    const key = activeSendKey(input.sessionId, input.attemptId);

    // Phase A — atomic claim. All precondition checks and the pending→sending transition happen in
    // one critical section against a fresh read, so two concurrent resolvers cannot both claim.
    const claim = await mutateRecovery<ResolveClaim>(input.sessionId, async (recovery) => {
      const existing = recovery.attemptsById[input.attemptId];
      const terminalResult = existing ? resolveTerminalStatus(existing.status) : null;
      if (terminalResult) return { result: { kind: 'return', value: terminalResult } };

      if (existing?.status === 'sending') {
        if (existing.sentAtMs !== undefined) {
          recovery.attemptsById[input.attemptId] = buildAttempt(
            { ...input, continuationRequired: resolveContinuationRequired({ existing, fallback: input.continuationRequired }) },
            'awaiting_provider_activity',
            deps.nowMs(),
            { sentAtMs: existing.sentAtMs },
          );
          return { recovery, result: { kind: 'return', value: { status: 'already_awaiting_provider_activity' } } };
        }
        if (activeSends.has(key)) {
          // Another in-process owner is mid-send for this exact attempt: observe its claim and do
          // not re-send. If that owner dies, the stuck-expiry backstop rescues the row.
          return { result: { kind: 'return', value: { status: 'already_awaiting_provider_activity' } } };
        }
        // Persisted `sending` with no send evidence and no live owner (prior daemon claimed then
        // died). Fall through to re-drive the send with the same deterministic handoff id.
      }

      if (existing?.status === 'awaiting_provider_activity') {
        if (isProviderActivityWaitExpired({ attempt: existing, nowMs: deps.nowMs(), timeoutMs: providerActivityTimeoutMs })) {
          recovery.attemptsById[input.attemptId] = buildAttempt(
            attemptInputFromExisting(input.sessionId, existing),
            'provider_activity_timeout',
            deps.nowMs(),
            {
              ...(existing.sentAtMs === undefined ? {} : { sentAtMs: existing.sentAtMs }),
              errorCode: 'provider_activity_timeout',
            },
          );
          return { recovery, result: { kind: 'return', value: { status: 'provider_activity_timeout' } } };
        }
        return { result: { kind: 'return', value: { status: 'already_awaiting_provider_activity' } } };
      }

      const continuationRequired = resolveContinuationRequired({
        existing,
        fallback: input.continuationRequired,
      });
      const attemptInput: BeginContinuationAttemptInput = { ...input, continuationRequired };
      const replayMode = attemptInput.replayMode ?? 'continuation_prompt';

      if (!continuationRequired || replayMode === 'suppress') {
        recovery.attemptsById[input.attemptId] = buildAttempt(attemptInput, 'suppressed_no_interrupted_turn', deps.nowMs());
        return { recovery, result: { kind: 'return', value: { status: 'suppressed_no_interrupted_turn' } } };
      }
      if (input.resumePromptMode === 'off') {
        recovery.attemptsById[input.attemptId] = buildAttempt(attemptInput, 'retry_required', deps.nowMs(), { errorCode: 'resume_prompt_disabled' });
        return { recovery, result: { kind: 'return', value: { status: 'retry_required' } } };
      }
      if (!input.exactProviderContextAvailable && replayMode === 'continuation_prompt') {
        recovery.attemptsById[input.attemptId] = buildAttempt(attemptInput, 'retry_required', deps.nowMs(), { errorCode: 'provider_context_unavailable' });
        return { recovery, result: { kind: 'return', value: { status: 'retry_required' } } };
      }
      if (await input.hasUserMessageAfterFailure()) {
        recovery.attemptsById[input.attemptId] = buildAttempt(attemptInput, 'suppressed_newer_user_input', deps.nowMs());
        return { recovery, result: { kind: 'return', value: { status: 'suppressed_newer_user_input' } } };
      }

      if (replayMode === 'retry_original_user_message') {
        if (!input.retryOriginalUserMessage) {
          recovery.attemptsById[input.attemptId] = buildAttempt(attemptInput, 'retry_required', deps.nowMs(), { errorCode: 'original_user_message_retry_unavailable' });
          return { recovery, result: { kind: 'return', value: { status: 'retry_required' } } };
        }
        const retrySafety = input.canRetryOriginalUserMessage
          ? await input.canRetryOriginalUserMessage({ failureAtMs: input.failureAtMs })
          : 'unknown';
        if (retrySafety !== 'allowed') {
          recovery.attemptsById[input.attemptId] = buildAttempt(attemptInput, 'retry_required', deps.nowMs(), {
            errorCode: retrySafety === 'blocked_provider_activity'
              ? 'original_user_message_retry_provider_activity_detected'
              : 'original_user_message_retry_evidence_unavailable',
          });
          return { recovery, result: { kind: 'return', value: { status: 'retry_required' } } };
        }
      }

      // Claim: transition to `sending` and register in-process ownership before releasing the lock,
      // so a concurrent resolver observes the claim rather than re-sending.
      recovery.attemptsById[input.attemptId] = buildAttempt(attemptInput, 'sending', deps.nowMs());
      activeSends.add(key);
      return { recovery, result: { kind: 'send', attemptInput, replayMode } };
    });

    if (claim.kind === 'return') return claim.value;

    // Phase B — side effect (outside the lock). Phase C — guarded finalize: a concurrent transition
    // (suppression, expiry, observed activity) that already advanced the attempt wins; the finalize
    // must never regress a newer terminal state back to `awaiting_provider_activity`.
    const { attemptInput, replayMode } = claim;
    try {
      try {
        if (replayMode === 'retry_original_user_message') {
          await input.retryOriginalUserMessage!({
            localId: buildOriginalUserMessageRetryLocalId(input),
          });
        } else {
          await input.sendContinuationPrompt({
            prompt: buildContinuationResumePrompt({
              resumePromptMode: input.resumePromptMode,
              customResumePrompt: deps.readCustomResumePrompt?.() ?? null,
            }),
            localId: buildContinuationPromptLocalId(input),
          });
        }
      } catch {
        return {
          status: await mutateRecovery<ResolveContinuationAttemptResult['status']>(input.sessionId, (recovery) => {
            const current = recovery.attemptsById[input.attemptId];
            if (current?.status === 'sending') {
              recovery.attemptsById[input.attemptId] = buildAttempt(attemptInput, 'retry_required', deps.nowMs(), { errorCode: 'continuation_prompt_failed' });
              return { recovery, result: 'retry_required' as const };
            }
            const terminal = current ? resolveTerminalStatus(current.status) : null;
            return { result: terminal ? terminal.status : 'retry_required' };
          }),
        };
      }

      const sentAtMs = deps.nowMs();
      return {
        status: await mutateRecovery<ResolveContinuationAttemptResult['status']>(input.sessionId, (recovery) => {
          const current = recovery.attemptsById[input.attemptId];
          if (current?.status === 'sending') {
            recovery.attemptsById[input.attemptId] = buildAttempt(attemptInput, 'awaiting_provider_activity', deps.nowMs(), { sentAtMs });
            return { recovery, result: 'awaiting_provider_activity' as const };
          }
          const terminal = current ? resolveTerminalStatus(current.status) : null;
          return { result: terminal ? terminal.status : 'already_awaiting_provider_activity' };
        }),
      };
    } finally {
      activeSends.delete(key);
    }
  }

  return {
    async beginAttempt(input: BeginContinuationAttemptInput): Promise<SessionContinuationRecoveryV1> {
      return mutateRecovery(input.sessionId, (recovery) => {
        const existing = recovery.attemptsById[input.attemptId];
        if (existing && terminalStatuses.has(existing.status)) return { result: recovery };
        recovery.attemptsById[input.attemptId] = buildAttempt(
          input,
          'pending_provider_context',
          deps.nowMs(),
        );
        return { recovery, result: recovery };
      });
    },

    resolveAttempt,

    async recordProviderActivity(input: Readonly<{
      sessionId: string;
      recoveryIdentity?: SessionContinuationRecoveryIdentityV1;
      activityAtMs?: number;
    }>): Promise<{ observed: number }> {
      return mutateRecovery(input.sessionId, (recovery) => {
        let observed = 0;
        const activityAtMs = input.activityAtMs ?? deps.nowMs();
        for (const attempt of Object.values(recovery.attemptsById)) {
          if (!shouldRecordProviderActivityForAttempt({
            attempt,
            activityAtMs,
            recoveryIdentity: input.recoveryIdentity,
          })) continue;
          recovery.attemptsById[attempt.attemptId] = buildAttempt(
            attemptInputFromExisting(input.sessionId, attempt),
            'provider_activity_observed',
            deps.nowMs(),
            attempt.sentAtMs === undefined ? undefined : { sentAtMs: attempt.sentAtMs },
          );
          observed += 1;
        }
        return { recovery: observed > 0 ? recovery : undefined, result: { observed } };
      });
    },

    async expireProviderActivityWaits(input: Readonly<{
      sessionId: string;
    }>): Promise<{ expired: number }> {
      return mutateRecovery(input.sessionId, (recovery) => {
        let expired = 0;
        const nowMs = deps.nowMs();
        for (const attempt of Object.values(recovery.attemptsById)) {
          if (!isProviderActivityWaitExpired({ attempt, nowMs, timeoutMs: providerActivityTimeoutMs })) continue;
          recovery.attemptsById[attempt.attemptId] = buildAttempt(
            attemptInputFromExisting(input.sessionId, attempt),
            'provider_activity_timeout',
            nowMs,
            {
              ...(attempt.sentAtMs === undefined ? {} : { sentAtMs: attempt.sentAtMs }),
              errorCode: 'provider_activity_timeout',
            },
          );
          expired += 1;
        }
        return { recovery: expired > 0 ? recovery : undefined, result: { expired } };
      });
    },

    /**
     * Q3 liveness backstop. An `awaiting_provider_activity` attempt is bounded by
     * `expireProviderActivityWaits`, but a continuation blocked BEFORE it ever reached the provider
     * — the runtime was disposed while the attempt was still `pending_provider_context`/`sending`
     * (`runtime_disposed_before_delivery`) — has no terminal transition and blocks the pending drain
     * forever ("waiting for provider confirmation"). Past a bound, request exactly ONE relaunch via
     * the injected restart machinery (best-effort) and then terminalize the attempt with a typed,
     * actionable error so the drain unblocks. Never indefinite silence.
     *
     * The terminalization is committed atomically through the same per-session mutation owner (so a
     * concurrent begin/resolve cannot be erased); the relaunch side effect runs afterwards, outside
     * the lock, exactly once per attempt this sweep terminalized.
     */
    async expireStuckRecoveryAttempts(input: Readonly<{
      sessionId: string;
      stuckAfterMs?: number;
      requestRelaunch?: (input: { attemptId: string; failureAtMs: number }) =>
        | Promise<'requested' | 'unavailable'>
        | 'requested'
        | 'unavailable';
    }>): Promise<{ relaunchRequested: number; failed: number }> {
      const stuckAfterMs = typeof input.stuckAfterMs === 'number' && Number.isFinite(input.stuckAfterMs)
        ? Math.max(1_000, Math.trunc(input.stuckAfterMs))
        : providerActivityTimeoutMs;

      const terminalized = await mutateRecovery<Array<{ attemptId: string; failureAtMs: number }>>(input.sessionId, (recovery) => {
        const nowMs = deps.nowMs();
        const collected: Array<{ attemptId: string; failureAtMs: number }> = [];
        for (const attempt of Object.values(recovery.attemptsById)) {
          if (attempt.status !== 'pending_provider_context' && attempt.status !== 'sending') continue;
          if (nowMs - attempt.updatedAtMs < stuckAfterMs) continue;
          recovery.attemptsById[attempt.attemptId] = buildAttempt(
            attemptInputFromExisting(input.sessionId, attempt),
            'continuity_failed',
            nowMs,
            {
              ...(attempt.sentAtMs === undefined ? {} : { sentAtMs: attempt.sentAtMs }),
              errorCode: 'runtime_disposed_before_delivery',
            },
          );
          collected.push({ attemptId: attempt.attemptId, failureAtMs: attempt.failureAtMs });
        }
        return { recovery: collected.length > 0 ? recovery : undefined, result: collected };
      });

      let relaunchRequested = 0;
      if (input.requestRelaunch) {
        for (const attempt of terminalized) {
          try {
            const outcome = await input.requestRelaunch({
              attemptId: attempt.attemptId,
              failureAtMs: attempt.failureAtMs,
            });
            if (outcome === 'requested') relaunchRequested += 1;
          } catch {
            // A relaunch-request failure must not leave the attempt blocking; the attempt is already
            // terminalized above, so the drain is guaranteed to unblock.
          }
        }
      }
      return { relaunchRequested, failed: terminalized.length };
    },

    async suppressPendingAttempts(input: Readonly<{
      sessionId: string;
    }>): Promise<{ suppressed: number }> {
      return mutateRecovery(input.sessionId, (recovery) => {
        let suppressed = 0;
        for (const attempt of Object.values(recovery.attemptsById)) {
          if (terminalStatuses.has(attempt.status)) continue;
          recovery.attemptsById[attempt.attemptId] = buildAttempt(
            attemptInputFromExisting(input.sessionId, attempt),
            'suppressed_newer_user_input',
            deps.nowMs(),
            attempt.sentAtMs === undefined ? undefined : { sentAtMs: attempt.sentAtMs },
          );
          suppressed += 1;
        }
        return { recovery: suppressed > 0 ? recovery : undefined, result: { suppressed } };
      });
    },

    async resolvePendingAttempts(input: Readonly<{
      sessionId: string;
      exactProviderContextAvailable: boolean;
      hasUserMessageAfterFailure: (input: { failureAtMs: number }) => Promise<boolean> | boolean;
      sendContinuationPrompt: (input: { prompt: string; localId: string }) => Promise<void> | void;
      canRetryOriginalUserMessage?: (input: { attemptId: string; failureAtMs: number }) =>
        | Promise<'allowed' | 'blocked_provider_activity' | 'unknown'>
        | 'allowed'
        | 'blocked_provider_activity'
        | 'unknown';
      retryOriginalUserMessage?: (input: { attemptId: string; localId: string; failureAtMs: number }) => Promise<void> | void;
    }>): Promise<{ resolved: Array<{ attemptId: string; status: ResolveContinuationAttemptResult['status'] }> }> {
      const recovery = await readRecovery(deps.store, input.sessionId);
      const unresolvedAttempts = Object.values(recovery.attemptsById)
        .filter((attempt) => !terminalStatuses.has(attempt.status));
      const resolved: Array<{ attemptId: string; status: ResolveContinuationAttemptResult['status'] }> = [];
      for (const attempt of unresolvedAttempts) {
        const result = await resolveAttempt({
          sessionId: input.sessionId,
          attemptId: attempt.attemptId,
          failureAtMs: attempt.failureAtMs,
          resumePromptMode: attempt.resumePromptMode,
          replayMode: attempt.replayMode,
          recoveryIdentity: attempt.recoveryIdentity,
          continuationRequired: attempt.continuationRequired,
          exactProviderContextAvailable: input.exactProviderContextAvailable,
          hasUserMessageAfterFailure: () =>
            input.hasUserMessageAfterFailure({ failureAtMs: attempt.failureAtMs }),
          sendContinuationPrompt: input.sendContinuationPrompt,
          canRetryOriginalUserMessage: input.canRetryOriginalUserMessage
            ? () => input.canRetryOriginalUserMessage?.({
                attemptId: attempt.attemptId,
                failureAtMs: attempt.failureAtMs,
              }) ?? 'unknown'
            : undefined,
          retryOriginalUserMessage: input.retryOriginalUserMessage
            ? ({ localId }) => input.retryOriginalUserMessage?.({
                attemptId: attempt.attemptId,
                localId,
                failureAtMs: attempt.failureAtMs,
              })
            : undefined,
        });
        resolved.push({ attemptId: attempt.attemptId, status: result.status });
      }
      return { resolved };
    },
  };
}
