import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DirectSessionTranscriptDeltaEphemeral } from '@happier-dev/protocol';

import { bindApiSessionSocketMock, createApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';
import { logger } from '@/ui/logger';
import type { Machine } from './types';

const { configurationMock, mockAxiosGet, mockAxiosIsAxiosError, mockAxiosPost, mockIo } = vi.hoisted(() => ({
  configurationMock: {
    apiServerUrl: 'http://localhost:3005',
    activeServerDir: '',
    socketIoTransports: ['polling', 'websocket'] as string[],
  },
  mockAxiosIsAxiosError: vi.fn((error: unknown) => (
    typeof error === 'object' && error !== null && (error as { isAxiosError?: unknown }).isAxiosError === true
  )),
  mockAxiosGet: vi.fn(),
  mockAxiosPost: vi.fn(),
  mockIo: vi.fn<(url: string, opts: Record<string, unknown>) => any>(() => ({
    on: vi.fn(),
    emit: vi.fn(),
    emitWithAck: vi.fn(),
    io: { on: vi.fn() },
  })),
}));

vi.mock('socket.io-client', () => ({
  io: mockIo,
}));

vi.mock('axios', () => ({
  default: {
    isAxiosError: mockAxiosIsAxiosError,
    get: mockAxiosGet,
    post: mockAxiosPost,
  },
  isAxiosError: mockAxiosIsAxiosError,
}));

vi.mock('@/configuration', () => ({
  configuration: configurationMock,
}));

vi.mock('@/ui/logger', () => ({
  logger: {
    debug: vi.fn(),
    warn: vi.fn(),
    debugLargeJson: vi.fn(),
  },
}));

vi.mock('@/rpc/handlers/registerSessionHandlers', () => ({ registerSessionHandlers: vi.fn() }));
vi.mock('@/rpc/handlers/scm', () => ({ registerScmHandlers: vi.fn() }));
vi.mock('@/rpc/handlers/fileSystem', () => ({ registerFileSystemHandlers: vi.fn() }));
vi.mock('@/rpc/handlers/machineFileBrowser/registerMachineFileBrowserHandlers', () => ({ registerMachineFileBrowserHandlers: vi.fn() }));
vi.mock('./machine/rpcHandlers', () => ({ registerMachineRpcHandlers: vi.fn() }));
vi.mock('./rpc/RpcHandlerManager', () => ({
  RpcHandlerManager: class {
    registerHandler() {}
    onSocketConnect() {}
    onSocketDisconnect() {}
    async handleRequest() {
      return { ok: true };
    }
    async invokeLocal() {
      return { ok: true };
    }
    async waitForIdle() {}
  },
}));
vi.mock('./changes', () => ({ fetchChanges: vi.fn() }));
vi.mock('@/persistence', () => ({ readAccountChangesCursor: vi.fn(), writeAccountChangesCursor: vi.fn() }));
vi.mock('./client/loopbackUrl', () => ({ resolveLoopbackHttpUrl: (value: string) => value }));
vi.mock('@/utils/proxy/socketIoProxy', () => ({ getSocketIoProxyOptions: () => ({}) }));
vi.mock('@/utils/time', () => ({ backoff: async <T>(fn: () => Promise<T>) => await fn() }));

describe('ApiMachineClient transports', () => {
  beforeEach(() => {
    configurationMock.apiServerUrl = 'http://localhost:3005';
    configurationMock.socketIoTransports = ['polling', 'websocket'];
    mockAxiosPost.mockResolvedValue({ status: 200, data: { success: true, applied: true } });
    mockAxiosGet.mockResolvedValue({ status: 200, data: { machine: null } });
    bindApiSessionSocketMock(mockIo, createApiSessionSocketStub());
  });

  afterEach(() => {
    configurationMock.apiServerUrl = 'http://localhost:3005';
    configurationMock.activeServerDir = '';
    configurationMock.socketIoTransports = ['polling', 'websocket'];
    vi.mocked(logger.warn).mockReset();
    vi.mocked(logger.debug).mockReset();
    mockAxiosGet.mockReset();
    mockAxiosPost.mockReset();
  });

  it('uses polling-first transports by default (upgrade to websocket when available)', async () => {
    const mod = await import('./apiMachine');

    const machine: Machine = {
      id: 'test-machine',
      encryptionKey: new Uint8Array(32),
      encryptionVariant: 'legacy',
      metadata: null,
      metadataVersion: 0,
      daemonState: null,
      daemonStateVersion: 0,
    };

    const client = new mod.ApiMachineClient('fake-token', machine);
    client.connect();

    const opts = mockIo.mock.calls[0]?.[1] as any;
    expect(opts.path).toBe('/v1/updates');
    expect(opts.transports).toEqual(['polling', 'websocket']);
    expect(opts.reconnection).toBe(false);
    expect(opts.autoConnect).toBe(false);
  });

  it('serializes machine refresh errors without dumping axios request details', async () => {
    const mod = await import('./apiMachine');

    mockAxiosGet.mockRejectedValueOnce({
      isAxiosError: true,
      name: 'AxiosError',
      message: 'refresh failed',
      code: 'ECONNABORTED',
      response: { status: 503 },
      config: {
        method: 'get',
        url: 'https://api.example.test/v1/machines/m1?token=SECRET',
        headers: { Authorization: 'Bearer SECRET' },
        data: { secret: 'SECRET_BODY' },
      },
    });

    const client = new mod.ApiMachineClient('fake-token', {
      id: 'm1',
      encryptionKey: new Uint8Array(32),
      encryptionVariant: 'legacy',
      metadata: null,
      metadataVersion: 0,
      daemonState: null,
      daemonStateVersion: 0,
    });

    await (client as unknown as { refreshMachineFromServer: () => Promise<void> }).refreshMachineFromServer();

    const calls = JSON.stringify(vi.mocked(logger.debug).mock.calls);
    expect(calls).toContain('[API MACHINE] Failed to refresh machine snapshot');
    expect(calls).toContain('https://api.example.test/v1/machines/m1');
    expect(calls).not.toContain('Authorization');
    expect(calls).not.toContain('Bearer SECRET');
    expect(calls).not.toContain('SECRET_BODY');
    expect(calls).not.toContain('"headers"');
    expect(calls).not.toContain('"data"');
  });

  it('can force websocket-only via config flag', async () => {
    configurationMock.socketIoTransports = ['websocket'];

    const mod = await import('./apiMachine');

    const machine: Machine = {
      id: 'test-machine',
      encryptionKey: new Uint8Array(32),
      encryptionVariant: 'legacy',
      metadata: null,
      metadataVersion: 0,
      daemonState: null,
      daemonStateVersion: 0,
    };

    const client = new mod.ApiMachineClient('fake-token', machine);
    client.connect();

    const opts = mockIo.mock.calls[0]?.[1] as any;
    expect(opts.path).toBe('/v1/updates');
    expect(opts.transports).toEqual(['websocket']);
    expect(opts.reconnection).toBe(false);
    expect(opts.autoConnect).toBe(false);
  });

  it('includes takeover auth when explicitly requested', async () => {
    const mod = await import('./apiMachine');

    const machine: Machine = {
      id: 'test-machine',
      encryptionKey: new Uint8Array(32),
      encryptionVariant: 'legacy',
      metadata: null,
      metadataVersion: 0,
      daemonState: null,
      daemonStateVersion: 0,
    };

    const client = new mod.ApiMachineClient('fake-token', machine);
    client.connect({ takeover: true });

    const opts = mockIo.mock.calls.at(-1)?.[1] as any;
    expect(opts.auth.takeover).toBe(true);
  });

  it('emits and receives machine transfer envelopes over the machine-scoped socket', async () => {
    const machineSocket = createApiSessionSocketStub();
    bindApiSessionSocketMock(mockIo, machineSocket);

    const mod = await import('./apiMachine');
    const { SOCKET_RPC_EVENTS } = await import('@happier-dev/protocol/socketRpc');

    const machine: Machine = {
      id: 'test-machine',
      encryptionKey: new Uint8Array(32),
      encryptionVariant: 'legacy',
      metadata: null,
      metadataVersion: 0,
      daemonState: null,
      daemonStateVersion: 0,
    };

    const client = new mod.ApiMachineClient('fake-token', machine);
    const received: unknown[] = [];
    client.onMachineTransferEnvelope((payload) => {
      received.push(payload);
    });
    client.connect();

    client.sendMachineTransferEnvelope({
      targetMachineId: 'machine-target',
      envelope: {
        transferId: 'transfer_1',
        kind: 'chunk',
        sequence: 1,
        payloadBase64: 'YQ==',
      },
    });

    expect(machineSocket.emit).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.MACHINE_TRANSFER_ENVELOPE, {
      targetMachineId: 'machine-target',
      envelope: {
        transferId: 'transfer_1',
        kind: 'chunk',
        sequence: 1,
        payloadBase64: 'YQ==',
      },
    });

    machineSocket.trigger(SOCKET_RPC_EVENTS.MACHINE_TRANSFER_ENVELOPE, {
      sourceMachineId: 'machine-source',
      targetMachineId: 'test-machine',
      envelope: {
        transferId: 'transfer_1',
        kind: 'ack',
        nextSequence: 2,
      },
    });

    expect(received).toEqual([
      {
        sourceMachineId: 'machine-source',
        targetMachineId: 'test-machine',
        envelope: {
          transferId: 'transfer_1',
          kind: 'ack',
          nextSequence: 2,
        },
      },
    ]);
  });

  it('emits direct-session transcript delta updates over the machine-scoped socket', async () => {
    const machineSocket = createApiSessionSocketStub();
    bindApiSessionSocketMock(mockIo, machineSocket);

    const mod = await import('./apiMachine');

    const machine: Machine = {
      id: 'test-machine',
      encryptionKey: new Uint8Array(32),
      encryptionVariant: 'legacy',
      metadata: null,
      metadataVersion: 0,
      daemonState: null,
      daemonStateVersion: 0,
    };

    const client = new mod.ApiMachineClient('fake-token', machine);
    client.connect();

    expect(client.emitDirectSessionTranscriptUpdate).toEqual(expect.any(Function));

    client.emitDirectSessionTranscriptUpdate({
      type: 'direct-session-transcript-delta',
      sessionId: 'session-1',
      items: [
        {
          id: 'a2',
          createdAtMs: 1_050,
          localId: 'direct-2',
          raw: {
            type: 'assistant',
            uuid: 'a2',
            message: { model: 'm', content: [{ type: 'text', text: 'hello from push' }] },
          },
        },
      ],
      fromCursor: 'cursor-1',
      nextCursor: 'cursor-2',
      truncated: false,
    });

    expect(machineSocket.emit).toHaveBeenCalledWith('direct-session-transcript-delta', expect.objectContaining({
      sessionId: 'session-1',
      truncated: false,
      items: expect.arrayContaining([
        expect.objectContaining({ id: 'a2' }),
      ]),
    }));
  });

  it('confirms session-end over HTTP even when the machine socket is absent', async () => {
    const mod = await import('./apiMachine');

    const machine: Machine = {
      id: 'test-machine',
      encryptionKey: new Uint8Array(32),
      encryptionVariant: 'legacy',
      metadata: null,
      metadataVersion: 0,
      daemonState: null,
      daemonStateVersion: 0,
    };

    const client = new mod.ApiMachineClient('fake-token', machine);
    client.emitSessionEnd({ sid: 'session-1', time: 1234 });

    await vi.waitFor(() => {
      expect(mockAxiosPost).toHaveBeenCalledWith(
        'http://localhost:3005/v1/sessions/session-1/end',
        { time: 1234 },
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer fake-token',
          }),
        }),
      );
    });
  });

  it('keeps startup cleanup session-end queued when HTTP delivery fails', async () => {
    const tempServerDir = await mkdtemp(join(tmpdir(), 'happier-machine-session-end-'));
    configurationMock.activeServerDir = tempServerDir;
    mockAxiosPost.mockRejectedValue(new Error('server offline'));
    const mod = await import('./apiMachine');

    const machine: Machine = {
      id: 'test-machine',
      encryptionKey: new Uint8Array(32),
      encryptionVariant: 'legacy',
      metadata: null,
      metadataVersion: 0,
      daemonState: null,
      daemonStateVersion: 0,
    };

    const client = new mod.ApiMachineClient('fake-token', machine);

    try {
      const durableClient: {
        enqueueSessionEndMutation?: (payload: { sid: string; time: number; exit?: unknown }) => void;
      } = client;

      expect(durableClient.enqueueSessionEndMutation).toBeTypeOf('function');
      durableClient.enqueueSessionEndMutation?.({
        sid: 'session-1',
        time: 1234,
        exit: { observedBy: 'daemon', reason: 'process-missing' },
      });

      await vi.waitFor(async () => {
        const parsed = JSON.parse(
          await readFile(join(tempServerDir, 'session-mutations', 'session-session-1.json'), 'utf8'),
        ) as { mutations?: Array<{ kind?: string; payload?: { sessionId?: string; observedAt?: number } }> };
        expect(parsed.mutations).toEqual([
          expect.objectContaining({
            kind: 'session_end',
            payload: expect.objectContaining({
              sessionId: 'session-1',
              observedAt: 1234,
            }),
          }),
        ]);
      });
    } finally {
      await client.shutdown();
      await rm(tempServerDir, { recursive: true, force: true });
    }
  });

  it('redacts authorization headers when session-end HTTP confirmation fails', async () => {
    const mod = await import('./apiMachine');

    const machine: Machine = {
      id: 'test-machine',
      encryptionKey: new Uint8Array(32),
      encryptionVariant: 'legacy',
      metadata: null,
      metadataVersion: 0,
      daemonState: null,
      daemonStateVersion: 0,
    };

    mockAxiosPost.mockRejectedValueOnce({
      isAxiosError: true,
      name: 'AxiosError',
      message: 'socket hang up',
      code: 'ECONNRESET',
      config: {
        method: 'post',
        url: 'http://localhost:3005/v1/sessions/session-1/end?token=secret',
        headers: { Authorization: 'Bearer fake-token' },
        data: { time: 1234 },
      },
    });

    const client = new mod.ApiMachineClient('fake-token', machine);
    client.emitSessionEnd({ sid: 'session-1', time: 1234 });

    await vi.waitFor(() => {
      expect(logger.warn).toHaveBeenCalled();
    });

    const logged = JSON.stringify(vi.mocked(logger.warn).mock.calls);
    expect(logged).not.toContain('fake-token');
    expect(logged).not.toContain('Authorization');
    expect(logged).not.toContain('token=secret');
  });

  it('does not warn when connected legacy session-end delivery reaches a server without the durable route', async () => {
    const machineSocket = createApiSessionSocketStub({ connected: true });
    bindApiSessionSocketMock(mockIo, machineSocket);
    mockAxiosPost.mockResolvedValueOnce({ status: 404, data: { error: 'not found' } });

    const mod = await import('./apiMachine');

    const machine: Machine = {
      id: 'test-machine',
      encryptionKey: new Uint8Array(32),
      encryptionVariant: 'legacy',
      metadata: null,
      metadataVersion: 0,
      daemonState: null,
      daemonStateVersion: 0,
    };

    const client = new mod.ApiMachineClient('fake-token', machine);
    client.connect();
    client.emitSessionEnd({ sid: 'session-1', time: 1234 });

    await vi.waitFor(() => {
      expect(mockAxiosPost).toHaveBeenCalledWith(
        'http://localhost:3005/v1/sessions/session-1/end',
        { time: 1234 },
        expect.any(Object),
      );
    });
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });

    expect(machineSocket.emit).toHaveBeenCalledWith('session-end', { sid: 'session-1', time: 1234 });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('threads direct-session transcript delta emission into machine RPC dependencies', async () => {
    const machineSocket = createApiSessionSocketStub();
    bindApiSessionSocketMock(mockIo, machineSocket);

    const mod = await import('./apiMachine');
    const rpcHandlers = await import('./machine/rpcHandlers');
    const registerMachineRpcHandlers = vi.mocked(rpcHandlers.registerMachineRpcHandlers);

    const machine: Machine = {
      id: 'test-machine',
      encryptionKey: new Uint8Array(32),
      encryptionVariant: 'legacy',
      metadata: null,
      metadataVersion: 0,
      daemonState: null,
      daemonStateVersion: 0,
    };

    const client = new mod.ApiMachineClient('fake-token', machine);
    client.connect();
    client.setRPCHandlers({
      spawnSession: async () => ({ type: 'success', sessionId: 'session-1' }),
      stopSession: async () => true,
      requestShutdown: () => {},
    });

    const lastCall = registerMachineRpcHandlers.mock.calls.at(-1)?.[0];
    const deps = lastCall?.deps as Partial<{
      emitDirectSessionTranscriptUpdate: (payload: DirectSessionTranscriptDeltaEphemeral) => void;
    }> | undefined;

    expect(deps?.emitDirectSessionTranscriptUpdate).toEqual(expect.any(Function));

    deps?.emitDirectSessionTranscriptUpdate?.({
      type: 'direct-session-transcript-delta',
      sessionId: 'session-1',
      items: [{ id: 'a2', createdAtMs: 1_050, raw: { type: 'assistant' } }],
      fromCursor: 'cursor-1',
      nextCursor: 'cursor-2',
      truncated: false,
    });

    expect(machineSocket.emit).toHaveBeenCalledWith('direct-session-transcript-delta', expect.objectContaining({
      sessionId: 'session-1',
      nextCursor: 'cursor-2',
    }));
  });
});
