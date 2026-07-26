import { describe, expect, it } from 'vitest';

import { createSessionMediaTurnState } from './sessionMediaTurnState';

function createDeferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe('sessionMediaTurnState', () => {
  it('bounds reservations while allowing an unavailable key to retry in its existing slot', () => {
    const state = createSessionMediaTurnState<{ key: string }>({
      maxEntries: 2,
      resolveDedupeKey: (item) => item.key,
    });

    expect(state.admit([{ key: 'a' }, { key: 'b' }, { key: 'c' }]).map((entry) => entry.dedupeKey))
      .toEqual(['a', 'b']);
    expect(state.reservedSize).toBe(2);
    expect(state.takeOverflowCount()).toBe(1);

    state.finish('a', 'unavailable');
    expect(state.admit([{ key: 'a' }, { key: 'c' }]).map((entry) => entry.dedupeKey))
      .toEqual(['a']);
    state.finish('a', 'persisted');
    expect(state.admit([{ key: 'a' }])).toEqual([]);
  });

  it('releases empty or failed keys, removes settled promises, and clears all turn state on reset', async () => {
    const state = createSessionMediaTurnState<{ key: string }>({
      maxEntries: 1,
      resolveDedupeKey: (item) => item.key,
    });
    expect(state.admit([{ key: 'a' }])).toHaveLength(1);
    state.finish('a', 'release');
    expect(state.admit([{ key: 'b' }])).toHaveLength(1);

    const deferred = createDeferred();
    state.track(deferred.promise);
    expect(state.pendingSize).toBe(1);
    deferred.resolve();
    await state.drain();
    expect(state.pendingSize).toBe(0);

    state.recordOverflow(3);
    state.reset();
    expect(state.reservedSize).toBe(0);
    expect(state.pendingSize).toBe(0);
    expect(state.takeOverflowCount()).toBe(0);
    expect(state.admit([{ key: 'next-turn' }])).toHaveLength(1);
  });
});
