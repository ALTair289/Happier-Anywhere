import { describe, expect, it } from 'vitest';

import { applyConnectedServiceAuthGroupGenerationToSessions } from './applyAuthGroupGenerationToSessions';

function deferred() {
  let resolve: (value: Readonly<{ ok: boolean; action?: string; errorCode?: string }>) => void = () => {};
  const promise = new Promise<Readonly<{ ok: boolean; action?: string; errorCode?: string }>>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

describe('applyConnectedServiceAuthGroupGenerationToSessions', () => {
  it('fans out to sessions in parallel instead of serializing turn-boundary deferrals', async () => {
    // Live incident 2026-07-10: the sequential loop meant N mid-turn sessions cost N × the 60s
    // deferral window, guaranteeing the client ack aborted and the UI reported divergence on every
    // pool switch. Sessions are independent (per-session FSM locks); the fan-out must overlap them.
    const first = deferred();
    const second = deferred();
    const started: string[] = [];

    const resultPromise = applyConnectedServiceAuthGroupGenerationToSessions({
      serviceId: 'openai-codex',
      groupId: 'team',
      activeProfileId: 'next',
      generation: 7,
      switchReason: 'manual',
      reason: 'manual',
      targets: [
        { sessionId: 'sess_1', fromProfileId: 'prev' },
        { sessionId: 'sess_2', fromProfileId: null },
      ],
      applyAuthGeneration: async (input) => {
        started.push(input.sessionId);
        return input.sessionId === 'sess_1' ? first.promise : second.promise;
      },
    });

    // Both applies must have STARTED before either resolves — the sequential shape never starts
    // the second until the first settles.
    await Promise.resolve();
    expect(started.sort()).toEqual(['sess_1', 'sess_2']);

    first.resolve({ ok: true, action: 'restart_requested' });
    second.resolve({ ok: true, action: 'hot_applied' });
    await expect(resultPromise).resolves.toEqual({
      ok: true,
      appliedSessionCount: 1,
      restartRequestedSessionCount: 1,
      skippedIdleSessionCount: 0,
      failedSessionCount: 0,
      failures: [],
    });
  });

  it('records per-session failures without aborting the other sessions', async () => {
    const result = await applyConnectedServiceAuthGroupGenerationToSessions({
      serviceId: 'openai-codex',
      groupId: 'team',
      activeProfileId: 'next',
      generation: 7,
      switchReason: 'manual',
      reason: 'manual',
      targets: [
        { sessionId: 'sess_ok', fromProfileId: null },
        { sessionId: 'sess_fail', fromProfileId: null },
        { sessionId: 'sess_throw', fromProfileId: null },
      ],
      applyAuthGeneration: async (input) => {
        if (input.sessionId === 'sess_fail') return { ok: false, errorCode: 'restart_failed' };
        if (input.sessionId === 'sess_throw') throw new Error('boom');
        return { ok: true, action: 'metadata_updated' };
      },
    });

    expect(result.ok).toBe(false);
    expect(result.appliedSessionCount).toBe(1);
    expect(result.failedSessionCount).toBe(2);
    expect(result.failures).toEqual(expect.arrayContaining([
      { sessionId: 'sess_fail', errorCode: 'restart_failed' },
      { sessionId: 'sess_throw', errorCode: 'apply_generation_threw' },
    ]));
  });

  it('bounds fan-out concurrency so a large pool cannot thundering-herd restarts', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const targets = Array.from({ length: 12 }, (_, index) => ({
      sessionId: `sess_${index}`,
      fromProfileId: null,
    }));

    const result = await applyConnectedServiceAuthGroupGenerationToSessions({
      serviceId: 'openai-codex',
      groupId: 'team',
      activeProfileId: 'next',
      generation: 7,
      switchReason: 'manual',
      reason: 'manual',
      targets,
      applyAuthGeneration: async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 1));
        inFlight -= 1;
        return { ok: true, action: 'hot_applied' };
      },
    });

    expect(result.appliedSessionCount).toBe(12);
    expect(maxInFlight).toBeLessThanOrEqual(4);
    expect(maxInFlight).toBeGreaterThan(1);
  });
});
