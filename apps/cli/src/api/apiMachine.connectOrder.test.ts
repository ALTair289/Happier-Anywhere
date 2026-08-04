import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  bindApiSessionSocketSequenceMock,
  createApiSessionSocketStub,
} from '@/testkit/backends/apiSessionSocketHarness';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { ApiMachineClient } from './apiMachine';
import type { RpcHandlerManager } from './rpc/RpcHandlerManager';

const callOrder = vi.hoisted(() => [] as string[]);

const ioMock = vi.hoisted(() => vi.fn());
const connectionHarness = vi.hoisted(() => {
  let config: {
    createTransport: () => {
      connect: () => Promise<void>;
    };
    onConnected: () => Promise<void>;
  } | null = null;
  const reportProbeResult = vi.fn();

  const connectNextTransport = async () => {
    if (!config) throw new Error('connection supervisor was not created');
    const transport = config.createTransport();
    await transport.connect();
    await config.onConnected();
  };

  return {
    reset() {
      config = null;
      reportProbeResult.mockReset();
    },
    reportProbeResult,
    connectNextTransport,
    createManagedConnectionSupervisor(nextConfig: typeof config) {
      config = nextConfig;
      return {
        start: vi.fn(async () => {
          await connectNextTransport();
        }),
        stop: vi.fn(async () => {}),
        reportProbeResult,
        getState: vi.fn(() => ({
          phase: 'online',
          reason: null,
          attempt: 0,
          nextRetryAt: null,
          lastConnectedAt: Date.now(),
          lastDisconnectedAt: null,
          lastErrorMessage: null,
        })),
      };
    },
  };
});

vi.mock('socket.io-client', () => ({
  io: ioMock,
}));

vi.mock('@happier-dev/connection-supervisor', () => ({
  DEFAULT_MANAGED_CONNECTION_POLICY: {},
  createManagedConnectionSupervisor: connectionHarness.createManagedConnectionSupervisor,
}));

vi.mock('@/configuration', () => ({
  configuration: {
    serverUrl: 'https://example.test',
    apiServerUrl: 'https://example.test',
    socketForceWebsocketOnly: false,
    socketIoTransports: ['polling', 'websocket'],
  },
}));

vi.mock('@/utils/proxy/socketIoProxy', () => ({
  getSocketIoProxyOptions: () => ({}),
}));

vi.mock('@/rpc/handlers/registerSessionHandlers', () => ({
  registerSessionHandlers: () => ({ dispose: async () => {} }),
}));

vi.mock('@/rpc/handlers/scm', () => ({
  registerScmHandlers: () => undefined,
}));

vi.mock('@/rpc/handlers/fileSystem', () => ({
  registerFileSystemHandlers: () => ({ dispose: async () => {} }),
}));

vi.mock('@/rpc/handlers/workspaceAnchors/registerWorkspaceAnchorHandlers', () => ({
  registerWorkspaceAnchorHandlers: () => undefined,
}));

vi.mock('@/rpc/handlers/workspaceFavicon/registerWorkspaceFaviconHandlers', () => ({
  registerWorkspaceFaviconHandlers: () => undefined,
}));

vi.mock('@/rpc/handlers/machineFileBrowser/registerMachineFileBrowserHandlers', () => ({
  registerMachineFileBrowserHandlers: () => undefined,
}));

vi.mock('@/ui/logger', () => ({
  logger: {
    debug: () => undefined,
    warn: () => undefined,
    debugLargeJson: () => undefined,
  },
}));

