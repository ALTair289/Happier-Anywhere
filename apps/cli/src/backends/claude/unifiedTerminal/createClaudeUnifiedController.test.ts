import { describe, expect, it, vi } from 'vitest';

import { createClaudeUnifiedController } from './createClaudeUnifiedController';
import { createClaudeUnifiedPendingQueuePump } from './createClaudeUnifiedPendingQueuePump';

const createIdleSnapshot = () => ({
  queuedCount: 0,
  pendingInjectionCount: 0,
  terminalCustodyCount: 0,
  providerAcceptancePendingCount: 0,
  disposed: false,
  turnState: 'idle' as const,
  permissionBlocked: false,
  userTyping: false,
  lastDeferredReason: null,
  lastFailureReason: null,
  headInputState: null,
});

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function waitOneTurn(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('createClaudeUnifiedController', () => {
  it('fails closed when the terminal host is not alive', async () => {
    const disposeHost = vi.fn().mockResolvedValue(undefined);
    const liveness = {
      paneAlive: false,
      paneDead: true,
      paneCurrentCommand: '/managed/node',
      paneExitStatus: 127,
      observedAt: 1,
    };
    const controller = createClaudeUnifiedController({
      host: {
        evaluateLiveness: vi.fn().mockResolvedValue(liveness),
        dispose: disposeHost,
      },
      pendingQueuePump: {
        start: vi.fn(),
        dispose: vi.fn(),
      },
      arbiter: {
        dispose: vi.fn(),
      },
      transcriptBridge: {
        start: vi.fn(),
        dispose: vi.fn(),
      },
    });

    await expect(controller.run()).rejects.toMatchObject({
      code: 'claude_unified_terminal_host_dead',
      liveness,
    });
    expect(disposeHost).toHaveBeenCalledTimes(1);
  });

  it('preserves the typed host-dead error when cleanup after a dead host fails', async () => {
    const liveness = {
      paneAlive: false,
      paneDead: true,
      paneCurrentCommand: '/managed/node',
      paneExitStatus: 1,
      observedAt: 1,
    };
    const controller = createClaudeUnifiedController({
      host: {
        evaluateLiveness: vi.fn().mockResolvedValue(liveness),
        dispose: vi.fn().mockRejectedValue(new Error('cleanup failed')),
      },
      pendingQueuePump: {
        start: vi.fn(),
        dispose: vi.fn(),
      },
      arbiter: {
        dispose: vi.fn(),
      },
      transcriptBridge: {
        start: vi.fn(),
        dispose: vi.fn(),
      },
    });

    await expect(controller.run()).rejects.toMatchObject({
      code: 'claude_unified_terminal_host_dead',
      liveness,
    });
  });

  it('retries transient startup liveness failures before starting supervised bridges', async () => {
    const initialLiveness = {
      paneAlive: false,
      paneDead: true,
      observedAt: 1,
    };
    const recoveredLiveness = {
      paneAlive: true,
      observedAt: 2,
    };
    const evaluateLiveness = vi.fn()
      .mockResolvedValueOnce(initialLiveness)
      .mockResolvedValueOnce(recoveredLiveness);
    const disposeHost = vi.fn();
    const pendingStart = vi.fn();
    const transcriptStart = vi.fn();
    const controller = createClaudeUnifiedController({
      host: {
        evaluateLiveness,
        dispose: disposeHost,
      },
      pendingQueuePump: {
        start: pendingStart,
        dispose: vi.fn(),
      },
      arbiter: {
        dispose: vi.fn(),
      },
      transcriptBridge: {
        start: transcriptStart,
        dispose: vi.fn(),
      },
      initialLivenessTimeoutMs: 25,
      initialLivenessPollMs: 1,
    });

    await expect(controller.run()).resolves.toBeUndefined();

    expect(evaluateLiveness).toHaveBeenCalledTimes(2);
    expect(transcriptStart).toHaveBeenCalledTimes(1);
    expect(pendingStart).toHaveBeenCalledTimes(1);
    expect(disposeHost).not.toHaveBeenCalled();
  });

  it('aborts producers before waiting for terminal host disposal', async () => {
    const disposeOrder: string[] = [];
    let producerAbortObservedDuringHostDispose = false;
    const orderedHostDispose = vi.fn(async () => {
      disposeOrder.push('host');
      await waitOneTurn();
      producerAbortObservedDuringHostDispose = disposeOrder.includes('pump');
    });
    const pumpDispose = vi.fn(async () => {
      disposeOrder.push('pump');
    });
    const transcriptDispose = vi.fn(async () => {
      disposeOrder.push('transcript');
    });
    const arbiterDispose = vi.fn(async () => {
      disposeOrder.push('arbiter');
    });
    const controller = createClaudeUnifiedController({
      host: {
        evaluateLiveness: vi.fn().mockResolvedValue({ paneAlive: true, observedAt: 1 }),
        dispose: orderedHostDispose,
      },
      pendingQueuePump: {
        start: vi.fn(),
        dispose: pumpDispose,
      },
      arbiter: {
        dispose: arbiterDispose,
      },
      transcriptBridge: {
        start: vi.fn(),
        dispose: transcriptDispose,
      },
    });

    await controller.run();
    await controller.dispose();
    await controller.dispose();

    expect(pumpDispose).toHaveBeenCalledTimes(1);
    expect(transcriptDispose).toHaveBeenCalledTimes(1);
    expect(arbiterDispose).toHaveBeenCalledTimes(1);
    expect(orderedHostDispose).toHaveBeenCalledTimes(1);
    expect(producerAbortObservedDuringHostDispose).toBe(true);
    expect(disposeOrder).toEqual(['pump', 'transcript', 'arbiter', 'host']);
  });

  it('starts the pending queue pump without waiting for async transcript bridge startup', async () => {
    const transcriptStartup = createDeferred<void>();
    const order: string[] = [];
    const controller = createClaudeUnifiedController({
      host: {
        evaluateLiveness: vi.fn().mockResolvedValue({ paneAlive: true, observedAt: 1 }),
        dispose: vi.fn(),
      },
      pendingQueuePump: {
        start: vi.fn(() => {
          order.push('pump-start');
        }),
        dispose: vi.fn(),
      },
      arbiter: {
        dispose: vi.fn(),
      },
      transcriptBridge: {
        start: vi.fn(() => {
          order.push('transcript-start');
          return transcriptStartup.promise;
        }),
        dispose: vi.fn(),
      },
    });

    const runPromise = controller.run();
    await Promise.resolve();

    expect(order).toEqual(['transcript-start', 'pump-start']);

    transcriptStartup.resolve();
    await runPromise;
  });

  it('starts the pending queue pump without waiting for its running task', async () => {
    const pumpRun = createDeferred<void>();
    const order: string[] = [];
    const controller = createClaudeUnifiedController({
      host: {
        evaluateLiveness: vi.fn().mockResolvedValue({ paneAlive: true, observedAt: 1 }),
        dispose: vi.fn(),
      },
      pendingQueuePump: {
        start: vi.fn(() => {
          order.push('pump-start');
          return pumpRun.promise;
        }),
        dispose: vi.fn(),
      },
      arbiter: {
        dispose: vi.fn(),
      },
    });

    const runPromise = controller.run();
    let runResolved = false;
    void runPromise.then(() => {
      runResolved = true;
    });
    await waitOneTurn();

    expect(runResolved).toBe(true);
    expect(order).toEqual(['pump-start']);

    pumpRun.resolve();
    await runPromise;
  });

  it('routes pending queue input waiting failures through the fatal path after startup', async () => {
    const pumpError = new Error('pending queue materialization failed');
    const onFatalError = vi.fn();
    const pendingQueuePump = createClaudeUnifiedPendingQueuePump({
      inputConsumer: {
        waitForNextInput: vi.fn().mockRejectedValue(pumpError),
      },
      arbiter: {
        enqueueUiMessage: vi.fn(),
        drainWhenSafe: vi.fn(),
        snapshot: vi.fn(createIdleSnapshot),
      },
    });
    const controller = createClaudeUnifiedController({
      host: {
        evaluateLiveness: vi.fn().mockResolvedValue({ paneAlive: true, observedAt: 1 }),
        dispose: vi.fn(),
      },
      pendingQueuePump,
      arbiter: {
        dispose: vi.fn(),
      },
      onFatalError,
    });

    await expect(controller.run()).resolves.toBeUndefined();
    await Promise.resolve();

    expect(onFatalError).toHaveBeenCalledTimes(1);
    expect(onFatalError).toHaveBeenCalledWith(pumpError);
  });

  it('routes pending queue drain failures through the fatal path after startup', async () => {
    const drainError = new Error('pending queue drain failed');
    const onFatalError = vi.fn();
    const pendingQueuePump = createClaudeUnifiedPendingQueuePump({
      inputConsumer: {
        waitForNextInput: vi.fn().mockResolvedValue({
          message: 'from queue',
          mode: undefined,
          isolate: false,
          hash: 'same-mode',
        }),
      },
      arbiter: {
        enqueueUiMessage: vi.fn().mockResolvedValue(undefined),
        drainWhenSafe: vi.fn().mockRejectedValue(drainError),
        snapshot: vi.fn(createIdleSnapshot),
      },
    });
    const controller = createClaudeUnifiedController({
      host: {
        evaluateLiveness: vi.fn().mockResolvedValue({ paneAlive: true, observedAt: 1 }),
        dispose: vi.fn(),
      },
      pendingQueuePump,
      arbiter: {
        dispose: vi.fn(),
      },
      onFatalError,
    });

    await expect(controller.run()).resolves.toBeUndefined();
    await waitOneTurn();

    expect(onFatalError).toHaveBeenCalledTimes(1);
    expect(onFatalError).toHaveBeenCalledWith(drainError);
  });

  it('ignores pending queue pump failures after disposal', async () => {
    const pumpFailure = createDeferred<void>();
    const onFatalError = vi.fn();
    const controller = createClaudeUnifiedController({
      host: {
        evaluateLiveness: vi.fn().mockResolvedValue({ paneAlive: true, observedAt: 1 }),
        dispose: vi.fn(),
      },
      pendingQueuePump: {
        start: vi.fn(() => pumpFailure.promise),
        dispose: vi.fn(),
      },
      arbiter: {
        dispose: vi.fn(),
      },
      onFatalError,
    });

    const runPromise = controller.run();
    void runPromise.catch(() => undefined);
    let runResolved = false;
    void runPromise.then(() => {
      runResolved = true;
    });
    await waitOneTurn();

    expect(runResolved).toBe(true);
    await controller.dispose();
    pumpFailure.reject(new Error('late pump failure'));
    await Promise.resolve();
    await runPromise;

    expect(onFatalError).not.toHaveBeenCalled();
  });

  it('continues disposing bridges when host disposal fails', async () => {
    const hostError = new Error('host cleanup failed');
    const pumpDispose = vi.fn().mockResolvedValue(undefined);
    const transcriptDispose = vi.fn().mockResolvedValue(undefined);
    const arbiterDispose = vi.fn().mockResolvedValue(undefined);
    const controller = createClaudeUnifiedController({
      host: {
        evaluateLiveness: vi.fn().mockResolvedValue({ paneAlive: true, observedAt: 1 }),
        dispose: vi.fn().mockRejectedValue(hostError),
      },
      pendingQueuePump: {
        start: vi.fn(),
        dispose: pumpDispose,
      },
      arbiter: {
        dispose: arbiterDispose,
      },
      transcriptBridge: {
        start: vi.fn(),
        dispose: transcriptDispose,
      },
    });

    await controller.run();
    await expect(controller.dispose()).rejects.toBe(hostError);

    expect(pumpDispose).toHaveBeenCalledTimes(1);
    expect(transcriptDispose).toHaveBeenCalledTimes(1);
    expect(arbiterDispose).toHaveBeenCalledTimes(1);
  });
});
