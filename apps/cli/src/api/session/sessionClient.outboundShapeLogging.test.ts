import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AxiosError, AxiosHeaders } from 'axios';

import { createPlainSessionFixture } from '@/testkit/backends/sessionFixtures';
import { createApiSessionSocketStub, type ApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';

let sessionSocketStub: ApiSessionSocketStub | null = null;
let userSocketStub: ApiSessionSocketStub | null = null;

const { runSessionChangesSyncOnConnectMock } = vi.hoisted(() => ({
  runSessionChangesSyncOnConnectMock: vi.fn(),
}));

vi.mock('./sockets', () => ({
  createUserScopedSocket: () => {
    if (!userSocketStub) throw new Error('Missing user socket stub');
    return userSocketStub as any;
  },
}));

vi.mock('./connection/createSessionSocketTransport', () => ({
  createSessionSocketTransport: () => {
    if (!sessionSocketStub) throw new Error('Missing session socket stub');
    return {
      socket: sessionSocketStub as any,
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
  },
}));

vi.mock('@happier-dev/connection-supervisor', () => ({
  DEFAULT_MANAGED_CONNECTION_POLICY: {},
  createManagedConnectionSupervisor: (params: { createTransport: () => unknown; onConnected?: () => Promise<void> | void }) => ({
    start: async () => {
      params.createTransport();
      await params.onConnected?.();
    },
    stop: async () => {},
  }),
}));

vi.mock('./sessionChangesSyncOnConnect', async (importOriginal) => ({
  ...await importOriginal<typeof import('./sessionChangesSyncOnConnect')>(),
  isV2ChangesSyncEnabled: () => true,
  runSessionChangesSyncOnConnect: runSessionChangesSyncOnConnectMock,
}));

beforeEach(() => {
  vi.stubEnv('HAPPIER_TRANSCRIPT_STORAGE', 'direct');
  runSessionChangesSyncOnConnectMock.mockReset();
  runSessionChangesSyncOnConnectMock.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  sessionSocketStub = null;
  userSocketStub = null;
});

async function waitForDebugLog(
  spy: ReturnType<typeof vi.spyOn>,
  expected: string,
): Promise<string> {
  for (let i = 0; i < 20; i += 1) {
    const calls = JSON.stringify(spy.mock.calls);
    if (calls.includes(expected)) return calls;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return JSON.stringify(spy.mock.calls);
}

describe('ApiSessionClient outbound diagnostics logging', () => {
  it('logs outbound ACP message shapes without leaking message content', async () => {
    vi.resetModules();

    sessionSocketStub = createApiSessionSocketStub({
      connected: false,
      emitWithAck: async (event: string) => {
        if (event === 'message') {
          return { ok: true, id: 'm1', seq: 1, localId: 'l1' };
        }
        return { ok: true };
      },
    });
    userSocketStub = createApiSessionSocketStub({
      connected: true,
      emitWithAck: async () => ({ ok: true }),
    });

    const { ApiSessionClient } = await import('./sessionClient');
    const { logger } = await import('@/ui/logger');
    const debugSpy = vi.spyOn(logger, 'debug');
    debugSpy.mockClear();

    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));

    client.sendAgentMessage('claude' as any, { type: 'message', message: 'SUPER_SECRET_VALUE' } as any);

    const calls = JSON.stringify(debugSpy.mock.calls);
    expect(calls).not.toContain('SUPER_SECRET_VALUE');
    expect(debugSpy.mock.calls.some((c) => String(c[0]).includes('[shape:session-out]'))).toBe(true);
  });

  it('serializes connect sync errors without dumping axios request details', async () => {
    vi.resetModules();

    runSessionChangesSyncOnConnectMock.mockRejectedValueOnce(new AxiosError('connect failed', 'ECONNABORTED', {
      method: 'get',
      url: 'https://api.example.test/v2/changes?token=SECRET#hash',
      headers: new AxiosHeaders({ Authorization: 'Bearer SECRET' }),
      data: { secret: 'SECRET_BODY' },
    }));

    sessionSocketStub = createApiSessionSocketStub({ connected: true });
    userSocketStub = createApiSessionSocketStub({ connected: true });

    const { ApiSessionClient } = await import('./sessionClient');
    const { logger } = await import('@/ui/logger');
    const debugSpy = vi.spyOn(logger, 'debug');
    debugSpy.mockClear();

    new ApiSessionClient('tok', createPlainSessionFixture({ id: 's-log' }));

    const calls = await waitForDebugLog(debugSpy, '[API] Session changes sync on connect failed');
    expect(calls).toContain('[API] Session changes sync on connect failed');
    expect(calls).toContain('https://api.example.test/v2/changes');
    expect(calls).not.toContain('Authorization');
    expect(calls).not.toContain('Bearer SECRET');
    expect(calls).not.toContain('SECRET_BODY');
    expect(calls).not.toContain('"headers"');
    expect(calls).not.toContain('"data"');
  });

  it('serializes socket errors without dumping axios request details', async () => {
    vi.resetModules();

    sessionSocketStub = createApiSessionSocketStub({ connected: true });
    userSocketStub = createApiSessionSocketStub({ connected: true });

    const { ApiSessionClient } = await import('./sessionClient');
    const { logger } = await import('@/ui/logger');
    const debugSpy = vi.spyOn(logger, 'debug');
    debugSpy.mockClear();

    new ApiSessionClient('tok', createPlainSessionFixture({ id: 's-socket-log' }));

    const socketError = new AxiosError('socket failed', 'ECONNRESET', {
      method: 'get',
      url: 'https://api.example.test/socket.io/?token=SECRET',
      headers: new AxiosHeaders({ Authorization: 'Bearer SECRET' }),
      data: { secret: 'SECRET_BODY' },
    });
    sessionSocketStub.trigger('connect_error', socketError);
    sessionSocketStub.trigger('error', socketError);

    const calls = JSON.stringify(debugSpy.mock.calls);
    expect(calls).toContain('[API] Socket connection error');
    expect(calls).toContain('[API] Socket error');
    expect(calls).toContain('https://api.example.test/socket.io/');
    expect(calls).not.toContain('Authorization');
    expect(calls).not.toContain('Bearer SECRET');
    expect(calls).not.toContain('SECRET_BODY');
    expect(calls).not.toContain('"headers"');
    expect(calls).not.toContain('"data"');
  });
});
