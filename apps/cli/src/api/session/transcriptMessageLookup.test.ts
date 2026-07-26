import axios from 'axios';
import type { AxiosResponse } from 'axios';
import fastify, { type FastifyInstance } from 'fastify';
import type { ManagedConnectionState, ManagedConnectionSupervisor } from '@happier-dev/connection-supervisor';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { reloadConfiguration } from '@/configuration';
import { HttpStatusError } from '@/api/client/httpStatusError';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { findTranscriptEncryptedMessageByLocalIdV2 } from './transcriptMessageLookup';

function createLookupMessage() {
  return {
    id: 'm1',
    seq: 1,
    localId: 'l1',
    sidechainId: 'sc-1',
    createdAt: 111,
    updatedAt: 222,
    content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'hi' } } },
  } as const;
}

function createAxiosResponse(data: unknown): AxiosResponse<unknown> {
  // AxiosResponse transport details are irrelevant to these boundary fixtures.
  return { data, status: 200, statusText: 'OK', headers: {}, config: {}, request: {} } as AxiosResponse<unknown>;
}

function createAxiosLikeError(params: Readonly<{
  status?: number;
  data?: unknown;
  code?: string;
  message?: string;
}>) {
  return Object.assign(new Error(params.message ?? 'request failed'), {
    isAxiosError: true,
    code: params.code,
    response: typeof params.status === 'number' ? { status: params.status, data: params.data } : undefined,
  });
}

async function withAxiosGetMock<T>(
  result: { resolve: AxiosResponse<unknown> } | { reject: unknown },
  run: () => Promise<T>,
): Promise<T> {
  const getSpy = vi.spyOn(axios, 'get');
  if ('resolve' in result) {
    getSpy.mockResolvedValueOnce(result.resolve);
  } else {
    getSpy.mockRejectedValueOnce(result.reject);
  }
  try {
    return await run();
  } finally {
    getSpy.mockRestore();
  }
}

function configureServerUrl() {
  process.env.HAPPIER_SERVER_URL = 'http://adapter.test';
  process.env.HAPPIER_TRANSCRIPT_RECOVERY_DELAY_MS = '0';
  reloadConfiguration();
}

function lookupParams(localId = 'l1') {
  return { token: 'token', serverUrl: 'http://adapter.test', sessionId: 'sid', localId };
}

function wrapperParams(onError: (error: unknown) => void) {
  return { token: 'token', sessionId: 'sid', localId: 'l1', onError };
}

