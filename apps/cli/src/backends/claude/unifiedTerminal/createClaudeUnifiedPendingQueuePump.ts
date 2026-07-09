import type { DrainPendingOptions, DrainPendingResult, MessageBatch } from '@/agent/runtime/sessionInput/types';
import { PendingQueueMaterializationAuthError } from '@/agent/runtime/sessionInput/SessionProviderInputConsumer';
import { logger } from '@/ui/logger';

import type {
  ClaudeUnifiedInputArbiter,
  ClaudeUnifiedInputArbiterSnapshot,
  ClaudeUnifiedInputConsumer,
  ClaudeUnifiedPendingQueuePump,
} from './_types';

function shouldPausePumpForArbiterBackpressure(snapshot: ClaudeUnifiedInputArbiterSnapshot): boolean {
  if (snapshot.pendingInjectionCount > 0) return true;
  return snapshot.providerAcceptancePendingCount > snapshot.terminalCustodyCount;
}

const DEFAULT_PAUSED_ARBITER_RECHECK_MS = 500;
const DEFAULT_FAILURE_RETRY_BACKOFF_MS = 250;
const DEFAULT_MAX_CONSECUTIVE_HANDLED_FAILURES = 3;

type PumpOnceResult =
  | Readonly<{ kind: 'delivered' }>
  | Readonly<{ kind: 'stopped' }>
  | Readonly<{ kind: 'handled_failure'; error: unknown }>;

function createPumpFailureBudgetExhaustedError(error: unknown, failureCount: number): Error & {
  code: 'claude_unified_pending_queue_pump_failure_budget_exhausted';
  failureCount: number;
  cause: unknown;
} {
  return Object.assign(new Error('Claude unified pending queue pump failure budget exhausted'), {
    name: 'ClaudeUnifiedPendingQueuePumpFailureBudgetExhaustedError',
    code: 'claude_unified_pending_queue_pump_failure_budget_exhausted' as const,
    failureCount,
    cause: error,
  });
}

async function waitForPausedArbiterRecheck(abortSignal: AbortSignal, delayMs: number): Promise<boolean> {
  if (abortSignal.aborted) return false;
  return await new Promise<boolean>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (keepGoing: boolean) => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      abortSignal.removeEventListener('abort', onAbort);
      resolve(keepGoing);
    };
    const onAbort = () => finish(false);
    abortSignal.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => finish(!abortSignal.aborted), delayMs);
  });
}

