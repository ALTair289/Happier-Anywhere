import { describe, expect, it } from 'vitest';

import { awaitCursorPermissionDecision } from '../permission';

describe('Cursor extension permission cancellation', () => {
  it('removes its abort listener immediately when cancellation wins an unresolved decision race', async () => {
    const abortListeners = new Set<() => void>();
    let removeCalls = 0;
    const signal = {
      aborted: false,
      reason: undefined,
      addEventListener(type: string, listener: () => void) {
        if (type === 'abort') abortListeners.add(listener);
      },
      removeEventListener(type: string, listener: () => void) {
        if (type !== 'abort') return;
        removeCalls += 1;
        abortListeners.delete(listener);
      },
    // Boundary fixture exposes only the AbortSignal methods used by the cancellation owner.
    } as unknown as AbortSignal;
    const decision = new Promise<never>(() => {});
    const pending = awaitCursorPermissionDecision(() => decision, {
      method: 'cursor/ask_question',
      sessionId: 'session-1',
      signal,
      agentName: 'cursor',
    });

    for (const listener of abortListeners) listener();

    await expect(pending).rejects.toThrow(/aborted/i);
    expect(removeCalls).toBe(1);
    expect(abortListeners.size).toBe(0);
  });
});
