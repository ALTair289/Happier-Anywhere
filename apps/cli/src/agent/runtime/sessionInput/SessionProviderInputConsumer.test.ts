import { describe, expect, it, vi } from 'vitest';

import { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';
import { HttpStatusError } from '@/api/client/httpStatusError';
import type { MaterializeNextPendingResult } from '@/api/session/sessionClientPort';
import { logger } from '@/ui/logger';

import {
  createSessionProviderInputConsumer,
  createSessionProviderPendingDrainAdapter,
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
      popPendingMessage: vi.fn(async () => false),
      materializeNextPendingMessageSafely,
      waitForMetadataUpdate: async () => false,
    });

    await expect(consumer.drainPending?.({ reason: 'test-default-one' })).resolves.toEqual({
      materialized: 1,
      stoppedReason: 'max_pop_per_wake',
    });
    expect(materializeNextPendingMessageSafely).toHaveBeenCalledTimes(1);
  });

  it('uses safe pending materialization before legacy pop fallback', async () => {
    const popPendingMessage = vi.fn(async () => false);
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
      popPendingMessage,
      materializeNextPendingMessageSafely,
      waitForMetadataUpdate: async () => false,
    });

    expect(consumer.drainPending).toEqual(expect.any(Function));
    await expect(consumer.drainPending?.({ maxPopPerWake: 5, reason: 'test-safe' })).resolves.toEqual({
      materialized: 1,
      stoppedReason: 'no_pending',
    });
    expect(materializeNextPendingMessageSafely).toHaveBeenCalledWith({ reconcileWhenEmpty: 'force' });
    expect(popPendingMessage).not.toHaveBeenCalled();
  });

  it('reconciles before stopping when materialization is disallowed', async () => {
    const popPendingMessage = vi.fn(async () => true);
    const reconcilePendingQueueState = vi.fn(async () => false);

    const consumer = createDrainConsumer({
      popPendingMessage,
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
    expect(popPendingMessage).not.toHaveBeenCalled();
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
        popPendingMessage: vi.fn(async () => false),
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
        popPendingMessage: vi.fn(async () => false),
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
        popPendingMessage: vi.fn(async () => false),
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
    const popPendingMessage = vi.fn(async () => true);
    const reconcilePendingQueueState = vi.fn(async () => {
      throw new Error('reconcile failed');
    });

    const consumer = createDrainConsumer({
      popPendingMessage,
      shouldAttemptPendingMaterialization: () => false,
      reconcilePendingQueueState,
      waitForMetadataUpdate: async () => false,
    });

    await expect(consumer.drainPending({ reason: 'test-reconcile-error' })).resolves.toEqual({
      materialized: 0,
      stoppedReason: 'error',
    });
    expect(reconcilePendingQueueState).toHaveBeenCalledWith({ force: true });
    expect(popPendingMessage).not.toHaveBeenCalled();
  });

  it('stops after terminal auth failure without throwing', async () => {
    const popPendingMessage = vi.fn(async () => {
      throw new HttpStatusError(401, 'Authentication failed');
    });

    const consumer = createDrainConsumer({
      popPendingMessage,
      waitForMetadataUpdate: async () => false,
    });

    expect(consumer.drainPending).toEqual(expect.any(Function));
    await expect(consumer.drainPending?.({ maxPopPerWake: 5, reason: 'test-auth' })).resolves.toEqual({
      materialized: 0,
      stoppedReason: 'auth_failure',
    });
    expect(popPendingMessage).toHaveBeenCalledTimes(1);
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
        popPendingMessage: vi.fn(async () => false),
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
        popPendingMessage: vi.fn(async () => false),
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
    const popPendingMessage = vi.fn(async () => true);
    const materializeNextPendingMessageSafely = vi
      .fn<() => Promise<MaterializeNextPendingResult>>()
      .mockResolvedValue({
        type: 'no_pending',
      });
    const reconcilePendingQueueState = vi.fn(async () => false);

    const consumer = createSessionProviderInputConsumer({
      messageQueue: new MessageQueue2<TestMode>(() => 'hash'),
      session: {
        popPendingMessage,
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
    expect(popPendingMessage).not.toHaveBeenCalled();
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
        popPendingMessage: vi.fn(async () => false),
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
        popPendingMessage: vi.fn(async () => false),
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
        popPendingMessage: vi.fn(async () => false),
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
          popPendingMessage: vi.fn(async () => false),
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
          popPendingMessage: vi.fn(async () => false),
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
          popPendingMessage: vi.fn(async () => false),
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
        popPendingMessage: vi.fn(async () => false),
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
});
