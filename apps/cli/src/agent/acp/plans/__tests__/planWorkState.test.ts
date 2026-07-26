import { describe, expect, it } from 'vitest';

import { mergeSessionWorkStateMetadataV1 } from '@/session/workState/sessionWorkStateMetadata';
import { buildAcpPlanWorkState, resolveAcpPlanWorkStateItemPrefix } from '../planWorkState';
import { normalizeAcpPlan } from '../normalizeAcpPlan';

describe('ACP plan work-state projection', () => {
  it('maps statuses and stable vendor ids into generic todo work state', () => {
    const snapshot = normalizeAcpPlan({
      providerId: 'cursor',
      turnId: 'turn-1',
      source: 'proprietary',
      merge: false,
      items: [
        { id: 'one', content: 'One', status: 'pending' },
        { id: 'two', content: 'Two', status: 'in_progress' },
        { id: 'three', content: 'Three', status: 'completed' },
        { id: 'four', content: 'Four', status: 'cancelled' },
      ],
    })!;
    const workState = buildAcpPlanWorkState({ snapshot, updatedAt: 10 });
    const cursorPrefix = resolveAcpPlanWorkStateItemPrefix('cursor');

    expect(workState.items.map(({ id, status, vendorRef, order }) => ({
      hasOwnedPrefix: id.startsWith(cursorPrefix), status, vendorRef, order,
    }))).toEqual([
      { hasOwnedPrefix: true, status: 'pending', vendorRef: 'one', order: 0 },
      { hasOwnedPrefix: true, status: 'active', vendorRef: 'two', order: 1 },
      { hasOwnedPrefix: true, status: 'complete', vendorRef: 'three', order: 2 },
      { hasOwnedPrefix: true, status: 'cancelled', vendorRef: 'four', order: 3 },
    ]);
  });

  it('clears only ACP-plan-owned items on empty replacement', () => {
    const cursorPrefix = resolveAcpPlanWorkStateItemPrefix('cursor');
    const otherAcpPrefix = resolveAcpPlanWorkStateItemPrefix('other-acp');
    const previous = {
      sessionWorkStateV1: {
        v: 1 as const,
        backendId: 'mixed',
        updatedAt: 1,
        primaryItemId: 'goal:other',
        items: [
          { id: 'goal:other', kind: 'goal', origin: 'happier', status: 'active', title: 'Keep', updatedAt: 1 },
          { id: `${cursorPrefix}old`, kind: 'todo', origin: 'vendor', status: 'pending', title: 'Old', updatedAt: 1 },
          { id: `${otherAcpPrefix}keep`, kind: 'todo', origin: 'vendor', status: 'pending', title: 'Other ACP', updatedAt: 1 },
        ],
      },
    };
    const empty = buildAcpPlanWorkState({
      snapshot: normalizeAcpPlan({
        providerId: 'cursor', turnId: 'turn-1', source: 'proprietary', merge: false, items: [],
      })!,
      updatedAt: 2,
    });

    const next = mergeSessionWorkStateMetadataV1({
      metadata: previous,
      nextOwned: empty,
      ownedItemIdPrefixes: [cursorPrefix],
    });
    expect(next.sessionWorkStateV1.items.map((item) => (item as { id: string }).id)).toEqual([
      'goal:other',
      `${otherAcpPrefix}keep`,
    ]);
  });

  it('does not collapse distinct exact opaque vendor ids into one work-state identity', () => {
    const snapshot = normalizeAcpPlan({
      providerId: 'cursor',
      turnId: 'turn-exact-ids',
      source: 'proprietary',
      merge: false,
      items: [
        { id: 'todo', content: 'Plain', status: 'pending' },
        { id: ' todo ', content: 'Spaced', status: 'pending' },
      ],
    })!;
    const state = buildAcpPlanWorkState({ snapshot, updatedAt: 10 });

    expect(state.items[0]?.vendorRef).toBe('todo');
    expect(state.items[1]?.vendorRef).toBe(' todo ');
    expect(state.items[0]?.id).not.toBe(state.items[1]?.id);
  });
});
