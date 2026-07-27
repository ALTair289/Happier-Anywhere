import { logger } from '@/ui/logger';
import type { LiveRunnerSnapshotFingerprints } from '@/utils/pinnedRunnerSnapshotPrune';

import { resolveSessionRunnerEntrypointIdentityFromProcessCommand } from './resolveRunnerEntrypointIdentity';

const SNAPSHOT_COMPARABLE_ID_PREFIX = 'snapshot:';

/**
 * The subset of a tracked session this resolver reads. Prefer the untruncated spawn argv the daemon
 * launched the runner with; fall back to the observed (possibly ps-truncated) process command.
 */
export type LiveRunnerSnapshotSource = Readonly<{
  processCommand?: string;
  childProcess?: { spawnargs?: readonly (string | undefined)[] } | undefined;
}>;

function resolveTrackedSessionCommand(source: LiveRunnerSnapshotSource): string | null {
  const spawnargs = source.childProcess?.spawnargs;
  if (Array.isArray(spawnargs)) {
    const joined = spawnargs
      .filter((arg): arg is string => typeof arg === 'string' && arg.trim().length > 0)
      .join(' ');
    if (joined.trim().length > 0) return joined;
  }
  const command = typeof source.processCommand === 'string' ? source.processCommand.trim() : '';
  return command.length > 0 ? command : null;
}

/**
 * Enumerate the pinned-snapshot fingerprints referenced by LIVE session runners so the daemon spawn
 * path can protect them from pruning (`pinnedRunnerSnapshotPrune`). The in-memory tracked sessions
 * ARE the daemon's authoritative live-runner registry — this reuses the canonical entrypoint-identity
 * parser and derives the `snapshot:<fingerprint>` attestation; it does not introduce a second registry.
 *
 * Fail-closed: any enumeration failure returns `{ reliable: false }`, which makes pruning delete
 * nothing rather than risk evicting a live runner's snapshot.
 */
export function resolveLiveRunnerSnapshotFingerprints(
  trackedSessions: Iterable<LiveRunnerSnapshotSource>,
): LiveRunnerSnapshotFingerprints {
  try {
    const fingerprints = new Set<string>();
    for (const tracked of trackedSessions) {
      const command = resolveTrackedSessionCommand(tracked);
      // A tracked runner is authoritative liveness data. Without an entrypoint command we cannot
      // rule out a snapshot-backed adopted runner, so pruning must fail closed rather than silently
      // treat its snapshot as dead.
      if (!command) return { reliable: false, fingerprints: new Set() };
      const identity = resolveSessionRunnerEntrypointIdentityFromProcessCommand(command);
      // `known` non-snapshot identities (`path:` / `version:`) positively rule snapshot use out;
      // only an unknown identity leaves its snapshot fingerprint indeterminate.
      if (identity.status !== 'known') return { reliable: false, fingerprints: new Set() };
      if (!identity.comparableId.startsWith(SNAPSHOT_COMPARABLE_ID_PREFIX)) continue;
      const fingerprint = identity.comparableId.slice(SNAPSHOT_COMPARABLE_ID_PREFIX.length).trim();
      if (fingerprint) fingerprints.add(fingerprint);
    }
    return { reliable: true, fingerprints };
  } catch (error) {
    logger.debug(`[DAEMON RUN] Could not enumerate live runner snapshot fingerprints: ${String(error)}`);
    return { reliable: false, fingerprints: new Set() };
  }
}
