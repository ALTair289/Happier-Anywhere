/**
 * Retention decision for pinned runner dist snapshots.
 *
 * Root cause guarded here (2026-07-10 machine-wide session-killer): the recency+count pruner
 * evicted snapshot dirs still referenced by LIVE session runners, so the next tool spawn
 * (bundled zellij) ENOENT'd and the host was false-classified dead. The decision must never
 * mark a live-referenced fingerprint deletable, and must fail closed when liveness is unknown.
 */
import { describe, it, expect } from 'vitest';

import {
  decidePinnedRunnerSnapshotPrune,
  type LiveRunnerSnapshotFingerprints,
  type PinnedRunnerSnapshotDirEntry,
} from './pinnedRunnerSnapshotPrune';

function reliableLive(fingerprints: string[]): LiveRunnerSnapshotFingerprints {
  return { reliable: true, fingerprints: new Set(fingerprints) };
}

function entries(names: Array<[string, number]>): PinnedRunnerSnapshotDirEntry[] {
  return names.map(([name, mtimeMs]) => ({ name, mtimeMs }));
}

describe('decidePinnedRunnerSnapshotPrune', () => {
  it('never deletes a live-referenced snapshot even when it is older than the keep window', () => {
    // The live runner's snapshot is the OLDEST, well beyond the keepCount window of newer dirs.
    const liveOldFingerprint = 'live00000000old0';
    const decision = decidePinnedRunnerSnapshotPrune({
      entries: entries([
        [liveOldFingerprint, 1_000],
        ['dead0000000000a1', 2_000],
        ['dead0000000000a2', 3_000],
        ['dead0000000000a3', 4_000],
      ]),
      keepFingerprint: 'currentbuild0001',
      live: reliableLive([liveOldFingerprint]),
      keepCount: 2,
    });

    expect(decision.skipped).toBeNull();
    expect(decision.deletable).not.toContain(liveOldFingerprint);
  });

  it('still deletes dead snapshots beyond the cap so disk does not grow unbounded', () => {
    const decision = decidePinnedRunnerSnapshotPrune({
      entries: entries([
        ['dead0000000000a1', 5_000],
        ['dead0000000000a2', 4_000],
        ['dead0000000000a3', 3_000],
        ['dead0000000000a4', 2_000],
      ]),
      keepFingerprint: 'currentbuild0001',
      live: reliableLive([]),
      keepCount: 2,
    });

    expect(decision.skipped).toBeNull();
    // Newest 2 dead kept; the 2 oldest dead deleted.
    expect(decision.deletable).toEqual(['dead0000000000a3', 'dead0000000000a4']);
  });

  it('keeps the current build fingerprint regardless of recency', () => {
    const decision = decidePinnedRunnerSnapshotPrune({
      entries: entries([
        ['currentbuild0001', 1],
        ['dead0000000000a1', 5_000],
        ['dead0000000000a2', 4_000],
        ['dead0000000000a3', 3_000],
      ]),
      keepFingerprint: 'currentbuild0001',
      live: reliableLive([]),
      keepCount: 1,
    });

    expect(decision.deletable).not.toContain('currentbuild0001');
  });

  it('fails closed and deletes nothing when live data is unavailable', () => {
    const decision = decidePinnedRunnerSnapshotPrune({
      entries: entries([
        ['dead0000000000a1', 5_000],
        ['dead0000000000a2', 4_000],
        ['dead0000000000a3', 3_000],
      ]),
      keepFingerprint: 'currentbuild0001',
      live: null,
      keepCount: 1,
    });

    expect(decision.deletable).toEqual([]);
    expect(decision.skipped).toBe('live_data_unavailable');
  });

  it('fails closed and deletes nothing when live data is unreliable', () => {
    const decision = decidePinnedRunnerSnapshotPrune({
      entries: entries([
        ['dead0000000000a1', 5_000],
        ['dead0000000000a2', 4_000],
      ]),
      keepFingerprint: 'currentbuild0001',
      live: { reliable: false, fingerprints: new Set(['dead0000000000a1']) },
      keepCount: 0,
    });

    expect(decision.deletable).toEqual([]);
    expect(decision.skipped).toBe('live_data_unreliable');
  });
});
