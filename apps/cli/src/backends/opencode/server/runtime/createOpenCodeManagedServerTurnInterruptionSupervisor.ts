import { logger } from '@/ui/logger';

import {
  describeOpenCodeManagedServerIdentityForLog,
  type OpenCodeManagedServerIdentity,
  type OpenCodeManagedServerIdentityChange,
} from '../openCodeManagedServerIdentity';

/**
 * Provider-owned `SessionRuntimeIssueV1` code emitted when the managed `opencode serve` process is
 * replaced mid-turn and the in-flight tool work cannot be reconciled from durable history.
 *
 * `SessionRuntimeIssueV1.code` is an open string (not a closed protocol union), so this constant is
 * the single source of truth for the CLI runtime, the fake-OpenCode e2e fixture, and any aligned
 * lane. Keep the literal in sync with `packages/tests/src/testkit/fakeOpenCodeServer.ts`.
 */
export const OPENCODE_SERVER_RESTARTED_DURING_TURN_ISSUE_CODE = 'opencode_server_restarted_during_turn';

const MANAGED_SERVER_RESTARTED_DURING_TURN_PREVIEW =
  "OpenCode's managed server restarted while a provider turn had in-flight tool work. "
  + 'The turn was marked failed instead of being left stuck.';

export type OpenCodeManagedServerTurnInterruptionAction =
  | 'continued_after_reconcile'
  | 'failed_turn_interrupted'
  | 'cleared_no_active_turn'
  | 'ignored_no_generation_change';

export type OpenCodeManagedServerTurnInterruptionDeps = Readonly<{
  /** True while a Happier turn is active (deferred turn + active prompt). */
  isTurnActive: () => boolean;
  /** Current managed-server identity from the runtime client (null in non-managed/unknown modes). */
  getManagedServerIdentity: () => OpenCodeManagedServerIdentity | null;
  /** Forward the active observation generation to the foreground tool tracker. */
  setObservedGenerationKey: (generationKey: string | null) => void;
  /** Run ONE bounded reconciliation of live-known ids from the replacement server's durable history. */
  reconcileLiveKnownToolStateFromHistory: () => Promise<void>;
  /** True if any live-known tool call of the active turn is still active (non-terminal/missing) after reconcile. */
  hasUnreconciledActiveLiveKnownToolWork: () => boolean;
  /** Fail the active turn exactly once with the server-restart issue (no task_complete/sessionAbort/replay). */
  failActiveTurnDueToManagedServerRestart: (input: Readonly<{ sanitizedPreview: string }>) => void;
  /** Reset all foreground provider work for the interrupted turn. */
  resetProviderWorkForInterruptedTurn: () => void;
  /** Drop provider work not backed by the given (current) generation. */
  clearOrphanedProviderWork: (currentGenerationKey: string | null) => void;
  /** Sanitized snapshot of active provider work for diagnostics (no tool inputs/outputs). */
  describeActiveProviderWorkForLog: () => Record<string, unknown>;
  getProviderSessionId: () => string | null;
  getActiveSidechainSessionIds: () => readonly string[];
}>;

export type OpenCodeManagedServerTurnInterruptionSupervisor = Readonly<{
  /** Capture the managed-server generation at the moment a turn starts. */
  captureTurnStartGeneration: () => void;
  /** Receive a managed-server generation change from the runtime client. */
  handleManagedServerIdentityChange: (change: OpenCodeManagedServerIdentityChange) => void;
  /** Generation the runtime currently believes it is talking to (for generation-aware liveness). */
  getCurrentGenerationKey: () => string | null;
}>;

