import { describe, expect, it, vi } from 'vitest';

import { createDeferred } from '@/testkit/async/deferred';
import { createPendingMaterializationRetryEpisode } from './pendingMaterializationRetryEpisode';

type Result = Readonly<{ type: 'retryable_transport' | 'materialized' }>;

describe('pendingMaterializationRetryEpisode', () => {
  it('attaches concurrent wakes with the same key to one bounded episode', async () => {
    vi.useFakeTimers();
    try {
      const attempt = vi
        .fn<() => Promise<Result>>()
        .mockResolvedValueOnce({ type: 'retryable_transport' })
        .mockResolvedValueOnce({ type: 'materialized' });
      const episode = createPendingMaterializationRetryEpisode<Result>({
        config: { maxAttempts: 3, initialDelayMs: 10, maxDelayMs: 10, jitterMs: 0 },
        isRetryable: (result) => result.type === 'retryable_transport',
      });
      const abortController = new AbortController();

      const first = episode.run({ key: 'session-1', abortSignal: abortController.signal, attempt });
      const attached = episode.run({ key: 'session-1', abortSignal: abortController.signal, attempt });

      expect(attached).not.toBe(first);
      await vi.advanceTimersByTimeAsync(10);
      await expect(first).resolves.toEqual({ type: 'materialized' });
      expect(attempt).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('lets a healthy attached waiter succeed when the first waiter cancels', async () => {
    vi.useFakeTimers();
    try {
      const attempt = vi
        .fn<() => Promise<Result>>()
        .mockResolvedValueOnce({ type: 'retryable_transport' })
        .mockResolvedValueOnce({ type: 'materialized' });
      const episode = createPendingMaterializationRetryEpisode<Result>({
        config: { maxAttempts: 3, initialDelayMs: 10, maxDelayMs: 10, jitterMs: 0 },
        isRetryable: (result) => result.type === 'retryable_transport',
      });
      const firstController = new AbortController();
      const secondController = new AbortController();

      const first = episode.run({ key: 'session-1', abortSignal: firstController.signal, attempt });
      const second = episode.run({ key: 'session-1', abortSignal: secondController.signal, attempt });
      firstController.abort();

      await expect(first).rejects.toMatchObject({ name: 'AbortError' });
      await vi.advanceTimersByTimeAsync(10);
      await expect(second).resolves.toEqual({ type: 'materialized' });
      expect(attempt).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('detaches a cancelled attached waiter without cancelling the first waiter', async () => {
    vi.useFakeTimers();
    try {
      const attempt = vi
        .fn<() => Promise<Result>>()
        .mockResolvedValueOnce({ type: 'retryable_transport' })
        .mockResolvedValueOnce({ type: 'materialized' });
      const episode = createPendingMaterializationRetryEpisode<Result>({
        config: { maxAttempts: 3, initialDelayMs: 10, maxDelayMs: 10, jitterMs: 0 },
        isRetryable: (result) => result.type === 'retryable_transport',
      });
      const firstController = new AbortController();
      const secondController = new AbortController();

      const first = episode.run({ key: 'session-1', abortSignal: firstController.signal, attempt });
      const second = episode.run({ key: 'session-1', abortSignal: secondController.signal, attempt });
      secondController.abort();

      await expect(second).rejects.toMatchObject({ name: 'AbortError' });
      await vi.advanceTimersByTimeAsync(10);
      await expect(first).resolves.toEqual({ type: 'materialized' });
      expect(attempt).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('aborts an episode after every waiter detaches and starts a fresh later episode', async () => {
    vi.useFakeTimers();
    try {
      const attempt = vi
        .fn<() => Promise<Result>>()
        .mockResolvedValueOnce({ type: 'retryable_transport' })
        .mockResolvedValueOnce({ type: 'materialized' });
      const episode = createPendingMaterializationRetryEpisode<Result>({
        config: { maxAttempts: 3, initialDelayMs: 10, maxDelayMs: 10, jitterMs: 0 },
        isRetryable: (result) => result.type === 'retryable_transport',
      });
      const firstController = new AbortController();
      const secondController = new AbortController();
      const first = episode.run({ key: 'session-1', abortSignal: firstController.signal, attempt });
      const second = episode.run({ key: 'session-1', abortSignal: secondController.signal, attempt });

      firstController.abort();
      secondController.abort();
      await expect(first).rejects.toMatchObject({ name: 'AbortError' });
      await expect(second).rejects.toMatchObject({ name: 'AbortError' });

      const later = episode.run({
        key: 'session-1',
        abortSignal: new AbortController().signal,
        attempt,
      });
      await expect(later).resolves.toEqual({ type: 'materialized' });
      expect(attempt).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('retains same-key serialization when every waiter cancels during an unresolved attempt', async () => {
    const heldAttempt = createDeferred<Result>();
    const attempt = vi
      .fn<() => Promise<Result>>()
      .mockImplementationOnce(async () => await heldAttempt.promise)
      .mockResolvedValueOnce({ type: 'materialized' });
    const episode = createPendingMaterializationRetryEpisode<Result>({
      config: { maxAttempts: 2, initialDelayMs: 0, maxDelayMs: 0, jitterMs: 0 },
      isRetryable: (result) => result.type === 'retryable_transport',
    });
    const firstController = new AbortController();
    const secondController = new AbortController();

    const first = episode.run({ key: 'session-1', abortSignal: firstController.signal, attempt });
    const second = episode.run({ key: 'session-1', abortSignal: secondController.signal, attempt });
    firstController.abort();
    secondController.abort();
    await expect(first).rejects.toMatchObject({ name: 'AbortError' });
    await expect(second).rejects.toMatchObject({ name: 'AbortError' });

    const later = episode.run({
      key: 'session-1',
      abortSignal: new AbortController().signal,
      attempt,
    });
    await Promise.resolve();
    expect(attempt).toHaveBeenCalledTimes(1);

    heldAttempt.resolve({ type: 'retryable_transport' });
    await expect(later).resolves.toEqual({ type: 'materialized' });
    expect(attempt).toHaveBeenCalledTimes(2);

    await expect(episode.run({
      key: 'session-1',
      abortSignal: new AbortController().signal,
      attempt: async () => ({ type: 'materialized' }),
    })).resolves.toEqual({ type: 'materialized' });
  });

  it('reports exhaustion once and remains available for a later wake', async () => {
    vi.useFakeTimers();
    try {
      const onExhausted = vi.fn();
      const attempt = vi.fn(async (): Promise<Result> => ({ type: 'retryable_transport' }));
      const episode = createPendingMaterializationRetryEpisode<Result>({
        config: { maxAttempts: 2, initialDelayMs: 5, maxDelayMs: 5, jitterMs: 0 },
        isRetryable: (result) => result.type === 'retryable_transport',
        onExhausted,
      });

      const first = episode.run({ key: 'session-1', abortSignal: new AbortController().signal, attempt });
      await vi.advanceTimersByTimeAsync(5);
      await expect(first).resolves.toEqual({ type: 'retryable_transport' });
      expect(onExhausted).toHaveBeenCalledTimes(1);

      const later = episode.run({ key: 'session-1', abortSignal: new AbortController().signal, attempt });
      await vi.advanceTimersByTimeAsync(5);
      await expect(later).resolves.toEqual({ type: 'retryable_transport' });
      expect(onExhausted).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not await a hanging exhaustion observer before completing or releasing the key', async () => {
    const observer = new Promise<void>(() => {});
    const attempt = vi.fn(async (): Promise<Result> => ({ type: 'retryable_transport' }));
    const episode = createPendingMaterializationRetryEpisode<Result>({
      config: { maxAttempts: 1, initialDelayMs: 0, maxDelayMs: 0, jitterMs: 0 },
      isRetryable: (result) => result.type === 'retryable_transport',
      onExhausted: () => observer,
    });

    await expect(episode.run({
      key: 'session-1',
      abortSignal: new AbortController().signal,
      attempt,
    })).resolves.toEqual({ type: 'retryable_transport' });
    await expect(episode.run({
      key: 'session-1',
      abortSignal: new AbortController().signal,
      attempt,
    })).resolves.toEqual({ type: 'retryable_transport' });
    expect(attempt).toHaveBeenCalledTimes(2);
  });

  it('isolates a rejecting exhaustion observer and leaves the key reusable', async () => {
    const attempt = vi.fn(async (): Promise<Result> => ({ type: 'retryable_transport' }));
    const episode = createPendingMaterializationRetryEpisode<Result>({
      config: { maxAttempts: 1, initialDelayMs: 0, maxDelayMs: 0, jitterMs: 0 },
      isRetryable: (result) => result.type === 'retryable_transport',
      onExhausted: async () => {
        throw new Error('observer failed');
      },
    });

    await expect(episode.run({
      key: 'session-1',
      abortSignal: new AbortController().signal,
      attempt,
    })).resolves.toEqual({ type: 'retryable_transport' });
    await expect(episode.run({
      key: 'session-1',
      abortSignal: new AbortController().signal,
      attempt,
    })).resolves.toEqual({ type: 'retryable_transport' });
    expect(attempt).toHaveBeenCalledTimes(2);
  });
});
