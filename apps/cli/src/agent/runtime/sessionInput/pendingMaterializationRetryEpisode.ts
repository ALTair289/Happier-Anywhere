export type PendingMaterializationRetryEpisodeConfig = Readonly<{
  maxAttempts?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  jitterMs?: number;
}>;

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_INITIAL_DELAY_MS = 250;
const DEFAULT_MAX_DELAY_MS = 15_000;
const DEFAULT_JITTER_MS = 50;

function readBoundedInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function resolveDelayMs(config: Required<PendingMaterializationRetryEpisodeConfig>, failedAttempt: number): number {
  const exponential = Math.min(config.maxDelayMs, config.initialDelayMs * (2 ** Math.max(0, failedAttempt - 1)));
  if (config.jitterMs <= 0) return exponential;
  return exponential + Math.trunc(Math.random() * (config.jitterMs + 1));
}

async function waitForRetry(delayMs: number, abortSignal: AbortSignal): Promise<boolean> {
  if (abortSignal.aborted) return false;
  return await new Promise<boolean>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (continueEpisode: boolean) => {
      if (timer) clearTimeout(timer);
      timer = null;
      abortSignal.removeEventListener('abort', onAbort);
      resolve(continueEpisode);
    };
    const onAbort = () => finish(false);
    abortSignal.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => finish(!abortSignal.aborted), delayMs);
    timer.unref?.();
    if (abortSignal.aborted) onAbort();
  });
}

export function createPendingMaterializationRetryEpisode<T>(opts: Readonly<{
  config?: PendingMaterializationRetryEpisodeConfig;
  isRetryable: (result: T) => boolean;
  onExhausted?: (params: Readonly<{ key: string; attemptCount: number; result: T }>) => void | Promise<void>;
}>): Readonly<{
  run: (params: Readonly<{ key: string; abortSignal: AbortSignal; attempt: () => Promise<T> }>) => Promise<T>;
}> {
  const config: Required<PendingMaterializationRetryEpisodeConfig> = {
    maxAttempts: readBoundedInteger(opts.config?.maxAttempts, DEFAULT_MAX_ATTEMPTS, 1, 120),
    initialDelayMs: readBoundedInteger(opts.config?.initialDelayMs, DEFAULT_INITIAL_DELAY_MS, 0, 60_000),
    maxDelayMs: readBoundedInteger(opts.config?.maxDelayMs, DEFAULT_MAX_DELAY_MS, 0, 60_000),
    jitterMs: readBoundedInteger(opts.config?.jitterMs, DEFAULT_JITTER_MS, 0, 60_000),
  };
  type EpisodeState = {
    abortController: AbortController;
    waiterCount: number;
    settled: boolean;
    attemptInFlight: boolean;
    abortWhenAttemptSettles: boolean;
  };
  type ActiveEpisode = Readonly<{
    promise: Promise<T>;
    state: EpisodeState;
  }>;
  const activeByKey = new Map<string, ActiveEpisode>();

  const createAbortError = (): Error => {
    const error = new Error('Pending materialization waiter cancelled');
    error.name = 'AbortError';
    return error;
  };

  const notifyExhausted = (params: Readonly<{ key: string; attemptCount: number; result: T }>): void => {
    try {
      void Promise.resolve(opts.onExhausted?.(params)).catch(() => undefined);
    } catch {
      // Exhaustion visibility is observational and cannot own retry completion or controller health.
    }
  };

  const runNewEpisode = async (params: Readonly<{
    key: string;
    state: EpisodeState;
    attempt: () => Promise<T>;
  }>): Promise<T> => {
    const runAttempt = async (): Promise<T> => {
      params.state.attemptInFlight = true;
      try {
        return await params.attempt();
      } finally {
        params.state.attemptInFlight = false;
        if (params.state.abortWhenAttemptSettles && params.state.waiterCount === 0) {
          params.state.abortController.abort();
        }
      }
    };

    let result = await runAttempt();
    for (let attemptCount = 1; opts.isRetryable(result) && attemptCount < config.maxAttempts; attemptCount += 1) {
      const shouldContinue = await waitForRetry(
        resolveDelayMs(config, attemptCount),
        params.state.abortController.signal,
      );
      if (!shouldContinue) return result;
      result = await runAttempt();
    }
    if (opts.isRetryable(result) && !params.state.abortController.signal.aborted) {
      notifyExhausted({ key: params.key, attemptCount: config.maxAttempts, result });
    }
    return result;
  };

  const attachWaiter = (params: Readonly<{
    key: string;
    abortSignal: AbortSignal;
    episode: ActiveEpisode;
  }>): Promise<T> => {
    if (params.abortSignal.aborted) return Promise.reject(createAbortError());
    params.episode.state.waiterCount += 1;
    params.episode.state.abortWhenAttemptSettles = false;

    return new Promise<T>((resolve, reject) => {
      let detached = false;
      const detach = () => {
        if (detached) return;
        detached = true;
        params.abortSignal.removeEventListener('abort', onAbort);
        params.episode.state.waiterCount -= 1;
        if (params.episode.state.waiterCount === 0 && !params.episode.state.settled) {
          if (params.episode.state.attemptInFlight) {
            // The materialization boundary cannot consume an AbortSignal. Retain this entry as
            // the serialization owner until that mutation settles; deleting it here would let a
            // later same-key wake overlap the still-running request.
            params.episode.state.abortWhenAttemptSettles = true;
          } else {
            params.episode.state.abortController.abort();
          }
        }
      };
      const onAbort = () => {
        detach();
        reject(createAbortError());
      };

      params.abortSignal.addEventListener('abort', onAbort, { once: true });
      params.episode.promise.then(
        (result) => {
          if (detached) return;
          detach();
          resolve(result);
        },
        (error: unknown) => {
          if (detached) return;
          detach();
          reject(error);
        },
      );
      if (params.abortSignal.aborted) onAbort();
    });
  };

  return {
    run(params) {
      const active = activeByKey.get(params.key);
      if (active) {
        return attachWaiter({ key: params.key, abortSignal: params.abortSignal, episode: active });
      }
      if (params.abortSignal.aborted) return Promise.reject(createAbortError());

      const abortController = new AbortController();
      const state: EpisodeState = {
        abortController,
        waiterCount: 0,
        settled: false,
        attemptInFlight: false,
        abortWhenAttemptSettles: false,
      };
      const promise = runNewEpisode({
        key: params.key,
        state,
        attempt: params.attempt,
      }).finally(() => {
        state.settled = true;
        if (activeByKey.get(params.key) === episode) activeByKey.delete(params.key);
      });
      const episode: ActiveEpisode = { promise, state };
      activeByKey.set(params.key, episode);
      return attachWaiter({ key: params.key, abortSignal: params.abortSignal, episode });
    },
  };
}
