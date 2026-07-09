import { afterEach, describe, expect, it, vi } from 'vitest';

import { createClaudeUnifiedInputArbiter } from './createClaudeUnifiedInputArbiter';
import { createClaudeUnifiedPendingQueuePump } from './createClaudeUnifiedPendingQueuePump';
import { PendingQueueMaterializationAuthError } from '@/agent/runtime/sessionInput/SessionProviderInputConsumer';

const createIdleSnapshot = () => ({
  queuedCount: 0,
  pendingInjectionCount: 0,
  terminalCustodyCount: 0,
  providerAcceptancePendingCount: 0,
  disposed: false,
  turnState: 'idle' as const,
  permissionBlocked: false,
  userTyping: false,
  lastDeferredReason: null,
  lastFailureReason: null,
  currentHeadBlocker: null,
  headInputState: null,
});

describe('createClaudeUnifiedPendingQueuePump', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('enqueues batches already produced by SessionProviderInputConsumer without materializing again', async () => {
    const waitForNextInput = vi.fn().mockResolvedValue({
      message: 'from queue',
      mode: { permissionMode: 'default' },
      isolate: false,
      hash: 'same-mode',
    });
    const drainPending = vi.fn();
    const enqueueUiMessage = vi.fn().mockResolvedValue(undefined);
    const drainWhenSafe = vi.fn().mockResolvedValue(undefined);

    const pump = createClaudeUnifiedPendingQueuePump({
      inputConsumer: { waitForNextInput, drainPending },
      arbiter: { enqueueUiMessage, drainWhenSafe, snapshot: vi.fn(createIdleSnapshot) },
    });

    await pump.pumpOnce({ abortSignal: new AbortController().signal });

    expect(enqueueUiMessage).toHaveBeenCalledWith({
      message: 'from queue',
      mode: { permissionMode: 'default' },
      origin: { kind: 'ui_pending' },
      maxUserMessageSeq: null,
      userMessageLocalIds: [],
    });
    expect(drainWhenSafe).toHaveBeenCalledTimes(1);
    expect(drainPending).not.toHaveBeenCalled();
  });

  it('delegates explicit pending drain to SessionProviderInputConsumer', async () => {
    const drainPending = vi.fn().mockResolvedValue({ materialized: 2, stoppedReason: 'no_pending' });
    const pump = createClaudeUnifiedPendingQueuePump({
      inputConsumer: {
        waitForNextInput: vi.fn(),
        drainPending,
      },
      arbiter: { enqueueUiMessage: vi.fn(), drainWhenSafe: vi.fn(), snapshot: vi.fn(createIdleSnapshot) },
    });

    await expect(pump.drainPending({ reason: 'unified-test' })).resolves.toEqual({
      materialized: 2,
      stoppedReason: 'no_pending',
    });
    expect(drainPending).toHaveBeenCalledWith({ reason: 'unified-test' });
  });

  it('does not prefetch another pending input while the arbiter head waits for provider acceptance', async () => {
    const waitForNextInput = vi.fn()
      .mockResolvedValueOnce({
        message: 'old prompt awaiting Claude acceptance',
        mode: undefined,
        isolate: false,
        hash: 'h1',
        userMessageLocalIds: ['old-local'],
      })
      .mockResolvedValueOnce({
        message: 'new prompt should remain server-pending',
        mode: undefined,
        isolate: false,
        hash: 'h2',
        userMessageLocalIds: ['new-local'],
      })
      .mockResolvedValueOnce(null);
    const enqueueUiMessage = vi.fn().mockResolvedValue(undefined);
    const snapshot = vi.fn()
      .mockReturnValueOnce(createIdleSnapshot())
      .mockReturnValue({
        queuedCount: 1,
        pendingInjectionCount: 0,
        terminalCustodyCount: 0,
        providerAcceptancePendingCount: 1,
        disposed: false,
        turnState: 'idle',
        permissionBlocked: false,
        userTyping: false,
        lastDeferredReason: null,
        lastFailureReason: null,
        headInputState: 'awaiting_provider_acceptance',
      });
    const pump = createClaudeUnifiedPendingQueuePump({
      inputConsumer: { waitForNextInput },
      arbiter: {
        enqueueUiMessage,
        drainWhenSafe: vi.fn().mockResolvedValue(undefined),
        snapshot,
      },
    });

    const abortController = new AbortController();
    const running = pump.start({ abortSignal: abortController.signal });
    await Promise.resolve();
    await Promise.resolve();

    expect(waitForNextInput).toHaveBeenCalledTimes(1);
    expect(enqueueUiMessage).toHaveBeenCalledTimes(1);
    expect(enqueueUiMessage).toHaveBeenCalledWith(expect.objectContaining({
      message: 'old prompt awaiting Claude acceptance',
      userMessageLocalIds: ['old-local'],
    }));

    abortController.abort();
    await expect(running).resolves.toBeUndefined();
  });

  it('unparks after the arbiter provider-acceptance deadline resolves a compaction-blocked head', async () => {
    vi.useFakeTimers();
    let nowMs = 10_000;
    const injectPrompt = vi.fn(async (batch) => ({
      status: 'injected' as const,
      at: nowMs,
      bytesWritten: batch.message.length,
    }));
    const arbiter = createClaudeUnifiedInputArbiter({
      nowMs: () => nowMs,
      quietPeriodMs: 0,
      providerAcceptanceTimeoutMs: 40,
      injectPrompt,
      onInjectionFailure: vi.fn(async () => ({ action: 'claimed_pending_delivery' as const })),
    });
    arbiter.observeLifecycle({ type: 'turn_state', state: 'idle', observedAtMs: nowMs });
    arbiter.observeLifecycle({ type: 'output', observedAtMs: nowMs });

    const waitForNextInput = vi.fn()
      .mockResolvedValueOnce({
        message: 'old prompt awaiting Claude acceptance',
        mode: undefined,
        isolate: false,
        hash: 'h1',
        userMessageLocalIds: ['old-local'],
      })
      .mockResolvedValueOnce({
        message: 'new prompt should unpark after timeout',
        mode: undefined,
        isolate: false,
        hash: 'h2',
        userMessageLocalIds: ['new-local'],
      })
      .mockResolvedValueOnce(null);
    const pump = createClaudeUnifiedPendingQueuePump({
      inputConsumer: { waitForNextInput },
      arbiter,
      pausedArbiterRecheckMs: 5,
    });

    const abortController = new AbortController();
    const running = pump.start({ abortSignal: abortController.signal });
    await Promise.resolve();
    await Promise.resolve();

    expect(waitForNextInput).toHaveBeenCalledTimes(1);
    expect(injectPrompt).toHaveBeenCalledTimes(1);
    arbiter.observeLifecycle({
      type: 'compaction',
      phase: 'started',
      observedAtMs: nowMs,
    } as Parameters<typeof arbiter.observeLifecycle>[0]);

    nowMs += 85;
    await vi.advanceTimersByTimeAsync(85);
    await Promise.resolve();

    expect(waitForNextInput).toHaveBeenCalledTimes(2);
    expect(arbiter.snapshot()).toMatchObject({
      queuedCount: 1,
      pendingInjectionCount: 1,
      headInputState: 'waiting_for_readiness',
      lastDeferredReason: 'compaction',
    });
    abortController.abort();
    await expect(running).resolves.toBeUndefined();
    expect(injectPrompt.mock.calls.map(([batch]) => batch.message)).toEqual([
      'old prompt awaiting Claude acceptance',
    ]);
  });

  it('marks provider-acceptance pending batches as owned before arbiter delivery', async () => {
    const waitForNextInput = vi.fn().mockResolvedValue({
      message: 'prompt already claimed by pending-provider delivery',
      mode: undefined,
      isolate: false,
      hash: 'h1',
      maxUserMessageSeq: null,
      userMessageLocalIds: ['pending-provider-local'],
      providerAcceptancePending: true,
    });
    const events: string[] = [];
    const pump = createClaudeUnifiedPendingQueuePump({
      inputConsumer: { waitForNextInput },
      arbiter: {
        enqueueUiMessage: vi.fn(async () => {
          events.push('enqueue');
        }),
        drainWhenSafe: vi.fn(),
        snapshot: vi.fn(createIdleSnapshot),
      },
      onProviderAcceptancePendingPrompt: (batch) => {
        events.push(`owned:${batch.message}`);
      },
    });

    await pump.pumpOnce({ abortSignal: new AbortController().signal });

    expect(events).toEqual([
      'owned:prompt already claimed by pending-provider delivery',
      'enqueue',
    ]);
  });

  it('continues pumping when provider-acceptance work is already in terminal custody', async () => {
    const waitForNextInput = vi.fn()
      .mockResolvedValueOnce({
        message: 'first prompt in terminal custody',
        mode: undefined,
        isolate: false,
        hash: 'h1',
      })
      .mockResolvedValueOnce({
        message: 'second prompt can still drain',
        mode: undefined,
        isolate: false,
        hash: 'h2',
      })
      .mockResolvedValueOnce(null);
    const enqueueUiMessage = vi.fn().mockResolvedValue(undefined);
    const pump = createClaudeUnifiedPendingQueuePump({
      inputConsumer: { waitForNextInput },
      arbiter: {
        enqueueUiMessage,
        drainWhenSafe: vi.fn().mockResolvedValue(undefined),
        snapshot: vi.fn(() => ({
          ...createIdleSnapshot(),
          queuedCount: 1,
          terminalCustodyCount: 1,
          providerAcceptancePendingCount: 1,
          headInputState: 'submitted' as const,
        })),
      },
    });

    await pump.start({ abortSignal: new AbortController().signal });

    expect(waitForNextInput).toHaveBeenCalledTimes(3);
    expect(enqueueUiMessage.mock.calls.map(([batch]) => batch.message)).toEqual([
      'first prompt in terminal custody',
      'second prompt can still drain',
    ]);
  });

  it('continues pumping after a handled input wait failure instead of resolving the runner', async () => {
    vi.useFakeTimers();
    const error = new Error('pending materialization failed');
    const waitForNextInput = vi.fn()
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce({
        message: 'delivered after transient input failure',
        mode: undefined,
        isolate: false,
        hash: 'after-failure',
      })
      .mockResolvedValueOnce(null);
    const enqueueUiMessage = vi.fn().mockResolvedValue(undefined);
    const pump = createClaudeUnifiedPendingQueuePump({
      inputConsumer: {
        waitForNextInput,
      },
      arbiter: {
        enqueueUiMessage,
        drainWhenSafe: vi.fn().mockResolvedValue(undefined),
        snapshot: vi.fn(createIdleSnapshot),
      },
      failureRetryBackoffMs: 1,
    });

    const startResult: unknown = pump.start({ abortSignal: new AbortController().signal });
    const settled = vi.fn();
    void Promise.resolve(startResult).then(settled, settled);

    expect(startResult).toBeInstanceOf(Promise);
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await expect(startResult).resolves.toBeUndefined();
    expect(waitForNextInput).toHaveBeenCalledTimes(3);
    expect(enqueueUiMessage).toHaveBeenCalledWith(expect.objectContaining({
      message: 'delivered after transient input failure',
    }));
  });

  it('hands back a failed delivery and continues pumping later batches', async () => {
    vi.useFakeTimers();
    const error = new Error('drain failed');
    const onUndeliverableBatch = vi.fn();
    const waitForNextInput = vi.fn()
      .mockResolvedValueOnce({
        message: 'from queue',
        mode: undefined,
        isolate: false,
        hash: 'same-mode',
      })
      .mockResolvedValueOnce({
        message: 'next queue item',
        mode: undefined,
        isolate: false,
        hash: 'next-mode',
      })
      .mockResolvedValueOnce(null);
    const drainWhenSafe = vi.fn()
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce(undefined);
    const enqueueUiMessage = vi.fn().mockResolvedValue(undefined);
    const pump = createClaudeUnifiedPendingQueuePump({
      inputConsumer: {
        waitForNextInput,
      },
      arbiter: {
        enqueueUiMessage,
        drainWhenSafe,
        snapshot: vi.fn(createIdleSnapshot),
      },
      onUndeliverableBatch,
      failureRetryBackoffMs: 1,
    });

    const startResult: unknown = pump.start({ abortSignal: new AbortController().signal });

    expect(startResult).toBeInstanceOf(Promise);
    await vi.advanceTimersByTimeAsync(1);
    await expect(startResult).resolves.toBeUndefined();
    expect(onUndeliverableBatch).toHaveBeenCalledWith(expect.objectContaining({
      message: 'from queue',
    }));
    expect(enqueueUiMessage.mock.calls.map(([batch]) => batch.message)).toEqual([
      'from queue',
      'next queue item',
    ]);
    expect(drainWhenSafe).toHaveBeenCalledTimes(2);
  });

  it('rejects auth materialization failures so the launcher park-wait path can handle them', async () => {
    const authError = new PendingQueueMaterializationAuthError();
    const pump = createClaudeUnifiedPendingQueuePump({
      inputConsumer: {
        waitForNextInput: vi.fn().mockRejectedValue(authError),
      },
      arbiter: {
        enqueueUiMessage: vi.fn(),
        drainWhenSafe: vi.fn(),
        snapshot: vi.fn(createIdleSnapshot),
      },
    });

    await expect(pump.start({ abortSignal: new AbortController().signal })).rejects.toBe(authError);
  });

  it('rejects after a bounded run of handled delivery failures instead of silently stopping', async () => {
    vi.useFakeTimers();
    const waitForNextInput = vi.fn()
      .mockResolvedValue({
        message: 'repeat failure',
        mode: undefined,
        isolate: false,
        hash: 'repeat',
      });
    const pump = createClaudeUnifiedPendingQueuePump({
      inputConsumer: {
        waitForNextInput,
      },
      arbiter: {
        enqueueUiMessage: vi.fn().mockResolvedValue(undefined),
        drainWhenSafe: vi.fn().mockRejectedValue(new Error('persistent drain failure')),
        snapshot: vi.fn(createIdleSnapshot),
      },
      onUndeliverableBatch: vi.fn(),
      maxConsecutiveHandledFailures: 2,
      failureRetryBackoffMs: 1,
    });

    const running = pump.start({ abortSignal: new AbortController().signal });
    const rejected = expect(running).rejects.toMatchObject({
      code: 'claude_unified_pending_queue_pump_failure_budget_exhausted',
      failureCount: 2,
    });

    await vi.advanceTimersByTimeAsync(1);
    await rejected;
    expect(waitForNextInput).toHaveBeenCalledTimes(2);
  });

  it('hands an already-consumed batch back instead of dropping it when aborted during the input wait (silent queue-swallow fix)', async () => {
    const abortController = new AbortController();
    let resolveInput!: (value: { message: string; mode: undefined; isolate: boolean; hash: string }) => void;
    const enqueueUiMessage = vi.fn();
    const onUndeliverableBatch = vi.fn();
    const pump = createClaudeUnifiedPendingQueuePump({
      inputConsumer: {
        waitForNextInput: vi.fn(() => new Promise<{ message: string; mode: undefined; isolate: boolean; hash: string }>((resolve) => {
          resolveInput = resolve;
        })),
      },
      arbiter: { enqueueUiMessage, drainWhenSafe: vi.fn(), snapshot: vi.fn(createIdleSnapshot) },
      onUndeliverableBatch,
    });

    const pumping = pump.pumpOnce({ abortSignal: abortController.signal });
    abortController.abort();
    resolveInput({ message: 'arrived during unwind', mode: undefined, isolate: false, hash: 'h1' });

    await expect(pumping).resolves.toBe(false);
    expect(enqueueUiMessage).not.toHaveBeenCalled();
    expect(onUndeliverableBatch).toHaveBeenCalledWith(expect.objectContaining({
      message: 'arrived during unwind',
    }));
  });

  it('hands an already-consumed batch back when disposed during the input wait', async () => {
    let resolveInput!: (value: { message: string; mode: undefined; isolate: boolean; hash: string }) => void;
    const enqueueUiMessage = vi.fn();
    const onUndeliverableBatch = vi.fn();
    const pump = createClaudeUnifiedPendingQueuePump({
      inputConsumer: {
        waitForNextInput: vi.fn(() => new Promise<{ message: string; mode: undefined; isolate: boolean; hash: string }>((resolve) => {
          resolveInput = resolve;
        })),
      },
      arbiter: { enqueueUiMessage, drainWhenSafe: vi.fn(), snapshot: vi.fn(createIdleSnapshot) },
      onUndeliverableBatch,
    });

    const pumping = pump.pumpOnce({ abortSignal: new AbortController().signal });
    pump.dispose();
    resolveInput({ message: 'stolen by stale waiter', mode: undefined, isolate: false, hash: 'h2' });

    await expect(pumping).resolves.toBe(false);
    expect(enqueueUiMessage).not.toHaveBeenCalled();
    expect(onUndeliverableBatch).toHaveBeenCalledWith(expect.objectContaining({
      message: 'stolen by stale waiter',
    }));
  });

  it('resolves the running promise after disposal when the consumer stops', async () => {
    let resolveInput!: (value: null) => void;
    const pump = createClaudeUnifiedPendingQueuePump({
      inputConsumer: {
        waitForNextInput: vi.fn(() => new Promise<null>((resolve) => {
          resolveInput = resolve;
        })),
      },
      arbiter: { enqueueUiMessage: vi.fn(), drainWhenSafe: vi.fn(), snapshot: vi.fn(createIdleSnapshot) },
    });

    const startResult = pump.start({ abortSignal: new AbortController().signal });
    pump.dispose();
    resolveInput(null);

    await expect(startResult).resolves.toBeUndefined();
  });
});
