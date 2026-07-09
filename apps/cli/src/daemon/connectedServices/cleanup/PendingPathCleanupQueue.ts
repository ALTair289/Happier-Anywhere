import { rm } from 'node:fs/promises';

import { logger } from '@/ui/logger';

export type PendingPathCleanupTarget = Readonly<{
  path: string;
  cleanupAttempts?: number;
  lastCleanupError?: unknown;
}>;

export type PendingPathCleanupRetryExhaustedEvent<TTarget extends PendingPathCleanupTarget> = Readonly<{
  key: string;
  path: string;
  attempts: number;
  error: unknown;
  target: TTarget;
}>;

type RemovePath = (path: string, options: Readonly<{ recursive: true; force: true }>) => Promise<void>;
type BeforeRemovePath<TTarget extends PendingPathCleanupTarget> = (target: TTarget) => Promise<void>;

function normalizeMaxCleanupRetries(value: number | undefined): number {
  return Math.max(0, Math.trunc(value ?? 3));
}

function defaultRetryExhaustedLog<TTarget extends PendingPathCleanupTarget>(
  event: PendingPathCleanupRetryExhaustedEvent<TTarget>,
): void {
  logger.debug('[DAEMON RUN] Connected-service cleanup target abandoned after retry exhaustion', {
    key: event.key,
    path: event.path,
    attempts: event.attempts,
    error: event.error,
  });
}

export function createPendingPathCleanupQueue<TTarget extends PendingPathCleanupTarget>(
  deps: Readonly<{
    maxCleanupRetries?: number;
    removePath?: RemovePath;
    beforeRemove?: BeforeRemovePath<TTarget>;
    onRetryExhausted?: (event: PendingPathCleanupRetryExhaustedEvent<TTarget>) => void;
  }> = {},
): Readonly<{
  setPending(key: string, target: TTarget): void;
  deletePending(key: string): void;
  removeNow(key: string, target: TTarget): Promise<void>;
  drainPending<TResult>(input: Readonly<{
    shouldKeepPending(target: TTarget): boolean | Promise<boolean>;
    shouldDropPending?: (target: TTarget) => boolean | Promise<boolean>;
    toCleanedResult(target: TTarget): TResult;
  }>): Promise<ReadonlyArray<TResult>>;
}> {
  const pendingTargetsByKey = new Map<string, TTarget>();
  const maxCleanupRetries = normalizeMaxCleanupRetries(deps.maxCleanupRetries);
  const removePath = deps.removePath ?? rm;
  const beforeRemove = deps.beforeRemove;
  const onRetryExhausted = deps.onRetryExhausted ?? defaultRetryExhaustedLog<TTarget>;

  function emitRetryExhausted(key: string, target: TTarget): void {
    onRetryExhausted({
      key,
      path: target.path,
      attempts: target.cleanupAttempts ?? 0,
      error: target.lastCleanupError,
      target,
    });
  }

  async function removeNow(key: string, target: TTarget): Promise<void> {
    try {
      await beforeRemove?.(target);
      await removePath(target.path, { recursive: true, force: true });
      pendingTargetsByKey.delete(key);
    } catch (error) {
      const nextTarget = {
        ...target,
        cleanupAttempts: (target.cleanupAttempts ?? 0) + 1,
        lastCleanupError: error,
      };
      if (nextTarget.cleanupAttempts >= maxCleanupRetries) {
        pendingTargetsByKey.delete(key);
        emitRetryExhausted(key, nextTarget);
      } else {
        pendingTargetsByKey.set(key, nextTarget);
      }
      throw error;
    }
  }

  async function drainPending<TResult>(input: Readonly<{
    shouldKeepPending(target: TTarget): boolean | Promise<boolean>;
    shouldDropPending?: (target: TTarget) => boolean | Promise<boolean>;
    toCleanedResult(target: TTarget): TResult;
  }>): Promise<ReadonlyArray<TResult>> {
    const cleaned: TResult[] = [];
    for (const [key, target] of pendingTargetsByKey.entries()) {
      if (target.cleanupAttempts !== undefined && target.cleanupAttempts >= maxCleanupRetries) {
        pendingTargetsByKey.delete(key);
        emitRetryExhausted(key, target);
        continue;
      }
      if (input.shouldDropPending && await input.shouldDropPending(target)) {
        pendingTargetsByKey.delete(key);
        continue;
      }
      if (await input.shouldKeepPending(target)) continue;
      await removeNow(key, target);
      cleaned.push(input.toCleanedResult(target));
    }
    return cleaned;
  }

  return {
    setPending: (key, target) => {
      pendingTargetsByKey.set(key, target);
    },
    deletePending: (key) => {
      pendingTargetsByKey.delete(key);
    },
    removeNow,
    drainPending,
  };
}
