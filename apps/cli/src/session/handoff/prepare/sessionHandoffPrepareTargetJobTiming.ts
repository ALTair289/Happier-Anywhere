export const SESSION_HANDOFF_PREPARE_TARGET_JOB_RECORD_LOCK_TIMEOUT_MS = 10_000;

// A missing-runner proof can spend the full record-lock wait before the canonical transition
// revalidates it. Keep one bounded lock margin so an ordinary delayed acquisition does not expire
// the proof at the exact point where it becomes load-bearing.
export const SESSION_HANDOFF_PREPARE_TARGET_JOB_RECOVERY_PROOF_TTL_MS =
  SESSION_HANDOFF_PREPARE_TARGET_JOB_RECORD_LOCK_TIMEOUT_MS + 5_000;
