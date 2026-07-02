import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import axios from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createPlainSessionFixture } from '@/testkit/backends/sessionFixtures';
import {
  type ApiSessionSocketStub,
  createApiSessionSocketStub,
} from '@/testkit/backends/apiSessionSocketHarness';
import type { ACPMessageData } from './sessionMessageTypes';
import type { createSessionSocketTransport } from './connection/createSessionSocketTransport';
import type { createUserScopedSocket } from './sockets';

type SessionSocketTransportResult = ReturnType<typeof createSessionSocketTransport>;
type UserScopedSocket = ReturnType<typeof createUserScopedSocket>;
let sessionSocketStub: ApiSessionSocketStub | null = null;
let userSocketStub: ApiSessionSocketStub | null = null;
let supervisorConnect: null | (() => Promise<void>) = null;
let tempHomeDir: string | null = null;
const originalHappyHomeDir = process.env.HAPPIER_HOME_DIR;

vi.mock('axios');

vi.mock('./sockets', () => ({
  createUserScopedSocket: () => {
    if (!userSocketStub) throw new Error('Missing user socket stub');
    return userSocketStub as unknown as UserScopedSocket;
  },
}));

vi.mock('./connection/createSessionSocketTransport', () => ({
  createSessionSocketTransport: () => {
    if (!sessionSocketStub) throw new Error('Missing session socket stub');
    const transportResult: SessionSocketTransportResult = {
      socket: sessionSocketStub as unknown as SessionSocketTransportResult['socket'],
      transport: {
        connect: async () => {},
        disconnect: async () => {},
        destroy: async () => {},
        isConnected: () => sessionSocketStub?.connected === true,
        onConnected: () => () => {},
        onDisconnected: () => () => {},
        onError: () => () => {},
      },
    };
    return transportResult;
  },
}));

vi.mock('@happier-dev/connection-supervisor', () => ({
  DEFAULT_MANAGED_CONNECTION_POLICY: {},
  createManagedConnectionSupervisor: (params: { createTransport: () => unknown; onConnected?: () => Promise<void> | void }) => {
    supervisorConnect = async () => {
      params.createTransport();
      await params.onConnected?.();
    };
    return {
      start: async () => {
        await supervisorConnect?.();
      },
      getState: () => ({ phase: 'online' }),
      stop: async () => {},
    };
  },
}));

async function useTempHappyHome(): Promise<string> {
  tempHomeDir = await mkdtemp(join(tmpdir(), 'happier-cli-session-outbox-'));
  process.env.HAPPIER_HOME_DIR = tempHomeDir;
  return tempHomeDir;
}

async function readPersistedOutboxMutationCount(sessionId: string): Promise<number> {
  const { configuration } = await import('@/configuration');
  const filePath = join(configuration.activeServerDir, 'session-mutations', `session-${sessionId}.json`);
  try {
    const parsed = JSON.parse(await readFile(filePath, 'utf8')) as { mutations?: unknown[] };
    return Array.isArray(parsed.mutations) ? parsed.mutations.length : 0;
  } catch {
    return 0;
  }
}

async function readPersistedOutboxMutations(sessionId: string): Promise<unknown[]> {
  const { configuration } = await import('@/configuration');
  const filePath = join(configuration.activeServerDir, 'session-mutations', `session-${sessionId}.json`);
  try {
    const parsed = JSON.parse(await readFile(filePath, 'utf8')) as { mutations?: unknown[] };
    return Array.isArray(parsed.mutations) ? parsed.mutations : [];
  } catch {
    return [];
  }
}

