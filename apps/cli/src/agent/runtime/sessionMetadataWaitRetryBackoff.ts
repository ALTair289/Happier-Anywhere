import { delayUnref, delayUnrefAbortable } from '@/utils/time';

export const DEFAULT_SESSION_METADATA_WAIT_RETRY_BACKOFF_MS = 250;

export function resolveSessionMetadataWaitRetryBackoffMs(
  backoffMs: number | null | undefined,
  opts?: {
    defaultMs?: number | undefined;
    minMs?: number | undefined;
  },
): number {
  const defaultMs = opts?.defaultMs ?? DEFAULT_SESSION_METADATA_WAIT_RETRY_BACKOFF_MS;
  const minMs = opts?.minMs ?? 25;
  return typeof backoffMs === 'number' && Number.isFinite(backoffMs) && backoffMs >= minMs
    ? Math.floor(backoffMs)
    : defaultMs;
}

export async function waitForSessionMetadataRetryBackoff(opts: {
  abortSignal?: AbortSignal | undefined;
  backoffMs?: number | null | undefined;
  defaultMs?: number | undefined;
  minMs?: number | undefined;
}): Promise<void> {
  const backoffMs = resolveSessionMetadataWaitRetryBackoffMs(opts.backoffMs, {
    defaultMs: opts.defaultMs,
    minMs: opts.minMs,
  });
  if (backoffMs <= 0 || opts.abortSignal?.aborted) {
    return;
  }
  if (opts.abortSignal) {
    await delayUnrefAbortable(backoffMs, opts.abortSignal);
    return;
  }
  await delayUnref(backoffMs);
}
