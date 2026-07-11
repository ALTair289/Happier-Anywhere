import { describe, expect, it, vi } from 'vitest';

import { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';
import { HttpStatusError } from '@/api/client/httpStatusError';
import type { MaterializeNextPendingResult } from '@/api/session/sessionClientPort';
import { logger } from '@/ui/logger';

import {
  createSessionProviderInputConsumer,
  createSessionProviderPendingDrainAdapter,
  PendingQueueMaterializationAuthError,
} from './SessionProviderInputConsumer';
import type { DrainPendingOptions, DrainPendingResult } from './types';

type TestMode = { id: string };
type ConsumerWithDrain = ReturnType<typeof createSessionProviderInputConsumer<TestMode, string>> & {
  drainPending?: (opts?: DrainPendingOptions) => Promise<DrainPendingResult>;
};

function createDrainConsumer(
  session: Parameters<typeof createSessionProviderInputConsumer<TestMode, string>>[0]['session'],
  options: Partial<Omit<Parameters<typeof createSessionProviderInputConsumer<TestMode, string>>[0], 'messageQueue' | 'session'>> = {},
): ConsumerWithDrain {
  return createSessionProviderInputConsumer({
    messageQueue: new MessageQueue2<TestMode>(() => 'hash'),
    session,
    ...options,
  }) as ConsumerWithDrain;
}

describe('SessionProviderInputConsumer drainPending', () => {
  it('drains one pending message per wake by default', async () => {
    const materializeNextPendingMessageSafely = vi
      .fn<() => Promise<MaterializeNextPendingResult>>()
      .mockResolvedValue({
        type: 'materialized',
        localId: 'local-safe',
        seq: 7,
        content: null,
      });

    const consumer = createDrainConsumer({
      materializeNextPendingMessageSafely,
      waitForMetadataUpdate: async () => false,
    });

    await expect(consumer.drainPending?.({ reason: 'test-default-one' })).resolves.toEqual({
      materialized: 1,
      stoppedReason: 'max_pop_per_wake',
    });
    expect(materializeNextPendingMessageSafely).toHaveBeenCalledTimes(1);
  });

  it('uses structured pending materialization for every drain', async () => {
    const materializeNextPendingMessageSafely = vi
      .fn<() => Promise<MaterializeNextPendingResult>>()
      .mockResolvedValueOnce({
        type: 'materialized',
        localId: 'local-safe',
        seq: 7,
        content: null,
      })
      .mockResolvedValueOnce({ type: 'no_pending' });

    const consumer = createDrainConsumer({
      materializeNextPendingMessageSafely,
      waitForMetadataUpdate: async () => false,
    });

    expect(consumer.drainPending).toEqual(expect.any(Function));
    await expect(consumer.drainPending?.({ maxPopPerWake: 5, reason: 'test-safe' })).resolves.toEqual({
      materialized: 1,
      stoppedReason: 'no_pending',
    });
    expect(materializeNextPendingMessageSafely).toHaveBeenCalledWith({ reconcileWhenEmpty: 'force' });
  });

  it('reconciles before stopping when materialization is disallowed', async () => {
    const reconcilePendingQueueState = vi.fn(async () => false);

    const consumer = createDrainConsumer({
      materializeNextPendingMessageSafely: vi.fn(async () => ({ type: 'no_pending' as const })),
      shouldAttemptPendingMaterialization: () => false,
      reconcilePendingQueueState,
      waitForMetadataUpdate: async () => false,
    });

    expect(consumer.drainPending).toEqual(expect.any(Function));
    await expect(consumer.drainPending?.({ reason: 'test-disallowed' })).resolves.toEqual({
      materialized: 0,
      stoppedReason: 'materialization_blocked',
    });
    expect(reconcilePendingQueueState).toHaveBeenCalledWith({ force: true });
  });

  it('passes the active-turn delivery policy into the drain preflight gate', async () => {
    const shouldAttemptPendingMaterialization = vi.fn((
      opts?: { activeTurnDeliveryPolicy?: 'block' | 'allow_live_delivery' },
    ) => opts?.activeTurnDeliveryPolicy === 'allow_live_delivery');
    const materializeNextPendingMessageSafely = vi
      .fn<() => Promise<MaterializeNextPendingResult>>()
      .mockResolvedValue({
        type: 'materialized',
        localId: 'local-live',
        seq: 11,
        content: null,
      });

    const consumer = createDrainConsumer(
      {
        materializeNextPendingMessageSafely,
        shouldAttemptPendingMaterialization,
        waitForMetadataUpdate: async () => false,
      },
      { activeTurnDeliveryPolicy: 'allow_live_delivery' },
    );

    await expect(consumer.drainPending?.({ reason: 'test-live-preflight' })).resolves.toEqual({
      materialized: 1,
      stoppedReason: 'max_pop_per_wake',
    });
    expect(shouldAttemptPendingMaterialization).toHaveBeenCalledWith({
      activeTurnDeliveryPolicy: 'allow_live_delivery',
    });
    expect(materializeNextPendingMessageSafely).toHaveBeenCalledWith({
      reconcileWhenEmpty: 'force',
      activeTurnDeliveryPolicy: 'allow_live_delivery',
    });
  });

  it('lets an explicit drain active-turn policy override a default resolver', async () => {
    const shouldAttemptPendingMaterialization = vi.fn(() => true);
    const materializeNextPendingMessageSafely = vi
      .fn<() => Promise<MaterializeNextPendingResult>>()
      .mockResolvedValue({ type: 'no_pending' });

    const consumer = createDrainConsumer(
      {
        materializeNextPendingMessageSafely,
        shouldAttemptPendingMaterialization,
        waitForMetadataUpdate: async () => false,
      },
      { resolveActiveTurnDeliveryPolicy: () => 'allow_live_delivery' },
    );

    await expect(consumer.drainPending?.({
      reason: 'test-explicit-block-over-default-resolver',
      activeTurnDeliveryPolicy: 'block',
    })).resolves.toEqual({
      materialized: 0,
      stoppedReason: 'no_pending',
    });
    expect(shouldAttemptPendingMaterialization).toHaveBeenCalledWith({
      activeTurnDeliveryPolicy: 'block',
    });
    expect(materializeNextPendingMessageSafely).toHaveBeenCalledWith({
      reconcileWhenEmpty: 'force',
      activeTurnDeliveryPolicy: 'block',
    });
  });

  it('passes adapter default active-turn policy into pending materialization', async () => {
    const shouldAttemptPendingMaterialization = vi.fn((
      opts?: { activeTurnDeliveryPolicy?: 'block' | 'allow_live_delivery' },
    ) => opts?.activeTurnDeliveryPolicy === 'allow_live_delivery');
    const materializeNextPendingMessageSafely = vi
      .fn<() => Promise<MaterializeNextPendingResult>>()
      .mockResolvedValue({
        type: 'materialized',
        localId: 'local-adapter-live',
        seq: 12,
        content: null,
      });

    const adapter = createSessionProviderPendingDrainAdapter(
      {
        materializeNextPendingMessageSafely,
        shouldAttemptPendingMaterialization,
        waitForMetadataUpdate: async () => false,
      },
      { activeTurnDeliveryPolicy: 'allow_live_delivery' },
    );

    await expect(adapter.drainPending({ reason: 'test-adapter-live-preflight' })).resolves.toEqual({
      materialized: 1,
      stoppedReason: 'max_pop_per_wake',
    });
    expect(shouldAttemptPendingMaterialization).toHaveBeenCalledWith({
      activeTurnDeliveryPolicy: 'allow_live_delivery',
    });
    expect(materializeNextPendingMessageSafely).toHaveBeenCalledWith({
      reconcileWhenEmpty: 'force',
      activeTurnDeliveryPolicy: 'allow_live_delivery',
    });
  });

  it('returns an error result when reconciliation fails during drain', async () => {
    const reconcilePendingQueueState = vi.fn(async () => {
      throw new Error('reconcile failed');
    });

    const consumer = createDrainConsumer({
      materializeNextPendingMessageSafely: vi.fn(async () => ({ type: 'no_pending' as const })),
      shouldAttemptPendingMaterialization: () => false,
      reconcilePendingQueueState,
      waitForMetadataUpdate: async () => false,
    });

    await expect(consumer.drainPending({ reason: 'test-reconcile-error' })).resolves.toEqual({
      materialized: 0,
      stoppedReason: 'error',
    });
    expect(reconcilePendingQueueState).toHaveBeenCalledWith({ force: true });
  });

  it('stops after terminal auth failure without throwing', async () => {
    const materializeNextPendingMessageSafely = vi.fn(async () => {
      throw new HttpStatusError(401, 'Authentication failed');
    });

    const consumer = createDrainConsumer({
      materializeNextPendingMessageSafely,
      waitForMetadataUpdate: async () => false,
    });

    expect(consumer.drainPending).toEqual(expect.any(Function));
    await expect(consumer.drainPending?.({ maxPopPerWake: 5, reason: 'test-auth' })).resolves.toEqual({
      materialized: 0,
      stoppedReason: 'auth_failure',
    });
    expect(materializeNextPendingMessageSafely).toHaveBeenCalledTimes(1);
  });

  it('routes a typed unavailable materializer through the keyed exhaustion policy', async () => {
    const materializeNextPendingMessageSafely = vi.fn(async () => ({ type: 'retryable_transport' as const }));
    const onPendingMaterializationRetryEpisodeExhausted = vi.fn();

    const consumer = createDrainConsumer(
      {
        materializeNextPendingMessageSafely,
        waitForMetadataUpdate: async () => false,
      },
      {
        pendingMaterializationRetryEpisode: {
          maxAttempts: 1,
          initialDelayMs: 0,
          maxDelayMs: 0,
          jitterMs: 0,
        },
        onPendingMaterializationRetryEpisodeExhausted,
      },
    );

    await expect(consumer.drainPending?.({ reason: 'test-legacy-pop-name' })).resolves.toEqual({
      materialized: 0,
      stoppedReason: 'error',
    });
    expect(onPendingMaterializationRetryEpisodeExhausted).toHaveBeenCalledWith({ attemptCount: 1 });
    expect(materializeNextPendingMessageSafely).toHaveBeenCalledTimes(1);
  });
});

describe('SessionProviderInputConsumer waitForNextInput', () => {
  it('serializes overlapping waits without duplicating queued messages', async () => {
    const messageQueue = new MessageQueue2<TestMode>(() => 'hash');
    const firstAbortController = new AbortController();
    const secondAbortController = new AbortController();
    const materializeNextPendingMessageSafely = vi.fn(async () => ({ type: 'no_pending' as const }));

    const consumer = createSessionProviderInputConsumer({
      messageQueue,
      session: {
        materializeNextPendingMessageSafely,
        shouldAttemptPendingMaterialization: () => false,
        waitForMetadataUpdate: () => new Promise<boolean>(() => {}),
      },
      reconcileWhenEmpty: 'skip',
      idleWakePollIntervalMs: 0,
    });

    const firstWait = consumer.waitForNextInput({ abortSignal: firstAbortController.signal });
    await Promise.resolve();
    await Promise.resolve();

    const secondWait = consumer.waitForNextInput({ abortSignal: secondAbortController.signal });
    const earlySecondOutcome = await Promise.race([
      secondWait.then(
        () => 'resolved',
        (error: unknown) => error instanceof Error ? error.message : String(error),
      ),
      new Promise<string>((resolve) => setTimeout(() => resolve('pending'), 10)),
    ]);

    try {
      expect(earlySecondOutcome).toBe('pending');

      messageQueue.push('first', { id: 'mode' });
      await expect(firstWait).resolves.toMatchObject({ message: 'first' });

      messageQueue.push('second', { id: 'mode' });
      await expect(secondWait).resolves.toMatchObject({ message: 'second' });
    } finally {
      firstAbortController.abort();
      secondAbortController.abort();
    }
  });

  it('lets a queued overlapping wait observe its own abort before the active wait completes', async () => {
    const messageQueue = new MessageQueue2<TestMode>(() => 'hash');
    const firstAbortController = new AbortController();
    const secondAbortController = new AbortController();

    const consumer = createSessionProviderInputConsumer({
      messageQueue,
      session: {
        materializeNextPendingMessageSafely: vi.fn(async () => ({ type: 'no_pending' as const })),
        shouldAttemptPendingMaterialization: () => false,
        waitForMetadataUpdate: () => new Promise<boolean>(() => {}),
      },
      reconcileWhenEmpty: 'skip',
      idleWakePollIntervalMs: 0,
    });

    const firstWait = consumer.waitForNextInput({ abortSignal: firstAbortController.signal });
    await Promise.resolve();
    await Promise.resolve();

    const secondWait = consumer.waitForNextInput({ abortSignal: secondAbortController.signal });
    secondAbortController.abort();

    try {
      await expect(secondWait).resolves.toBeNull();
    } finally {
      firstAbortController.abort();
      await expect(firstWait).resolves.toBeNull();
    }
  });

  it('routes passive known-empty materialization through the safe materializer policy', async () => {
    const abortController = new AbortController();
    const materializeNextPendingMessageSafely = vi
      .fn<() => Promise<MaterializeNextPendingResult>>()
      .mockResolvedValue({
        type: 'no_pending',
      });
    const reconcilePendingQueueState = vi.fn(async () => false);

    const consumer = createSessionProviderInputConsumer({
      messageQueue: new MessageQueue2<TestMode>(() => 'hash'),
      session: {
        materializeNextPendingMessageSafely,
        shouldAttemptPendingMaterialization: () => false,
        reconcilePendingQueueState,
        waitForMetadataUpdate: async () => {
          abortController.abort();
          return false;
        },
      },
      reconcileWhenEmpty: 'skip',
      idleWakePollIntervalMs: 0,
    });

    await expect(consumer.waitForNextInput({ abortSignal: abortController.signal })).resolves.toBeNull();
    expect(materializeNextPendingMessageSafely).toHaveBeenCalledWith({ reconcileWhenEmpty: 'skip' });
    expect(reconcilePendingQueueState).not.toHaveBeenCalled();
  });

  it('keeps waiting instead of rejecting when safe materialization throws before a batch is queued', async () => {
    const abortController = new AbortController();
    const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => {});
    const materializeError = new Error('provider attach returned an unexpected response');
    const materializeNextPendingMessageSafely = vi
      .fn<() => Promise<MaterializeNextPendingResult>>()
      .mockRejectedValue(materializeError);

    const consumer = createSessionProviderInputConsumer({
      messageQueue: new MessageQueue2<TestMode>(() => 'hash'),
      session: {
        materializeNextPendingMessageSafely,
        waitForMetadataUpdate: async () => {
          abortController.abort();
          return false;
        },
      },
      reconcileWhenEmpty: 'skip',
      idleWakePollIntervalMs: 0,
    });

    await expect(consumer.waitForNextInput({ abortSignal: abortController.signal })).resolves.toBeNull();
    expect(debugSpy).toHaveBeenCalledWith(
      '[pendingQueue] input consumer materialization failed (non-fatal)',
      materializeError,
    );
    debugSpy.mockRestore();
  });

  it('blocks a visible pending row immediately for a non-transport contract fault with local-id evidence', async () => {
    const abortController = new AbortController();
    const materializeError = Object.assign(
      new Error('provider attach returned malformed pending delivery metadata'),
      { localId: 'permanent-fault-local' },
    );
    const materializeNextPendingMessageSafely = vi
      .fn<() => Promise<MaterializeNextPendingResult>>()
      .mockRejectedValue(materializeError);
    const blockPendingMessageDelivery = vi.fn(async () => true);

    const consumer = createSessionProviderInputConsumer({
      messageQueue: new MessageQueue2<TestMode>(() => 'hash'),
      session: {
        materializeNextPendingMessageSafely,
        blockPendingMessageDelivery,
        waitForMetadataUpdate: async () => {
          if (blockPendingMessageDelivery.mock.calls.length > 0) {
            abortController.abort();
            return false;
          }
          return true;
        },
      },
      reconcileWhenEmpty: 'skip',
      idleWakePollIntervalMs: 0,
    });

    await expect(consumer.waitForNextInput({ abortSignal: abortController.signal })).resolves.toBeNull();

    expect(materializeNextPendingMessageSafely).toHaveBeenCalledTimes(1);
    expect(blockPendingMessageDelivery).toHaveBeenCalledWith({
      localIds: ['permanent-fault-local'],
      reason: 'unknown',
    });
  });

  it('logs text-free materialization decisions with delivery policy metadata', async () => {
    const abortController = new AbortController();
    const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => {});
    const materializeNextPendingMessageSafely = vi
      .fn<() => Promise<MaterializeNextPendingResult>>()
      .mockResolvedValue({
        type: 'materialized',
        localId: 'local-secret',
        seq: 33,
        content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'do not log this secret prompt' } } },
      });

    const consumer = createSessionProviderInputConsumer({
      messageQueue: new MessageQueue2<TestMode>(() => 'hash'),
      session: {
        materializeNextPendingMessageSafely,
        waitForMetadataUpdate: async () => {
          abortController.abort();
          return false;
        },
      },
      activeTurnDeliveryPolicy: 'allow_live_delivery',
      reconcileWhenEmpty: 'skip',
      idleWakePollIntervalMs: 0,
    });

    await expect(consumer.waitForNextInput({ abortSignal: abortController.signal })).resolves.toBeNull();

    expect(debugSpy).toHaveBeenCalledWith('[pendingQueue] input consumer materialization decision', {
      activeTurnDeliveryPolicy: 'allow_live_delivery',
      localId: 'local-secret',
      reconcileWhenEmpty: 'skip',
      resultType: 'materialized',
      seq: 33,
      source: 'waitForNextInput',
    });
    expect(debugSpy.mock.calls).not.toEqual(expect.arrayContaining([
      expect.arrayContaining([
        expect.any(String),
        expect.objectContaining({ content: expect.anything() }),
      ]),
    ]));
  });

  it('idle wakes reconcile a stale-empty pending count (throttled) so lost nudges self-heal', async () => {
    const abortController = new AbortController();
    const materializeNextPendingMessageSafely = vi
      .fn<(opts?: { reconcileWhenEmpty?: string }) => Promise<MaterializeNextPendingResult>>()
      .mockResolvedValue({ type: 'no_pending' });

    const consumer = createSessionProviderInputConsumer({
      messageQueue: new MessageQueue2<TestMode>(() => 'hash'),
      session: {
        materializeNextPendingMessageSafely,
        shouldAttemptPendingMaterialization: () => false,
        waitForMetadataUpdate: () => new Promise<boolean>(() => {}),
      },
      reconcileWhenEmpty: 'skip',
      idleWakePollIntervalMs: 1,
    });

    const waitPromise = consumer.waitForNextInput({ abortSignal: abortController.signal });
    setTimeout(() => abortController.abort(), 25).unref?.();
    await expect(waitPromise).resolves.toBeNull();

    const policies = materializeNextPendingMessageSafely.mock.calls.map((call) => call[0]?.reconcileWhenEmpty);
    // First (pre-wait) attempt stays passive; idle-timer wakes must reconcile (throttled).
    expect(policies[0]).toBe('skip');
    expect(policies).toContain('throttled');
  });

  it('calls metadata refresh when only the idle timer wakes', async () => {
    const abortController = new AbortController();
    const onMetadataUpdate = vi.fn();
    const materializeNextPendingMessageSafely = vi
      .fn<() => Promise<MaterializeNextPendingResult>>()
      .mockResolvedValue({ type: 'no_pending' });

    const consumer = createSessionProviderInputConsumer({
      messageQueue: new MessageQueue2<TestMode>(() => 'hash'),
      session: {
        materializeNextPendingMessageSafely,
        shouldAttemptPendingMaterialization: () => false,
        waitForMetadataUpdate: () => new Promise<boolean>(() => {}),
      },
      onMetadataUpdate,
      reconcileWhenEmpty: 'skip',
      idleWakePollIntervalMs: 1,
    });

    const waitPromise = consumer.waitForNextInput({ abortSignal: abortController.signal });
    setTimeout(() => abortController.abort(), 10).unref?.();

    await expect(waitPromise).resolves.toBeNull();
    expect(onMetadataUpdate).toHaveBeenCalled();
  });

  it('keeps waiting after a transient non-aborted metadata wait failure when idle polling is disabled', async () => {
    vi.useFakeTimers();
    try {
      const abortController = new AbortController();
      const messageQueue = new MessageQueue2<TestMode>(() => 'hash');
      const onMetadataUpdate = vi.fn(async () => {});
      const consumer = createSessionProviderInputConsumer({
        messageQueue,
        session: {
          materializeNextPendingMessageSafely: vi.fn(async () => ({ type: 'no_pending' as const })),
          waitForMetadataUpdate: vi.fn(async () => false),
        },
        onMetadataUpdate,
        reconcileWhenEmpty: 'skip',
        idleWakePollIntervalMs: 0,
      });

      const waitPromise = consumer.waitForNextInput({ abortSignal: abortController.signal });
      const settled = vi.fn();
      void waitPromise.then(settled, settled);

      await vi.advanceTimersByTimeAsync(0);
      expect(settled).not.toHaveBeenCalled();

      messageQueue.push('after reconnect', { id: 'mode' });
      await expect(waitPromise).resolves.toMatchObject({ message: 'after reconnect' });
      expect(onMetadataUpdate).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps waiting after a rejected metadata wait when idle polling is disabled', async () => {
    vi.useFakeTimers();
    try {
      const abortController = new AbortController();
      const messageQueue = new MessageQueue2<TestMode>(() => 'hash');
      const onMetadataUpdate = vi.fn(async () => {});
      const consumer = createSessionProviderInputConsumer({
        messageQueue,
        session: {
          materializeNextPendingMessageSafely: vi.fn(async () => ({ type: 'no_pending' as const })),
          waitForMetadataUpdate: vi
            .fn<() => Promise<boolean>>()
            .mockRejectedValueOnce(new Error('metadata stream disconnected'))
            .mockImplementation(() => new Promise<boolean>(() => {})),
        },
        onMetadataUpdate,
        reconcileWhenEmpty: 'skip',
        idleWakePollIntervalMs: 0,
        metadataWaitRetryBackoffMs: 1,
      });

      const waitPromise = consumer.waitForNextInput({ abortSignal: abortController.signal });
      const settled = vi.fn();
      void waitPromise.then(settled, settled);

      await vi.advanceTimersByTimeAsync(1);
      expect(settled).not.toHaveBeenCalled();

      messageQueue.push('after rejected metadata wait', { id: 'mode' });
      await expect(waitPromise).resolves.toMatchObject({ message: 'after rejected metadata wait' });
      expect(onMetadataUpdate).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('lets idle wakes win across repeated transient metadata wait failures', async () => {
    vi.useFakeTimers();
    try {
      const abortController = new AbortController();
      const onMetadataUpdate = vi.fn();
      const materializeNextPendingMessageSafely = vi
        .fn<(opts?: { reconcileWhenEmpty?: string }) => Promise<MaterializeNextPendingResult>>()
        .mockResolvedValue({ type: 'no_pending' });

      const consumer = createSessionProviderInputConsumer({
        messageQueue: new MessageQueue2<TestMode>(() => 'hash'),
        session: {
          materializeNextPendingMessageSafely,
          shouldAttemptPendingMaterialization: () => false,
          waitForMetadataUpdate: vi.fn(async () => false),
        },
        onMetadataUpdate,
        reconcileWhenEmpty: 'skip',
        idleWakePollIntervalMs: 1,
      });

      const waitPromise = consumer.waitForNextInput({ abortSignal: abortController.signal });
      await vi.advanceTimersByTimeAsync(1);
      abortController.abort();
      await expect(waitPromise).resolves.toBeNull();

      expect(onMetadataUpdate).toHaveBeenCalled();
      const policies = materializeNextPendingMessageSafely.mock.calls.map((call) => call[0]?.reconcileWhenEmpty);
      expect(policies).toContain('throttled');
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns null when an aborted metadata wait resolves false', async () => {
    const onMetadataUpdate = vi.fn(async () => {});
    const abortController = new AbortController();
    abortController.abort();
    const consumer = createSessionProviderInputConsumer({
      messageQueue: new MessageQueue2<TestMode>(() => 'hash'),
      session: {
        materializeNextPendingMessageSafely: vi.fn(async () => ({ type: 'no_pending' as const })),
        waitForMetadataUpdate: vi.fn(async () => false),
      },
      onMetadataUpdate,
      reconcileWhenEmpty: 'skip',
      idleWakePollIntervalMs: 0,
    });

    await expect(consumer.waitForNextInput({ abortSignal: abortController.signal })).resolves.toBeNull();
    expect(onMetadataUpdate).not.toHaveBeenCalled();
  });

  it('owns one bounded retry episode and succeeds after transient transport recovery', async () => {
    vi.useFakeTimers();
    try {
      const abortController = new AbortController();
      const messageQueue = new MessageQueue2<TestMode>(() => 'hash');
      const materializeNextPendingMessageSafely = vi
        .fn<() => Promise<MaterializeNextPendingResult>>()
        .mockResolvedValueOnce({ type: 'retryable_transport' } as MaterializeNextPendingResult)
        .mockImplementationOnce(async () => {
          messageQueue.push('recovered', { id: 'mode' });
          return { type: 'materialized', localId: 'recovered-local', seq: 1, content: null };
        });
      const consumer = createSessionProviderInputConsumer({
        messageQueue,
        session: {
          materializeNextPendingMessageSafely,
          waitForMetadataUpdate: () => new Promise<boolean>(() => {}),
        },
        idleWakePollIntervalMs: 0,
        pendingMaterializationRetryEpisode: {
          maxAttempts: 3,
          initialDelayMs: 10,
          maxDelayMs: 10,
          jitterMs: 0,
        },
      } as Parameters<typeof createSessionProviderInputConsumer<TestMode, string>>[0]);

      const first = consumer.waitForNextInput({ abortSignal: abortController.signal });
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(10);
      const attemptCount = materializeNextPendingMessageSafely.mock.calls.length;
      const firstResult = await first;

      expect(attemptCount).toBe(2);
      expect(firstResult).toMatchObject({ message: 'recovered' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels retry backoff without another transport attempt', async () => {
    vi.useFakeTimers();
    try {
      const abortController = new AbortController();
      const materializeNextPendingMessageSafely = vi
        .fn<() => Promise<MaterializeNextPendingResult>>()
        .mockResolvedValue({ type: 'retryable_transport' } as MaterializeNextPendingResult);
      const consumer = createSessionProviderInputConsumer({
        messageQueue: new MessageQueue2<TestMode>(() => 'hash'),
        session: {
          materializeNextPendingMessageSafely,
          waitForMetadataUpdate: () => new Promise<boolean>(() => {}),
        },
        idleWakePollIntervalMs: 0,
        pendingMaterializationRetryEpisode: {
          maxAttempts: 3,
          initialDelayMs: 10,
          maxDelayMs: 10,
          jitterMs: 0,
        },
      } as Parameters<typeof createSessionProviderInputConsumer<TestMode, string>>[0]);

      const waiting = consumer.waitForNextInput({ abortSignal: abortController.signal });
      await vi.advanceTimersByTimeAsync(0);
      abortController.abort();
      await vi.advanceTimersByTimeAsync(10);

      await expect(waiting).resolves.toBeNull();
      expect(materializeNextPendingMessageSafely).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('exits through auth policy immediately without consuming retry budget', async () => {
    const materializeNextPendingMessageSafely = vi
      .fn<() => Promise<MaterializeNextPendingResult>>()
      .mockResolvedValue({ type: 'auth_failure', statusCode: 401 } as MaterializeNextPendingResult);
    const consumer = createSessionProviderInputConsumer({
      messageQueue: new MessageQueue2<TestMode>(() => 'hash'),
      session: {
        materializeNextPendingMessageSafely,
        waitForMetadataUpdate: () => new Promise<boolean>(() => {}),
      },
      idleWakePollIntervalMs: 0,
    });

    await expect(consumer.waitForNextInput({ abortSignal: new AbortController().signal }))
      .rejects.toBeInstanceOf(PendingQueueMaterializationAuthError);
    expect(materializeNextPendingMessageSafely).toHaveBeenCalledTimes(1);
  });

  it('exits through auth policy when authentication fails during the transport request', async () => {
    const materializeNextPendingMessageSafely = vi
      .fn<() => Promise<MaterializeNextPendingResult>>()
      .mockRejectedValue(new HttpStatusError(403, 'Authentication failed'));
    const consumer = createSessionProviderInputConsumer({
      messageQueue: new MessageQueue2<TestMode>(() => 'hash'),
      session: {
        materializeNextPendingMessageSafely,
        waitForMetadataUpdate: () => new Promise<boolean>(() => {}),
      },
      idleWakePollIntervalMs: 0,
    });

    await expect(consumer.waitForNextInput({ abortSignal: new AbortController().signal }))
      .rejects.toBeInstanceOf(PendingQueueMaterializationAuthError);
    expect(materializeNextPendingMessageSafely).toHaveBeenCalledTimes(1);
  });
});
