import type { ManagedConnectionState, ManagedConnectionSupervisor } from '@happier-dev/connection-supervisor';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { HttpStatusError } from '@/api/client/httpStatusError';
import type { TranscriptLookupOutcome, TranscriptMessageLookupResult } from '../transcriptMessageLookup';
import { TranscriptRecoveryCoordinator } from './TranscriptRecoveryCoordinator';

function createState(overrides: Partial<ManagedConnectionState> = {}): ManagedConnectionState {
  return {
    phase: 'online',
    reason: null,
    attempt: 0,
    nextRetryAt: null,
    lastConnectedAt: 1,
    lastDisconnectedAt: null,
    lastErrorMessage: null,
    ...overrides,
  };
}

function createSupervisor(state: ManagedConnectionState = createState()): ManagedConnectionSupervisor {
  return {
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    getState: vi.fn(() => state),
    reportProbeResult: vi.fn(),
  };
}

function createLookupMessage(): TranscriptMessageLookupResult {
  return {
    id: 'm1',
    seq: 1,
    localId: 'local-1',
    sidechainId: null,
    createdAt: 1,
    updatedAt: 1,
    content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'hi' } } },
  };
}

function createDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('TranscriptRecoveryCoordinator', () => {
  afterEach(() => {
    vi.useRealTimers();
    TranscriptRecoveryCoordinator.__resetForTesting();
  });

  it('returns the same singleton for the same serverUrl', () => {
    const first = TranscriptRecoveryCoordinator.forServer('http://server.test');
    const second = TranscriptRecoveryCoordinator.forServer('http://server.test');

    expect(second).toBe(first);
  });

  it('defers offline supervisors before running network work', async () => {
    const coordinator = TranscriptRecoveryCoordinator.forServer('http://server.test', { delayMs: 0 });
    const runRequest = vi.fn(async (): Promise<TranscriptLookupOutcome> => ({ type: 'not_found' }));

    await expect(
      coordinator.scheduleByLocalId({
        sessionId: 'sid',
        localId: 'local-1',
        supervisor: createSupervisor(createState({ phase: 'offline', reason: 'server_unreachable' })),
        runRequest,
      }),
    ).resolves.toEqual({ type: 'deferred', reason: 'supervisor_offline' });
    expect(runRequest).not.toHaveBeenCalled();
  });

  it('defers auth_failed supervisors before running network work', async () => {
    const coordinator = TranscriptRecoveryCoordinator.forServer('http://server.test', { delayMs: 0 });
    const runRequest = vi.fn(async (): Promise<TranscriptLookupOutcome> => ({ type: 'not_found' }));

    await expect(
      coordinator.scheduleByLocalId({
        sessionId: 'sid',
        localId: 'local-1',
        supervisor: createSupervisor(createState({ phase: 'auth_failed', reason: 'auth_invalid' })),
        runRequest,
      }),
    ).resolves.toEqual({ type: 'deferred', reason: 'supervisor_auth_failed' });
    expect(runRequest).not.toHaveBeenCalled();
  });

  it('single-flights concurrent requests for the same session and localId', async () => {
    vi.useFakeTimers();

    const supervisor = createSupervisor();
    const coordinator = TranscriptRecoveryCoordinator.forServer('http://server.test', { delayMs: 0 });
    const deferred = createDeferred<TranscriptLookupOutcome>();
    const runRequest = vi.fn(async () => deferred.promise);

    const first = coordinator.scheduleByLocalId({
      sessionId: 'sid',
      localId: 'local-1',
      supervisor,
      runRequest,
    });
    const second = coordinator.scheduleByLocalId({
      sessionId: 'sid',
      localId: 'local-1',
      supervisor,
      runRequest,
    });

    await vi.runAllTimersAsync();
    expect(runRequest).toHaveBeenCalledTimes(1);

    deferred.resolve({ type: 'found', message: createLookupMessage() });

    await expect(first).resolves.toMatchObject({ type: 'success', value: { id: 'm1' } });
    await expect(second).resolves.toMatchObject({ type: 'success', value: { id: 'm1' } });
  });

  it('respects the per-server max concurrency for distinct localIds', async () => {
    vi.useFakeTimers();

    const supervisor = createSupervisor();
    const coordinator = TranscriptRecoveryCoordinator.forServer('http://server.test', {
      delayMs: 0,
      maxConcurrent: 2,
    });
    const first = createDeferred<TranscriptLookupOutcome>();
    const second = createDeferred<TranscriptLookupOutcome>();
    const started: string[] = [];
    let active = 0;
    let maxActive = 0;

    function runFor(key: string, deferred: { promise: Promise<TranscriptLookupOutcome> }): () => Promise<TranscriptLookupOutcome> {
      return async () => {
        started.push(key);
        active += 1;
        maxActive = Math.max(maxActive, active);
        const result = await deferred.promise;
        active -= 1;
        return result;
      };
    }

    const a = coordinator.scheduleByLocalId({ sessionId: 'sid', localId: 'a', supervisor, runRequest: runFor('a', first) });
    const b = coordinator.scheduleByLocalId({ sessionId: 'sid', localId: 'b', supervisor, runRequest: runFor('b', second) });
    const runC = vi.fn(async (): Promise<TranscriptLookupOutcome> => {
      started.push('c');
      active += 1;
      maxActive = Math.max(maxActive, active);
      active -= 1;
      return { type: 'not_found' };
    });
    const c = coordinator.scheduleByLocalId({
      sessionId: 'sid',
      localId: 'c',
      supervisor,
      runRequest: runC,
    });

    await vi.runAllTimersAsync();
    expect(started).toEqual(['a', 'b']);
    expect(maxActive).toBe(2);

    first.resolve({ type: 'not_found' });
    await expect(a).resolves.toEqual({ type: 'not_found' });
    await vi.runAllTimersAsync();

    expect(started).toEqual(['a', 'b', 'c']);
    expect(maxActive).toBe(2);
    await expect(c).resolves.toEqual({ type: 'not_found' });

    second.resolve({ type: 'not_found' });
    await expect(b).resolves.toEqual({ type: 'not_found' });
    expect(runC).toHaveBeenCalledTimes(1);
  });

  it('defaults to two concurrent recovery reads per server', async () => {
    vi.useFakeTimers();

    const supervisor = createSupervisor();
    const coordinator = TranscriptRecoveryCoordinator.forServer('http://server.test', { delayMs: 0 });
    const first = createDeferred<TranscriptLookupOutcome>();
    const second = createDeferred<TranscriptLookupOutcome>();
    const started: string[] = [];

    function runFor(key: string, deferred: { promise: Promise<TranscriptLookupOutcome> }): () => Promise<TranscriptLookupOutcome> {
      return async () => {
        started.push(key);
        return await deferred.promise;
      };
    }

    const a = coordinator.scheduleByLocalId({ sessionId: 'sid', localId: 'a', supervisor, runRequest: runFor('a', first) });
    const b = coordinator.scheduleByLocalId({ sessionId: 'sid', localId: 'b', supervisor, runRequest: runFor('b', second) });
    const c = coordinator.scheduleByLocalId({
      sessionId: 'sid',
      localId: 'c',
      supervisor,
      runRequest: vi.fn(async (): Promise<TranscriptLookupOutcome> => {
        started.push('c');
        return { type: 'not_found' };
      }),
    });

    await vi.runAllTimersAsync();
    expect(started).toEqual(['a', 'b']);

    first.resolve({ type: 'not_found' });
    await expect(a).resolves.toEqual({ type: 'not_found' });
    await vi.runAllTimersAsync();

    expect(started).toEqual(['a', 'b', 'c']);
    await expect(c).resolves.toEqual({ type: 'not_found' });

    second.resolve({ type: 'not_found' });
    await expect(b).resolves.toEqual({ type: 'not_found' });
  });

  it('defers immediate retries during the per-key backoff window', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);

    const coordinator = TranscriptRecoveryCoordinator.forServer('http://server.test', {
      delayMs: 0,
      errorBackoffBaseMs: 100,
      errorBackoffMaxMs: 100,
    });
    const runRequest = vi.fn(async (): Promise<TranscriptLookupOutcome> => ({
      type: 'unhealthy',
      reason: 'server_5xx',
      error: new Error('unavailable'),
    }));

    const first = coordinator.scheduleByLocalId({
      sessionId: 'sid',
      localId: 'local-1',
      supervisor: createSupervisor(),
      runRequest,
    });
    await vi.runAllTimersAsync();

    await expect(first).resolves.toMatchObject({ type: 'error', reason: 'unhealthy' });
    await expect(
      coordinator.scheduleByLocalId({
        sessionId: 'sid',
        localId: 'local-1',
        supervisor: createSupervisor(),
        runRequest,
      }),
    ).resolves.toEqual({ type: 'deferred', reason: 'backoff' });
    expect(runRequest).toHaveBeenCalledTimes(1);
  });

  it('maps auth failures into coordinator errors and reports the supervisor probe result', async () => {
    vi.useFakeTimers();

    const supervisor = createSupervisor();
    const error = new Error('expired token');
    const coordinator = TranscriptRecoveryCoordinator.forServer('http://server.test', { delayMs: 0 });
    const runRequest = vi.fn(async (): Promise<TranscriptLookupOutcome> => ({
      type: 'auth_failed',
      statusCode: 401,
      error,
    }));

    const result = coordinator.scheduleByLocalId({
      sessionId: 'sid',
      localId: 'local-1',
      supervisor,
      runRequest,
    });
    await vi.runAllTimersAsync();

    await expect(result).resolves.toEqual({ type: 'error', reason: 'auth_failed', error });
    expect(supervisor.reportProbeResult).toHaveBeenCalledWith({
      status: 'auth_failed',
      statusCode: 401,
      errorMessage: 'expired token',
    });
  });

  it.each([
    ['server 5xx', { type: 'unhealthy', reason: 'server_5xx', error: new Error('unavailable') }],
    ['network', { type: 'unhealthy', reason: 'network', error: Object.assign(new Error('connection reset'), { code: 'ECONNRESET' }) }],
    ['timeout', { type: 'unhealthy', reason: 'timeout', error: Object.assign(new Error('request timed out'), { code: 'ETIMEDOUT' }) }],
    ['protocol', { type: 'protocol_error', error: new Error('malformed response') }],
  ] as const)('keeps %s lookup failures operation-local', async (_name, outcome) => {
    vi.useFakeTimers();

    const supervisor = createSupervisor();
    const coordinator = TranscriptRecoveryCoordinator.forServer('http://server.test', { delayMs: 0 });
    const runRequest = vi.fn(async (): Promise<TranscriptLookupOutcome> => outcome);

    const result = coordinator.scheduleByLocalId({
      sessionId: 'sid',
      localId: 'local-1',
      supervisor,
      runRequest,
    });
    await vi.runAllTimersAsync();

    await expect(result).resolves.toMatchObject({ type: 'error' });
    expect(supervisor.reportProbeResult).not.toHaveBeenCalled();
  });

  it('keeps thrown server failures operation-local while retaining keyed backoff', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);

    const supervisor = createSupervisor();
    const error = new HttpStatusError(503, 'service unavailable');
    const coordinator = TranscriptRecoveryCoordinator.forServer('http://server.test', {
      delayMs: 0,
      errorBackoffBaseMs: 100,
      errorBackoffMaxMs: 100,
    });
    const runRequest = vi.fn(async (): Promise<TranscriptLookupOutcome> => {
      throw error;
    });

    const result = coordinator.scheduleByLocalId({
      sessionId: 'sid',
      localId: 'local-1',
      supervisor,
      runRequest,
    });
    await vi.runAllTimersAsync();

    await expect(result).resolves.toEqual({ type: 'error', reason: 'unhealthy', error });
    expect(supervisor.reportProbeResult).not.toHaveBeenCalled();
    await expect(
      coordinator.scheduleByLocalId({
        sessionId: 'sid',
        localId: 'local-1',
        supervisor,
        runRequest,
      }),
    ).resolves.toEqual({ type: 'deferred', reason: 'backoff' });
    expect(runRequest).toHaveBeenCalledTimes(1);
  });

  it('reports thrown 403 authentication failures to the shared supervisor', async () => {
    vi.useFakeTimers();

    const supervisor = createSupervisor();
    const error = new HttpStatusError(403, 'forbidden');
    const coordinator = TranscriptRecoveryCoordinator.forServer('http://server.test', { delayMs: 0 });
    const result = coordinator.scheduleByLocalId({
      sessionId: 'sid',
      localId: 'local-1',
      supervisor,
      runRequest: async () => {
        throw error;
      },
    });
    await vi.runAllTimersAsync();

    await expect(result).resolves.toEqual({ type: 'error', reason: 'auth_failed', error });
    expect(supervisor.reportProbeResult).toHaveBeenCalledWith({
      status: 'auth_failed',
      statusCode: 403,
      errorMessage: 'forbidden',
    });
  });

  it('maps protocol errors into coordinator errors with backoff', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);

    const error = new Error('bad response');
    const coordinator = TranscriptRecoveryCoordinator.forServer('http://server.test', {
      delayMs: 0,
      errorBackoffBaseMs: 100,
      errorBackoffMaxMs: 100,
    });
    const runRequest = vi.fn(async (): Promise<TranscriptLookupOutcome> => ({
      type: 'protocol_error',
      error,
    }));

    const result = coordinator.scheduleByLocalId({
      sessionId: 'sid',
      localId: 'local-1',
      supervisor: createSupervisor(),
      runRequest,
    });
    await vi.runAllTimersAsync();

    await expect(result).resolves.toEqual({ type: 'error', reason: 'protocol_error', error });
    await expect(
      coordinator.scheduleByLocalId({
        sessionId: 'sid',
        localId: 'local-1',
        supervisor: createSupervisor(),
        runRequest,
      }),
    ).resolves.toEqual({ type: 'deferred', reason: 'backoff' });
    expect(runRequest).toHaveBeenCalledTimes(1);
  });
});
