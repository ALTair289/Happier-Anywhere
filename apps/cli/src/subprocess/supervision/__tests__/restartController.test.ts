import { describe, expect, it } from 'vitest';

import { RestartController } from '../restartController';

describe('RestartController', () => {
  it('does not restart when stop was requested', () => {
    const controller = new RestartController(
      { mode: 'on_unexpected_exit', maxRestarts: 10, baseDelayMs: 10, maxDelayMs: 100, jitterMs: 0 },
      { random: () => 0 },
    );
    controller.markStopRequested({ reason: 'user_request', requestedAtMs: Date.now() });
    const decision = controller.nextDecisionForTermination({ type: 'exited', code: 1 });
    expect(decision).toEqual({ type: 'no_restart', reason: 'stop_requested:user_request' });
  });

  it('enforces maxRestarts', () => {
    const controller = new RestartController(
      { mode: 'on_unexpected_exit', maxRestarts: 1, baseDelayMs: 10, maxDelayMs: 100, jitterMs: 0 },
      { random: () => 0 },
    );
    expect(controller.nextDecisionForTermination({ type: 'exited', code: 1 }).type).toBe('restart_after_delay');
    expect(controller.nextDecisionForTermination({ type: 'exited', code: 1 })).toEqual({
      type: 'no_restart',
      reason: 'max_restarts_exceeded:1',
    });
  });

  it('does not consume the generic crash budget for intended restarts (RR-2)', () => {
    const controller = new RestartController(
      {
        mode: 'on_unexpected_exit',
        maxRestarts: 2,
        maxIntendedRestarts: 5,
        baseDelayMs: 10,
        maxDelayMs: 100,
        jitterMs: 0,
      },
      { random: () => 0 },
    );
    // Several intended (connected-service-initiated) restarts must not touch the crash counter.
    for (let i = 0; i < 5; i += 1) {
      expect(controller.nextDecisionForIntendedRestart().type).toBe('restart_after_delay');
    }
    // The generic crash budget is still fully available afterwards.
    expect(controller.nextDecisionForTermination({ type: 'exited', code: 1 }).type).toBe('restart_after_delay');
    expect(controller.nextDecisionForTermination({ type: 'exited', code: 1 }).type).toBe('restart_after_delay');
    expect(controller.nextDecisionForTermination({ type: 'exited', code: 1 })).toEqual({
      type: 'no_restart',
      reason: 'max_restarts_exceeded:2',
    });
  });

  it('bounds an intended-restart storm by its own limiter (RR-2)', () => {
    const controller = new RestartController(
      {
        mode: 'on_unexpected_exit',
        maxRestarts: 10,
        maxIntendedRestarts: 3,
        baseDelayMs: 10,
        maxDelayMs: 100,
        jitterMs: 0,
      },
      { random: () => 0 },
    );
    expect(controller.nextDecisionForIntendedRestart().type).toBe('restart_after_delay');
    expect(controller.nextDecisionForIntendedRestart().type).toBe('restart_after_delay');
    expect(controller.nextDecisionForIntendedRestart().type).toBe('restart_after_delay');
    expect(controller.nextDecisionForIntendedRestart()).toEqual({
      type: 'no_restart',
      reason: 'max_intended_restarts_exceeded:3',
    });
  });

  it('intended-restart accounting survives successful respawns — crash-budget reset keeps the window (RR-2 cross-cycle)', () => {
    const controller = new RestartController(
      { mode: 'on_unexpected_exit', maxRestarts: 10, maxIntendedRestarts: 3, baseDelayMs: 10, maxDelayMs: 100, jitterMs: 0 },
      { random: () => 0, now: () => 1_000 },
    );
    expect(controller.nextDecisionForIntendedRestart().type).toBe('restart_after_delay');
    // A SUCCESSFUL respawn ends the cycle: only the crash budget resets, never the intended window.
    controller.resetCrashBudget();
    expect(controller.nextDecisionForIntendedRestart().type).toBe('restart_after_delay');
    controller.resetCrashBudget();
    expect(controller.nextDecisionForIntendedRestart().type).toBe('restart_after_delay');
    controller.resetCrashBudget();
    expect(controller.nextDecisionForIntendedRestart()).toEqual({
      type: 'no_restart',
      reason: 'max_intended_restarts_exceeded:3',
    });
    // Crash budget itself is untouched by the intended storm.
    expect(controller.nextDecisionForTermination({ type: 'exited', code: 1 }).type).toBe('restart_after_delay');
  });

  it('lets occasional intended restarts spread over time through window decay (RR-2)', () => {
    let now = 0;
    const controller = new RestartController(
      {
        mode: 'on_unexpected_exit',
        maxRestarts: 10,
        maxIntendedRestarts: 2,
        intendedRestartWindowMs: 1_000,
        baseDelayMs: 10,
        maxDelayMs: 100,
        jitterMs: 0,
      },
      { random: () => 0, now: () => now },
    );
    expect(controller.nextDecisionForIntendedRestart().type).toBe('restart_after_delay');
    now = 500;
    expect(controller.nextDecisionForIntendedRestart().type).toBe('restart_after_delay');
    now = 600;
    expect(controller.nextDecisionForIntendedRestart()).toEqual({
      type: 'no_restart',
      reason: 'max_intended_restarts_exceeded:2',
    });
    // Window decays: after the old restarts age out, a legitimate restart is allowed again.
    now = 1_601;
    expect(controller.nextDecisionForIntendedRestart().type).toBe('restart_after_delay');
    expect(controller.hasRecentIntendedRestarts()).toBe(true);
  });

  it('still suppresses intended restarts when stop was requested', () => {
    const controller = new RestartController(
      { mode: 'on_unexpected_exit', maxRestarts: 10, maxIntendedRestarts: 3, baseDelayMs: 10, maxDelayMs: 100, jitterMs: 0 },
      { random: () => 0 },
    );
    controller.markStopRequested({ reason: 'user_request', requestedAtMs: Date.now() });
    expect(controller.nextDecisionForIntendedRestart()).toEqual({
      type: 'no_restart',
      reason: 'stop_requested:user_request',
    });
  });
});

