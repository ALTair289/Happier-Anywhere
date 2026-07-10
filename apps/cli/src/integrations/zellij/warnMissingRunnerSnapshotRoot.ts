/**
 * Orphan surfacing for pinned runner dist snapshots.
 *
 * A session runner spawns bundled tools (zellij, node-pty relay) from paths inside its own
 * `.runner-snapshots/<fingerprint>/` root for its whole lifetime. If that root is deleted out from
 * under the still-running runner, those spawns ENOENT. This helper makes that class diagnosable by
 * emitting ONE distinct WARN naming the snapshot fingerprint and runner pid.
 *
 * It is diagnostic-only: it never restarts anything and never classifies host liveness/death.
 */
import { existsSync } from 'node:fs';

import { logger } from '@/ui/logger';

const RUNNER_SNAPSHOTS_SEGMENT = '.runner-snapshots';

export type MissingRunnerSnapshotRoot = Readonly<{
  fingerprint: string;
  snapshotRoot: string;
}>;

function normalizeSeparators(pathLike: string): string {
  return pathLike.replaceAll('\\', '/');
}

/**
 * When `entrypointPath` points inside a `.runner-snapshots/<fingerprint>/` root and that root no
 * longer exists on disk, return the fingerprint + root; otherwise null.
 */
export function describeMissingRunnerSnapshotRoot(params: Readonly<{
  entrypointPath: string | null | undefined;
  rootExists?: (rootPath: string) => boolean;
}>): MissingRunnerSnapshotRoot | null {
  const entrypointPath = typeof params.entrypointPath === 'string' ? params.entrypointPath.trim() : '';
  if (!entrypointPath) return null;

  const normalized = normalizeSeparators(entrypointPath);
  const match = new RegExp(`^(.*/${RUNNER_SNAPSHOTS_SEGMENT}/([^/]+))(?:/|$)`).exec(normalized);
  const snapshotRoot = match?.[1];
  const fingerprint = match?.[2]?.trim();
  if (!snapshotRoot || !fingerprint || fingerprint.startsWith('.')) return null;

  const rootExists = params.rootExists ?? ((rootPath: string) => existsSync(rootPath));
  if (rootExists(snapshotRoot)) return null;

  return { fingerprint, snapshotRoot };
}

let hasWarnedAboutMissingOwnSnapshotRoot = false;

export function __resetRunnerSnapshotRootWarningForTests(): void {
  hasWarnedAboutMissingOwnSnapshotRoot = false;
}

/**
 * If the current runner's own snapshot root has been pruned away, emit ONE distinct WARN naming the
 * snapshot and runner. Returns whether it warned. Idempotent per process.
 */
export function warnIfOwnRunnerSnapshotRootMissing(params: Readonly<{
  entrypointPath?: string | null;
  pid?: number;
  rootExists?: (rootPath: string) => boolean;
  warn?: (message: string) => void;
}> = {}): boolean {
  if (hasWarnedAboutMissingOwnSnapshotRoot) return false;

  const entrypointPath = params.entrypointPath ?? process.argv[1];
  const missing = describeMissingRunnerSnapshotRoot({
    entrypointPath,
    rootExists: params.rootExists,
  });
  if (!missing) return false;

  hasWarnedAboutMissingOwnSnapshotRoot = true;
  const pid = typeof params.pid === 'number' && Number.isInteger(params.pid) ? params.pid : process.pid;
  const warn = params.warn ?? ((message: string) => logger.warn(message));
  warn(
    `[RUNNER SNAPSHOT ORPHAN] Runner pid ${pid} is running from pinned snapshot ${missing.fingerprint} but its snapshot root ${missing.snapshotRoot} no longer exists on disk; bundled tool spawns from this snapshot will fail. This runner should be restarted.`,
  );
  return true;
}
