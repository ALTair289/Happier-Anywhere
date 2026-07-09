import { resolveTerminalInjectionReadiness } from '@/agent/runtime/terminal/injection/arbiter';
import { resolveTerminalPromptProviderAcceptanceTimeoutMs } from '@/agent/runtime/terminal/injection/promptWriteTimeout';
import type { TerminalInputInjectionResult, TerminalLifecycleObservation, TerminalTurnState } from '@/agent/runtime/terminal/_types';
import { isNonSteerablePromptPayload, parseSpecialCommand } from '@/cli/parsers/specialCommands';

import type {
  ClaudeUnifiedInFlightSteerEvaluator,
  ClaudeUnifiedInputArbiter,
  ClaudeUnifiedInputArbiterSnapshot,
  ClaudeUnifiedDeliveryBlocker,
  ClaudeUnifiedPromptAcceptance,
  ClaudeUnifiedPromptAcceptedHandler,
  ClaudeUnifiedPromptBatch,
  ClaudeUnifiedPromptInjectedHandler,
  ClaudeUnifiedPromptInjectionFailure,
  ClaudeUnifiedPromptInjectionFailureHandling,
  ClaudeUnifiedPromptInjectionFailureHandler,
  ClaudeUnifiedPromptInjector,
} from './_types';
import { classifyClaudeUnifiedInjectionFailure } from './injectionFailurePolicy';
import { normalizeClaudeUnifiedPromptIdentityText } from './promptIdentity';

type HeadInputState = ClaudeUnifiedInputArbiterSnapshot['headInputState'];
type PendingProviderAcceptance<Mode> = Readonly<{
  batch: ClaudeUnifiedPromptBatch<Mode>;
  acceptance: ClaudeUnifiedPromptAcceptance;
}>;

const DEFAULT_INJECTION_RETRY_LIMIT = 3;
const DEFAULT_INJECTION_RETRY_BASE_DELAY_MS = 250;
const DEFAULT_PROVIDER_ACCEPTANCE_TIMEOUT_MS = 5_000;
// A pending-queue prompt deferred while the turn is running is normally redrained
// by the turn-end lifecycle hook. This bounded fallback wake re-evaluates the
// deferral even if that hook never arrives, so the prompt cannot starve forever.
// It re-defers (no mid-turn injection) while the turn is still running.
const DEFAULT_BUSY_TURN_FALLBACK_WAKE_MS = 15_000;
// A 'running' turn state can be STALE: after a respawn, replayed transcript rows mark the
// turn running but no live provider turn exists, so turn-end evidence never arrives and a
// deferred ui_pending prompt starves forever (incident cmq7pyqkj, L1). When NO provider
// lifecycle activity is observed for this bounded window, the turn is treated as not
// running and the prompt drains normally as a new turn (never as an in-flight steer).
const DEFAULT_STALE_TURN_RECOVERY_MS = 30_000;

function normalizePromptText(value: string): string {
  return normalizeClaudeUnifiedPromptIdentityText(value);
}

function isCompactPrompt(batch: Readonly<{ message: string }>): boolean {
  return parseSpecialCommand(normalizePromptText(batch.message)).type === 'compact';
}

function isNonSteerablePrompt(batch: Readonly<{ message: string }>): boolean {
  return isNonSteerablePromptPayload(normalizePromptText(batch.message));
}

function isDeterministicPreProviderInputRejection(
  failure: Extract<TerminalInputInjectionResult, { status: 'failed' }>,
): boolean {
  return failure.reason === 'invalid_prompt_text'
    && failure.phase === 'before_write'
    && failure.duplicateRisk === 'none'
    && failure.recoverable === false;
}

