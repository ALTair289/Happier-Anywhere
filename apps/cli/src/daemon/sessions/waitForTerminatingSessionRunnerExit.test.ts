import { describe, expect, it, vi } from 'vitest';

import { waitForTerminatingSessionRunnerExit } from './waitForTerminatingSessionRunnerExit';

describe('waitForTerminatingSessionRunnerExit', () => {
  it('waits only for an explicitly terminating runner and returns the first settled probe', async () => {
    let nowMs = 0;
    const probe = vi.fn()
      .mockResolvedValueOnce({
        state: 'runner_present' as const,
        control: { state: 'recoverable_unservable' as const, reason: 'runtime_terminating' as const },
      })
      .mockResolvedValueOnce({ state: 'runner_absent' as const });

    await expect(waitForTerminatingSessionRunnerExit({
      initialProbe: {
        state: 'runner_present',
        control: { state: 'recoverable_unservable', reason: 'runtime_terminating' },
      },
      probe,
      timeoutMs: 100,
      pollIntervalMs: 10,
      now: () => nowMs,
      sleep: async (delayMs) => { nowMs += delayMs; },
    })).resolves.toEqual({ state: 'runner_absent' });
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('does not wait for an unknown or unsupported live runner', async () => {
    const probe = vi.fn();
    const initialProbe = {
      state: 'runner_present' as const,
      control: { state: 'unknown' as const, reason: 'rpc_failed' as const },
    };
    await expect(waitForTerminatingSessionRunnerExit({
      initialProbe,
      probe,
      timeoutMs: 100,
      pollIntervalMs: 10,
    })).resolves.toBe(initialProbe);
    expect(probe).not.toHaveBeenCalled();
  });
});