export function createClaudeUnifiedPendingQueuePump<Mode = unknown>(opts: Readonly<{
  inputConsumer: ClaudeUnifiedInputConsumer<Mode>;
  arbiter: Pick<ClaudeUnifiedInputArbiter<Mode>, 'enqueueUiMessage' | 'drainWhenSafe' | 'snapshot'>;
  pausedArbiterRecheckMs?: number | undefined;
  failureRetryBackoffMs?: number | undefined;
  maxConsecutiveHandledFailures?: number | undefined;
  /**
   * Called when a batch was already pulled from the input consumer but the pump
   * can no longer deliver it (aborted/disposed mid-wait, e.g. host-death
   * unwind). Lets the owner return the message to its queue instead of
   * permanently dropping it into a dead session.
   */
  onUndeliverableBatch?: (batch: MessageBatch<Mode, string>) => void;
  /**
   * A provider-acceptance pending batch already has a durable pending row claiming ownership, but
   * the terminal may still show the same text in the composer while awaiting provider proof.
   * Let the terminal owner register that exact text before the draft guard runs.
   */
  onProviderAcceptancePendingPrompt?: (batch: MessageBatch<Mode, string>) => void;
}>): ClaudeUnifiedPendingQueuePump<Mode> {
  let disposed = false;
  let runPromise: Promise<void> | null = null;

  const pumpOnceDetailed = async (pumpOpts: { abortSignal: AbortSignal }): Promise<PumpOnceResult> => {
    if (disposed || pumpOpts.abortSignal.aborted) {
      return { kind: 'stopped' };
    }
    let batch: MessageBatch<Mode, string> | null = null;
    try {
      batch = await opts.inputConsumer.waitForNextInput({ abortSignal: pumpOpts.abortSignal });
    } catch (error) {
      if (error instanceof PendingQueueMaterializationAuthError) {
        throw error;
      }
      logger.debug('[unified]: pending queue pump input wait failed (non-fatal)', error);
      return { kind: 'handled_failure', error };
    }
    if (!batch) {
      return { kind: 'stopped' };
    }
    if (pumpOpts.abortSignal.aborted || disposed) {
      opts.onUndeliverableBatch?.(batch);
      return { kind: 'stopped' };
    }
    if (batch.providerAcceptancePending === true) {
      opts.onProviderAcceptancePendingPrompt?.(batch);
    }
    try {
      await opts.arbiter.enqueueUiMessage({
        message: batch.message,
        mode: batch.mode,
        origin: { kind: 'ui_pending' },
        maxUserMessageSeq: batch.maxUserMessageSeq ?? null,
        userMessageLocalIds: batch.userMessageLocalIds ?? [],
      });
      await opts.arbiter.drainWhenSafe();
    } catch (error) {
      if (error instanceof PendingQueueMaterializationAuthError) {
        throw error;
      }
      logger.debug('[unified]: pending queue pump delivery failed (non-fatal)', error);
      opts.onUndeliverableBatch?.(batch);
      return { kind: 'handled_failure', error };
    }
    return { kind: 'delivered' };
  };

  const pumpOnce = async (pumpOpts: { abortSignal: AbortSignal }): Promise<boolean> => {
    return (await pumpOnceDetailed(pumpOpts)).kind === 'delivered';
  };

  const run = async (runOpts: { abortSignal: AbortSignal }): Promise<void> => {
    const pausedArbiterRecheckMs = Math.max(
      1,
      Math.trunc(opts.pausedArbiterRecheckMs ?? DEFAULT_PAUSED_ARBITER_RECHECK_MS),
    );
    const failureRetryBackoffMs = Math.max(
      1,
      Math.trunc(opts.failureRetryBackoffMs ?? DEFAULT_FAILURE_RETRY_BACKOFF_MS),
    );
    const maxConsecutiveHandledFailures = Math.max(
      1,
      Math.trunc(opts.maxConsecutiveHandledFailures ?? DEFAULT_MAX_CONSECUTIVE_HANDLED_FAILURES),
    );
    let consecutiveHandledFailures = 0;
    while (!disposed && !runOpts.abortSignal.aborted) {
      // Backpressure is local to the terminal arbiter: while a prompt is still waiting to be
      // injected or the head is waiting for provider acceptance, do not claim another durable
      // pending row from the server. Terminal-custody acceptances are exempt because Claude owns
      // those prompts and the arbiter can safely continue draining later input.
      if (shouldPausePumpForArbiterBackpressure(opts.arbiter.snapshot())) {
        const keepGoing = await waitForPausedArbiterRecheck(runOpts.abortSignal, pausedArbiterRecheckMs);
        if (!keepGoing) return;
        continue;
      }
      const pumped = await pumpOnceDetailed(runOpts);
      if (pumped.kind === 'stopped') return;
      if (pumped.kind === 'delivered') {
        consecutiveHandledFailures = 0;
        continue;
      }

      consecutiveHandledFailures += 1;
      if (consecutiveHandledFailures >= maxConsecutiveHandledFailures) {
        throw createPumpFailureBudgetExhaustedError(pumped.error, consecutiveHandledFailures);
      }
      const keepGoing = await waitForPausedArbiterRecheck(runOpts.abortSignal, failureRetryBackoffMs);
      if (!keepGoing) return;
    }
  };

  return {
    pumpOnce,
    async drainPending(drainOpts?: DrainPendingOptions): Promise<DrainPendingResult | null> {
      return await (opts.inputConsumer.drainPending?.(drainOpts) ?? Promise.resolve(null));
    },
    start(startOpts) {
      if (runPromise) return runPromise;
      if (disposed) return Promise.resolve();
      runPromise = run(startOpts).finally(() => {
        runPromise = null;
      });
      return runPromise;
    },
    dispose() {
      disposed = true;
    },
  };
}
