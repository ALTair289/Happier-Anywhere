import { withJsonOwnerFileLock } from '@/utils/fs/jsonOwnerFileLock';

const LOCK_TIMEOUT_MS = 10_000;
const LOCK_STALE_AFTER_MS = 30_000;

function lockPath(itemPath: string): string {
  return `${itemPath}.lock`;
}

/**
 * Serializes one outbox item's read/merge/write or removal across processes.
 * Atomic JSON replacement protects bytes; this lock protects the identity and
 * merge decision that must precede that replacement.
 */
export async function withRuntimeAuthFailureReportOutboxFileLock<T>(
  itemFilePath: string,
  effect: () => Promise<T>,
): Promise<T> {
  return await withJsonOwnerFileLock({
    lockPath: lockPath(itemFilePath),
    timeoutMs: LOCK_TIMEOUT_MS,
    staleAfterMs: LOCK_STALE_AFTER_MS,
    errorCode: 'runtime_auth_failure_report_outbox_lock_timeout',
  }, effect);
}
