import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSessionSocketStaleSafetyScheduler } from './sessionSocketStaleSafety';

describe('createSessionSocketStaleSafetyScheduler', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs one safety tick after the configured stale interval', async () => {
    vi.useFakeTimers();
    const runSafetyTick = vi.fn(async () => {});
    const scheduler = createSessionSocketStaleSafetyScheduler({
      intervalMs: 100,
      random: () => 0,
      isOnline: () => true,
      runSafetyTick,
    });

    scheduler.start();

    await vi.advanceTimersByTimeAsync(99);
    expect(runSafetyTick).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(runSafetyTick).toHaveBeenCalledTimes(1);

    scheduler.stop();
  });

  it('does not let inbound updates postpone the bounded stale-safety tick', async () => {
    vi.useFakeTimers();
    const runSafetyTick = vi.fn(async () => {});
    const scheduler = createSessionSocketStaleSafetyScheduler({
      intervalMs: 100,
      random: () => 0,
      isOnline: () => true,
      runSafetyTick,
    });

    scheduler.start();
    await vi.advanceTimersByTimeAsync(80);
    scheduler.recordInboundUpdate();
    await vi.advanceTimersByTimeAsync(19);
    scheduler.recordInboundUpdate();
    expect(runSafetyTick).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(runSafetyTick).toHaveBeenCalledTimes(1);

    scheduler.stop();
  });

  it('does not run a safety tick while offline', async () => {
    vi.useFakeTimers();
    const runSafetyTick = vi.fn(async () => {});
    const scheduler = createSessionSocketStaleSafetyScheduler({
      intervalMs: 100,
      random: () => 0,
      isOnline: () => false,
      runSafetyTick,
    });

    scheduler.start();
    await vi.advanceTimersByTimeAsync(100);

    expect(runSafetyTick).not.toHaveBeenCalled();

    scheduler.stop();
  });

  it('keeps re-ticking so a safety action gated off on one tick can run after the gate opens', async () => {
    vi.useFakeTimers();
    let enabled = false;
    const gatedSafetyAction = vi.fn();
    const scheduler = createSessionSocketStaleSafetyScheduler({
      intervalMs: 100,
      random: () => 0,
      isOnline: () => true,
      runSafetyTick: async () => {
        if (enabled) gatedSafetyAction();
      },
    });

    scheduler.start();

    await vi.advanceTimersByTimeAsync(100);
    expect(gatedSafetyAction).not.toHaveBeenCalled();

    enabled = true;
    await vi.advanceTimersByTimeAsync(100);
    expect(gatedSafetyAction).toHaveBeenCalledTimes(1);

    scheduler.stop();
  });

  it('keeps the active safety timeout refed so stale sockets are checked during provider waits', () => {
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const unref = vi.fn();
    setTimeoutSpy.mockReturnValue({
      unref,
    } as unknown as ReturnType<typeof setTimeout>);

    try {
      const scheduler = createSessionSocketStaleSafetyScheduler({
        intervalMs: 100,
        random: () => 0,
        isOnline: () => true,
        runSafetyTick: async () => {},
      });

      scheduler.start();

      expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
      expect(unref).not.toHaveBeenCalled();

      scheduler.stop();
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });
});