describe('ApiMachineClient connect ordering', () => {
  afterEach(() => {
    callOrder.length = 0;
    connectionHarness.reset();
    ioMock.mockReset();
  });

  it('installs the RPC listener before connecting and replays client handlers before state on every reconnect', async () => {
    const firstSocket = createApiSessionSocketStub({
      id: 'machine-socket-1',
      onConnect: (socket) => {
        callOrder.push(
          `${socket.getHandlers(SOCKET_RPC_EVENTS.REQUEST).length === 1 ? 'attach' : 'attach-missing'}:machine-socket-1`,
        );
      },
      emit: (event) => {
        if (event === SOCKET_RPC_EVENTS.REGISTER) {
          callOrder.push('register:machine-socket-1');
        }
      },
    });
    const secondSocket = createApiSessionSocketStub({
      id: 'machine-socket-2',
      onConnect: (socket) => {
        callOrder.push(
          `${socket.getHandlers(SOCKET_RPC_EVENTS.REQUEST).length === 1 ? 'attach' : 'attach-missing'}:machine-socket-2`,
        );
      },
      emit: (event) => {
        if (event === SOCKET_RPC_EVENTS.REGISTER) {
          callOrder.push('register:machine-socket-2');
        }
      },
    });
    bindApiSessionSocketSequenceMock(ioMock, [firstSocket, secondSocket]);

    const client = new ApiMachineClient('token', {
      id: 'machine-1',
      encryptionKey: new Uint8Array(32).fill(1),
      encryptionVariant: 'legacy',
      metadata: null,
      metadataVersion: 0,
      daemonState: null,
      daemonStateVersion: 0,
    });

    Object.defineProperty(client, 'startKeepAlive', { value: () => undefined });
    Object.defineProperty(client, 'syncChangesOnConnect', { value: async () => undefined });
    const rpcHandlerManager = Reflect.get(client, 'rpcHandlerManager') as RpcHandlerManager;
    rpcHandlerManager.registerHandler('neutral.reconnect', async () => ({ ok: true }));

    vi.spyOn(client, 'updateDaemonState').mockImplementation(async () => {
      const socket = Reflect.get(client, 'socket') as { id?: string } | null;
      callOrder.push(`state:${socket?.id ?? 'none'}`);
    });

    client.connect();
    await vi.waitFor(() => expect(callOrder).toContain('state:machine-socket-1'));
    await connectionHarness.connectNextTransport();

    expect(callOrder).toEqual([
      'attach:machine-socket-1',
      'register:machine-socket-1',
      'state:machine-socket-1',
      'attach:machine-socket-2',
      'register:machine-socket-2',
      'state:machine-socket-2',
    ]);
    expect(firstSocket.emit).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.REGISTER, {
      method: 'machine-1:neutral.reconnect',
    });
    expect(secondSocket.emit).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.REGISTER, {
      method: 'machine-1:neutral.reconnect',
    });
  });

  it('fails closed when the server rejects a provider-starting RPC registration as upgrade-required', async () => {
    const socket = createApiSessionSocketStub({ id: 'machine-socket-1' });
    bindApiSessionSocketSequenceMock(ioMock, [socket]);
    const client = new ApiMachineClient('token', {
      id: 'machine-1',
      encryptionKey: new Uint8Array(32).fill(1),
      encryptionVariant: 'legacy',
      metadata: null,
      metadataVersion: 0,
      daemonState: null,
      daemonStateVersion: 0,
    });
    Object.defineProperty(client, 'startKeepAlive', { value: () => undefined });
    Object.defineProperty(client, 'syncChangesOnConnect', { value: async () => undefined });

    client.connect();
    await vi.waitFor(() => expect(socket.getHandlers(SOCKET_RPC_EVENTS.ERROR)).toHaveLength(1));
    socket.trigger(SOCKET_RPC_EVENTS.ERROR, {
      type: 'register',
      error: 'client-upgrade-required',
      requirement: {
        v: 1,
        clientKind: 'daemon',
        minimumAppVersion: '0.3.0',
        updateUrl: null,
      },
    });

    expect(connectionHarness.reportProbeResult).toHaveBeenCalledWith({
      status: 'auth_failed',
      statusCode: 426,
      errorMessage: 'This Happier daemon must be upgraded before it can sync sessions.',
    });
  });
});