export function createClaudeUnifiedInputArbiter<Mode = unknown>(opts: Readonly<{
  injectPrompt: ClaudeUnifiedPromptInjector<Mode>['injectPrompt'];
  onPromptInjected?: ClaudeUnifiedPromptInjectedHandler<Mode> | undefined;
  onPromptAccepted?: ClaudeUnifiedPromptAcceptedHandler<Mode> | undefined;
  nowMs?: (() => number) | undefined;
  quietPeriodMs?: number | undefined;
  maxWaitMs?: number | undefined;
  injectionRetryLimit?: number | undefined;
  injectionRetryBaseDelayMs?: number | undefined;
  providerAcceptanceTimeoutMs?: number | undefined;
  busyTurnFallbackWakeMs?: number | undefined;
  /**
   * Bounded no-provider-activity window after which a 'running' turn is treated as stale and a
   * deferred `ui_pending` prompt drains normally (L1). Screen evidence (`turnLikelyEnded`) is
   * additionally required whenever an in-flight steer evaluation was possible for the prompt.
   */
  staleTurnRecoveryMs?: number | undefined;
  /**
   * Canonical session turn lifecycle probe (Lane N2). The canonical lifecycle (the session
   * client's turn owner) is a stronger truth source than a one-frame screen parse: when it
   * reports NO active turn during stale-turn recovery, the prompt drains without requiring
   * turn-end screen evidence. Absent probe keeps the fail-closed screen-evidence requirement.
   */
  isCanonicalTurnActive?: (() => boolean) | undefined;
  onInjectionFailure?: ClaudeUnifiedPromptInjectionFailureHandler<Mode> | undefined;
  /**
   * Undeliverable-batch handback (F-1 / A3-MED-1): fired with every batch the arbiter can no
   * longer deliver — all still-queued batches on dispose (including a `failed_terminal` head
   * that would otherwise be dropped by the park/relaunch unwind) and any batch enqueued after
   * dispose. Batches are handed back in FIFO order so the owner can re-pend them to its queue
   * instead of silently losing user input. Mirrors the pump-level `onUndeliverableBatch` seam,
   * which only covers the pulled-but-not-yet-enqueued window.
   */
  onUndeliverableBatches?: ((batches: ReadonlyArray<ClaudeUnifiedPromptBatch<Mode>>) => void) | undefined;
  /**
   * Screen-evidence evaluation for steering a pending UI prompt into a RUNNING turn (D19). When
   * absent or vetoing, the prompt keeps the existing bounded defer-until-idle behavior.
   */
  evaluateInFlightSteer?: ClaudeUnifiedInFlightSteerEvaluator<Mode> | undefined;
  /**
   * Fired once per steered prompt when turn-end evidence arms its provider-acceptance expectation
   * (the queued prompt's UserPromptSubmit/JSONL row arrives only after the steered turn ends).
   */
  onSteerAcceptanceArmed?: ((batch: ClaudeUnifiedPromptBatch<Mode>) => void) | undefined;
  /**
   * Canonical delivery-state probe. The arbiter owns Claude's terminal retry loop, but the
   * session client owns provider-acceptance truth; consult it before replaying an ambiguous
   * head so a provider-confirmed prompt cannot be injected a second time.
   */
  isPromptDeliveryAccepted?: ((batch: ClaudeUnifiedPromptBatch<Mode>) => boolean) | undefined;
}>): ClaudeUnifiedInputArbiter<Mode> {
  const queue: Array<ClaudeUnifiedPromptBatch<Mode>> = [];
  const nowMs = opts.nowMs ?? Date.now;
  const injectionRetryLimit = Math.max(0, Math.trunc(opts.injectionRetryLimit ?? DEFAULT_INJECTION_RETRY_LIMIT));
  const injectionRetryBaseDelayMs = Math.max(0, Math.trunc(opts.injectionRetryBaseDelayMs ?? DEFAULT_INJECTION_RETRY_BASE_DELAY_MS));
  const providerAcceptanceTimeoutMs = Math.max(0, Math.trunc(opts.providerAcceptanceTimeoutMs ?? DEFAULT_PROVIDER_ACCEPTANCE_TIMEOUT_MS));
  const busyTurnFallbackWakeMs = Math.max(0, Math.trunc(opts.busyTurnFallbackWakeMs ?? DEFAULT_BUSY_TURN_FALLBACK_WAKE_MS));
  const staleTurnRecoveryMs = Math.max(0, Math.trunc(opts.staleTurnRecoveryMs ?? DEFAULT_STALE_TURN_RECOVERY_MS));

  let disposed = false;
  let turnState: TerminalTurnState = 'idle';
  let permissionBlocked = false;
  let userTyping = false;
  let userTypingObservedAtMs: number | null = null;
  let firstObservedAtMs = nowMs();
  let outputObserved = false;
  let lastOutputAtMs: number | null = null;
  let compactionActive = false;
  let lastDeferredReason: string | null = null;
  let lastFailureReason: string | null = null;
  let currentHeadBlocker: ClaudeUnifiedDeliveryBlocker | null = null;
  let headInputState: HeadInputState = null;
  let draining: Promise<void> | null = null;
  let retryDrainTimer: ReturnType<typeof setTimeout> | null = null;
  let providerAcceptanceTimer: ReturnType<typeof setTimeout> | null = null;
  let providerAcceptanceTimeoutContext: Readonly<{
    timeoutMs: number;
    result: Extract<TerminalInputInjectionResult, { status: 'failed' }>;
  }> | null = null;
  let providerAcceptanceCompactionGraceUsed = false;
  let retryAttempt = 0;
  let pendingProviderAcceptance: PendingProviderAcceptance<Mode> | null = null;
  let injectingProviderAcceptance: PendingProviderAcceptance<Mode> | null = null;
  let providerAcceptanceObservedDuringInjection: PendingProviderAcceptance<Mode> | null = null;
  let pendingAcceptanceCompletedCompaction = false;
  let providerOutputObservedSincePendingAcceptance = false;
  let ambiguousProviderAcceptanceFailure: PendingProviderAcceptance<Mode> | null = null;
  const providerAcceptanceUnknownTerminalBatches = new Set<ClaudeUnifiedPromptBatch<Mode>>();
  let ambiguousProviderAcceptanceRetryAttempt = 0;
  let lastInjectedNotifiedBatch: ClaudeUnifiedPromptBatch<Mode> | null = null;
  // An in-flight steer's provider acceptance (UserPromptSubmit/JSONL row) arrives only when Claude
  // submits the queued prompt at TURN END. While this flag is set, the short provider-acceptance
  // timeout is deferred; turn-end evidence arms it (and the normal ambiguous recovery thereafter).
  let steerAcceptanceAwaitingTurnEnd = false;
  let steerAcceptanceTimeoutResult: Extract<TerminalInputInjectionResult, { status: 'failed' }> | null = null;
  let steerTurnEndFallbackTimer: ReturnType<typeof setTimeout> | null = null;
  const providerAcceptanceByBatch = new Map<ClaudeUnifiedPromptBatch<Mode>, ClaudeUnifiedPromptAcceptance>();

  const providerAcceptancePendingCount = (): number =>
    (pendingProviderAcceptance ? 1 : 0) +
    (ambiguousProviderAcceptanceFailure ? 1 : 0);

  const pendingInjectionCount = (): number =>
    queue.reduce((count, batch) => {
      if (pendingProviderAcceptance?.batch === batch) return count;
      if (ambiguousProviderAcceptanceFailure?.batch === batch) return count;
      if (providerAcceptanceUnknownTerminalBatches.has(batch)) return count;
      return count + 1;
    }, 0);

  const snapshot = (): ClaudeUnifiedInputArbiterSnapshot => ({
    queuedCount: queue.length,
    pendingInjectionCount: pendingInjectionCount(),
    terminalCustodyCount: 0,
    providerAcceptancePendingCount: providerAcceptancePendingCount(),
    disposed,
    turnState,
    permissionBlocked,
    userTyping,
    lastDeferredReason,
    lastFailureReason,
    currentHeadBlocker,
    headInputState,
  });

  const observeLifecycle = (observation: TerminalLifecycleObservation): void => {
    const observedAtMs = observation.observedAtMs ?? nowMs();
    if (observation.type === 'turn_state') {
      turnState = observation.state;
      if (observation.state === 'running' || observation.state === 'finalizing') {
        outputObserved = true;
        lastOutputAtMs = observedAtMs;
        if (pendingProviderAcceptance) {
          providerOutputObservedSincePendingAcceptance = true;
        }
      }
      if (observation.state === 'blocked_on_permission') {
        permissionBlocked = true;
      } else if (observation.state === 'idle') {
        permissionBlocked = false;
        // Turn-end evidence: a steered prompt queued by Claude's TUI is submitted now, so its
        // provider-acceptance expectation can finally be armed.
        armSteerAcceptanceAfterTurnEnd();
      }
      return;
    }
    if (observation.type === 'permission') {
      permissionBlocked = observation.blocked;
      return;
    }
    if (observation.type === 'compaction') {
      compactionActive = observation.phase === 'started';
      if (pendingProviderAcceptance) {
        pendingAcceptanceCompletedCompaction = observation.phase === 'completed';
        if (observation.phase === 'started') {
          clearProviderAcceptanceTimer();
          if (providerAcceptanceTimeoutContext) {
            armProviderAcceptanceTimeout(
              providerAcceptanceTimeoutContext.timeoutMs,
              providerAcceptanceTimeoutContext.result,
            );
          }
        } else {
          clearProviderAcceptanceTimer();
        }
      } else if (
        observation.phase === 'completed'
        && ambiguousProviderAcceptanceFailure
        && queue[0] === ambiguousProviderAcceptanceFailure.batch
      ) {
        pendingProviderAcceptance = ambiguousProviderAcceptanceFailure;
        providerOutputObservedSincePendingAcceptance = false;
        pendingAcceptanceCompletedCompaction = true;
        ambiguousProviderAcceptanceFailure = null;
        ambiguousProviderAcceptanceRetryAttempt = 0;
        lastFailureReason = null;
        headInputState = 'awaiting_provider_acceptance';
      }
      if (observation.phase === 'started') {
        lastDeferredReason = 'compaction';
      }
      return;
    }
    outputObserved = true;
    lastOutputAtMs = observedAtMs;
    if (pendingProviderAcceptance) {
      providerOutputObservedSincePendingAcceptance = true;
    }
  };

  const observeUserTypingState = (state: Readonly<{ userTyping: boolean; observedAtMs?: number | undefined }>): void => {
    userTyping = state.userTyping;
    userTypingObservedAtMs = state.userTyping ? state.observedAtMs ?? nowMs() : null;
  };

  const notifyTerminalComposerCleared = (
    state?: Readonly<{ observedAtMs?: number | undefined }>,
  ): void => {
    if (disposed) return;
    observeUserTypingState({ userTyping: false, observedAtMs: state?.observedAtMs ?? nowMs() });
    if (queue.length === 0) return;
    scheduleRetryDrain(0);
  };

  function clearRetryDrainTimer(): void {
    if (!retryDrainTimer) return;
    clearTimeout(retryDrainTimer);
    retryDrainTimer = null;
  }

  function clearProviderAcceptanceTimer(): void {
    if (!providerAcceptanceTimer) return;
    clearTimeout(providerAcceptanceTimer);
    providerAcceptanceTimer = null;
  }

  function clearSteerTurnEndFallbackTimer(): void {
    if (!steerTurnEndFallbackTimer) return;
    clearTimeout(steerTurnEndFallbackTimer);
    steerTurnEndFallbackTimer = null;
  }

  function clearPendingSteerArming(): void {
    steerAcceptanceAwaitingTurnEnd = false;
    steerAcceptanceTimeoutResult = null;
    clearSteerTurnEndFallbackTimer();
  }

  function clearCurrentHeadBlocker(): void {
    currentHeadBlocker = null;
  }

  function resolveReadinessBlocker(
    reason: string,
  ): ClaudeUnifiedDeliveryBlocker | null {
    if (reason === 'pane_initializing') {
      return { kind: 'pane_initializing', source: 'readiness' };
    }
    if (reason === 'terminal_busy') {
      return { kind: 'terminal_busy', source: 'readiness' };
    }
    if (reason === 'user_typing') {
      return { kind: 'terminal_user_draft', source: 'readiness' };
    }
    return null;
  }

  function armSteerAcceptanceAfterTurnEnd(): void {
    if (!steerAcceptanceAwaitingTurnEnd || !pendingProviderAcceptance) return;
    const armedBatch = pendingProviderAcceptance.batch;
    const timeoutResult = steerAcceptanceTimeoutResult ?? buildProviderAcceptanceTimeoutResult();
    clearPendingSteerArming();
    scheduleProviderAcceptanceTimeout(
      resolveProviderAcceptanceTimeoutMs(armedBatch),
      timeoutResult,
    );
    opts.onSteerAcceptanceArmed?.(armedBatch);
  }

  function isClaimedPendingDeliveryHandling(
    handling: ClaudeUnifiedPromptInjectionFailureHandling | undefined,
  ): handling is Readonly<{ action: 'claimed_pending_delivery' }> {
    return Boolean(handling)
      && typeof handling === 'object'
      && (handling as { action?: unknown }).action === 'claimed_pending_delivery';
  }

  function isHandledInjectionFailure(
    handling: ClaudeUnifiedPromptInjectionFailureHandling | undefined,
  ): handling is Exclude<ClaudeUnifiedPromptInjectionFailureHandling, void> {
    return Boolean(handling)
      && typeof handling === 'object'
      && (
        (handling as { action?: unknown }).action === 'claimed_pending_delivery'
        || (handling as { action?: unknown }).action === 'surfaced_runtime_issue'
      );
  }

  function isPendingQueueBatch(batch: ClaudeUnifiedPromptBatch<Mode>): boolean {
    return (batch.userMessageLocalIds?.length ?? 0) > 0;
  }

  function clearInjectionAcceptanceForBatch(batch: ClaudeUnifiedPromptBatch<Mode>): void {
    if (injectingProviderAcceptance?.batch === batch) {
      injectingProviderAcceptance = null;
    }
    if (providerAcceptanceObservedDuringInjection?.batch === batch) {
      providerAcceptanceObservedDuringInjection = null;
    }
  }

  function clearProviderAcceptanceObservedDuringInjection(acceptance: PendingProviderAcceptance<Mode>): void {
    if (providerAcceptanceObservedDuringInjection === acceptance) {
      providerAcceptanceObservedDuringInjection = null;
    }
  }

  function dropClaimedPendingDeliveryBatch(batch: ClaudeUnifiedPromptBatch<Mode>): boolean {
    if (queue[0] !== batch) return false;
    queue.shift();
    if (pendingProviderAcceptance?.batch === batch) {
      pendingProviderAcceptance = null;
      providerOutputObservedSincePendingAcceptance = false;
      clearProviderAcceptanceTimer();
      clearPendingSteerArming();
    }
    if (ambiguousProviderAcceptanceFailure?.batch === batch) {
      ambiguousProviderAcceptanceFailure = null;
      ambiguousProviderAcceptanceRetryAttempt = 0;
    }
    providerAcceptanceUnknownTerminalBatches.delete(batch);
    if (lastInjectedNotifiedBatch === batch) {
      lastInjectedNotifiedBatch = null;
    }
    providerAcceptanceByBatch.delete(batch);
    clearInjectionAcceptanceForBatch(batch);
    pendingAcceptanceCompletedCompaction = false;
    lastFailureReason = null;
    retryAttempt = 0;
    clearCurrentHeadBlocker();
    headInputState = queue.length > 0 ? 'waiting_for_readiness' : null;
    return true;
  }

  // Hooks can be lost mid-turn. While a steer acceptance waits for turn-end evidence, periodically
  // re-check the screen; an idle interactive composer is trusted turn-end evidence and arms the
  // acceptance expectation so the steered prompt can never wedge as awaiting acceptance forever.
  function scheduleSteerTurnEndFallbackWake(): void {
    clearSteerTurnEndFallbackTimer();
    steerTurnEndFallbackTimer = setTimeout(() => {
      steerTurnEndFallbackTimer = null;
      void (async () => {
        if (disposed || !steerAcceptanceAwaitingTurnEnd || !pendingProviderAcceptance) return;
        if (turnState !== 'running') {
          armSteerAcceptanceAfterTurnEnd();
          return;
        }
        try {
          const decision = await opts.evaluateInFlightSteer?.(pendingProviderAcceptance.batch);
          if (
            !disposed
            && steerAcceptanceAwaitingTurnEnd
            && pendingProviderAcceptance
            && decision
            && decision.turnLikelyEnded === true
          ) {
            armSteerAcceptanceAfterTurnEnd();
            return;
          }
        } catch {
          // Screen evidence unavailable; keep waiting for lifecycle evidence.
        }
        if (!disposed && steerAcceptanceAwaitingTurnEnd) {
          scheduleSteerTurnEndFallbackWake();
        }
      })();
    }, busyTurnFallbackWakeMs);
    steerTurnEndFallbackTimer.unref?.();
  }

  function scheduleRetryDrain(retryAfterMs: number | undefined): void {
    if (retryAfterMs === undefined || retryAfterMs < 0) return;
    clearRetryDrainTimer();
    retryDrainTimer = setTimeout(() => {
      retryDrainTimer = null;
      void drainWhenSafe().catch(() => undefined);
    }, retryAfterMs);
    retryDrainTimer.unref?.();
  }

  async function notifyInjectionFailure(
    failure: ClaudeUnifiedPromptInjectionFailure<Mode>,
  ): Promise<ClaudeUnifiedPromptInjectionFailureHandling | undefined> {
    return await opts.onInjectionFailure?.(failure);
  }

  function buildProviderAcceptanceTimeoutResult(): Extract<TerminalInputInjectionResult, { status: 'failed' }> {
    return {
      status: 'failed',
      reason: 'timeout',
      phase: 'after_enter_unknown',
      duplicateRisk: 'likely',
      recoverable: true,
    };
  }

  function isUnconfirmedSubmitFailure(
    result: Extract<TerminalInputInjectionResult, { status: 'failed' }>,
  ): boolean {
    return result.reason === 'host_unreachable'
      && result.phase === 'after_enter_unknown'
      && result.recoverable === true;
  }

  function resolveProviderAcceptanceTimeoutMs(
    batch: ClaudeUnifiedPromptBatch<Mode>,
    result?: Extract<TerminalInputInjectionResult, { status: 'injected' }> | undefined,
    baseTimeoutMs = providerAcceptanceTimeoutMs,
  ): number {
    return resolveTerminalPromptProviderAcceptanceTimeoutMs(batch.message, {
      baseTimeoutMs,
      ...(result ? { bytesWritten: result.bytesWritten } : {}),
    });
  }

  function scheduleProviderAcceptanceTimeout(
    timeoutMs: number,
    result: Extract<TerminalInputInjectionResult, { status: 'failed' }>,
  ): void {
    providerAcceptanceTimeoutContext = { timeoutMs, result };
    providerAcceptanceCompactionGraceUsed = false;
    armProviderAcceptanceTimeout(timeoutMs, result);
  }

  function armProviderAcceptanceTimeout(
    timeoutMs: number,
    result: Extract<TerminalInputInjectionResult, { status: 'failed' }>,
  ): void {
    clearProviderAcceptanceTimer();
    providerAcceptanceTimer = setTimeout(() => {
      providerAcceptanceTimer = null;
      void (async () => {
        if (pendingProviderAcceptance && compactionActive) {
          if (!providerAcceptanceCompactionGraceUsed) {
            providerAcceptanceCompactionGraceUsed = true;
            armProviderAcceptanceTimeout(timeoutMs, result);
            return;
          }
        }
        if (pendingProviderAcceptance) {
          if (
            pendingProviderAcceptance.acceptance.acceptedAs === 'new_turn'
            && queue[0] === pendingProviderAcceptance.batch
            && providerOutputObservedSincePendingAcceptance
            && !isPendingQueueBatch(pendingProviderAcceptance.batch)
          ) {
            const outputAccepted = pendingProviderAcceptance;
            queue.shift();
            await acceptBatch(outputAccepted.batch, outputAccepted.acceptance);
            return;
          }
          const timedOutAcceptance = pendingProviderAcceptance;
          pendingProviderAcceptance = null;
          providerOutputObservedSincePendingAcceptance = false;
          ambiguousProviderAcceptanceFailure = timedOutAcceptance;
          pendingAcceptanceCompletedCompaction = false;
          providerAcceptanceTimeoutContext = null;
          providerAcceptanceCompactionGraceUsed = false;
          lastFailureReason = result.reason;
          headInputState = 'failed_ambiguous';
          const handling = await notifyInjectionFailure({
            batch: timedOutAcceptance.batch,
            result,
            failureState: 'failed_ambiguous',
          });
          if (isClaimedPendingDeliveryHandling(handling)) {
            if (dropClaimedPendingDeliveryBatch(timedOutAcceptance.batch)) {
              scheduleRetryDrain(0);
            }
            return;
          }
          if (isPendingQueueBatch(timedOutAcceptance.batch)) {
            return;
          }
          if (!isCompactPrompt(timedOutAcceptance.batch)) {
            scheduleRetryDrain(0);
          }
        }
      })().catch(() => undefined);
    }, timeoutMs);
    providerAcceptanceTimer.unref?.();
  }

  function resolvePromptAcceptance(state: TerminalTurnState): ClaudeUnifiedPromptAcceptance {
    return {
      acceptedAs: state === 'running' ? 'in_flight_steer' : 'new_turn',
      turnStateAtInjection: state,
    };
  }

  function readCanonicalTurnInactive(): boolean {
    if (!opts.isCanonicalTurnActive) return false;
    try {
      return opts.isCanonicalTurnActive() === false;
    } catch {
      return false;
    }
  }

  function readPromptDeliveryAccepted(batch: ClaudeUnifiedPromptBatch<Mode>): boolean {
    if (!opts.isPromptDeliveryAccepted) return false;
    try {
      return opts.isPromptDeliveryAccepted(batch) === true;
    } catch {
      return false;
    }
  }

  async function acceptBatch(
    batch: ClaudeUnifiedPromptBatch<Mode>,
    acceptance: ClaudeUnifiedPromptAcceptance,
    options?: Readonly<{ preserveTerminalState?: boolean }> | undefined,
  ): Promise<void> {
    lastDeferredReason = null;
    lastFailureReason = null;
    clearCurrentHeadBlocker();
    headInputState = 'submitted';
    retryAttempt = 0;
    ambiguousProviderAcceptanceRetryAttempt = 0;
    if (options?.preserveTerminalState !== true) {
      firstObservedAtMs = nowMs();
      outputObserved = false;
      lastOutputAtMs = null;
      turnState = 'unknown';
    }
    if (pendingProviderAcceptance?.batch === batch) {
      pendingProviderAcceptance = null;
      providerOutputObservedSincePendingAcceptance = false;
      pendingAcceptanceCompletedCompaction = false;
      clearProviderAcceptanceTimer();
      clearPendingSteerArming();
    }
    if (ambiguousProviderAcceptanceFailure?.batch === batch) {
      ambiguousProviderAcceptanceFailure = null;
      ambiguousProviderAcceptanceRetryAttempt = 0;
    }
    providerAcceptanceUnknownTerminalBatches.delete(batch);
    if (lastInjectedNotifiedBatch === batch) {
      lastInjectedNotifiedBatch = null;
    }
    providerAcceptanceByBatch.delete(batch);
    clearInjectionAcceptanceForBatch(batch);
    await opts.onPromptAccepted?.(batch, acceptance);
    if (pendingProviderAcceptance) {
      headInputState = 'awaiting_provider_acceptance';
    }
  }

  function resolveQueueHeadKnownProviderDeliveryAcceptance(): ClaudeUnifiedPromptAcceptance | null {
    const next = queue[0];
    if (!next || !readPromptDeliveryAccepted(next)) return null;
    return pendingProviderAcceptance?.batch === next
      ? pendingProviderAcceptance.acceptance
      : ambiguousProviderAcceptanceFailure?.batch === next
        ? ambiguousProviderAcceptanceFailure.acceptance
        : injectingProviderAcceptance?.batch === next
          ? injectingProviderAcceptance.acceptance
          : providerAcceptanceByBatch.get(next) ?? resolvePromptAcceptance(turnState);
  }

  async function confirmPromptAcceptedByProviderMatching(
    matcher: (batch: ClaudeUnifiedPromptBatch<Mode>) => boolean,
    optsOverride?: Readonly<{ includeAmbiguousTimeout?: boolean }> | undefined,
  ): Promise<boolean> {
    const pendingAcceptance = pendingProviderAcceptance
      ?? (optsOverride?.includeAmbiguousTimeout ? ambiguousProviderAcceptanceFailure : null);
    if (!pendingAcceptance) {
      const injectingAcceptance = injectingProviderAcceptance;
      if (!injectingAcceptance) return false;
      const injectingBatch = queue[0];
      if (injectingBatch !== injectingAcceptance.batch) return false;
      if (!matcher(injectingBatch)) return false;
      providerAcceptanceObservedDuringInjection = injectingAcceptance;
      return true;
    }
    const next = queue[0];
    if (next !== pendingAcceptance.batch) return false;
    if (!matcher(next)) return false;
    queue.shift();
    await acceptBatch(next, pendingAcceptance.acceptance);
    return true;
  }

  async function confirmPromptAcceptedByProvider(): Promise<boolean> {
    return confirmPromptAcceptedByProviderMatching(
      (batch) => !isPendingQueueBatch(batch),
      { includeAmbiguousTimeout: true },
    );
  }

  async function observePromptCustodyByTerminal(batch: ClaudeUnifiedPromptBatch<Mode>): Promise<boolean> {
    if (disposed || queue[0] !== batch) return false;
    const currentAcceptance = pendingProviderAcceptance
      ?? (ambiguousProviderAcceptanceFailure?.batch === batch ? ambiguousProviderAcceptanceFailure : null);
    if (!currentAcceptance || currentAcceptance.batch !== batch) return false;

    queue.shift();
    if (pendingProviderAcceptance?.batch === batch) {
      pendingProviderAcceptance = null;
      providerOutputObservedSincePendingAcceptance = false;
      clearProviderAcceptanceTimer();
      clearPendingSteerArming();
    }
    ambiguousProviderAcceptanceFailure = null;
    ambiguousProviderAcceptanceRetryAttempt = 0;
    pendingAcceptanceCompletedCompaction = false;
    lastFailureReason = null;
    await acceptBatch(batch, currentAcceptance.acceptance, { preserveTerminalState: true });
    if (queue.length > 0) {
      scheduleRetryDrain(0);
    }
    return true;
  }

  async function observePendingProviderAcceptanceTerminalFailure(): Promise<boolean> {
    if (disposed) return false;
    const failedAcceptance = pendingProviderAcceptance
      ?? (
        ambiguousProviderAcceptanceFailure && queue[0] === ambiguousProviderAcceptanceFailure.batch
          ? ambiguousProviderAcceptanceFailure
          : null
    );
    if (!failedAcceptance || queue[0] !== failedAcceptance.batch) return false;

    const { batch } = failedAcceptance;
    const result = buildProviderAcceptanceTimeoutResult();
    if (pendingProviderAcceptance?.batch === batch) {
      pendingProviderAcceptance = null;
      providerOutputObservedSincePendingAcceptance = false;
      clearProviderAcceptanceTimer();
      clearPendingSteerArming();
    }
    if (ambiguousProviderAcceptanceFailure?.batch === batch) {
      ambiguousProviderAcceptanceFailure = null;
      ambiguousProviderAcceptanceRetryAttempt = 0;
    }
    pendingAcceptanceCompletedCompaction = false;
    providerAcceptanceUnknownTerminalBatches.add(batch);
    lastFailureReason = result.reason;
    headInputState = 'failed_terminal';
    const handling = await notifyInjectionFailure({
      batch,
      result,
      failureState: 'failed_terminal',
    });
    if (isClaimedPendingDeliveryHandling(handling) && dropClaimedPendingDeliveryBatch(batch)) {
      scheduleRetryDrain(0);
    }
    return isHandledInjectionFailure(handling);
  }

  const runDrain = async (): Promise<void> => {
    clearRetryDrainTimer();
    while (!disposed && queue.length > 0) {
      const knownProviderDeliveryAcceptance = resolveQueueHeadKnownProviderDeliveryAcceptance();
      if (knownProviderDeliveryAcceptance) {
        const acceptedHead = queue.shift();
        if (acceptedHead) {
          await acceptBatch(acceptedHead, knownProviderDeliveryAcceptance);
        }
        continue;
      }
      if (pendingProviderAcceptance) {
        if (compactionActive || !pendingAcceptanceCompletedCompaction) {
          headInputState = 'awaiting_provider_acceptance';
          return;
        }
        const completedAcceptance = pendingProviderAcceptance;
        pendingProviderAcceptance = null;
        providerOutputObservedSincePendingAcceptance = false;
        pendingAcceptanceCompletedCompaction = false;
        clearProviderAcceptanceTimer();
        clearPendingSteerArming();
        // Compaction completion is provider acceptance of a pending /compact prompt.
        // Consume it so a PostCompact hook racing ahead of the compact_boundary
        // transcript row cannot leave /compact at the queue head and re-inject it.
        // Regular prompts interrupted by compaction stay queued for re-injection.
        if (queue[0] === completedAcceptance.batch && isCompactPrompt(completedAcceptance.batch)) {
          queue.shift();
          await acceptBatch(completedAcceptance.batch, completedAcceptance.acceptance);
          continue;
        }
      }
      if (compactionActive) {
        lastDeferredReason = 'compaction';
        clearCurrentHeadBlocker();
        headInputState = 'waiting_for_readiness';
        return;
      }
      if (headInputState === 'failed_ambiguous' || headInputState === 'failed_terminal') {
        if (
          headInputState === 'failed_ambiguous'
          && ambiguousProviderAcceptanceFailure
          && queue[0] === ambiguousProviderAcceptanceFailure.batch
          && readPromptDeliveryAccepted(ambiguousProviderAcceptanceFailure.batch)
        ) {
          const acceptedFailure = ambiguousProviderAcceptanceFailure;
          pendingProviderAcceptance = null;
          providerOutputObservedSincePendingAcceptance = false;
          pendingAcceptanceCompletedCompaction = false;
          ambiguousProviderAcceptanceFailure = null;
          lastFailureReason = null;
          queue.shift();
          await acceptBatch(acceptedFailure.batch, acceptedFailure.acceptance);
          continue;
        }
        if (
          headInputState === 'failed_ambiguous'
          && ambiguousProviderAcceptanceFailure
          && queue[0] === ambiguousProviderAcceptanceFailure.batch
          && !isPendingQueueBatch(ambiguousProviderAcceptanceFailure.batch)
          && ambiguousProviderAcceptanceRetryAttempt < 1
        ) {
          ambiguousProviderAcceptanceRetryAttempt += 1;
          pendingProviderAcceptance = null;
          providerOutputObservedSincePendingAcceptance = false;
          pendingAcceptanceCompletedCompaction = false;
          ambiguousProviderAcceptanceFailure = null;
          lastFailureReason = null;
          headInputState = 'waiting_for_readiness';
        } else {
          if (
            headInputState === 'failed_ambiguous'
            && ambiguousProviderAcceptanceFailure
            && queue[0] === ambiguousProviderAcceptanceFailure.batch
          ) {
            const failure = ambiguousProviderAcceptanceFailure;
            pendingProviderAcceptance = null;
            providerOutputObservedSincePendingAcceptance = false;
            pendingAcceptanceCompletedCompaction = false;
            ambiguousProviderAcceptanceFailure = null;
            lastFailureReason = 'timeout';
            headInputState = 'failed_terminal';
            providerAcceptanceUnknownTerminalBatches.add(failure.batch);
            const handling = await notifyInjectionFailure({
              batch: failure.batch,
              result: buildProviderAcceptanceTimeoutResult(),
              failureState: 'failed_terminal',
            });
            if (isClaimedPendingDeliveryHandling(handling) && dropClaimedPendingDeliveryBatch(failure.batch)) {
              continue;
            }
          }
          return;
        }
      }
      const next = queue[0];
      const bypassQuietWindowForRunningSteer = next?.origin.kind === 'ui_pending' && turnState === 'running';
      const readiness = resolveTerminalInjectionReadiness({
        nowMs: nowMs(),
        firstObservedAtMs,
        outputObserved,
        lastOutputAtMs,
        permissionBlocked,
        turnState,
        userTyping,
        userTypingObservedAtMs,
      }, {
        quietPeriodMs: bypassQuietWindowForRunningSteer ? 0 : opts.quietPeriodMs,
        maxWaitMs: opts.maxWaitMs,
      });
      if (!readiness.ready) {
        lastDeferredReason = readiness.reason;
        currentHeadBlocker = resolveReadinessBlocker(readiness.reason);
        headInputState = 'waiting_for_readiness';
        scheduleRetryDrain(readiness.retryAfterMs);
        return;
      }

      let injectAsInFlightSteer = false;
      if (next.origin.kind === 'ui_pending' && turnState === 'running') {
        // In-flight steering (D19): evaluate the SCREEN before deciding. Claude's TUI natively
        // queues text typed mid-generation and submits it at turn end (probe P-D), so a safe
        // actively-generating screen can take the prompt now instead of holding it invisibly
        // until the turn ends. Slash commands and vetoed/unknown screens keep the existing
        // bounded defer-until-idle behavior.
        let steerSafe = false;
        let steerEvaluationAttempted = false;
        let steerTurnLikelyEnded = false;
        let canonicalTurnInactive = false;
        if (opts.evaluateInFlightSteer && !isNonSteerablePrompt(next)) {
          steerEvaluationAttempted = true;
          try {
            const decision = await opts.evaluateInFlightSteer(next);
            steerSafe = decision.steer === true;
            steerTurnLikelyEnded = decision.turnLikelyEnded === true;
          } catch {
            steerSafe = false;
          }
        }
        canonicalTurnInactive = readCanonicalTurnInactive();
        if (canonicalTurnInactive) {
          steerSafe = false;
        }
        if (disposed || queue[0] !== next) continue;
        if (turnState !== 'running') continue;
        if (!steerSafe) {
          // Stale-turn recovery (incident cmq7pyqkj, L1): a 'running' state with NO provider
          // lifecycle activity for a bounded window is treated as stale (e.g. set from replayed
          // transcript rows after a respawn, with no live turn behind it). When the steer
          // evaluation also proved an idle composer (`turnLikelyEnded`) — or no evaluation was
          // possible for this prompt (slash command / no evaluator) — drain the prompt normally
          // as a new turn instead of deferring forever. A veto without turn-end screen evidence
          // keeps the bounded deferred path (fail-closed).
          const screenAllowsStaleRecovery = !steerEvaluationAttempted || steerTurnLikelyEnded || canonicalTurnInactive;
          const lastProviderEvidenceMs = lastOutputAtMs ?? firstObservedAtMs;
          if (screenAllowsStaleRecovery && nowMs() - lastProviderEvidenceMs >= staleTurnRecoveryMs) {
            turnState = 'unknown';
            continue;
          }
          lastDeferredReason = 'terminal_busy';
          currentHeadBlocker = { kind: 'terminal_busy', source: 'readiness' };
          headInputState = 'waiting_for_readiness';
          // The turn-end lifecycle hook normally redrains this deferral. Schedule a
          // bounded fallback wake so a missing turn-end signal cannot starve the
          // prompt forever; re-evaluation re-defers while still running.
          scheduleRetryDrain(busyTurnFallbackWakeMs);
          return;
        }
        injectAsInFlightSteer = true;
      }
      const acceptance = resolvePromptAcceptance(turnState);
      const injectionAcceptance: PendingProviderAcceptance<Mode> = { batch: next, acceptance };
      providerAcceptanceByBatch.set(next, acceptance);
      headInputState = 'injecting';
      injectingProviderAcceptance = injectionAcceptance;
      let result: TerminalInputInjectionResult;
      try {
        result = await opts.injectPrompt(
          next,
          injectAsInFlightSteer ? { inFlightSteer: true } : undefined,
        );
      } catch (error) {
        clearInjectionAcceptanceForBatch(next);
        throw error;
      }
      if (injectingProviderAcceptance === injectionAcceptance) {
        injectingProviderAcceptance = null;
      }
      if (result.status === 'injected') {
        lastDeferredReason = null;
        lastFailureReason = null;
        clearCurrentHeadBlocker();
        pendingProviderAcceptance = injectionAcceptance;
        providerOutputObservedSincePendingAcceptance = false;
        pendingAcceptanceCompletedCompaction = false;
        headInputState = 'awaiting_provider_acceptance';
        // Notify a successful injection at most once per batch. An ambiguous retry
        // re-injects the same batch; re-firing onPromptInjected would double-record
        // its accepted-echo bookkeeping and could suppress a later identical
        // terminal-typed prompt.
        if (lastInjectedNotifiedBatch !== next) {
          lastInjectedNotifiedBatch = next;
          await opts.onPromptInjected?.(next, acceptance, result);
        }
        const providerAcceptedDuringInjection = providerAcceptanceObservedDuringInjection === injectionAcceptance;
        clearProviderAcceptanceObservedDuringInjection(injectionAcceptance);
        if (pendingProviderAcceptance?.batch !== next || queue[0] !== next) {
          return;
        }
        if (providerAcceptedDuringInjection) {
          queue.shift();
          await acceptBatch(next, acceptance);
          return;
        }
        if (acceptance.acceptedAs === 'in_flight_steer') {
          // Acceptance evidence arrives only at turn end; defer the acceptance timeout until
          // turn-end evidence so a long steered turn cannot mark the prompt ambiguous (and
          // retry/double-queue it) while it is still legitimately queued in the TUI.
          steerAcceptanceAwaitingTurnEnd = true;
          steerAcceptanceTimeoutResult = buildProviderAcceptanceTimeoutResult();
          scheduleSteerTurnEndFallbackWake();
        } else {
          scheduleProviderAcceptanceTimeout(
            resolveProviderAcceptanceTimeoutMs(next, result),
            buildProviderAcceptanceTimeoutResult(),
          );
        }
        return;
      }
      clearProviderAcceptanceObservedDuringInjection(injectionAcceptance);
      if (result.status === 'deferred') {
        lastDeferredReason = result.reason;
        currentHeadBlocker = result.blocker ?? resolveReadinessBlocker(result.reason);
        pendingProviderAcceptance = null;
        providerOutputObservedSincePendingAcceptance = false;
        ambiguousProviderAcceptanceFailure = null;
        ambiguousProviderAcceptanceRetryAttempt = 0;
        pendingAcceptanceCompletedCompaction = false;
        clearProviderAcceptanceTimer();
        clearPendingSteerArming();
        headInputState = 'waiting_for_readiness';
        scheduleRetryDrain(result.retryAfterMs);
        return;
      }
      lastFailureReason = result.reason;
      clearCurrentHeadBlocker();
      const failureAction = classifyClaudeUnifiedInjectionFailure(result, {
        retryAttempt,
        retryLimit: injectionRetryLimit,
        retryBaseDelayMs: injectionRetryBaseDelayMs,
        providerAcceptanceTimeoutMs,
      });
      if (failureAction.kind === 'retry') {
        pendingProviderAcceptance = null;
        providerOutputObservedSincePendingAcceptance = false;
        ambiguousProviderAcceptanceFailure = null;
        ambiguousProviderAcceptanceRetryAttempt = 0;
        pendingAcceptanceCompletedCompaction = false;
        clearProviderAcceptanceTimer();
        clearPendingSteerArming();
        retryAttempt += 1;
        headInputState = 'failed_retryable';
        scheduleRetryDrain(failureAction.retryAfterMs);
        return;
      }
      if (failureAction.kind === 'await_provider_confirmation') {
        if (isUnconfirmedSubmitFailure(result)) {
          pendingProviderAcceptance = null;
          providerOutputObservedSincePendingAcceptance = false;
          ambiguousProviderAcceptanceFailure = null;
          ambiguousProviderAcceptanceRetryAttempt = 0;
          pendingAcceptanceCompletedCompaction = false;
          clearProviderAcceptanceTimer();
          clearPendingSteerArming();
          headInputState = 'failed_ambiguous';
          let handling: ClaudeUnifiedPromptInjectionFailureHandling | undefined;
          try {
            handling = await notifyInjectionFailure({
              batch: next,
              result,
              failureState: 'failed_ambiguous',
            });
          } catch {
            handling = undefined;
          }
          if (isClaimedPendingDeliveryHandling(handling) && dropClaimedPendingDeliveryBatch(next)) {
            if (queue.length > 0) {
              retryAttempt = 0;
              continue;
            }
          }
          if (!isHandledInjectionFailure(handling)) {
            providerAcceptanceUnknownTerminalBatches.add(next);
            lastFailureReason = result.reason;
            return;
          }
          if (queue[0] === next) {
            queue.shift();
            providerAcceptanceByBatch.delete(next);
            providerAcceptanceUnknownTerminalBatches.add(next);
            lastFailureReason = result.reason;
            headInputState = queue.length > 0 ? 'waiting_for_readiness' : null;
            if (queue.length > 0) {
              retryAttempt = 0;
              continue;
            }
          }
          return;
        }
        pendingProviderAcceptance = { batch: next, acceptance };
        providerOutputObservedSincePendingAcceptance = false;
        pendingAcceptanceCompletedCompaction = false;
        headInputState = 'awaiting_provider_acceptance';
        if (acceptance.acceptedAs === 'in_flight_steer') {
          // Same turn-end semantics as a successful steer write: the queued prompt cannot be
          // accepted before the running turn ends, so defer the confirmation timeout too.
          steerAcceptanceAwaitingTurnEnd = true;
          steerAcceptanceTimeoutResult = result;
          scheduleSteerTurnEndFallbackWake();
        } else {
          scheduleProviderAcceptanceTimeout(
            resolveProviderAcceptanceTimeoutMs(next, undefined, failureAction.timeoutMs),
            result,
          );
        }
        return;
      }
      pendingProviderAcceptance = null;
      providerOutputObservedSincePendingAcceptance = false;
      ambiguousProviderAcceptanceFailure = null;
      ambiguousProviderAcceptanceRetryAttempt = 0;
      pendingAcceptanceCompletedCompaction = false;
      clearProviderAcceptanceTimer();
      clearPendingSteerArming();
      headInputState = 'failed_terminal';
      if (isDeterministicPreProviderInputRejection(result)) {
        const rejected = queue.shift();
        if (rejected) {
          providerAcceptanceByBatch.delete(rejected);
          void notifyInjectionFailure({
            batch: rejected,
            result,
            failureState: 'failed_terminal',
          }).catch(() => undefined);
        }
        headInputState = null;
        if (queue.length > 0) {
          retryAttempt = 0;
          continue;
        }
        return;
      }
      let handling: ClaudeUnifiedPromptInjectionFailureHandling | undefined;
      try {
        handling = await notifyInjectionFailure({
          batch: next,
          result,
          failureState: 'failed_terminal',
        });
      } catch {
        handling = undefined;
      }
      if (isClaimedPendingDeliveryHandling(handling) && dropClaimedPendingDeliveryBatch(next)) {
        if (queue.length > 0) {
          retryAttempt = 0;
          continue;
        }
      }
      return;
    }
  };

  async function drainWhenSafe(): Promise<void> {
    if (!draining) {
      draining = runDrain().finally(() => {
        draining = null;
      });
    }
    await draining;
  }

  function handBackUndeliverableBatches(batches: ReadonlyArray<ClaudeUnifiedPromptBatch<Mode>>): void {
    if (batches.length === 0) return;
    opts.onUndeliverableBatches?.(batches);
  }

  return {
    async enqueueUiMessage(batch) {
      if (disposed) {
        // The arbiter can never deliver this batch; hand it back instead of silently
        // swallowing it (races the pump's own disposed check).
        handBackUndeliverableBatches([batch]);
        return;
      }
      queue.push(batch);
    },
    observeLifecycle,
    observeUserTypingState,
    notifyTerminalComposerCleared,
    observePromptCustodyByTerminal,
    confirmPromptAcceptedByProvider,
    confirmPromptAcceptedByProviderIf(matcher) {
      return confirmPromptAcceptedByProviderMatching(matcher, { includeAmbiguousTimeout: true });
    },
    observePendingProviderAcceptanceTerminalFailure,
    drainWhenSafe,
    snapshot,
    dispose() {
      disposed = true;
      clearRetryDrainTimer();
      clearProviderAcceptanceTimer();
      clearPendingSteerArming();
      // Anything still queued is undeliverable by this arbiter; hand it back to the owner before
      // clearing. Exception: a provider-acceptance-unknown terminal batch was already written and
      // submitted to the provider-facing terminal, so returning it would risk duplicate execution.
      const undelivered = queue.splice(0, queue.length);
      handBackUndeliverableBatches(
        undelivered.filter((batch) => (
          !providerAcceptanceUnknownTerminalBatches.has(batch)
        )),
      );
      queue.length = 0;
      pendingProviderAcceptance = null;
      providerOutputObservedSincePendingAcceptance = false;
      pendingAcceptanceCompletedCompaction = false;
      ambiguousProviderAcceptanceFailure = null;
      providerAcceptanceUnknownTerminalBatches.clear();
      providerAcceptanceByBatch.clear();
      clearCurrentHeadBlocker();
      injectingProviderAcceptance = null;
      providerAcceptanceObservedDuringInjection = null;
      ambiguousProviderAcceptanceRetryAttempt = 0;
      lastInjectedNotifiedBatch = null;
      headInputState = null;
        clearCurrentHeadBlocker();
    },
  };
}
