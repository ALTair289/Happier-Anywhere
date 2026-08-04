import { readClaudeJsonlTimestampMs } from './claudeJsonlTimestamp';

const JSONL_RESET_REPLAY_SUPPRESS_SKEW_MS = 30_000;

export function resolveClaudeJsonlResetReplaySuppressBeforeMs(params: Readonly<{
  nowMs?: number | undefined;
  baselineSuppressBeforeMs?: number | null | undefined;
}> = {}): number {
  const nowMs = typeof params.nowMs === 'number' && Number.isFinite(params.nowMs)
    ? Math.trunc(params.nowMs)
    : Date.now();
  const resetSuppressBeforeMs = nowMs - JSONL_RESET_REPLAY_SUPPRESS_SKEW_MS;
  const baselineSuppressBeforeMs = params.baselineSuppressBeforeMs;
  return typeof baselineSuppressBeforeMs === 'number'
    ? Math.max(baselineSuppressBeforeMs, resetSuppressBeforeMs)
    : resetSuppressBeforeMs;
}

export function isClaudeJsonlReplaySuppressedValue(
  value: unknown,
  suppressBeforeMs: number | null | undefined,
): boolean {
  if (typeof suppressBeforeMs !== 'number') return false;
  const timestampMs = readClaudeJsonlTimestampMs(value);
  // Fail closed: replay rows without parseable timestamps cannot be proven newer than the cutoff.
  return timestampMs === null || timestampMs < suppressBeforeMs;
}

export type ClaudeJsonlResetReplaySuppressor = Readonly<{
  markReset(params?: Readonly<{ baselineSuppressBeforeMs?: number | null | undefined }>): number;
  shouldSuppress(value: unknown): boolean;
  getSuppressBeforeMs(): number | null;
  clear(): void;
}>;

export function createClaudeJsonlResetReplaySuppressor(params: Readonly<{
  nowMs?: number | undefined;
}> = {}): ClaudeJsonlResetReplaySuppressor {
  let suppressBeforeMs: number | null = null;
  const fixedNowMs = typeof params.nowMs === 'number' && Number.isFinite(params.nowMs)
    ? Math.trunc(params.nowMs)
    : null;

  return {
    markReset(resetParams = {}) {
      suppressBeforeMs = resolveClaudeJsonlResetReplaySuppressBeforeMs({
        nowMs: fixedNowMs ?? undefined,
        baselineSuppressBeforeMs: resetParams.baselineSuppressBeforeMs ?? null,
      });
      return suppressBeforeMs;
    },
    shouldSuppress(value) {
      if (typeof suppressBeforeMs !== 'number') return false;
      const timestampMs = readClaudeJsonlTimestampMs(value);
      if (timestampMs !== null && timestampMs >= suppressBeforeMs) {
        suppressBeforeMs = null;
        return false;
      }
      return true;
    },
    getSuppressBeforeMs() {
      return suppressBeforeMs;
    },
    clear() {
      suppressBeforeMs = null;
    },
  };
}
