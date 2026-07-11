/**
 * Retention decision for pinned runner dist snapshots (`.runner-snapshots/<fingerprint>/`).
 *
 * A snapshot dir is the frozen dist closure a session runner spawned from; the runner keeps
 * spawning bundled tools (zellij, node-pty relay, ripgrep) from paths INSIDE its snapshot for its
 * whole lifetime. Deleting a snapshot out from under a live runner turns the next tool spawn into
 * an ENOENT that upstream classification can misread as a dead host — a machine-wide session-killer
 * (2026-07-10 root cause). Retention must therefore be liveness-aware, not recency+count only.
 *
 * Invariants enforced here:
 * - A fingerprint referenced by a live runner is NEVER deletable, regardless of age or count.
 * - The build fingerprint currently being created is NEVER deletable.
 * - Fail closed: when liveness is unavailable or unreliable, delete nothing.
 * - Growth guard: among the remaining (dead) snapshots, keep only the newest `keepCount`.
 */

export type LiveRunnerSnapshotFingerprints = Readonly<{
  /** Whether the fingerprint set was enumerated from an authoritative live-runner source. */
  reliable: boolean;
  fingerprints: ReadonlySet<string>;
}>;

export type PinnedRunnerSnapshotDirEntry = Readonly<{
  name: string;
  mtimeMs: number;
}>;

export type PinnedRunnerSnapshotPruneSkipReason =
  | 'live_data_unavailable'
  | 'live_data_unreliable';

export type PinnedRunnerSnapshotPruneDecision = Readonly<{
  deletable: readonly string[];
  skipped: PinnedRunnerSnapshotPruneSkipReason | null;
}>;

export function decidePinnedRunnerSnapshotPrune(params: Readonly<{
  entries: readonly PinnedRunnerSnapshotDirEntry[];
  keepFingerprint: string;
  live: LiveRunnerSnapshotFingerprints | null | undefined;
  keepCount: number;
}>): PinnedRunnerSnapshotPruneDecision {
  const { entries, keepFingerprint, live } = params;
  const keepCount = Math.max(0, Math.trunc(params.keepCount));

  if (!live) {
    return { deletable: [], skipped: 'live_data_unavailable' };
  }
  if (!live.reliable) {
    return { deletable: [], skipped: 'live_data_unreliable' };
  }

  const protectedNames = new Set<string>(live.fingerprints);
  if (keepFingerprint) protectedNames.add(keepFingerprint);

  const deadNewestFirst = entries
    .filter((entry) => !protectedNames.has(entry.name))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  const deletable = deadNewestFirst.slice(keepCount).map((entry) => entry.name);
  return { deletable, skipped: null };
}
