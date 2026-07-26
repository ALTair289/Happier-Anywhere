import { join } from 'node:path';

import { withJsonOwnerFileLock } from '@/utils/fs/jsonOwnerFileLock';

import { assertSessionHandoffPrepareTargetJobId } from './sessionHandoffPrepareTargetJobId';
import { SESSION_HANDOFF_PREPARE_TARGET_JOB_RECOVERY_PROOF_TTL_MS } from './sessionHandoffPrepareTargetJobTiming';

const SESSION_HANDOFF_PREPARE_TARGET_JOB_LEASE_OPERATION_LOCK_STALE_AFTER_MS = 30_000;

export async function withSessionHandoffPrepareTargetJobLeaseOperationLock<T>(input: Readonly<{
  activeServerDir: string;
  jobId: string;
}>, operation: () => Promise<T>): Promise<T> {
  assertSessionHandoffPrepareTargetJobId(input.jobId);
  const lockPath = join(
    input.activeServerDir,
    'session-handoff',
    'prepare-target-jobs-staging',
    input.jobId,
    'lease-operation.lock',
  );
  return await withJsonOwnerFileLock({
    lockPath,
    timeoutMs: SESSION_HANDOFF_PREPARE_TARGET_JOB_RECOVERY_PROOF_TTL_MS,
    staleAfterMs: SESSION_HANDOFF_PREPARE_TARGET_JOB_LEASE_OPERATION_LOCK_STALE_AFTER_MS,
    errorCode: 'session_handoff_prepare_target_job_lease_operation_lock_timeout',
  }, operation);
}
