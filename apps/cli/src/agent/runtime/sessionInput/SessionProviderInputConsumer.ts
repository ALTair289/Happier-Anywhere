import type { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';
import { readAuthenticationStatus } from '@/api/client/httpStatusError';
import { configuration } from '@/configuration';
import { logger } from '@/ui/logger';
import {
  DEFAULT_SESSION_METADATA_WAIT_RETRY_BACKOFF_MS,
  waitForSessionMetadataRetryBackoff,
} from '@/agent/runtime/sessionMetadataWaitRetryBackoff';

import type {
  DrainPendingOptions,
  DrainPendingResult,
  MessageBatch,
  PendingMaterializationActiveTurnPolicy,
  PendingQueueDeliveryTiming,
  PendingMaterializationReconcileWhenEmpty,
  PendingMaterializationResult,
  SessionProviderInputConsumer,
} from './types';
import { PENDING_QUEUE_ONE_AT_A_TIME_MAX_POP_PER_WAKE } from './pendingQueueDrainPolicy';

export class PendingQueueMaterializationAuthError extends Error {
  constructor() {
    super('Pending queue materialization stopped after supervisor authentication failure');
    this.name = 'PendingQueueMaterializationAuthError';
  }
}

export interface SessionProviderInputConsumerSession {
  materializeNextPendingMessageSafely?: ((opts?: {
    reconcileWhenEmpty?: PendingMaterializationReconcileWhenEmpty;
    activeTurnDeliveryPolicy?: PendingMaterializationActiveTurnPolicy;
    pendingQueueDeliveryTiming?: PendingQueueDeliveryTiming;
  }) => Promise<PendingMaterializationResult>) | undefined;
  popPendingMessage: () => Promise<boolean>;
  shouldAttemptPendingMaterialization?: ((opts?: {
    activeTurnDeliveryPolicy?: PendingMaterializationActiveTurnPolicy;
    pendingQueueDeliveryTiming?: PendingQueueDeliveryTiming;
  }) => boolean) | undefined;
  reconcilePendingQueueState?: ((opts: { force: boolean }) => unknown | Promise<unknown>) | undefined;
  waitForMetadataUpdate: (abortSignal?: AbortSignal) => Promise<boolean>;
}

export interface SessionProviderInputConsumerOptions<Mode, Message> {
  messageQueue: MessageQueue2<Mode, Message>;
  session: SessionProviderInputConsumerSession;
  onMetadataUpdate?: (() => void | Promise<void>) | null | undefined;
  reconcileWhenEmpty?: PendingMaterializationReconcileWhenEmpty | undefined;
  activeTurnDeliveryPolicy?: PendingMaterializationActiveTurnPolicy | undefined;
  resolveActiveTurnDeliveryPolicy?: (() => PendingMaterializationActiveTurnPolicy | undefined) | undefined;
  pendingQueueDeliveryTiming?: PendingQueueDeliveryTiming | undefined;
  resolvePendingQueueDeliveryTiming?: (() => PendingQueueDeliveryTiming | undefined) | undefined;
  idleWakePollIntervalMs?: number | undefined;
  metadataWaitRetryBackoffMs?: number | undefined;
  pendingDrainMaxPopPerWake?: number | undefined;
}

type WakeWinner = { kind: 'queue'; hasMessages: boolean } | { kind: 'meta'; ok: boolean } | { kind: 'idle' };

function buildMaterializeOptions(
  reconcileWhenEmpty: PendingMaterializationReconcileWhenEmpty,
  activeTurnDeliveryPolicy: PendingMaterializationActiveTurnPolicy | undefined,
  pendingQueueDeliveryTiming: PendingQueueDeliveryTiming | undefined,
): {
  reconcileWhenEmpty: PendingMaterializationReconcileWhenEmpty;
  activeTurnDeliveryPolicy?: PendingMaterializationActiveTurnPolicy;
  pendingQueueDeliveryTiming?: PendingQueueDeliveryTiming;
} {
  return {
    reconcileWhenEmpty,
    ...(activeTurnDeliveryPolicy ? { activeTurnDeliveryPolicy } : {}),
    ...(pendingQueueDeliveryTiming ? { pendingQueueDeliveryTiming } : {}),
  };
}

function readActiveTurnDeliveryPolicy(opts: {
  activeTurnDeliveryPolicy?: PendingMaterializationActiveTurnPolicy | undefined;
  resolveActiveTurnDeliveryPolicy?: (() => PendingMaterializationActiveTurnPolicy | undefined) | undefined;
}): PendingMaterializationActiveTurnPolicy | undefined {
  return opts.resolveActiveTurnDeliveryPolicy?.() ?? opts.activeTurnDeliveryPolicy;
}

function readPendingQueueDeliveryTiming(opts: {
  pendingQueueDeliveryTiming?: PendingQueueDeliveryTiming | undefined;
  resolvePendingQueueDeliveryTiming?: (() => PendingQueueDeliveryTiming | undefined) | undefined;
}): PendingQueueDeliveryTiming | undefined {
  return opts.resolvePendingQueueDeliveryTiming?.() ?? opts.pendingQueueDeliveryTiming;
}

function buildAttemptOptions(
  activeTurnDeliveryPolicy: PendingMaterializationActiveTurnPolicy | undefined,
  pendingQueueDeliveryTiming: PendingQueueDeliveryTiming | undefined,
): {
  activeTurnDeliveryPolicy?: PendingMaterializationActiveTurnPolicy;
  pendingQueueDeliveryTiming?: PendingQueueDeliveryTiming;
} {
  return {
    ...(activeTurnDeliveryPolicy ? { activeTurnDeliveryPolicy } : {}),
    ...(pendingQueueDeliveryTiming ? { pendingQueueDeliveryTiming } : {}),
  };
}

function logInputConsumerMaterializationDecision(opts: {
  source: 'waitForNextInput' | 'drainPending';
  reconcileWhenEmpty: PendingMaterializationReconcileWhenEmpty;
  activeTurnDeliveryPolicy: PendingMaterializationActiveTurnPolicy | undefined;
  result: PendingMaterializationResult;
}): void {
  logger.debug('[pendingQueue] input consumer materialization decision', {
    source: opts.source,
    reconcileWhenEmpty: opts.reconcileWhenEmpty,
    activeTurnDeliveryPolicy: opts.activeTurnDeliveryPolicy ?? 'block',
    resultType: opts.result.type,
    ...(opts.result.type === 'materialized'
      ? {
          localId: opts.result.localId,
          seq: opts.result.seq,
        }
      : {}),
    ...(opts.result.type === 'deferred' ? { deferredReason: opts.result.reason } : {}),
  });
}

export function createSessionProviderInputConsumer<Mode, Message>(
  opts: SessionProviderInputConsumerOptions<Mode, Message>,
): SessionProviderInputConsumer<Mode, Message> {
  let waitForNextInputTurn: Promise<void> = Promise.resolve();

  return {
    async waitForNextInput(waitOpts) {
      const previousTurn = waitForNextInputTurn;
      let releaseTurn: () => void = () => {};
      const currentTurn = new Promise<void>((resolve) => {
        releaseTurn = resolve;
      });
      waitForNextInputTurn = previousTurn.catch(() => undefined).then(() => currentTurn);

      try {
        const canStart = await waitForSerializedWaitTurn(previousTurn, waitOpts.abortSignal);
        if (!canStart || waitOpts.abortSignal.aborted) {
          return null;
        }
        return await waitForNextInput({ ...opts, abortSignal: waitOpts.abortSignal });
      } finally {
        releaseTurn();
      }
    },
    async drainPending(drainOpts) {
      return await drainPendingMessages(withDefaultDrainOptions(
        opts.session,
        opts.pendingDrainMaxPopPerWake,
        opts.activeTurnDeliveryPolicy,
        opts.resolveActiveTurnDeliveryPolicy,
        opts.pendingQueueDeliveryTiming,
        opts.resolvePendingQueueDeliveryTiming,
        drainOpts,
      ));
    },
  };
}

async function waitForSerializedWaitTurn(previousTurn: Promise<void>, abortSignal: AbortSignal): Promise<boolean> {
  if (abortSignal.aborted) {
    return false;
  }

  return await new Promise<boolean>((resolve) => {
    let done = false;

    const finish = (canStart: boolean) => {
      if (done) return;
      done = true;
      abortSignal.removeEventListener('abort', onAbort);
      resolve(canStart);
    };

    const onAbort = () => finish(false);
    abortSignal.addEventListener('abort', onAbort, { once: true });

    previousTurn.then(
      () => finish(true),
      () => finish(true),
    );
  });
}

export function createSessionProviderPendingDrainAdapter(
  session: SessionProviderInputConsumerSession,
  defaults?: Pick<
    DrainPendingOptions,
    | 'maxPopPerWake'
    | 'activeTurnDeliveryPolicy'
    | 'resolveActiveTurnDeliveryPolicy'
    | 'pendingQueueDeliveryTiming'
    | 'resolvePendingQueueDeliveryTiming'
  >,
): Pick<SessionProviderInputConsumer<never, never>, 'drainPending'> {
  return {
    async drainPending(drainOpts) {
      return await drainPendingMessages(withDefaultDrainOptions(
        session,
        defaults?.maxPopPerWake,
        defaults?.activeTurnDeliveryPolicy,
        defaults?.resolveActiveTurnDeliveryPolicy,
        defaults?.pendingQueueDeliveryTiming,
        defaults?.resolvePendingQueueDeliveryTiming,
        drainOpts,
      ));
    },
  };
}

async function waitForNextInput<Mode, Message>(
  opts: SessionProviderInputConsumerOptions<Mode, Message> & { abortSignal: AbortSignal },
): Promise<MessageBatch<Mode, Message> | null> {
  const idleWakePollIntervalMs = opts.idleWakePollIntervalMs ?? configuration.pendingQueueIdleWakePollIntervalMs;
  const metadataWaitRetryBackoffMs = opts.metadataWaitRetryBackoffMs ?? DEFAULT_SESSION_METADATA_WAIT_RETRY_BACKOFF_MS;
  // When explicitly enabled, idle-timer wakes upgrade the empty-queue reconcile
  // policy to 'throttled' so suspected lost pending-changed nudges can self-heal.
  // The default is disabled; normal wakeups should come from server metadata
  // updates and reconnect catch-up rather than periodic polling.
  let wokeByIdleTimer = false;

  while (true) {
    if (opts.abortSignal.aborted) {
      return null;
    }

    const existingBatch = await collectQueuedBatch(opts.messageQueue, opts.abortSignal);
    if (existingBatch) {
      await callMetadataUpdate(opts.onMetadataUpdate);
      if (opts.abortSignal.aborted) {
        return null;
      }
      return existingBatch;
    }

    await materializePendingMessage(
      wokeByIdleTimer
        ? { ...opts, reconcileWhenEmpty: opts.reconcileWhenEmpty === 'force' ? 'force' : 'throttled' }
        : opts,
    );
    wokeByIdleTimer = false;

    const materializedBatch = await collectQueuedBatch(opts.messageQueue, opts.abortSignal);
    if (materializedBatch) {
      await callMetadataUpdate(opts.onMetadataUpdate);
      if (opts.abortSignal.aborted) {
        return null;
      }
      return materializedBatch;
    }

    const controller = new AbortController();
    const onAbort = () => controller.abort();
    opts.abortSignal.addEventListener('abort', onAbort, { once: true });
    if (opts.abortSignal.aborted) {
      controller.abort();
    }

    try {
      const winner = await waitForWakeSignal({
        messageQueue: opts.messageQueue,
        waitForMetadataUpdate: opts.session.waitForMetadataUpdate,
        controller,
        idleWakePollIntervalMs,
        metadataWaitRetryBackoffMs,
      });

      if (winner.kind === 'meta' && !winner.ok) {
        controller.abort('sessionProviderInputConsumer-meta-false');

        if (opts.abortSignal.aborted) {
          return null;
        }

        continue;
      }

      controller.abort('sessionProviderInputConsumer');

      if (winner.kind === 'queue') {
        if (!winner.hasMessages) {
          return null;
        }
        await callMetadataUpdate(opts.onMetadataUpdate);
        if (opts.abortSignal.aborted) {
          return null;
        }
        return await opts.messageQueue.waitForMessagesAndGetAsString(opts.abortSignal);
      }

      if (winner.kind === 'idle') {
        wokeByIdleTimer = true;
        await callMetadataUpdate(opts.onMetadataUpdate);
        if (opts.abortSignal.aborted) {
          return null;
        }
        continue;
      }

      if (winner.kind === 'meta') {
        await callMetadataUpdate(opts.onMetadataUpdate);
      }
    } finally {
      opts.abortSignal.removeEventListener('abort', onAbort);
    }
  }
}

async function collectQueuedBatch<Mode, Message>(
  messageQueue: MessageQueue2<Mode, Message>,
  abortSignal: AbortSignal,
): Promise<MessageBatch<Mode, Message> | null> {
  if (messageQueue.size() <= 0) {
    return null;
  }
  return await messageQueue.waitForMessagesAndGetAsString(abortSignal);
}

async function materializePendingMessage<Mode, Message>(
  opts: SessionProviderInputConsumerOptions<Mode, Message>,
): Promise<void> {
  const safeMaterialize = opts.session.materializeNextPendingMessageSafely;
  if (safeMaterialize) {
    const reconcileWhenEmpty = opts.reconcileWhenEmpty ?? 'skip';
    const activeTurnDeliveryPolicy = readActiveTurnDeliveryPolicy(opts);
    const pendingQueueDeliveryTiming = readPendingQueueDeliveryTiming(opts);
    const result = await safeMaterialize(buildMaterializeOptions(
      reconcileWhenEmpty,
      activeTurnDeliveryPolicy,
      pendingQueueDeliveryTiming,
    ));
    logInputConsumerMaterializationDecision({
      source: 'waitForNextInput',
      reconcileWhenEmpty,
      activeTurnDeliveryPolicy,
      result,
    });
    if (result.type === 'materialized') {
      // The transcript update path owns queue delivery; do not synthesize a provider batch from the pending payload.
      return;
    }
    if (result.type === 'deferred' && result.reason === 'supervisor_auth_failed') {
      throw new PendingQueueMaterializationAuthError();
    }
    return;
  }

  if (!(opts.session.shouldAttemptPendingMaterialization?.(buildAttemptOptions(
    readActiveTurnDeliveryPolicy(opts),
    readPendingQueueDeliveryTiming(opts),
  )) ?? true)) {
    return;
  }

  await opts.session.popPendingMessage();
}

function withDefaultDrainOptions(
  session: SessionProviderInputConsumerSession,
  defaultMaxPopPerWake: number | undefined,
  defaultActiveTurnDeliveryPolicy: PendingMaterializationActiveTurnPolicy | undefined,
  defaultResolveActiveTurnDeliveryPolicy: (() => PendingMaterializationActiveTurnPolicy | undefined) | undefined,
  defaultPendingQueueDeliveryTiming: PendingQueueDeliveryTiming | undefined,
  defaultResolvePendingQueueDeliveryTiming: (() => PendingQueueDeliveryTiming | undefined) | undefined,
  drainOpts: DrainPendingOptions | undefined,
): DrainPendingOptions & { session: SessionProviderInputConsumerSession } {
  const drainPolicyOverride = drainOpts?.activeTurnDeliveryPolicy !== undefined;
  const deliveryTimingOverride = drainOpts?.pendingQueueDeliveryTiming !== undefined;

  return {
    ...(drainOpts ?? {}),
    session,
    maxPopPerWake: drainOpts?.maxPopPerWake ?? defaultMaxPopPerWake,
    activeTurnDeliveryPolicy: drainOpts?.activeTurnDeliveryPolicy ?? defaultActiveTurnDeliveryPolicy,
    resolveActiveTurnDeliveryPolicy: drainOpts?.resolveActiveTurnDeliveryPolicy
      ?? (drainPolicyOverride ? undefined : defaultResolveActiveTurnDeliveryPolicy),
    pendingQueueDeliveryTiming: drainOpts?.pendingQueueDeliveryTiming ?? defaultPendingQueueDeliveryTiming,
    resolvePendingQueueDeliveryTiming: drainOpts?.resolvePendingQueueDeliveryTiming
      ?? (deliveryTimingOverride ? undefined : defaultResolvePendingQueueDeliveryTiming),
  };
}

async function drainPendingMessages(
  opts: DrainPendingOptions & { session: SessionProviderInputConsumerSession },
): Promise<DrainPendingResult> {
  const maxPopPerWake = Math.max(1, Math.trunc(opts.maxPopPerWake ?? PENDING_QUEUE_ONE_AT_A_TIME_MAX_POP_PER_WAKE));
  let materialized = 0;

  for (let i = 0; i < maxPopPerWake; i += 1) {
    try {
      if (opts.abortSignal?.aborted) {
        return { materialized, stoppedReason: 'aborted' };
      }
      if (opts.shouldContinue && !opts.shouldContinue()) {
        return { materialized, stoppedReason: 'drain_disallowed' };
      }

      const activeTurnDeliveryPolicy = readActiveTurnDeliveryPolicy(opts);
      const pendingQueueDeliveryTiming = readPendingQueueDeliveryTiming(opts);
      const attemptOpts = buildAttemptOptions(activeTurnDeliveryPolicy, pendingQueueDeliveryTiming);
      const canMaterialize = opts.session.shouldAttemptPendingMaterialization?.(attemptOpts) ?? true;
      if (!canMaterialize) {
        await opts.session.reconcilePendingQueueState?.({ force: true });
        if (opts.abortSignal?.aborted) {
          return { materialized, stoppedReason: 'aborted' };
        }
        if (!(opts.session.shouldAttemptPendingMaterialization?.(attemptOpts) ?? true)) {
          return { materialized, stoppedReason: 'materialization_blocked' };
        }
      }

      const result = await materializeNextPendingForDrain(opts.session, opts);
      if (result === 'materialized') {
        materialized += 1;
        continue;
      }
      return { materialized, stoppedReason: result };
    } catch (error) {
      return { materialized, stoppedReason: readDrainErrorStoppedReason(error, opts) };
    }
  }

  return { materialized, stoppedReason: 'max_pop_per_wake' };
}

async function materializeNextPendingForDrain(
  session: SessionProviderInputConsumerSession,
  opts: DrainPendingOptions,
): Promise<Exclude<DrainPendingResult['stoppedReason'], 'aborted' | 'drain_disallowed' | 'materialization_blocked' | 'max_pop_per_wake'> | 'materialized'> {
  const safeMaterialize = session.materializeNextPendingMessageSafely;
  if (safeMaterialize) {
    try {
      const reconcileWhenEmpty = 'force';
      const activeTurnDeliveryPolicy = readActiveTurnDeliveryPolicy(opts);
      const pendingQueueDeliveryTiming = readPendingQueueDeliveryTiming(opts);
      const result = await safeMaterialize(buildMaterializeOptions(
        reconcileWhenEmpty,
        activeTurnDeliveryPolicy,
        pendingQueueDeliveryTiming,
      ));
      logInputConsumerMaterializationDecision({
        source: 'drainPending',
        reconcileWhenEmpty,
        activeTurnDeliveryPolicy,
        result,
      });
      if (result.type === 'materialized') {
        return 'materialized';
      }
      if (result.type === 'deferred') {
        if (result.reason === 'supervisor_auth_failed') {
          logTerminalAuthDrainStop(opts, null);
          return 'auth_failure';
        }
        return 'deferred';
      }
      return 'no_pending';
    } catch (error) {
      return readDrainErrorStoppedReason(error, opts);
    }
  }

  try {
    const didPop = await session.popPendingMessage();
    return didPop ? 'materialized' : 'no_pending';
  } catch (error) {
    return readDrainErrorStoppedReason(error, opts);
  }
}

function readDrainErrorStoppedReason(error: unknown, opts: DrainPendingOptions): 'auth_failure' | 'error' {
  const terminalAuthStatus = readAuthenticationStatus(error);
  if (terminalAuthStatus !== null) {
    logTerminalAuthDrainStop(opts, terminalAuthStatus);
    return 'auth_failure';
  }
  return 'error';
}

function logTerminalAuthDrainStop(opts: DrainPendingOptions, status: 401 | 403 | null): void {
  logger.debug(`${opts.logPrefix ?? '[INPUT-CONSUMER]'} Stopping pending queue drain after terminal auth failure`, {
    ...(status !== null ? { status } : {}),
    ...(opts.reason ? { reason: opts.reason } : {}),
  });
}

async function waitForWakeSignal<Mode, Message>(opts: {
  messageQueue: MessageQueue2<Mode, Message>;
  waitForMetadataUpdate: (abortSignal?: AbortSignal) => Promise<boolean>;
  controller: AbortController;
  idleWakePollIntervalMs: number;
  metadataWaitRetryBackoffMs: number;
}): Promise<WakeWinner> {
  const queueWait = opts.messageQueue
    .waitForMessagesSignal(opts.controller.signal)
    .then((hasMessages) => ({ kind: 'queue' as const, hasMessages }));
  const idleWait = createIdleWakeWait(opts.idleWakePollIntervalMs, opts.controller.signal);

  try {
    while (true) {
      if (opts.controller.signal.aborted) {
        return { kind: 'meta', ok: false };
      }

      const metaWait = opts.waitForMetadataUpdate(opts.controller.signal)
        .then(
          (ok) => ({ kind: 'meta' as const, ok }),
          () => ({ kind: 'meta' as const, ok: false }),
        );

      const winner = await Promise.race([queueWait, ...(idleWait ? [idleWait.promise] : []), metaWait]);
      if (winner.kind !== 'meta' || winner.ok || opts.controller.signal.aborted) {
        return winner;
      }

      const queueIdleOrBackoffWinner = await Promise.race([
        queueWait,
        ...(idleWait ? [idleWait.promise] : []),
        waitForSessionMetadataRetryBackoff({
          abortSignal: opts.controller.signal,
          backoffMs: opts.metadataWaitRetryBackoffMs,
        }).then(() => null),
      ]);
      if (queueIdleOrBackoffWinner) {
        return queueIdleOrBackoffWinner;
      }
    }
  } finally {
    idleWait?.cancel();
  }
}

function createIdleWakeWait(
  idleWakePollIntervalMs: number,
  abortSignal: AbortSignal,
): { promise: Promise<WakeWinner>; cancel: () => void } | null {
  if (idleWakePollIntervalMs <= 0) {
    return null;
  }

  let done = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let resolveWait: ((winner: WakeWinner) => void) | null = null;

  const cleanup = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    abortSignal.removeEventListener('abort', onAbort);
  };

  const finish = (winner: WakeWinner) => {
    if (done) return;
    done = true;
    cleanup();
    resolveWait?.(winner);
  };

  const onAbort = () => finish({ kind: 'meta', ok: false });

  const promise = new Promise<WakeWinner>((resolve) => {
    resolveWait = resolve;
    timer = setTimeout(() => finish({ kind: 'idle' }), idleWakePollIntervalMs);
    timer.unref?.();
    abortSignal.addEventListener('abort', onAbort, { once: true });
    if (abortSignal.aborted) {
      onAbort();
    }
  });

  return {
    promise,
    cancel: cleanup,
  };
}

async function callMetadataUpdate(onMetadataUpdate: (() => void | Promise<void>) | null | undefined): Promise<void> {
  try {
    await onMetadataUpdate?.();
  } catch {
    // Non-fatal: metadata reconciliation should not break the message loop.
  }
}