function createDeferred<T>(): Readonly<{
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const taskCompleteMessage = { type: 'task_complete', id: 'turn-1' } satisfies ACPMessageData;
const reusableUnknownTurnId = ['primary', 'runtime'].join('-') + ':s1:unknown';

describe('ApiSessionClient durable mutation outbox', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.mocked(axios.post).mockReset();
    supervisorConnect = null;
    sessionSocketStub = null;
    userSocketStub = null;
    await useTempHappyHome();
  });

  afterEach(async () => {
    process.env.HAPPIER_HOME_DIR = originalHappyHomeDir;
    if (tempHomeDir) {
      await rm(tempHomeDir, { recursive: true, force: true });
      tempHomeDir = null;
    }
  });

  it('does not queue a terminal session turn mutation when no turn is active', async () => {
    vi.mocked(axios.post).mockRejectedValue(new Error('server offline'));
    const deliveredEvents: string[] = [];
    sessionSocketStub = createApiSessionSocketStub({
      connected: false,
      emit: (event: string, args: unknown[]) => {
        if (event === 'ping') {
          const callback = args[0];
          if (typeof callback === 'function') callback();
        }
      },
      emitWithAck: async (event: string) => {
        deliveredEvents.push(event);
        return { ok: true };
      },
    });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    const { ApiSessionClient } = await import('./sessionClient');
    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));

    client.sendAgentMessage('codex', taskCompleteMessage);

    await expect.poll(() => readPersistedOutboxMutationCount('s1')).toBe(0);

    sessionSocketStub.connected = true;
    await client.flush();

    expect(deliveredEvents).not.toContain('session-turn-mutation');
    await client.close();
  });

  it('delivers queued terminal session turn mutations for an active turn after reconnect', async () => {
    vi.mocked(axios.post).mockRejectedValue(new Error('server offline'));
    const deliveredEvents: string[] = [];
    sessionSocketStub = createApiSessionSocketStub({
      connected: false,
      emit: (event: string, args: unknown[]) => {
        if (event === 'ping') {
          const callback = args[0];
          if (typeof callback === 'function') callback();
        }
      },
      emitWithAck: async (event: string) => {
        deliveredEvents.push(event);
        return { ok: true };
      },
    });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    const { ApiSessionClient } = await import('./sessionClient');
    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));

    client.sendAgentMessage('codex', { type: 'task_started', id: 'turn-1' });
    client.sendAgentMessage('codex', taskCompleteMessage);

    await expect.poll(async () => (await readPersistedOutboxMutationCount('s1')) > 0).toBe(true);

    sessionSocketStub.connected = true;
    await client.flush();

    expect(deliveredEvents).toContain('session-turn-mutation');
    await expect.poll(() => readPersistedOutboxMutationCount('s1')).toBe(0);
    await client.close();
  });

  it('keeps undelivered terminal session turn mutations persisted when the client closes', async () => {
    vi.mocked(axios.post).mockRejectedValue(new Error('server offline'));
    sessionSocketStub = createApiSessionSocketStub({
      connected: false,
      emitWithAck: async () => {
        throw new Error('socket emit should not be reached while disconnected');
      },
    });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    const { ApiSessionClient } = await import('./sessionClient');
    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));

    client.sendAgentMessage('codex', { type: 'task_started', id: 'turn-1' });
    client.sendAgentMessage('codex', taskCompleteMessage);

    await expect.poll(async () => (await readPersistedOutboxMutationCount('s1')) > 0).toBe(true);
    await client.close();

    expect(await readPersistedOutboxMutationCount('s1')).toBe(2);
  });

  it('uses HTTP fallback for session turn mutations when the socket is disconnected', async () => {
    vi.mocked(axios.post).mockResolvedValue({ status: 200, data: { ok: true } } as never);
    sessionSocketStub = createApiSessionSocketStub({
      connected: false,
      emitWithAck: async () => {
        throw new Error('socket emit should not be reached while disconnected');
      },
    });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    const { ApiSessionClient } = await import('./sessionClient');
    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));

    client.sendAgentMessage('codex', { type: 'task_started', id: 'turn-1' });
    client.sendAgentMessage('codex', taskCompleteMessage);

    await expect.poll(() => vi.mocked(axios.post).mock.calls.length).toBeGreaterThan(0);
    expect(vi.mocked(axios.post).mock.calls[0]?.[0]).toContain('/v1/sessions/s1/turns/mutations');
    expect(vi.mocked(axios.post).mock.calls[0]?.[1]).toEqual(expect.objectContaining({
      v: 1,
      sessionId: 's1',
      action: 'begin',
      turnId: expect.any(String),
    }));
    await client.close();
  });

  it('delivers disconnected terminal turn mutations after their begin mutation when the begin delivery is still in flight', async () => {
    const firstHttpAttempt = createDeferred<never>();
    const httpActions: string[] = [];
    let isFirstHttpAttempt = true;
    vi.mocked(axios.post).mockImplementation(async (_url, body) => {
      const action = (body as { action?: unknown }).action;
      httpActions.push(typeof action === 'string' ? action : 'unknown');
      if (isFirstHttpAttempt) {
        isFirstHttpAttempt = false;
        return await firstHttpAttempt.promise;
      }
      return { status: 200, data: { ok: true } } as never;
    });
    sessionSocketStub = createApiSessionSocketStub({
      connected: false,
      emitWithAck: async () => {
        throw new Error('socket emit should not be reached while disconnected');
      },
    });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    const { ApiSessionClient } = await import('./sessionClient');
    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));

    await client.sessionTurnLifecycle.beginTurn({ provider: 'codex', providerTurnId: 'turn-1' });
    await expect.poll(() => httpActions).toEqual(['begin']);

    await client.sessionTurnLifecycle.completeTurn({ provider: 'codex', providerTurnId: 'turn-1' });
    await expect.poll(() => readPersistedOutboxMutations('s1')).toEqual([
      expect.objectContaining({
        kind: 'session_turn',
        payload: expect.objectContaining({ action: 'begin' }),
      }),
      expect.objectContaining({
        kind: 'session_turn',
        payload: expect.objectContaining({ action: 'complete' }),
      }),
    ]);
    firstHttpAttempt.reject(new Error('server offline'));

    await client.flush();
    await expect.poll(() => httpActions).toEqual(['begin', 'begin', 'complete']);
    await client.close();
  });

  it('keeps terminal turn mutations queued behind a failed begin retry', async () => {
    const originalBaseRetryMs = process.env.HAPPIER_SESSION_MUTATION_OUTBOX_BASE_RETRY_MS;
    const originalJitterMs = process.env.HAPPIER_SESSION_MUTATION_OUTBOX_JITTER_MS;
    process.env.HAPPIER_SESSION_MUTATION_OUTBOX_BASE_RETRY_MS = '60000';
    process.env.HAPPIER_SESSION_MUTATION_OUTBOX_JITTER_MS = '0';

    const httpActions: string[] = [];
    let beginAttempts = 0;
    let outbox: {
      flush(reason: 'connect' | 'timer' | 'flush' | 'startup' | 'enqueue'): Promise<void>;
      close(): Promise<void>;
    } | null = null;
    vi.mocked(axios.post).mockImplementation(async (_url, body) => {
      const action = (body as { action?: unknown }).action;
      const normalizedAction = typeof action === 'string' ? action : 'unknown';
      httpActions.push(normalizedAction);
      if (normalizedAction === 'begin') {
        beginAttempts += 1;
        if (beginAttempts === 1) {
          throw new Error(`server offline for begin attempt ${beginAttempts}`);
        }
      }
      return { status: 200, data: { ok: true } } as never;
    });
    const socket = createApiSessionSocketStub({
      connected: false,
      emitWithAck: async () => {
        throw new Error('socket emit should not be reached while disconnected');
      },
    });

    try {
      const { createSessionMutationOutbox } = await import('./mutations/createSessionMutationOutbox');
      const { createSessionTurnMutation } = await import('./mutations/sessionMutationTypes');
      const { saveSessionMutationOutbox } = await import('./mutations/sessionMutationPersistence');
      const begin = createSessionTurnMutation({
        sessionId: 's1',
        action: 'begin',
        turnId: 'session-turn:turn-1',
        provider: 'codex',
        providerTurnId: 'turn-1',
        mutationId: 'mutation-begin',
        observedAt: 100,
      });
      const complete = createSessionTurnMutation({
        sessionId: 's1',
        action: 'complete',
        turnId: 'session-turn:turn-1',
        provider: 'codex',
        providerTurnId: 'turn-1',
        mutationId: 'mutation-complete',
        observedAt: 200,
      });
      await saveSessionMutationOutbox('s1', [
        {
          kind: 'session_turn',
          mutationId: begin.mutationId,
          payload: begin,
          createdAt: 100,
          attempts: 0,
          nextAttemptAt: 0,
        },
        {
          kind: 'session_turn',
          mutationId: complete.mutationId,
          payload: complete,
          createdAt: 200,
          attempts: 0,
          nextAttemptAt: 0,
        },
      ]);

      outbox = createSessionMutationOutbox({
        token: 'tok',
        sessionId: 's1',
        getSocket: () => socket,
        requestReconnect: () => {},
      });

      await expect.poll(() => httpActions).toEqual(['begin']);
      await expect.poll(() => readPersistedOutboxMutations('s1')).toEqual([
        expect.objectContaining({
          kind: 'session_turn',
          payload: expect.objectContaining({ action: 'begin' }),
        }),
        expect.objectContaining({
          kind: 'session_turn',
          payload: expect.objectContaining({ action: 'complete' }),
        }),
      ]);

      await outbox.flush('flush');

      expect(httpActions).toEqual(['begin', 'begin', 'complete']);
      await expect.poll(() => readPersistedOutboxMutationCount('s1')).toBe(0);
    } finally {
      await outbox?.close().catch(() => {});
      if (originalBaseRetryMs === undefined) {
        delete process.env.HAPPIER_SESSION_MUTATION_OUTBOX_BASE_RETRY_MS;
      } else {
        process.env.HAPPIER_SESSION_MUTATION_OUTBOX_BASE_RETRY_MS = originalBaseRetryMs;
      }
      if (originalJitterMs === undefined) {
        delete process.env.HAPPIER_SESSION_MUTATION_OUTBOX_JITTER_MS;
      } else {
        process.env.HAPPIER_SESSION_MUTATION_OUTBOX_JITTER_MS = originalJitterMs;
      }
    }
  });

  it('keeps disconnected session turn mutations queued when HTTP fallback reports an unsupported route', async () => {
    const originalBaseRetryMs = process.env.HAPPIER_SESSION_MUTATION_OUTBOX_BASE_RETRY_MS;
    const originalJitterMs = process.env.HAPPIER_SESSION_MUTATION_OUTBOX_JITTER_MS;
    process.env.HAPPIER_SESSION_MUTATION_OUTBOX_BASE_RETRY_MS = '60000';
    process.env.HAPPIER_SESSION_MUTATION_OUTBOX_JITTER_MS = '0';
    vi.mocked(axios.post).mockRejectedValue({ response: { status: 404 } });
    const { logger } = await import('@/ui/logger');
    const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => {});
    const socket = createApiSessionSocketStub({
      connected: false,
      emitWithAck: async () => {
        throw new Error('socket emit should not be reached while disconnected');
      },
    });
    let outbox: {
      flush(reason: 'connect' | 'timer' | 'flush' | 'startup' | 'enqueue'): Promise<void>;
      close(): Promise<void>;
    } | null = null;

    try {
      const { createSessionMutationOutbox } = await import('./mutations/createSessionMutationOutbox');
      const { createSessionTurnMutation } = await import('./mutations/sessionMutationTypes');
      const { saveSessionMutationOutbox } = await import('./mutations/sessionMutationPersistence');
      const begin = createSessionTurnMutation({
        sessionId: 's1',
        action: 'begin',
        turnId: 'session-turn:turn-1',
        provider: 'codex',
        providerTurnId: 'turn-1',
        mutationId: 'mutation-begin',
        observedAt: 100,
      });
      await saveSessionMutationOutbox('s1', [
        {
          kind: 'session_turn',
          mutationId: begin.mutationId,
          payload: begin,
          createdAt: 100,
          attempts: 0,
          nextAttemptAt: Date.now() + 60_000,
        },
      ]);

      outbox = createSessionMutationOutbox({
        token: 'tok',
        sessionId: 's1',
        getSocket: () => socket,
        requestReconnect: () => {},
      });

      await outbox.flush('flush');
      await expect.poll(() => vi.mocked(axios.post).mock.calls.length).toBe(1);
      await expect.poll(() => readPersistedOutboxMutations('s1')).toEqual([
        expect.objectContaining({
          kind: 'session_turn',
          payload: expect.objectContaining({ action: 'begin' }),
          attempts: 1,
        }),
      ]);
      expect(debugSpy.mock.calls.some(([message]) =>
        message === '[API] Session turn mutation unsupported by server; keeping durable outbox mutation queued'
      )).toBe(false);
    } finally {
      await outbox?.close();
      debugSpy.mockRestore();
      if (originalBaseRetryMs === undefined) {
        delete process.env.HAPPIER_SESSION_MUTATION_OUTBOX_BASE_RETRY_MS;
      } else {
        process.env.HAPPIER_SESSION_MUTATION_OUTBOX_BASE_RETRY_MS = originalBaseRetryMs;
      }
      if (originalJitterMs === undefined) {
        delete process.env.HAPPIER_SESSION_MUTATION_OUTBOX_JITTER_MS;
      } else {
        process.env.HAPPIER_SESSION_MUTATION_OUTBOX_JITTER_MS = originalJitterMs;
      }
    }
  });

  it('keeps durable outbox authentication errors queued without consuming retry attempts', async () => {
    const originalBaseRetryMs = process.env.HAPPIER_SESSION_MUTATION_OUTBOX_BASE_RETRY_MS;
    const originalJitterMs = process.env.HAPPIER_SESSION_MUTATION_OUTBOX_JITTER_MS;
    process.env.HAPPIER_SESSION_MUTATION_OUTBOX_BASE_RETRY_MS = '60000';
    process.env.HAPPIER_SESSION_MUTATION_OUTBOX_JITTER_MS = '0';
    const authError = Object.assign(new Error('authentication required'), { response: { status: 401 } });
    vi.mocked(axios.post).mockRejectedValue(authError);
    const socket = createApiSessionSocketStub({
      connected: false,
      emitWithAck: async () => {
        throw new Error('socket emit should not be reached while disconnected');
      },
    });
    let outbox: {
      flush(reason: 'connect' | 'timer' | 'flush' | 'startup' | 'enqueue'): Promise<void>;
      close(): Promise<void>;
    } | null = null;

    try {
      const { createSessionMutationOutbox } = await import('./mutations/createSessionMutationOutbox');
      const { createSessionTurnMutation } = await import('./mutations/sessionMutationTypes');
      const { saveSessionMutationOutbox } = await import('./mutations/sessionMutationPersistence');
      const begin = createSessionTurnMutation({
        sessionId: 's1',
        action: 'begin',
        turnId: 'session-turn:turn-1',
        provider: 'codex',
        providerTurnId: 'turn-1',
        mutationId: 'mutation-begin',
        observedAt: 100,
      });
      await saveSessionMutationOutbox('s1', [
        {
          kind: 'session_turn',
          mutationId: begin.mutationId,
          payload: begin,
          createdAt: 100,
          attempts: 0,
          nextAttemptAt: 0,
        },
      ]);

      outbox = createSessionMutationOutbox({
        token: 'tok',
        sessionId: 's1',
        getSocket: () => socket,
        requestReconnect: () => {},
      });

      await outbox.flush('flush');
      await expect(readPersistedOutboxMutations('s1')).resolves.toEqual([
        expect.objectContaining({
          kind: 'session_turn',
          mutationId: 'mutation-begin',
          attempts: 0,
        }),
      ]);
    } finally {
      await outbox?.close();
      if (originalBaseRetryMs === undefined) {
        delete process.env.HAPPIER_SESSION_MUTATION_OUTBOX_BASE_RETRY_MS;
      } else {
        process.env.HAPPIER_SESSION_MUTATION_OUTBOX_BASE_RETRY_MS = originalBaseRetryMs;
      }
      if (originalJitterMs === undefined) {
        delete process.env.HAPPIER_SESSION_MUTATION_OUTBOX_JITTER_MS;
      } else {
        process.env.HAPPIER_SESSION_MUTATION_OUTBOX_JITTER_MS = originalJitterMs;
      }
    }
  });

  it('drains in-flight durable session mutations before close returns', async () => {
    const httpDelivery = createDeferred<{ status: number; data: { ok: true } }>();
    const httpActions: string[] = [];
    let closeSettled = false;
    let outbox: {
      enqueueSessionTurn(mutation: Awaited<ReturnType<typeof import('./mutations/sessionMutationTypes').createSessionTurnMutation>>): Promise<void>;
      close(): Promise<void>;
    } | null = null;
    vi.mocked(axios.post).mockImplementation(async (_url, body) => {
      const action = (body as { action?: unknown }).action;
      httpActions.push(typeof action === 'string' ? action : 'unknown');
      return await httpDelivery.promise as never;
    });
    const socket = createApiSessionSocketStub({
      connected: false,
      emitWithAck: async () => {
        throw new Error('socket emit should not be reached while disconnected');
      },
    });

    try {
      const { createSessionMutationOutbox } = await import('./mutations/createSessionMutationOutbox');
      const { createSessionTurnMutation } = await import('./mutations/sessionMutationTypes');
      outbox = createSessionMutationOutbox({
        token: 'tok',
        sessionId: 's1',
        getSocket: () => socket,
        requestReconnect: () => {},
      });
      await outbox.enqueueSessionTurn(createSessionTurnMutation({
        sessionId: 's1',
        action: 'begin',
        turnId: 'session-turn:turn-1',
        provider: 'codex',
        providerTurnId: 'turn-1',
        mutationId: 'mutation-begin',
        observedAt: 100,
      }));

      await expect.poll(() => httpActions).toEqual(['begin']);
      const closePromise = outbox.close().then(() => {
        closeSettled = true;
      });
      await expect.poll(() => closeSettled, { timeout: 50 }).toBe(false);

      httpDelivery.resolve({ status: 200, data: { ok: true } });
      await closePromise;

      await expect.poll(() => readPersistedOutboxMutationCount('s1')).toBe(0);
    } finally {
      httpDelivery.resolve({ status: 200, data: { ok: true } });
      await outbox?.close();
    }
  });

  it('waits for pending lifecycle writes and session-end enqueue before closing the durable mutation outbox', async () => {
    const cancelEnqueue = createDeferred<void>();
    const sessionEndEnqueue = createDeferred<void>();
    const outboxClose = createDeferred<void>();
    const outboxEvents: string[] = [];
    vi.doMock('./mutations/createSessionMutationOutbox', () => ({
      createSessionMutationOutbox: () => ({
        enqueueSessionTurn: async (mutation: { action: string }) => {
          outboxEvents.push(`enqueue:${mutation.action}:start`);
          if (mutation.action === 'cancel') {
            await cancelEnqueue.promise;
          }
          outboxEvents.push(`enqueue:${mutation.action}:end`);
        },
        enqueueSessionEnd: async () => {
          outboxEvents.push('enqueue:end-session:start');
          await sessionEndEnqueue.promise;
          outboxEvents.push('enqueue:end-session:end');
        },
        flush: async () => {
          outboxEvents.push('flush');
        },
        close: async () => {
          outboxEvents.push('outbox-close:start');
          await outboxClose.promise;
          outboxEvents.push('outbox-close:end');
        },
      }),
    }));

    sessionSocketStub = createApiSessionSocketStub({ connected: false });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    try {
      const { ApiSessionClient } = await import('./sessionClient');
      const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));

      await client.sessionTurnLifecycle.beginTurn({ provider: 'codex', providerTurnId: 'turn-1' });
      client.sendSessionDeath();

      let closeSettled = false;
      const closePromise = client.close().then(() => {
        closeSettled = true;
      });

      await expect.poll(() => outboxEvents).toContain('enqueue:cancel:start');
      await expect.poll(() => outboxEvents).toContain('enqueue:end-session:start');
      await expect.poll(() => closeSettled, { timeout: 50 }).toBe(false);
      expect(outboxEvents).not.toContain('outbox-close:start');

      cancelEnqueue.resolve();
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(outboxEvents).not.toContain('outbox-close:start');

      sessionEndEnqueue.resolve();
      await expect.poll(() => outboxEvents).toContain('outbox-close:start');
      outboxClose.resolve();
      await closePromise;

      expect(outboxEvents).toContain('enqueue:cancel:end');
      expect(outboxEvents).toContain('enqueue:end-session:end');
      expect(outboxEvents.at(-1)).toBe('outbox-close:end');
    } finally {
      cancelEnqueue.resolve();
      sessionEndEnqueue.resolve();
      outboxClose.resolve();
      vi.doUnmock('./mutations/createSessionMutationOutbox');
      vi.resetModules();
    }
  });

  it('reuses one session-owned turn id across begin and terminal markers', async () => {
    vi.mocked(axios.post).mockRejectedValue(new Error('server offline'));
    const turnMutations: Array<Record<string, unknown>> = [];
    sessionSocketStub = createApiSessionSocketStub({
      connected: true,
      emitWithAck: async (event: string, payload: unknown) => {
        if (event === 'session-turn-mutation') {
          turnMutations.push(payload as Record<string, unknown>);
          return { ok: true };
        }
        return { ok: true };
      },
    });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    const { ApiSessionClient } = await import('./sessionClient');
    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));

    client.sendAgentMessage('opencode', { type: 'task_started', id: 'provider-start' });
    client.sendAgentMessage('opencode', { type: 'task_complete', id: 'random-terminal' });

    await expect.poll(() => turnMutations).toEqual([
      expect.objectContaining({ action: 'begin' }),
      expect.objectContaining({ action: 'complete' }),
    ]);
    expect(turnMutations[0]?.turnId).toBe(turnMutations[1]?.turnId);
    expect(turnMutations[0]?.turnId).not.toBe('provider-start');
    expect(turnMutations[1]?.turnId).not.toBe('random-terminal');
    expect(JSON.stringify(turnMutations)).not.toContain(reusableUnknownTurnId);
    await client.close();
  });

  it('commits compatibility lifecycle markers with the lifecycle turn id', async () => {
    vi.mocked(axios.post).mockRejectedValue(new Error('server offline'));
    const turnMutations: Array<Record<string, unknown>> = [];
    const lifecycleBodies: Array<Record<string, unknown>> = [];
    sessionSocketStub = createApiSessionSocketStub({
      connected: true,
      emitWithAck: async (event: string, payload: unknown) => {
        if (event === 'session-turn-mutation') {
          turnMutations.push(payload as Record<string, unknown>);
          return { ok: true };
        }
        if (event === 'message') {
          const message = (payload as { message?: unknown }).message;
          const plainValue = message && typeof message === 'object' && (message as { t?: unknown }).t === 'plain'
            ? (message as { v?: unknown }).v
            : null;
          const data = plainValue && typeof plainValue === 'object'
            ? ((plainValue as { content?: { data?: unknown } }).content?.data)
            : null;
          if (
            data
            && typeof data === 'object'
            && ['task_started', 'turn_aborted'].includes(String((data as { type?: unknown }).type))
          ) {
            lifecycleBodies.push(data as Record<string, unknown>);
          }
          return { ok: true, id: 'm1', seq: lifecycleBodies.length || 1, localId: (payload as { localId?: string }).localId ?? 'l1' };
        }
        return { ok: true };
      },
    });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    const { ApiSessionClient } = await import('./sessionClient');
    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));

    client.sendAgentMessage('opencode', { type: 'task_started', id: 'provider-start' }, { localId: 'start-marker' });
    client.sendAgentMessage('opencode', { type: 'turn_aborted', id: 'random-abort-id' }, { localId: 'abort-marker' });

    await expect.poll(() => turnMutations).toEqual([
      expect.objectContaining({ action: 'begin' }),
      expect.objectContaining({ action: 'cancel' }),
    ]);
    await expect.poll(() => lifecycleBodies).toEqual([
      expect.objectContaining({ type: 'task_started', id: turnMutations[0]?.turnId }),
      expect.objectContaining({ type: 'turn_aborted', id: turnMutations[0]?.turnId }),
    ]);
    await client.close();
  });

  it('closes the active turn when a terminal marker has no trusted id', async () => {
    vi.mocked(axios.post).mockRejectedValue(new Error('server offline'));
    const turnMutations: Array<Record<string, unknown>> = [];
    sessionSocketStub = createApiSessionSocketStub({
      connected: true,
      emitWithAck: async (event: string, payload: unknown) => {
        if (event === 'session-turn-mutation') {
          turnMutations.push(payload as Record<string, unknown>);
          return { ok: true };
        }
        return { ok: true };
      },
    });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    const { ApiSessionClient } = await import('./sessionClient');
    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));

    client.sendAgentMessage('opencode', { type: 'task_started', id: 'provider-start' });
    client.sendAgentMessage('opencode', { type: 'turn_cancelled', id: '' });

    await expect.poll(() => turnMutations).toEqual([
      expect.objectContaining({ action: 'begin' }),
      expect.objectContaining({ action: 'cancel' }),
    ]);
    expect(turnMutations[1]?.turnId).toBe(turnMutations[0]?.turnId);
    expect(JSON.stringify(turnMutations)).not.toContain(reusableUnknownTurnId);
    await client.close();
  });

  it('does not let a random terminal marker replace the active turn id', async () => {
    vi.mocked(axios.post).mockRejectedValue(new Error('server offline'));
    const turnMutations: Array<Record<string, unknown>> = [];
    sessionSocketStub = createApiSessionSocketStub({
      connected: true,
      emitWithAck: async (event: string, payload: unknown) => {
        if (event === 'session-turn-mutation') {
          turnMutations.push(payload as Record<string, unknown>);
          return { ok: true };
        }
        return { ok: true };
      },
    });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    const { ApiSessionClient } = await import('./sessionClient');
    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));

    client.sendAgentMessage('opencode', { type: 'task_started', id: 'provider-start' });
    client.sendAgentMessage('opencode', { type: 'turn_aborted', id: 'random-abort-id' });

    await expect.poll(() => turnMutations).toEqual([
      expect.objectContaining({ action: 'begin' }),
      expect.objectContaining({ action: 'cancel' }),
    ]);
    expect(turnMutations[1]?.turnId).toBe(turnMutations[0]?.turnId);
    expect(turnMutations[1]?.turnId).not.toBe('random-abort-id');
    await client.close();
  });

  it('does not erase recorded runtime issue details when a bare failed marker follows', async () => {
    vi.mocked(axios.post).mockRejectedValue(new Error('server offline'));
    const issue = {
      v: 1,
      scope: 'primary_session',
      status: 'failed',
      code: 'auth_error',
      source: 'auth_error',
      occurredAt: 123,
      sanitizedPreview: 'Authentication failed',
    } as const;
    const turnMutations: Array<Record<string, unknown>> = [];
    sessionSocketStub = createApiSessionSocketStub({
      connected: true,
      emitWithAck: async (event: string, payload: unknown) => {
        if (event === 'session-turn-mutation') {
          turnMutations.push(payload as Record<string, unknown>);
          return { ok: true };
        }
        return { ok: true };
      },
    });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    const { ApiSessionClient } = await import('./sessionClient');
    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));

    expect('updatePrimaryTurnRuntimeState' in client).toBe(false);

    await client.sessionTurnLifecycle.beginTurn({ provider: 'codex' });
    await client.sessionTurnLifecycle.failTurn({
      provider: 'codex',
      issue,
    });
    client.sendAgentMessage('codex', { type: 'turn_failed', id: '' });

    await expect.poll(() => turnMutations.length).toBeGreaterThan(0);
    expect(turnMutations.filter((mutation) => mutation.action === 'fail')).toEqual([
      expect.objectContaining({ issue }),
    ]);
    expect(JSON.stringify(turnMutations)).not.toContain(reusableUnknownTurnId);
    await client.close();
  });

  it('allocates a session turn id for an active turn instead of falling back to a reusable unknown id', async () => {
    vi.mocked(axios.post).mockRejectedValue(new Error('server offline'));
    const turnMutations: Array<Record<string, unknown>> = [];
    sessionSocketStub = createApiSessionSocketStub({
      connected: true,
      emitWithAck: async (event: string, payload: unknown) => {
        if (event === 'session-turn-mutation') {
          turnMutations.push(payload as Record<string, unknown>);
          return { ok: true };
        }
        return { ok: true };
      },
    });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    const { ApiSessionClient } = await import('./sessionClient');
    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));

    expect('updatePrimaryTurnRuntimeState' in client).toBe(false);

    await client.sessionTurnLifecycle.beginTurn({});
    await client.sessionTurnLifecycle.completeTurn();

    await expect.poll(() => turnMutations).toEqual([
      expect.objectContaining({ action: 'begin', turnId: expect.any(String) }),
      expect.objectContaining({ action: 'complete', turnId: expect.any(String) }),
    ]);
    expect(turnMutations[0]?.turnId).toBe(turnMutations[1]?.turnId);
    expect(turnMutations[0]?.turnId).not.toBe(reusableUnknownTurnId);
    await client.close();
  });

  it('keeps unsupported old-preview session turn mutations queued without emitting update-state', async () => {
    const originalBaseRetryMs = process.env.HAPPIER_SESSION_MUTATION_OUTBOX_BASE_RETRY_MS;
    const originalJitterMs = process.env.HAPPIER_SESSION_MUTATION_OUTBOX_JITTER_MS;
    process.env.HAPPIER_SESSION_MUTATION_OUTBOX_BASE_RETRY_MS = '60000';
    process.env.HAPPIER_SESSION_MUTATION_OUTBOX_JITTER_MS = '0';
    vi.mocked(axios.post).mockRejectedValue({ response: { status: 404 } });
    const deliveredEvents: string[] = [];
    let sessionTurnMutationAttempts = 0;
    const { logger } = await import('@/ui/logger');
    const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => {});
    sessionSocketStub = createApiSessionSocketStub({
      connected: true,
      emitWithAck: async (event: string, payload: unknown) => {
        deliveredEvents.push(event);
        if (event === 'session-turn-mutation') {
          sessionTurnMutationAttempts += 1;
          if (sessionTurnMutationAttempts === 1) return { ok: true };
          return { ok: false, errorCode: 'unsupported' };
        }
        if (event === 'update-state') {
          const updateStatePayload = payload as { agentState: unknown; expectedVersion: number };
          return {
            result: 'success',
            agentState: updateStatePayload.agentState,
            version: updateStatePayload.expectedVersion + 1,
          };
        }
        return { ok: true };
      },
    });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    let client: { close(): Promise<void>; sessionTurnLifecycle: { beginTurn(input: object): Promise<unknown>; failTurn(input: object): Promise<unknown> } } | null = null;

    try {
      const { ApiSessionClient } = await import('./sessionClient');
      client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));

      await client.sessionTurnLifecycle.beginTurn({});
      await client.sessionTurnLifecycle.failTurn({});

      await expect.poll(() => deliveredEvents).toEqual([
        'session-turn-mutation',
        'session-turn-mutation',
      ]);
      await expect.poll(() => readPersistedOutboxMutations('s1')).toSatisfy((mutations) => {
        return (
          mutations.length === 1
          && mutations[0]?.kind === 'session_turn'
          && (mutations[0]?.payload as { action?: unknown })?.action === 'fail'
          && typeof mutations[0]?.attempts === 'number'
          && mutations[0].attempts >= 1
        );
      });
      expect(sessionSocketStub.emitWithAck).not.toHaveBeenCalledWith(
        'update-state',
        expect.anything(),
      );
      const unsupportedDiagnostics = debugSpy.mock.calls.filter(([message]) =>
        message === '[API] Session turn mutation unsupported by server; keeping durable outbox mutation queued'
      );
      expect(unsupportedDiagnostics).toHaveLength(1);
      expect(unsupportedDiagnostics[0]?.[1]).toEqual(expect.objectContaining({
        sessionId: 's1',
        mutationId: expect.any(String),
        action: 'fail',
        turnId: expect.any(String),
        serverOrigin: expect.any(String),
        socket: expect.objectContaining({ transport: 'socket', evidence: 'unsupported_ack' }),
        http: expect.objectContaining({ transport: 'http', evidence: 'unsupported_status', status: 404 }),
      }));
    } finally {
      debugSpy.mockRestore();
      await client?.close();
      if (originalBaseRetryMs === undefined) {
        delete process.env.HAPPIER_SESSION_MUTATION_OUTBOX_BASE_RETRY_MS;
      } else {
        process.env.HAPPIER_SESSION_MUTATION_OUTBOX_BASE_RETRY_MS = originalBaseRetryMs;
      }
      if (originalJitterMs === undefined) {
        delete process.env.HAPPIER_SESSION_MUTATION_OUTBOX_JITTER_MS;
      } else {
        process.env.HAPPIER_SESSION_MUTATION_OUTBOX_JITTER_MS = originalJitterMs;
      }
    }
  });

  it('keeps 400 session turn mutation rejections queued without emitting update-state', async () => {
    const originalBaseRetryMs = process.env.HAPPIER_SESSION_MUTATION_OUTBOX_BASE_RETRY_MS;
    const originalJitterMs = process.env.HAPPIER_SESSION_MUTATION_OUTBOX_JITTER_MS;
    process.env.HAPPIER_SESSION_MUTATION_OUTBOX_BASE_RETRY_MS = '60000';
    process.env.HAPPIER_SESSION_MUTATION_OUTBOX_JITTER_MS = '0';
    vi.mocked(axios.post).mockRejectedValue({ response: { status: 400 } });
    const deliveredEvents: string[] = [];
    const { logger } = await import('@/ui/logger');
    const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => {});
    const socket = createApiSessionSocketStub({
      connected: true,
      emitWithAck: async (event: string) => {
        deliveredEvents.push(event);
        if (event === 'session-turn-mutation') {
          return { result: 'error' };
        }
        if (event === 'update-state') {
          throw new Error('400 session turn mutation rejection must not fall back to update-state');
        }
        return { ok: true };
      },
    });
    let outbox: {
      close(): Promise<void>;
    } | null = null;

    try {
      const { createSessionMutationOutbox } = await import('./mutations/createSessionMutationOutbox');
      const { createSessionTurnMutation } = await import('./mutations/sessionMutationTypes');
      const { saveSessionMutationOutbox } = await import('./mutations/sessionMutationPersistence');
      const fail = createSessionTurnMutation({
        sessionId: 's1',
        action: 'fail',
        turnId: 'session-turn:turn-1',
        provider: 'codex',
        providerTurnId: 'turn-1',
        issue: {
          v: 1,
          scope: 'primary_session',
          status: 'failed',
          code: 'provider_turn_failed',
          source: 'unknown',
          occurredAt: 200,
          provider: 'codex',
          providerTurnId: 'turn-1',
          sanitizedPreview: 'Provider reported turn failure',
        },
        mutationId: 'mutation-fail',
        observedAt: 200,
      });
      await saveSessionMutationOutbox('s1', [
        {
          kind: 'session_turn',
          mutationId: fail.mutationId,
          payload: fail,
          createdAt: 200,
          attempts: 0,
          nextAttemptAt: 0,
        },
      ]);

      outbox = createSessionMutationOutbox({
        token: 'tok',
        sessionId: 's1',
        getSocket: () => socket,
        requestReconnect: () => {},
      });

      await expect.poll(() => deliveredEvents).toEqual(['session-turn-mutation']);
      await expect.poll(() => readPersistedOutboxMutations('s1')).toEqual([
        expect.objectContaining({
          kind: 'session_turn',
          payload: expect.objectContaining({ action: 'fail' }),
          attempts: 1,
        }),
      ]);
      expect(socket.emitWithAck).not.toHaveBeenCalledWith(
        'update-state',
        expect.anything(),
      );
      expect(debugSpy.mock.calls.some(([message]) =>
        message === '[API] Session turn mutation unsupported by server; keeping durable outbox mutation queued'
      )).toBe(false);
    } finally {
      await outbox?.close();
      debugSpy.mockRestore();
      if (originalBaseRetryMs === undefined) {
        delete process.env.HAPPIER_SESSION_MUTATION_OUTBOX_BASE_RETRY_MS;
      } else {
        process.env.HAPPIER_SESSION_MUTATION_OUTBOX_BASE_RETRY_MS = originalBaseRetryMs;
      }
      if (originalJitterMs === undefined) {
        delete process.env.HAPPIER_SESSION_MUTATION_OUTBOX_JITTER_MS;
      } else {
        process.env.HAPPIER_SESSION_MUTATION_OUTBOX_JITTER_MS = originalJitterMs;
      }
    }
  });

  it('uses HTTP fallback for session-end when the socket is disconnected', async () => {
    vi.mocked(axios.post).mockResolvedValue({ status: 200, data: { ok: true } } as never);
    sessionSocketStub = createApiSessionSocketStub({
      connected: false,
      emitWithAck: async () => {
        throw new Error('socket emit should not be reached while disconnected');
      },
    });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    const { ApiSessionClient } = await import('./sessionClient');
    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));

    client.sendSessionDeath();

    await expect.poll(() => vi.mocked(axios.post).mock.calls.length).toBeGreaterThan(0);
    expect(vi.mocked(axios.post).mock.calls[0]?.[0]).toContain('/v1/sessions/s1/end');
    expect(vi.mocked(axios.post).mock.calls[0]?.[1]).toEqual(expect.objectContaining({
      time: expect.any(Number),
    }));
    await client.close();
  });

  it('keeps connected session-end mutations queued until HTTP confirms delivery', async () => {
    vi.mocked(axios.post).mockRejectedValue(new Error('server offline'));
    sessionSocketStub = createApiSessionSocketStub({
      connected: true,
    });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    const { ApiSessionClient } = await import('./sessionClient');
    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));

    client.sendSessionDeath();

    await expect.poll(() => vi.mocked(axios.post).mock.calls.length).toBeGreaterThan(0);
    expect(sessionSocketStub.emit).not.toHaveBeenCalledWith('session-end', expect.anything());
    expect(sessionSocketStub.emitWithAck).not.toHaveBeenCalledWith('session-end', expect.anything());
    await expect.poll(() => readPersistedOutboxMutationCount('s1')).toBe(1);
    await client.close();
  });

  it('keeps connected session-end mutations queued when unsupported HTTP only has unacked legacy delivery', async () => {
    vi.mocked(axios.post).mockRejectedValue({ response: { status: 404 } });
    sessionSocketStub = createApiSessionSocketStub({
      connected: true,
    });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    const { ApiSessionClient } = await import('./sessionClient');
    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));
    await supervisorConnect?.();

    await client.sendSessionDeath();

    await expect.poll(() => vi.mocked(axios.post).mock.calls.length).toBeGreaterThan(0);
    await client.flush();
    expect(sessionSocketStub.emitWithAck).toHaveBeenCalledWith(
      'session-end',
      expect.objectContaining({ sid: 's1', time: expect.any(Number) }),
    );
    expect(sessionSocketStub.emit).not.toHaveBeenCalledWith('session-end', expect.anything());
    await expect.poll(() => readPersistedOutboxMutationCount('s1')).toBe(1);
    await client.close();
  });

  it('flushes newer session-turn mutations without delivering superseded session-end mutations', async () => {
    const postCalls: string[] = [];
    vi.mocked(axios.post).mockImplementation(async (url) => {
      const requestUrl = String(url);
      postCalls.push(requestUrl);
      if (requestUrl.includes('/end')) {
        throw new Error('superseded session-end should not be delivered');
      }
      return { status: 200, data: { ok: true } } as never;
    });

    const socket = createApiSessionSocketStub({
      connected: false,
      emitWithAck: async () => {
        throw new Error('socket emit should not be reached while disconnected');
      },
    });
    const { createSessionMutationOutbox } = await import('./mutations/createSessionMutationOutbox');
    const { saveSessionMutationOutbox } = await import('./mutations/sessionMutationPersistence');
    const { createSessionEndMutation, createSessionTurnMutation } = await import('./mutations/sessionMutationTypes');

    const staleEnd = createSessionEndMutation({
      sessionId: 's1',
      observedAt: 1_000,
    });
    const newerBegin = createSessionTurnMutation({
      sessionId: 's1',
      mutationId: 'begin-new',
      action: 'begin',
      turnId: 'session-turn:new',
      provider: 'codex',
      observedAt: 2_000,
    });
    await saveSessionMutationOutbox('s1', [
      {
        kind: 'session_end',
        mutationId: staleEnd.mutationId,
        payload: staleEnd,
        createdAt: 1_000,
        attempts: 3,
        nextAttemptAt: 0,
      },
      {
        kind: 'session_turn',
        mutationId: newerBegin.mutationId,
        payload: newerBegin,
        createdAt: 2_000,
        attempts: 0,
        nextAttemptAt: 0,
      },
    ]);

    const outbox = createSessionMutationOutbox({
      token: 'tok',
      sessionId: 's1',
      getSocket: () => socket,
      requestReconnect: () => {},
    });

    await expect.poll(() => postCalls.some((url) => url.includes('/turns/mutations'))).toBe(true);
    expect(postCalls.some((url) => url.includes('/end'))).toBe(false);
    await expect.poll(() => readPersistedOutboxMutationCount('s1')).toBe(0);
    await outbox.close();
  });
});
