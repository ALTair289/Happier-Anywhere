import { describe, expect, it, vi } from 'vitest';

import { DEFAULT_SESSION_METADATA_WAIT_RETRY_BACKOFF_MS } from '@/agent/runtime/sessionMetadataWaitRetryBackoff';
import { startLocalPendingQueueRemoteSwitchWatcher } from './startLocalPendingQueueRemoteSwitchWatcher';

describe('startLocalPendingQueueRemoteSwitchWatcher', () => {
  it('inspects the local pending projection after a pending-queue update before switching', async () => {
    vi.useFakeTimers();
    const wakeRef: { current: ((value: boolean) => void) | null } = { current: null };
    const peekPendingCount = vi.fn<() => Promise<number>>().mockResolvedValue(1);
    const requestRemoteSwitch = vi.fn<() => Promise<boolean>>().mockResolvedValue(true);
    const waitForPendingQueueUpdate = vi.fn<(signal?: AbortSignal) => Promise<boolean>>(
        async (signal?: AbortSignal) =>
        await new Promise<boolean>((resolve) => {
          wakeRef.current = resolve;
          signal?.addEventListener('abort', () => resolve(false), { once: true });
        }),
    );

    const opts = {
      peekPendingCount,
      pollIntervalMs: 30_000,
      requestRemoteSwitch,
      waitForPendingQueueUpdate,
    };

    const watcher = startLocalPendingQueueRemoteSwitchWatcher(opts);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(peekPendingCount).not.toHaveBeenCalled();
    expect(requestRemoteSwitch).not.toHaveBeenCalled();
    expect(waitForPendingQueueUpdate).toHaveBeenCalledTimes(1);

    const wake = wakeRef.current;
    if (!wake) throw new Error('expected pending queue update waiter to be registered');
    wake(true);
    await vi.advanceTimersByTimeAsync(0);

    expect(peekPendingCount).toHaveBeenCalledTimes(1);
    expect(requestRemoteSwitch).toHaveBeenCalledTimes(1);

    watcher.stop();
    vi.useRealTimers();
  });

  it('uses defensive polling without forcing pending-state reconciliation before inspecting the local projection', async () => {
    vi.useFakeTimers();
    const peekPendingCount = vi.fn<() => Promise<number>>().mockResolvedValue(1);
    const requestRemoteSwitch = vi.fn<() => Promise<boolean>>().mockResolvedValue(true);
    const waitForPendingQueueUpdate = vi.fn<(signal?: AbortSignal) => Promise<boolean>>(
      async (signal?: AbortSignal) =>
        await new Promise<boolean>((resolve) => {
          signal?.addEventListener('abort', () => resolve(false), { once: true });
        }),
    );

    const opts = {
      peekPendingCount,
      pollIntervalMs: 30_000,
      requestRemoteSwitch,
      waitForPendingQueueUpdate,
    };

    const watcher = startLocalPendingQueueRemoteSwitchWatcher(opts);

    await vi.advanceTimersByTimeAsync(29_999);
    expect(peekPendingCount).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(requestRemoteSwitch).toHaveBeenCalledTimes(1);
    expect(peekPendingCount).toHaveBeenCalledTimes(1);

    watcher.stop();
    vi.useRealTimers();
  });

  it('waits for the defensive interval after a missed pending-queue update wait', async () => {
    vi.useFakeTimers();
    const requestRemoteSwitch = vi.fn<() => Promise<boolean>>().mockResolvedValue(true);
    let waitCalls = 0;
    const waitForPendingQueueUpdate = vi.fn<(signal?: AbortSignal) => Promise<boolean>>(
      async (signal?: AbortSignal) => {
        waitCalls += 1;
        if (waitCalls === 1) {
          return false;
        }
        return await new Promise<boolean>((resolve) => {
          signal?.addEventListener('abort', () => resolve(false), { once: true });
        });
      },
    );

    const watcher = startLocalPendingQueueRemoteSwitchWatcher({
      pollIntervalMs: 30_000,
      requestRemoteSwitch,
      waitForPendingQueueUpdate,
    });

    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();

    expect(waitForPendingQueueUpdate).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(waitForPendingQueueUpdate).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(waitForPendingQueueUpdate).toHaveBeenCalledTimes(2);

    watcher.stop();
    vi.useRealTimers();
  });

  it('re-arms after a missed pending-queue update wait when fallback polling is disabled', async () => {
    vi.useFakeTimers();
    const wakeRef: { current: ((value: boolean) => void) | null } = { current: null };
    const peekPendingCount = vi.fn<() => Promise<number>>().mockResolvedValue(1);
    const requestRemoteSwitch = vi.fn<() => Promise<boolean>>().mockResolvedValue(true);
    let waitCalls = 0;
    const waitForPendingQueueUpdate = vi.fn<(signal?: AbortSignal) => Promise<boolean>>(
      async (signal?: AbortSignal) => {
        waitCalls += 1;
        if (waitCalls === 1) {
          return false;
        }
        return await new Promise<boolean>((resolve) => {
          wakeRef.current = resolve;
          signal?.addEventListener('abort', () => resolve(false), { once: true });
        });
      },
    );

    const watcher = startLocalPendingQueueRemoteSwitchWatcher({
      peekPendingCount,
      pollIntervalMs: 0,
      requestRemoteSwitch,
      waitForPendingQueueUpdate,
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(waitForPendingQueueUpdate).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(DEFAULT_SESSION_METADATA_WAIT_RETRY_BACKOFF_MS - 1);
    expect(waitForPendingQueueUpdate).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(waitForPendingQueueUpdate).toHaveBeenCalledTimes(2);

    const wake = wakeRef.current;
    if (!wake) throw new Error('expected pending queue update waiter to be re-armed');
    wake(true);
    await vi.advanceTimersByTimeAsync(0);

    expect(peekPendingCount).toHaveBeenCalledTimes(1);
    expect(requestRemoteSwitch).toHaveBeenCalledTimes(1);

    watcher.stop();
    vi.useRealTimers();
  });

  it('triggers a remote switch once when server pending queue rows appear', async () => {
    vi.useFakeTimers();
    const peekPendingCount = vi
      .fn<() => Promise<number>>()
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(2);
    const requestRemoteSwitch = vi.fn<() => Promise<boolean>>().mockResolvedValue(true);

    const watcher = startLocalPendingQueueRemoteSwitchWatcher({
      peekPendingCount,
      pollIntervalMs: 25,
      requestRemoteSwitch,
    });

    await vi.advanceTimersByTimeAsync(24);
    expect(requestRemoteSwitch).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(requestRemoteSwitch).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(25);
    expect(requestRemoteSwitch).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(100);
    expect(requestRemoteSwitch).toHaveBeenCalledTimes(1);

    watcher.stop();
    vi.useRealTimers();
  });

  it('continues polling after a transient pending-count failure', async () => {
    vi.useFakeTimers();
    const peekPendingCount = vi
      .fn<() => Promise<number>>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(1);
    const requestRemoteSwitch = vi.fn<() => Promise<boolean>>().mockResolvedValue(true);

    const watcher = startLocalPendingQueueRemoteSwitchWatcher({
      peekPendingCount,
      pollIntervalMs: 25,
      requestRemoteSwitch,
    });

    await vi.advanceTimersByTimeAsync(25);
    expect(requestRemoteSwitch).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(25);
    expect(requestRemoteSwitch).toHaveBeenCalledTimes(1);

    watcher.stop();
    vi.useRealTimers();
  });

  it('re-arms after a rejected remote-switch request and retries on the next poll', async () => {
    vi.useFakeTimers();
    const peekPendingCount = vi.fn<() => Promise<number>>().mockResolvedValue(1);
    const requestRemoteSwitch = vi
      .fn<() => Promise<boolean>>()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);

    const watcher = startLocalPendingQueueRemoteSwitchWatcher({
      peekPendingCount,
      pollIntervalMs: 25,
      requestRemoteSwitch,
    });

    await vi.advanceTimersByTimeAsync(25);
    expect(requestRemoteSwitch).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(25);
    expect(requestRemoteSwitch).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(100);
    expect(requestRemoteSwitch).toHaveBeenCalledTimes(2);

    watcher.stop();
    vi.useRealTimers();
  });

  it('disables fallback polling when pollIntervalMs is non-positive', async () => {
    vi.useFakeTimers();
    const peekPendingCount = vi.fn<() => Promise<number>>().mockResolvedValue(1);
    const requestRemoteSwitch = vi.fn<() => Promise<boolean>>().mockResolvedValue(true);

    const watcher = startLocalPendingQueueRemoteSwitchWatcher({
      peekPendingCount,
      pollIntervalMs: 0,
      requestRemoteSwitch,
    });

    await vi.advanceTimersByTimeAsync(50);

    expect(peekPendingCount).not.toHaveBeenCalled();
    expect(requestRemoteSwitch).not.toHaveBeenCalled();

    watcher.stop();
    vi.useRealTimers();
  });

  it('stops polling without triggering a later switch', async () => {
    vi.useFakeTimers();
    const peekPendingCount = vi.fn<() => Promise<number>>().mockResolvedValue(1);
    const requestRemoteSwitch = vi.fn<() => Promise<boolean>>().mockResolvedValue(true);

    const watcher = startLocalPendingQueueRemoteSwitchWatcher({
      peekPendingCount,
      pollIntervalMs: 25,
      requestRemoteSwitch,
    });
    watcher.stop();

    await vi.advanceTimersByTimeAsync(50);

    expect(peekPendingCount).not.toHaveBeenCalled();
    expect(requestRemoteSwitch).not.toHaveBeenCalled();

    vi.useRealTimers();
  });
});
