import { describe, expect, it } from 'vitest';

import { CursorAvailableModelsContribution } from '../CursorAvailableModelsContribution';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

describe('CursorAvailableModelsContribution', () => {
  it('clears on a new generation and ignores late completion from an old generation', async () => {
    const changes: unknown[] = [];
    const first = deferred<unknown>();
    const contribution = new CursorAvailableModelsContribution({ onChange: (value) => changes.push(value) });

    const generation1 = contribution.beginGeneration();
    const discovery1 = contribution.discover(generation1, async () => first.promise);
    const generation2 = contribution.beginGeneration();
    await contribution.discover(generation2, async () => ({
      models: [{ value: 'new', name: 'New' }],
    }));
    first.resolve({ models: [{ value: 'old', name: 'Old' }] });
    await discovery1;

    expect(contribution.current()).toEqual([{ value: 'new', name: 'New' }]);
    expect(changes.at(-1)).toEqual([{ value: 'new', name: 'New' }]);
  });

  it('clears only the proprietary contribution after a current-generation malformed response', async () => {
    const contribution = new CursorAvailableModelsContribution({ onChange: () => {} });
    const generation = contribution.beginGeneration();
    await contribution.discover(generation, async () => ({ models: [{ value: 'a', name: 'A' }] }));
    await contribution.discover(generation, async () => ({ models: [{ value: '', name: 'bad' }] }));
    expect(contribution.current()).toBeNull();
  });
});