export function createOpenCodeManagedServerTurnInterruptionSupervisor(
  deps: OpenCodeManagedServerTurnInterruptionDeps,
): OpenCodeManagedServerTurnInterruptionSupervisor {
  let turnStartGenerationKey: string | null = null;
  let currentGenerationKey: string | null = null;
  // Bounded reconciliation is single-flight per detected change; the underlying failTurn is itself
  // guarded to run exactly once, so coalescing concurrent change events is safe.
  let reconciliationInFlight: Promise<void> | null = null;

  const getCurrentGenerationKey = (): string | null =>
    currentGenerationKey ?? deps.getManagedServerIdentity()?.generationKey ?? null;

  const captureTurnStartGeneration = (): void => {
    const identity = deps.getManagedServerIdentity();
    turnStartGenerationKey = identity?.generationKey ?? null;
    currentGenerationKey = turnStartGenerationKey;
    deps.setObservedGenerationKey(currentGenerationKey);
  };

  const buildDiagnostics = (
    change: OpenCodeManagedServerIdentityChange,
    action: OpenCodeManagedServerTurnInterruptionAction,
  ): Record<string, unknown> => ({
    reason: change.reason,
    action,
    turnStartGenerationKey: turnStartGenerationKey ? turnStartGenerationKey.slice(0, 12) : null,
    currentGenerationKey: currentGenerationKey ? currentGenerationKey.slice(0, 12) : null,
    previous: describeOpenCodeManagedServerIdentityForLog(change.previous),
    current: describeOpenCodeManagedServerIdentityForLog(change.current),
    providerSessionId: deps.getProviderSessionId(),
    sidechainSessionIds: deps.getActiveSidechainSessionIds(),
    providerWork: deps.describeActiveProviderWorkForLog(),
  });

  const runReconciliationAndMaybeFail = async (change: OpenCodeManagedServerIdentityChange): Promise<void> => {
    // ONE bounded reconciliation of live-known ids from the replacement server's durable history.
    await deps.reconcileLiveKnownToolStateFromHistory().catch((error) => {
      logger.debug('[OpenCodeServer] managed-server-restart reconciliation failed (non-fatal)', error);
    });

    if (!deps.isTurnActive()) {
      // The turn settled (resolved/failed) while reconciling; nothing further to do.
      return;
    }

    if (!deps.hasUnreconciledActiveLiveKnownToolWork()) {
      // Reconciled terminal, or no live-known tool work existed: forward-missing-results already ran
      // inside reconciliation; let the existing completion gate / idle fallback own the rest.
      logger.debug(
        '[OpenCodeServer] managed server generation changed mid-turn; reconciled, turn continues',
        buildDiagnostics(change, 'continued_after_reconcile'),
      );
      return;
    }

    logger.debug(
      '[OpenCodeServer] managed server restarted mid-turn with unreconciled tool work; failing turn',
      buildDiagnostics(change, 'failed_turn_interrupted'),
    );
    // Reset foreground provider work for the dead turn before failing so liveness/keepalive settle cleanly.
    deps.resetProviderWorkForInterruptedTurn();
    deps.failActiveTurnDueToManagedServerRestart({
      sanitizedPreview: MANAGED_SERVER_RESTARTED_DURING_TURN_PREVIEW,
    });
  };

  const handleManagedServerIdentityChange = (change: OpenCodeManagedServerIdentityChange): void => {
    const nextGenerationKey = change.current?.generationKey ?? null;
    currentGenerationKey = nextGenerationKey;
    deps.setObservedGenerationKey(nextGenerationKey);

    if (!deps.isTurnActive()) {
      // No user-visible failure when idle; just drop orphaned work bound to the dead generation.
      deps.clearOrphanedProviderWork(nextGenerationKey);
      logger.debug(
        '[OpenCodeServer] managed server generation changed with no active turn',
        buildDiagnostics(change, 'cleared_no_active_turn'),
      );
      return;
    }

    if (turnStartGenerationKey === null) {
      // No baseline was established at turn start (identity was unknown). Adopt the observed
      // generation so we never fail on a first-ever observation; the generation-aware deadlock
      // guard remains the safety net if work is genuinely orphaned.
      turnStartGenerationKey = nextGenerationKey;
      return;
    }

    if (nextGenerationKey !== null && nextGenerationKey === turnStartGenerationKey) {
      // Same generation as turn start: not a real replacement.
      return;
    }

    if (reconciliationInFlight) return;
    reconciliationInFlight = runReconciliationAndMaybeFail(change)
      .catch((error) => {
        logger.debug('[OpenCodeServer] managed-server-restart supervision failed (non-fatal)', error);
      })
      .finally(() => {
        reconciliationInFlight = null;
      });
  };

  return {
    captureTurnStartGeneration,
    handleManagedServerIdentityChange,
    getCurrentGenerationKey,
  };
}
