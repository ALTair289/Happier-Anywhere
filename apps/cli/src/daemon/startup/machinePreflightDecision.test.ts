import { describe, expect, it } from 'vitest';

import { resolveStartDaemonMachinePreflightDecision } from './machinePreflightDecision';

describe('resolveStartDaemonMachinePreflightDecision', () => {
  it('skips the synchronous machine preflight for matching self-restart replacements', () => {
    expect(resolveStartDaemonMachinePreflightDecision({
      runningDaemonVersionMatches: true,
      startupSource: 'self-restart',
    })).toBe('skip_sync_preflight_for_self_restart');
  });

  it('runs the synchronous machine preflight for matching manual starts', () => {
    expect(resolveStartDaemonMachinePreflightDecision({
      runningDaemonVersionMatches: true,
      startupSource: 'manual',
    })).toBe('run_sync_preflight');
  });

  it('skips the synchronous machine preflight for self-restart even when the current state does not match yet', () => {
    expect(resolveStartDaemonMachinePreflightDecision({
      runningDaemonVersionMatches: false,
      startupSource: 'self-restart',
    })).toBe('skip_sync_preflight_for_self_restart');
  });

  it('stops the current daemon before preflight when a manual start sees a version or machine mismatch', () => {
    expect(resolveStartDaemonMachinePreflightDecision({
      runningDaemonVersionMatches: false,
      startupSource: 'manual',
    })).toBe('stop_current_daemon');
  });
});
