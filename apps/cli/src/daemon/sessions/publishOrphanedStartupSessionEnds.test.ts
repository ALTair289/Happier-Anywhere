import { describe, expect, it, vi } from 'vitest';

import { publishOrphanedStartupSessionEnds } from './publishOrphanedStartupSessionEnds';

describe('publishOrphanedStartupSessionEnds', () => {
  it('stages only the marker exact turn and removes evidence after durable acceptance', async () => {
    const calls: string[] = [];
    const apiMachine = {
      enqueueDaemonTerminalExactTurnEnd: vi.fn(async () => { calls.push('persisted'); }),
    };
    const removeSessionMarkerFn = vi.fn(async () => { calls.push('removed'); });

    await publishOrphanedStartupSessionEnds({
      apiMachine,
      orphanedDeadDaemonSessions: [{
        sessionId: 'sess-orphaned-6480',
        pid: 6480,
        activeTurnId: 'turn-exact',
      }],
      removeSessionMarkerFn,
      now: () => 123456789,
    });

    expect(calls).toEqual(['persisted', 'removed']);
    expect(apiMachine.enqueueDaemonTerminalExactTurnEnd).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'sess-orphaned-6480',
      action: 'end_session',
      turnId: 'turn-exact',
      observedAt: 123456789,
    }));
    expect(removeSessionMarkerFn).toHaveBeenCalledWith(6480);
  });

  it('removes a no-turn orphan marker without staging a terminal row', async () => {
    const apiMachine = { enqueueDaemonTerminalExactTurnEnd: vi.fn(async () => {}) };
    const removeSessionMarkerFn = vi.fn(async () => {});

    await publishOrphanedStartupSessionEnds({
      apiMachine,
      orphanedDeadDaemonSessions: [{ sessionId: 'sess-between-turns', pid: 7001 }],
      removeSessionMarkerFn,
      now: () => 123,
    });

    expect(apiMachine.enqueueDaemonTerminalExactTurnEnd).not.toHaveBeenCalled();
    expect(removeSessionMarkerFn).toHaveBeenCalledWith(7001);
  });

  it('retains the orphan marker when durable staging fails', async () => {
    const removeSessionMarkerFn = vi.fn(async () => {});
    await expect(publishOrphanedStartupSessionEnds({
      apiMachine: {
        enqueueDaemonTerminalExactTurnEnd: async () => { throw new Error('disk unavailable'); },
      },
      orphanedDeadDaemonSessions: [{
        sessionId: 'sess-replayable',
        pid: 7002,
        activeTurnId: 'turn-replayable',
      }],
      removeSessionMarkerFn,
      now: () => 456,
    })).rejects.toThrow('disk unavailable');

    expect(removeSessionMarkerFn).not.toHaveBeenCalled();
  });
});
