import { waitForSessionMetadataRetryBackoff } from '@/agent/runtime/sessionMetadataWaitRetryBackoff';

export type LocalPendingQueueRemoteSwitchWatcher = Readonly<{
  stop: () => void;
}>;

export function startLocalPendingQueueRemoteSwitchWatcher(opts: Readonly<{
  peekPendingCount?: () => Promise<number>;
  pollIntervalMs: number;
  requestRemoteSwitch: () => Promise<boolean>;
  waitForPendingQueueUpdate?: (signal?: AbortSignal) => Promise<boolean>;
}>): LocalPendingQueueRemoteSwitchWatcher {
  let stopped = false;
  let triggered = false;
  let switchRequestInFlight = false;
  let waitController: AbortController | null = null;

  const pollIntervalMs = Number.isFinite(opts.pollIntervalMs) && opts.pollIntervalMs > 0
    ? Math.trunc(opts.pollIntervalMs)
    : 0;

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
      // temporarily unreachable. The next interval will retry.
      return false;
    }
  };

  const waitForDefensiveInterval = async (): Promise<'defensive' | 'stopped'> => {
    if (pollIntervalMs <= 0 || stopped || triggered) return 'stopped';
    const controller = new AbortController();
    waitController = controller;
    const wake = await new Promise<'defensive' | 'stopped'>((resolve) => {
      const timer = setTimeout(() => resolve('defensive'), pollIntervalMs);
      timer.unref?.();
      controller.signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          resolve('stopped');
        },
        { once: true },
      );
    });
    if (waitController === controller) {
      waitController = null;
    }
    return stopped || triggered ? 'stopped' : wake;
  };

  const waitForMissedUpdateBackoff = async (signal: AbortSignal): Promise<'defensive' | 'retry' | 'stopped'> => {
    if (stopped || triggered || signal.aborted) return 'stopped';
    await waitForSessionMetadataRetryBackoff({
      abortSignal: signal,
      backoffMs: pollIntervalMs > 0 ? pollIntervalMs : undefined,
      defaultMs: pollIntervalMs > 0 ? pollIntervalMs : undefined,
      minMs: 1,
    });
    if (stopped || triggered || signal.aborted) return 'stopped';
    return pollIntervalMs > 0 ? 'defensive' : 'retry';
  };

  const waitForWake = async (): Promise<'update' | 'defensive' | 'retry' | 'stopped'> => {
    if (stopped || triggered) return 'stopped';

    const controller = new AbortController();
    waitController = controller;

    const waits: Array<Promise<'update' | 'defensive' | 'retry' | 'stopped'>> = [];
    if (opts.waitForPendingQueueUpdate) {
      waits.push(
        opts.waitForPendingQueueUpdate(controller.signal)
          .then((ok) => ok ? 'update' as const : waitForMissedUpdateBackoff(controller.signal))
          .catch(() => waitForMissedUpdateBackoff(controller.signal)),
      );
    }
    if (pollIntervalMs > 0) {
      waits.push(new Promise<'defensive' | 'stopped'>((resolve) => {
        const timer = setTimeout(() => resolve('defensive'), pollIntervalMs);
        timer.unref?.();
        controller.signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            resolve('stopped');
          },
          { once: true },
        );
      }));
    }

    if (waits.length === 0) {
      return 'stopped';
    }

    const wake = await Promise.race(waits);
    if (waitController === controller) {
      waitController = null;
    }
    controller.abort();
    if (wake === 'stopped' && !stopped && !triggered && controller.signal.aborted) {
      return await waitForDefensiveInterval();
    }
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
      allowDirectInspection = wake !== 'retry';
    }
  })();

  return {
    stop: () => {
      stopped = true;
      stopWaiting();
    },
  };
}
