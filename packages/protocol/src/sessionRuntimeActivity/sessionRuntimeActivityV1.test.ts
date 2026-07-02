import { describe, expect, it } from 'vitest';

import {
  SESSION_RUNTIME_ACTIVITY_SOURCE_LIMIT,
  buildSessionRuntimeActivityV1,
  hasActiveSessionRuntimeActivity,
  isSessionRuntimeActivityProjectionIdleForPendingDrain,
  listActiveSessionRuntimeActivitySources,
  readSessionRuntimeActivityV1,
} from './sessionRuntimeActivityV1.js';

const activeSource = (overrides: Partial<{
  id: string;
  kind: 'provider_detached_task' | 'provider_autonomous_output';
  status: 'active' | 'ending' | 'stale';
  startedAtMs: number;
  lastObservedAtMs: number;
  expiresAtMs: number;
}> = {}) => ({
  id: 'source-1',
  kind: 'provider_detached_task' as const,
  status: 'active' as const,
  startedAtMs: 1_000,
  lastObservedAtMs: 2_000,
  expiresAtMs: 10_000,
  ...overrides,
});

describe('SessionRuntimeActivityV1', () => {
  it('builds a bounded provider-neutral snapshot and derives active sources from valid future leases', () => {
    const snapshot = buildSessionRuntimeActivityV1({
      observedAtMs: 3_000,
      nowMs: 4_000,
      sources: [
        activeSource({ id: 'a', expiresAtMs: 8_000 }),
        activeSource({ id: 'b', kind: 'provider_autonomous_output', status: 'ending', expiresAtMs: 9_000 }),
        activeSource({ id: 'expired', expiresAtMs: 4_000 }),
        activeSource({ id: 'stale', status: 'stale', expiresAtMs: 20_000 }),
      ],
    });

    expect(snapshot).toMatchObject({ v: 1, observedAtMs: 3_000, activeCount: 2 });
    expect(listActiveSessionRuntimeActivitySources(snapshot, 4_000).map((source) => source.id)).toEqual(['a', 'b']);
    expect(hasActiveSessionRuntimeActivity(snapshot, 4_000)).toBe(true);
    expect(hasActiveSessionRuntimeActivity(snapshot, 9_000)).toBe(false);
  });

  it('treats missing, invalid, or elapsed leases as idle instead of blocking display or delivery', () => {
    const snapshot = buildSessionRuntimeActivityV1({
      observedAtMs: 3_000,
      nowMs: 5_000,
      sources: [
        { ...activeSource({ id: 'missing' }), expiresAtMs: undefined as unknown as number },
        activeSource({ id: 'invalid', expiresAtMs: -1 }),
        activeSource({ id: 'elapsed', expiresAtMs: 5_000 }),
      ],
    });

    expect(snapshot.activeCount).toBe(0);
    expect(listActiveSessionRuntimeActivitySources(snapshot, 5_000)).toEqual([]);
    expect(hasActiveSessionRuntimeActivity(snapshot, 5_000)).toBe(false);
  });

  it('derives pending-drain idleness from active count and valid future projection expiry only', () => {
    expect(isSessionRuntimeActivityProjectionIdleForPendingDrain({
      runtimeActivityActiveCount: 1,
      runtimeActivityObservedAt: null,
      runtimeActivityExpiresAt: 10_000,
      runtimeActivitySourceClass: null,
    }, 5_000)).toBe(false);
    expect(isSessionRuntimeActivityProjectionIdleForPendingDrain({
      runtimeActivityActiveCount: 1,
      runtimeActivityObservedAt: BigInt(4_000),
      runtimeActivityExpiresAt: BigInt(10_000),
      runtimeActivitySourceClass: 'provider_detached_task',
    }, 5_000)).toBe(false);
    expect(isSessionRuntimeActivityProjectionIdleForPendingDrain({
      runtimeActivityActiveCount: 1,
      runtimeActivityObservedAt: 4_000,
      runtimeActivityExpiresAt: null,
      runtimeActivitySourceClass: 'provider_detached_task',
    }, 5_000)).toBe(true);
    expect(isSessionRuntimeActivityProjectionIdleForPendingDrain({
      runtimeActivityActiveCount: 1,
      runtimeActivityObservedAt: 4_000,
      runtimeActivityExpiresAt: 5_000,
      runtimeActivitySourceClass: 'provider_detached_task',
    }, 5_000)).toBe(true);
    expect(isSessionRuntimeActivityProjectionIdleForPendingDrain({
      runtimeActivityActiveCount: 0,
      runtimeActivityObservedAt: 4_000,
      runtimeActivityExpiresAt: 10_000,
      runtimeActivitySourceClass: null,
    }, 5_000)).toBe(true);
  });

  it('parses valid snapshots, strips unknown detail fields, and rejects malformed snapshots', () => {
    const parsed = readSessionRuntimeActivityV1({
      v: 1,
      observedAtMs: 3_000,
      activeCount: 1,
      blocksInput: true,
      sources: [{
        ...activeSource(),
        label: 'must not survive parse',
        diagnostic: 'must not survive parse',
        blocksInput: true,
      }],
    });

    expect(parsed).not.toBeNull();
    expect(parsed).not.toHaveProperty('blocksInput');
    expect(parsed?.sources[0]).not.toHaveProperty('label');
    expect(parsed?.sources[0]).not.toHaveProperty('diagnostic');
    expect(parsed?.sources[0]).not.toHaveProperty('blocksInput');
    expect(readSessionRuntimeActivityV1({ v: 1, observedAtMs: 'bad', activeCount: 0, sources: [] })).toBeNull();
    expect(readSessionRuntimeActivityV1({ v: 2, observedAtMs: 1, activeCount: 0, sources: [] })).toBeNull();
  });

  it('bounds retained sources so provider ledgers cannot leak an unbounded snapshot', () => {
    const snapshot = buildSessionRuntimeActivityV1({
      observedAtMs: 10_000,
      nowMs: 10_000,
      sources: Array.from({ length: SESSION_RUNTIME_ACTIVITY_SOURCE_LIMIT + 5 }, (_, index) => activeSource({
        id: `source-${index}`,
        lastObservedAtMs: 20_000 - index,
        expiresAtMs: 30_000,
      })),
    });

    expect(snapshot.sources).toHaveLength(SESSION_RUNTIME_ACTIVITY_SOURCE_LIMIT);
    expect(snapshot.sources[0]?.id).toBe('source-0');
    expect(snapshot.activeCount).toBe(SESSION_RUNTIME_ACTIVITY_SOURCE_LIMIT + 5);
  });
});
