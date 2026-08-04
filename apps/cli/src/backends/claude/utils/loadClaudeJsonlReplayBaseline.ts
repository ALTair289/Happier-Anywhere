import { logger } from '@/ui/logger';

import type { CommittedClaudeJsonlMessageBaseline } from './claudeJsonlMessageKey';

const COMMITTED_BASELINE_COVERAGE_SKEW_MS = 10 * 60_000;

export type ClaudeJsonlReplayBaseline = Readonly<{
  initialProcessedMessageKeys: ReadonlySet<string>;
  replaySuppressRowsBeforeMs: number | null;
}>;

export async function loadClaudeJsonlReplayBaseline(params: Readonly<{
  loadCommittedBaseline?: (() =>
    | Promise<CommittedClaudeJsonlMessageBaseline>
    | CommittedClaudeJsonlMessageBaseline) | undefined;
  resumesKnownClaudeSession: boolean;
  logPrefix: string;
}>): Promise<ClaudeJsonlReplayBaseline> {
  try {
    const baseline = await Promise.resolve(params.loadCommittedBaseline?.())
      ?? { keys: new Set<string>(), complete: true, oldestCoveredAtMs: null };
    return {
      initialProcessedMessageKeys: baseline.keys,
      replaySuppressRowsBeforeMs: !baseline.complete
        && typeof baseline.oldestCoveredAtMs === 'number'
        && Number.isFinite(baseline.oldestCoveredAtMs)
        ? baseline.oldestCoveredAtMs - COMMITTED_BASELINE_COVERAGE_SKEW_MS
        : null,
    };
  } catch (error) {
    logger.debug(`${params.logPrefix}: committed Claude JSONL baseline unavailable; suppressing resume replay (fail-closed)`, error);
    return {
      initialProcessedMessageKeys: new Set<string>(),
      replaySuppressRowsBeforeMs: params.resumesKnownClaudeSession
        ? Number.POSITIVE_INFINITY
        : null,
    };
  }
}
