export function startDevDaemonLifecycleReconciler(
  {
    enabled,
    observe,
    recover,
    isShuttingDown = () => false,
    intervalMs = 1_000,
    absenceConfirmations = 2,
    recoveryBackoffMs = 30_000,
  } = {},
  {
    setIntervalImpl = setInterval,
    clearIntervalImpl = clearInterval,
    nowImpl = Date.now,
    logger = console,
  } = {},
) {
  if (!enabled || typeof observe !== 'function' || typeof recover !== 'function') return null;

  let closed = false;
  let inFlight = null;
  let consecutiveAbsences = 0;
  let recoveryRetryAt = 0;
  const requiredAbsences = Math.max(2, Number(absenceConfirmations) || 2);
  const retryBackoffMs = Math.max(1_000, Number(recoveryBackoffMs) || 30_000);

  const runReconciliation = async () => {
    const observation = await observe();
    const status = String(observation?.status ?? '').trim();
    if (status === 'running' || status === 'starting' || status === 'unreachable') {
      consecutiveAbsences = 0;
      recoveryRetryAt = 0;
      return { skipped: true, reason: 'daemon-present', status };
    }

    const isExplicitAbsence =
      status === 'stopped'
      || status === 'stale_state'
      || status === 'stale_lock';
    if (!isExplicitAbsence) {
      consecutiveAbsences = 0;
      return { skipped: true, reason: 'daemon-state-inconclusive', status: status || 'unknown' };
    }

    consecutiveAbsences = Math.min(requiredAbsences, consecutiveAbsences + 1);
    if (consecutiveAbsences < requiredAbsences) {
      return {
        skipped: true,
        reason: 'daemon-absence-unconfirmed',
        consecutiveAbsences,
      };
    }

    const now = Number(nowImpl()) || 0;
    if (now < recoveryRetryAt) {
      return {
        skipped: true,
        reason: 'daemon-recovery-backoff',
        retryAfterMs: recoveryRetryAt - now,
      };
    }

    recoveryRetryAt = now + retryBackoffMs;
    return await recover({ observation, consecutiveAbsences });
  };

  const reconcileNow = async () => {
    if (closed || isShuttingDown?.() === true) return { skipped: true, reason: 'closed' };
    if (inFlight) return await inFlight;
    inFlight = Promise.resolve()
      .then(() => runReconciliation())
      .catch((error) => {
        // A failed observation is inconclusive evidence, so it must break the consecutive
        // absence proof before a later tick can authorize recovery. Recovery failures reset the
        // proof for the same reason: the next attempt must be based on fresh post-attempt state.
        consecutiveAbsences = 0;
        logger?.warn?.(`[local] daemon lifecycle reconciliation failed: ${error instanceof Error ? error.message : String(error)}`);
        return { skipped: true, reason: 'reconcile-failed', error };
      })
      .finally(() => {
        inFlight = null;
      });
    return await inFlight;
  };

  const timer = setIntervalImpl(() => {
    void reconcileNow();
  }, Math.max(250, Number(intervalMs) || 1_000));
  timer?.unref?.();

  return {
    reconcileNow,
    close() {
      closed = true;
      clearIntervalImpl(timer);
    },
  };
}
