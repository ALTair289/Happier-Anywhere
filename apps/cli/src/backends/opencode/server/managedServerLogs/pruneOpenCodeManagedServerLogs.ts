import { configuration } from '@/configuration';
import { pruneLogsByCount } from '@/utils/logs/pruneLogsByCount';
import { readPositiveIntEnv } from '@/utils/readPositiveIntEnv';

import { resolveOpenCodeManagedServersLogDir } from './resolveOpenCodeManagedServerLogPath';

export const OPENCODE_MANAGED_SERVER_LOG_KEEP_COUNT_ENV = 'HAPPIER_OPENCODE_MANAGED_SERVER_LOG_KEEP_COUNT';
const DEFAULT_KEEP_COUNT = 50;

function resolveKeepCount(explicit: number | undefined): number {
  if (typeof explicit === 'number' && Number.isInteger(explicit) && explicit > 0) return explicit;
  return readPositiveIntEnv(OPENCODE_MANAGED_SERVER_LOG_KEEP_COUNT_ENV, DEFAULT_KEEP_COUNT);
}

/**
 * Prune old managed-server logs by COUNT (never by age, never deleting the current log).
 *
 * Files are named `<timestamp>-port-...-pid-...log`, so a descending filename sort is chronological
 * (newest first). The newest `keepCount` are retained; the rest are removed best-effort. `keepPath`
 * (the just-created log) is ALWAYS retained regardless of count. Best-effort: never throws.
 */
export async function pruneOpenCodeManagedServerLogs(params: Readonly<{
  logsDir?: string;
  keepCount?: number;
  keepPath?: string;
}> = {}): Promise<void> {
  try {
    const dir = resolveOpenCodeManagedServersLogDir(params.logsDir ?? configuration.logsDir);
    const keepCount = resolveKeepCount(params.keepCount);
    await pruneLogsByCount({ dir, suffix: '.log', keepCount, keepPath: params.keepPath });
  } catch {
    // Best-effort pruning only.
  }
}
