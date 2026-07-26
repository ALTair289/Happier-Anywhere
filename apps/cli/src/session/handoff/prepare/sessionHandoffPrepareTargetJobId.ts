const SESSION_HANDOFF_PREPARE_TARGET_JOB_ID_PATTERN = /^[A-Za-z0-9._-]+$/u;

export function assertSessionHandoffPrepareTargetJobId(jobId: string): void {
  if (
    jobId === '.'
    || jobId === '..'
    || !SESSION_HANDOFF_PREPARE_TARGET_JOB_ID_PATTERN.test(jobId)
  ) {
    throw new Error(`Invalid session handoff prepare-target job id: ${jobId}`);
  }
}
