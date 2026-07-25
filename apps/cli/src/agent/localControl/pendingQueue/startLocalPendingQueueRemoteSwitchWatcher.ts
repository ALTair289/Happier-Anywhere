import { waitForSessionMetadataRetryBackoff } from '@/agent/runtime/sessionMetadataWaitRetryBackoff';

export type LocalPendingQueueRemoteSwitchWatcher = Readonly<{
  stop: () => void;
}>;

export function startLocalPendingQueueRemoteSwitchWatcher(opts: Readonly<{
  peekPendingCount?: () => Promise<number>;
  requestRemoteSwitch: () => Promise<boolean>;
  waitForPendingQueueUpdate?: (signal?: AbortSignal) => Promise<boolean>;
}>): LocalPendingQueueRemoteSwitchWatcher {
  let stopped = false;
  let triggered = false;
  let switchRequestInFlight = false;
  let waitController: AbortController | null = null;

  const stopWaiting = (): void => {
    waitController?.abort();
    waitController = null;
  };

  const shouldSwitchToRemote = async (allowDirectInspection: boolean): Promise<boolean> => {
    if (!allowDirectInspection || !opts.peekPendingCount) {
      return false;
    }
    return (await opts.peekPendingCount()) > 0;
  };

  const maybeRequestRemoteSwitch = async (allowDirectInspection: boolean): Promise<boolean> => {
    if (stopped || triggered || switchRequestInFlight) return false;

    try {
      if (!(await shouldSwitchToRemote(allowDirectInspection))) {
        return false;
      }

      switchRequestInFlight = true;
      try {
        triggered = await opts.requestRemoteSwitch();
      } finally {
        switchRequestInFlight = false;
      }
      return triggered;
    } catch {
      // Best-effort watcher: local mode should keep running if the server is
      // temporarily unreachable. A later server wake can retry the switch.
      return false;
    }
  };

  const waitForMissedUpdateBackoff = async (signal: AbortSignal): Promise<'retry' | 'stopped'> => {
    if (stopped || triggered || signal.aborted) return 'stopped';
    await waitForSessionMetadataRetryBackoff({
      abortSignal: signal,
    });
    if (stopped || triggered || signal.aborted) return 'stopped';
    return 'retry';
  };

  const waitForWake = async (): Promise<'update' | 'retry' | 'stopped'> => {
    if (stopped || triggered) return 'stopped';
    if (!opts.waitForPendingQueueUpdate) return 'stopped';

    const controller = new AbortController();
    waitController = controller;
    const wake = await opts.waitForPendingQueueUpdate(controller.signal)
      .then((ok) => ok ? 'update' as const : waitForMissedUpdateBackoff(controller.signal))
      .catch(() => waitForMissedUpdateBackoff(controller.signal));
    if (waitController === controller) {
      waitController = null;
    }
    controller.abort();
    return stopped || triggered ? 'stopped' : wake;
  };

  void (async () => {
    let allowDirectInspection = false;
    while (!stopped && !triggered) {
      const switched = await maybeRequestRemoteSwitch(allowDirectInspection);
      allowDirectInspection = false;
      if (switched || stopped || triggered) return;

      const wake = await waitForWake();
      if (wake === 'stopped') return;
      allowDirectInspection = wake === 'update';
    }
  })();

  return {
    stop: () => {
      stopped = true;
      stopWaiting();
    },
  };
}
