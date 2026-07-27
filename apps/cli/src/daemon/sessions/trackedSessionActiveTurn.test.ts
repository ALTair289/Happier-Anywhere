import { describe, expect, it } from 'vitest';

import { resolveTrackedSessionActiveTurn } from './trackedSessionActiveTurn';

describe('resolveTrackedSessionActiveTurn', () => {
  it('returns only the exact tracked session/marker turn identity', () => {
    expect(resolveTrackedSessionActiveTurn({
      pid: 51,
      sessionRunnerPid: 52,
      happySessionId: 'session-1',
      activeTurnId: 'session-turn:exact-1',
    })).toEqual({
      sessionId: 'session-1',
      turnId: 'session-turn:exact-1',
      markerPid: 52,
    });
  });

  it('returns null when no exact open turn is tracked', () => {
    expect(resolveTrackedSessionActiveTurn({
      pid: 51,
      happySessionId: 'session-1',
    })).toBeNull();
    expect(resolveTrackedSessionActiveTurn({
      pid: 51,
      activeTurnId: 'session-turn:orphan',
    })).toBeNull();
  });
});
