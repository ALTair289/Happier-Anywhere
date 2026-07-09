import { describe, expect, it } from 'vitest';

import { loadSyncTuning } from '@/sync/runtime/syncTuning';

import type { FeedItem } from '../../domains/social/feedTypes';
import { createFeedDomain } from './feed';

type State = ReturnType<typeof createFeedDomain> & { friendsLoaded: boolean };

function createHarness(): { get: () => State } {
  let state = {} as State;
  const get = () => state;
  const set = (updater: (state: State) => State) => {
    state = updater(state);
  };
  state = {
    friendsLoaded: false,
    ...createFeedDomain({ get, set } as any),
  };
  return { get };
}

function feedItem(counter: number): FeedItem {
  return {
    id: `feed_${counter}`,
    repeatKey: null,
    body: { kind: 'text', text: `item ${counter}` },
    createdAt: counter,
    cursor: `c:${counter}`,
    counter,
  };
}

describe('createFeedDomain', () => {
  it('retains only the newest configured feed items', () => {
    const cap = (loadSyncTuning() as { feedItemsRetentionMaxCount?: number }).feedItemsRetentionMaxCount ?? 500;
    const harness = createHarness();

    harness.get().applyFeedItems(Array.from({ length: cap + 2 }, (_, index) => feedItem(index + 1)));

    expect(harness.get().feedItems).toHaveLength(cap);
    expect(harness.get().feedItems[0]?.id).toBe(`feed_${cap + 2}`);
    expect(harness.get().feedItems.at(-1)?.id).toBe('feed_3');
    expect(harness.get().feedTail).toBe('c:3');
  });
});
