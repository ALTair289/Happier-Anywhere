import { describe, expect, it, vi } from 'vitest';

import { DEFAULT_SESSION_METADATA_WAIT_RETRY_BACKOFF_MS } from '@/agent/runtime/sessionMetadataWaitRetryBackoff';
import { startLocalPendingQueueRemoteSwitchWatcher } from './startLocalPendingQueueRemoteSwitchWatcher';

type Wake = (value: boolean) => void;

function createPendingUpdateWaiter() {
  const wakes: Wake[] = [];
  const waitForPendingQueueUpdate = vi.fn<(signal?: AbortSignal) => Promise<boolean>>(
    async (signal?: AbortSignal) => await new Promise<boolean>((resolve) => {
      wakes.push(resolve);
      signal?.addEventListener('abort', () => resolve(false), { once: true });
    }),
  );
  return { wakes, waitForPendingQueueUpdate };
}

describe('startLocalPendingQueueRemoteSwitchWatcher', () => {
  it('inspects the local projection only after a server Pending wake', async () => {
    vi.useFakeTimers();
    const { wakes, waitForPendingQueueUpdate } = createPendingUpdateWaiter();
    const peekPendingCount = vi.fn<() => Promise<number>>().mockResolvedValue(1);
    const requestRemoteSwitch = vi.fn<() => Promise<boolean>>().mockResolvedValue(true);

    const watcher = startLocalPendingQueueRemoteSwitchWatcher({
      peekPendingCount,
      requestRemoteSwitch,
      waitForPendingQueueUpdate,
    });

    await vi.advanceTimersByTimeAsync(60_000);
    expect(peekPendingCount).not.toHaveBeenCalled();
    expect(requestRemoteSwitch).not.toHaveBeenCalled();

    const wake = wakes.shift();
    if (!wake) throw new Error('expected Pending update waiter');
    wake(true);
    await vi.advanceTimersByTimeAsync(0);

    expect(peekPendingCount).toHaveBeenCalledTimes(1);
    expect(requestRemoteSwitch).toHaveBeenCalledTimes(1);

    watcher.stop();
    vi.useRealTimers();
  });

  it('re-arms the server wake wait after a missed subscription without inspecting Pending', async () => {
    vi.useFakeTimers();
    const peekPendingCount = vi.fn<() => Promise<number>>().mockResolvedValue(1);
    const requestRemoteSwitch = vi.fn<() => Promise<boolean>>().mockResolvedValue(true);
    const waitForPendingQueueUpdate = vi.fn<(signal?: AbortSignal) => Promise<boolean>>()
      .mockResolvedValueOnce(false)
      .mockImplementation(async (signal?: AbortSignal) => await new Promise<boolean>((resolve) => {
        signal?.addEventListener('abort', () => resolve(false), { once: true });
      }));

    const watcher = startLocalPendingQueueRemoteSwitchWatcher({
      peekPendingCount,
      requestRemoteSwitch,
      waitForPendingQueueUpdate,
    });

    await vi.advanceTimersByTimeAsync(DEFAULT_SESSION_METADATA_WAIT_RETRY_BACKOFF_MS - 1);
    expect(waitForPendingQueueUpdate).toHaveBeenCalledTimes(1);
    expect(peekPendingCount).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(waitForPendingQueueUpdate).toHaveBeenCalledTimes(2);
    expect(peekPendingCount).not.toHaveBeenCalled();

    watcher.stop();
    vi.useRealTimers();
  });

  it('re-arms the server wake wait after a subscription error without inspecting Pending', async () => {
    vi.useFakeTimers();
    const peekPendingCount = vi.fn<() => Promise<number>>().mockResolvedValue(1);
    const requestRemoteSwitch = vi.fn<() => Promise<boolean>>().mockResolvedValue(true);
    const waitForPendingQueueUpdate = vi.fn<(signal?: AbortSignal) => Promise<boolean>>()
      .mockRejectedValueOnce(new Error('subscription unavailable'))
      .mockImplementation(async (signal?: AbortSignal) => await new Promise<boolean>((resolve) => {
        signal?.addEventListener('abort', () => resolve(false), { once: true });
      }));

    const watcher = startLocalPendingQueueRemoteSwitchWatcher({
      peekPendingCount,
      requestRemoteSwitch,
      waitForPendingQueueUpdate,
    });

    await vi.advanceTimersByTimeAsync(DEFAULT_SESSION_METADATA_WAIT_RETRY_BACKOFF_MS - 1);
    expect(waitForPendingQueueUpdate).toHaveBeenCalledTimes(1);
    expect(peekPendingCount).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(waitForPendingQueueUpdate).toHaveBeenCalledTimes(2);
    expect(peekPendingCount).not.toHaveBeenCalled();

    watcher.stop();
    vi.useRealTimers();
  });

  it('waits for the next server wake after a rejected switch instead of polling', async () => {
    vi.useFakeTimers();
    const { wakes, waitForPendingQueueUpdate } = createPendingUpdateWaiter();
    const peekPendingCount = vi.fn<() => Promise<number>>().mockResolvedValue(1);
    const requestRemoteSwitch = vi.fn<() => Promise<boolean>>()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);

    const watcher = startLocalPendingQueueRemoteSwitchWatcher({
      peekPendingCount,
      requestRemoteSwitch,
      waitForPendingQueueUpdate,
    });

    await vi.advanceTimersByTimeAsync(0);
    wakes.shift()?.(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(requestRemoteSwitch).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(requestRemoteSwitch).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(0);
    wakes.shift()?.(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(requestRemoteSwitch).toHaveBeenCalledTimes(2);

    watcher.stop();
    vi.useRealTimers();
  });

  it('stops the active server wait without inspecting Pending', async () => {
    vi.useFakeTimers();
    const { waitForPendingQueueUpdate } = createPendingUpdateWaiter();
    const peekPendingCount = vi.fn<() => Promise<number>>().mockResolvedValue(1);
    const requestRemoteSwitch = vi.fn<() => Promise<boolean>>().mockResolvedValue(true);

    const watcher = startLocalPendingQueueRemoteSwitchWatcher({
      peekPendingCount,
      requestRemoteSwitch,
      waitForPendingQueueUpdate,
    });
    watcher.stop();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(peekPendingCount).not.toHaveBeenCalled();
    expect(requestRemoteSwitch).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});
