import { logger as defaultLogger } from '@/ui/logger';
import { drainRuntimeAuthFailureReportOutboxToDaemon } from './runtimeAuthFailureReportOutboxDrain';

type RuntimeAuthFailureReportOutboxDrainLogger = Readonly<{
  debug: (message: string, error?: unknown) => void;
}>;

type Timer = ReturnType<typeof setTimeout>;

const DEFAULT_DRAIN_DELAY_MS = 2_000;
const DEFAULT_RETRY_DELAY_MS = 10_000;
const DEFAULT_DRAIN_LIMIT = 8;

let scheduledTimer: Timer | null = null;
let drainInFlight = false;

function clearScheduledTimer(clearTimeoutFn: typeof clearTimeout = clearTimeout): void {
  if (!scheduledTimer) return;
  clearTimeoutFn(scheduledTimer);
  scheduledTimer = null;
}

function unrefTimer(timer: Timer): void {
  const maybeUnref = (timer as { unref?: () => void }).unref;
  if (typeof maybeUnref === 'function') {
    maybeUnref.call(timer);
  }
}

function readDelayMs(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : fallback;
}

export function resetRuntimeAuthFailureReportOutboxDrainSchedulerForTests(): void {
  clearScheduledTimer();
  drainInFlight = false;
}

export function scheduleRuntimeAuthFailureReportOutboxDrainToDaemon(input: Readonly<{
  outboxDir?: string;
  logger?: RuntimeAuthFailureReportOutboxDrainLogger;
  logPrefix?: string;
  delayMs?: number;
  retryDelayMs?: number;
  limit?: number;
  nowMs?: () => number;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
  drain?: typeof drainRuntimeAuthFailureReportOutboxToDaemon;
}> = {}): void {
  if (scheduledTimer || drainInFlight) return;

  const setTimeoutFn = input.setTimeoutFn ?? setTimeout;
  const clearTimeoutFn = input.clearTimeoutFn ?? clearTimeout;
  const delayMs = readDelayMs(input.delayMs, DEFAULT_DRAIN_DELAY_MS);
  scheduledTimer = setTimeoutFn(() => {
    clearScheduledTimer(clearTimeoutFn);
    void drainOnce(input);
  }, delayMs);
  unrefTimer(scheduledTimer);
}

async function drainOnce(input: Readonly<{
  outboxDir?: string;
  logger?: RuntimeAuthFailureReportOutboxDrainLogger;
  logPrefix?: string;
  retryDelayMs?: number;
  limit?: number;
  nowMs?: () => number;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
  drain?: typeof drainRuntimeAuthFailureReportOutboxToDaemon;
}>): Promise<void> {
  if (drainInFlight) return;

  const logger = input.logger ?? defaultLogger;
  const logPrefix = input.logPrefix ?? '[connected-services]';
  const drain = input.drain ?? drainRuntimeAuthFailureReportOutboxToDaemon;
  let shouldRetry = false;

  drainInFlight = true;
  try {
    const result = await drain({
      ...(input.outboxDir ? { outboxDir: input.outboxDir } : {}),
      limit: input.limit ?? DEFAULT_DRAIN_LIMIT,
      ...(input.nowMs ? { nowMs: input.nowMs } : {}),
    });
    shouldRetry = result.retried > 0;
  } catch (error) {
    shouldRetry = true;
    logger.debug(`${logPrefix} Failed to drain connected-service runtime auth failure report outbox (non-fatal)`, error);
  } finally {
    drainInFlight = false;
  }

  if (shouldRetry) {
    scheduleRuntimeAuthFailureReportOutboxDrainToDaemon({
      ...input,
      delayMs: readDelayMs(input.retryDelayMs, DEFAULT_RETRY_DELAY_MS),
    });
  }
}