function createSupervisorState(overrides: Partial<ManagedConnectionState> = {}): ManagedConnectionState {
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

function createSupervisor(state: ManagedConnectionState = createSupervisorState()): ManagedConnectionSupervisor {
  return {
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    getState: vi.fn(() => state),
    reportProbeResult: vi.fn(),
  };
}

describe('findTranscriptEncryptedMessageByLocalIdV2', () => {
  it('returns found for a valid 200 message response', async () => {
    await withAxiosGetMock(
      { resolve: createAxiosResponse({ message: createLookupMessage() }) },
      async () => expect(findTranscriptEncryptedMessageByLocalIdV2(lookupParams())).resolves.toMatchObject({
        type: 'found',
        message: { id: 'm1', seq: 1, localId: 'l1', sidechainId: 'sc-1', createdAt: 111, updatedAt: 222, content: { t: 'plain' } },
      }),
    );
  });

  it.each([
    {
      name: 'not_found for a real message-not-found response',
      error: createAxiosLikeError({ status: 404, data: { error: 'Message not found' } }),
      expected: { type: 'not_found' },
    },
    {
      name: 'unhealthy timeout for request timeouts',
      error: createAxiosLikeError({ code: 'ECONNABORTED', message: 'timeout of 50ms exceeded' }),
      expected: { type: 'unhealthy', reason: 'timeout' },
    },
    {
      name: 'unhealthy network for connection failures',
      error: createAxiosLikeError({ code: 'ECONNREFUSED', message: 'connect ECONNREFUSED 127.0.0.1:1' }),
      expected: { type: 'unhealthy', reason: 'network' },
    },
    {
      name: 'unhealthy server_5xx for server errors',
      error: createAxiosLikeError({ status: 503, data: { error: 'unavailable' } }),
      expected: { type: 'unhealthy', reason: 'server_5xx' },
    },
    {
      name: 'auth_failed for authentication errors',
      error: createAxiosLikeError({ status: 401, data: { error: 'unauthorized' } }),
      expected: { type: 'auth_failed', statusCode: 401 },
    },
  ])('returns $name', async ({ error, expected }) => {
    await withAxiosGetMock(
      { reject: error },
      async () => expect(findTranscriptEncryptedMessageByLocalIdV2(lookupParams())).resolves.toMatchObject({
        ...expected,
        ...(expected.type !== 'not_found' ? { error } : null),
      }),
    );
  });

  it('returns protocol_error for malformed 200 responses', async () => {
    await withAxiosGetMock(
      {
        resolve: createAxiosResponse({
          message: { id: 'm1', seq: 1, localId: 'l1', content: { t: 'plain', v: {} } },
        }),
      },
      async () => expect(findTranscriptEncryptedMessageByLocalIdV2(lookupParams())).resolves.toMatchObject({ type: 'protocol_error' }),
    );
  });

  it.each([
    ['fractional createdAt', { ...createLookupMessage(), createdAt: 111.5 }],
    ['fractional updatedAt', { ...createLookupMessage(), updatedAt: 222.5 }],
    ['unsafe createdAt', { ...createLookupMessage(), createdAt: Number.MAX_SAFE_INTEGER + 1 }],
    ['unsafe updatedAt', { ...createLookupMessage(), updatedAt: Number.MAX_SAFE_INTEGER + 1 }],
  ])('returns protocol_error for a non-canonical %s timestamp', async (_name, message) => {
    await withAxiosGetMock(
      { resolve: createAxiosResponse({ message }) },
      async () => expect(findTranscriptEncryptedMessageByLocalIdV2(lookupParams())).resolves.toMatchObject({ type: 'protocol_error' }),
    );
  });
});

describe('findTranscriptEncryptedMessageByLocalId', () => {
  afterEach(() => {
    vi.resetModules();
  });

  it.each([
    {
      name: 'unhealthy',
      mock: { reject: createAxiosLikeError({ status: 503, data: { error: 'unavailable' } }) },
    },
    {
      name: 'protocol',
      mock: {
        resolve: createAxiosResponse({
          message: { id: 'm1', seq: 1, localId: 'l1', content: { t: 'plain', v: {} } },
        }),
      },
    },
  ])('throws $name errors after reporting them to onError', async ({ name, mock }) => {
    configureServerUrl();

    const { findTranscriptEncryptedMessageByLocalId } = await import('./transcriptMessageLookup');
    const onError = vi.fn();

    await withAxiosGetMock(mock, async () => {
      const expectation = expect(findTranscriptEncryptedMessageByLocalId(wrapperParams(onError))).rejects;
      if (name === 'unhealthy' && 'reject' in mock) {
        await expectation.toBe(mock.reject);
      } else {
        await expectation.toBeInstanceOf(Error);
      }
      expect(onError).toHaveBeenCalledOnce();
    });
  });

  it('keeps old route-missing 404 responses compatible as reported null lookups', async () => {
    configureServerUrl();

    const { findTranscriptEncryptedMessageByLocalId } = await import('./transcriptMessageLookup');
    const error = createAxiosLikeError({ status: 404, data: { error: 'Not found' } });
    const onError = vi.fn();

    await withAxiosGetMock({ reject: error }, async () => {
      await expect(findTranscriptEncryptedMessageByLocalId(wrapperParams(onError))).resolves.toBeNull();
      expect(onError).toHaveBeenCalledWith(error);
    });
  });
});

describe('waitForTranscriptEncryptedMessageByLocalId', () => {
  let app: FastifyInstance | null = null;
  let restoreAdapter: (() => void) | null = null;

  async function importWaitLookup() {
    const lookup = await import('./transcriptMessageLookup');
    return lookup.waitForTranscriptEncryptedMessageByLocalId;
  }

  function waitLookupParams(overrides: Record<string, unknown> = {}) {
    return {
      token: 'token',
      sessionId: 'sid',
      localId: 'l1',
      maxWaitMs: 200,
      pollIntervalMs: 10,
      errorBackoffBaseMs: 10,
      errorBackoffMaxMs: 10,
      onError: () => {},
      ...overrides,
    };
  }

  async function installAdapterForCurrentApp() {
    if (!app) throw new Error('test app missing');
    await app.ready();
    restoreAdapter = installAxiosFastifyAdapter({ app, origin: 'http://adapter.test' });
  }

  afterEach(async () => {
    vi.useRealTimers();
    restoreAdapter?.();
    restoreAdapter = null;
    vi.resetModules();
    if (app) {
      await app.close().catch(() => {});
      app = null;
    }
  });

  it('defers supervisor-backed waits while offline without polling', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));

    configureServerUrl();
    const waitForTranscriptEncryptedMessageByLocalId = await importWaitLookup();
    const getSpy = vi.spyOn(axios, 'get').mockRejectedValue({
      isAxiosError: true,
      response: { status: 404, data: { error: 'Message not found' } },
    });

    try {
      const promise = waitForTranscriptEncryptedMessageByLocalId(waitLookupParams({
        supervisor: createSupervisor(createSupervisorState({ phase: 'offline', reason: 'server_unreachable' })),
        maxWaitMs: 50,
      }));

      await vi.advanceTimersByTimeAsync(100);
      await expect(promise).resolves.toBeNull();
      expect(getSpy).not.toHaveBeenCalled();
    } finally {
      getSpy.mockRestore();
    }
  });

  it('defers supervisor-backed waits while auth_failed without polling', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));

    configureServerUrl();
    const waitForTranscriptEncryptedMessageByLocalId = await importWaitLookup();
    const getSpy = vi.spyOn(axios, 'get').mockRejectedValue({
      isAxiosError: true,
      response: { status: 401, data: { error: 'unauthorized' } },
    });

    try {
      const promise = waitForTranscriptEncryptedMessageByLocalId(waitLookupParams({
        supervisor: createSupervisor(createSupervisorState({ phase: 'auth_failed', reason: 'auth_invalid' })),
        maxWaitMs: 50,
      }));

      await vi.advanceTimersByTimeAsync(100);
      await expect(promise).resolves.toBeNull();
      expect(getSpy).not.toHaveBeenCalled();
    } finally {
      getSpy.mockRestore();
    }
  });

  it('returns found messages through the supervisor-backed coordinator path', async () => {
    configureServerUrl();
    const waitForTranscriptEncryptedMessageByLocalId = await importWaitLookup();

    app = fastify({ logger: false });
    app.get('/v2/sessions/:sid/messages/by-local-id/:localId', async (_req, reply) => {
      return reply.code(200).send({ message: createLookupMessage() });
    });
    await installAdapterForCurrentApp();

    const result = await waitForTranscriptEncryptedMessageByLocalId(waitLookupParams({
      supervisor: createSupervisor(),
    }));

    expect(result).toMatchObject({ id: 'm1', seq: 1, localId: 'l1' });
  });

  it('uses direct bounded polling when no supervisor is provided', async () => {
    configureServerUrl();
    const waitForTranscriptEncryptedMessageByLocalId = await importWaitLookup();
    const getSpy = vi.spyOn(axios, 'get').mockRejectedValue({
      isAxiosError: true,
      response: { status: 404, data: { error: 'Message not found' } },
    });

    try {
      await expect(
        waitForTranscriptEncryptedMessageByLocalId(waitLookupParams({ maxWaitMs: 1 })),
      ).resolves.toBeNull();
      expect(getSpy).toHaveBeenCalled();
    } finally {
      getSpy.mockRestore();
    }
  });

  it('backs off between consecutive request errors to avoid tight polling loops', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));

    configureServerUrl();
    const waitForTranscriptEncryptedMessageByLocalId = await importWaitLookup();

    let requestCount = 0;
    app = fastify({ logger: false });
    app.get('/v2/sessions/:sid/messages/by-local-id/:localId', async (_req, reply) => {
      requestCount += 1;
      return reply.code(503).send({ error: 'nope' });
    });
    app.get('/v1/sessions/:sid/messages', async (_req, reply) => {
      return reply.code(500).send({ error: 'should not use v1 transcript scan when v2 is available' });
    });
    await installAdapterForCurrentApp();

    const p = waitForTranscriptEncryptedMessageByLocalId(waitLookupParams({
      localId: 'lid',
      maxWaitMs: 1000,
      errorBackoffBaseMs: 100,
      errorBackoffMaxMs: 400,
    }));

    await vi.advanceTimersByTimeAsync(2000);
    const result = await p;

    expect(result).toBeNull();
    expect(requestCount).toBe(4);

    // sanity: the adapter should have been exercised via axios
    expect(typeof axios.get).toBe('function');
  });

  it('caps per-request timeout to the remaining maxWaitMs', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));

    configureServerUrl();
    const waitForTranscriptEncryptedMessageByLocalId = await importWaitLookup();

    const observedTimeouts: number[] = [];
    const getSpy = vi.spyOn(axios, 'get').mockImplementation((async (_url: string, config?: any) => {
      observedTimeouts.push(config?.timeout);
      await new Promise((_resolve, reject) => setTimeout(() => reject(new Error('boom')), config?.timeout ?? 0));
      throw new Error('unreachable');
    }) as any);

    const p = waitForTranscriptEncryptedMessageByLocalId(waitLookupParams({
      localId: 'lid',
      maxWaitMs: 500,
      requestTimeoutMs: 10_000,
      pollIntervalMs: 1,
      errorBackoffBaseMs: 1,
      errorBackoffMaxMs: 1,
    }));

    try {
      await vi.advanceTimersByTimeAsync(20_000);
      const result = await p;

      expect(result).toBeNull();
      expect(observedTimeouts[0]).toBe(500);
    } finally {
      getSpy.mockRestore();
    }
  });

  it('does not fall back to v1 transcript scanning when the v2 localId route is missing', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));

    configureServerUrl();
    const waitForTranscriptEncryptedMessageByLocalId = await importWaitLookup();

    const calls: string[] = [];
    app = fastify({ logger: false });
    app.get('/v2/sessions/:sid/messages/by-local-id/:localId', async (req: any, reply) => {
      calls.push(`v2:${req.params.sid}:${req.params.localId}`);
      // Simulate an older server that does not implement this route.
      return reply.code(404).send({ error: 'Not found', path: `/v2/sessions/${req.params.sid}/messages/by-local-id/${req.params.localId}` });
    });
    app.get('/v1/sessions/:sid/messages', async (req: any, reply) => {
      calls.push(`v1:${req.params.sid}`);
      return reply.code(500).send({ error: 'v1 should not be used for localId lookup' });
    });
    await installAdapterForCurrentApp();

    const onUnsupported = vi.fn();
    const p = waitForTranscriptEncryptedMessageByLocalId(waitLookupParams({
      localId: 'lid',
      maxWaitMs: 100,
      onUnsupported,
    }));

    await vi.advanceTimersByTimeAsync(200);
    const result = await p;

    expect(result).toBeNull();
    expect(onUnsupported).toHaveBeenCalledOnce();
    expect(calls.some((v) => v.startsWith('v1:'))).toBe(false);
    expect(calls.filter((v) => v.startsWith('v2:')).length).toBeGreaterThan(0);
  });

  it('treats legacy route-missing responses as supervisor-backed misses and reports unsupported lookup capability', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));

    configureServerUrl();
    const waitForTranscriptEncryptedMessageByLocalId = await importWaitLookup();

    app = fastify({ logger: false });
    app.get('/v2/sessions/:sid/messages/by-local-id/:localId', async (req: any, reply) => {
      return reply.code(404).send({ error: 'Not found', path: `/v2/sessions/${req.params.sid}/messages/by-local-id/${req.params.localId}` });
    });
    await installAdapterForCurrentApp();

    const onError = vi.fn();
    const onUnsupported = vi.fn();
    const supervisor = createSupervisor();
    const p = waitForTranscriptEncryptedMessageByLocalId(waitLookupParams({
      localId: 'lid',
      supervisor,
      maxWaitMs: 25,
      pollIntervalMs: 10,
      errorBackoffBaseMs: 10,
      onError,
      onUnsupported,
    }));

    await vi.advanceTimersByTimeAsync(50);
    const result = await p;

    expect(result).toBeNull();
    expect(onError).not.toHaveBeenCalled();
    expect(onUnsupported).toHaveBeenCalledOnce();
    expect(supervisor.reportProbeResult).not.toHaveBeenCalled();
  });

  it('does not hide session-not-found 404s as legacy route-missing misses', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));

    configureServerUrl();
    const waitForTranscriptEncryptedMessageByLocalId = await importWaitLookup();

    app = fastify({ logger: false });
    app.get('/v2/sessions/:sid/messages/by-local-id/:localId', async (_req, reply) => {
      return reply.code(404).send({ error: 'Session not found' });
    });
    await installAdapterForCurrentApp();

    const onError = vi.fn();
    const supervisor = createSupervisor();
    const p = waitForTranscriptEncryptedMessageByLocalId(waitLookupParams({
      localId: 'lid',
      supervisor,
      maxWaitMs: 25,
      pollIntervalMs: 10,
      errorBackoffBaseMs: 10,
      onError,
    }));

    await vi.advanceTimersByTimeAsync(50);
    const result = await p;

    expect(result).toBeNull();
    expect(onError).toHaveBeenCalledOnce();
    expect(supervisor.reportProbeResult).not.toHaveBeenCalled();
  });

  it('returns parsed message details (sidechainId + timestamps) when the v2 localId route succeeds', async () => {
    configureServerUrl();
    const waitForTranscriptEncryptedMessageByLocalId = await importWaitLookup();

    app = fastify({ logger: false });
    app.get('/v2/sessions/:sid/messages/by-local-id/:localId', async (_req, reply) => {
      return reply.code(200).send({
        message: {
          ...createLookupMessage(),
          localId: ' l1 ',
          sidechainId: ' sc-1 ',
        },
      });
    });
    await installAdapterForCurrentApp();

    const result = await waitForTranscriptEncryptedMessageByLocalId(waitLookupParams());

    expect(result).toMatchObject({ id: 'm1', seq: 1, localId: ' l1 ', sidechainId: ' sc-1 ', createdAt: 111, updatedAt: 222, content: { t: 'plain' } });
  });

  it('returns null when the v2 localId route omits timestamps instead of inventing local clock values', async () => {
    configureServerUrl();
    const waitForTranscriptEncryptedMessageByLocalId = await importWaitLookup();

    app = fastify({ logger: false });
    app.get('/v2/sessions/:sid/messages/by-local-id/:localId', async (_req, reply) => {
      return reply.code(200).send({
        message: {
          id: 'm1',
          seq: 1,
          localId: 'l1',
          content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'hi' } } },
        },
      });
    });
    await installAdapterForCurrentApp();

    const result = await waitForTranscriptEncryptedMessageByLocalId(waitLookupParams());

    expect(result).toBeNull();
  });

  it('rethrows terminal auth failures instead of polling them as missing messages', async () => {
    configureServerUrl();
    const waitForTranscriptEncryptedMessageByLocalId = await importWaitLookup();

    const getSpy = vi.spyOn(axios, 'get').mockRejectedValueOnce(new HttpStatusError(401, 'Authentication failed'));

    try {
      await expect(
        waitForTranscriptEncryptedMessageByLocalId(waitLookupParams()),
      ).rejects.toMatchObject({
        name: 'HttpStatusError',
        response: { status: 401 },
      });
      expect(getSpy).toHaveBeenCalledTimes(1);
    } finally {
      getSpy.mockRestore();
    }
  });

  it('stops transcript polling when stale auth appears after an earlier not-found response', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));

    configureServerUrl();
    const waitForTranscriptEncryptedMessageByLocalId = await importWaitLookup();

    const getSpy = vi
      .spyOn(axios, 'get')
      .mockRejectedValueOnce({
        response: {
          status: 404,
          data: { error: 'Message not found' },
        },
      } as any)
      .mockRejectedValueOnce(new HttpStatusError(403, 'Authentication failed'));

    try {
      const promise = waitForTranscriptEncryptedMessageByLocalId(waitLookupParams());
      const rejection = expect(promise).rejects.toMatchObject({
        name: 'HttpStatusError',
        response: { status: 403 },
      });

      await vi.advanceTimersByTimeAsync(50);

      await rejection;
      expect(getSpy).toHaveBeenCalledTimes(2);
    } finally {
      getSpy.mockRestore();
    }
  });
});
