import { describe, expect, it, vi } from 'vitest';

import { createPlainSessionFixture } from '@/testkit/backends/sessionFixtures';
import {
  type ApiSessionSocketStub,
  createApiSessionSocketStub,
} from '@/testkit/backends/apiSessionSocketHarness';

let sessionSocketStub: ApiSessionSocketStub | null = null;
let userSocketStub: ApiSessionSocketStub | null = null;

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

describe('ApiSessionClient runtime activity projection transport', () => {
  it('sends runtime activity through update-runtime-activity without keepalive or foreground state transports', async () => {
    vi.resetModules();
    sessionSocketStub = createApiSessionSocketStub({
      connected: true,
      emitWithAckResult: {
        result: 'success',
        didWrite: true,
        runtimeActivityActiveCount: 1,
        runtimeActivityObservedAt: 1_000,
        runtimeActivityExpiresAt: 2_000,
        runtimeActivitySourceClass: 'provider_detached_task',
      },
    });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    const { ApiSessionClient } = await import('./sessionClient');
    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's-runtime' }));

    await client.updateRuntimeActivityProjection({
      runtimeActivityActiveCount: 1,
      runtimeActivityObservedAt: 1_000,
      runtimeActivityExpiresAt: 2_000,
      runtimeActivitySourceClass: 'provider_detached_task',
    });

    expect(sessionSocketStub.emitWithAck).toHaveBeenCalledTimes(1);
    expect(sessionSocketStub.emitWithAck).toHaveBeenCalledWith('update-runtime-activity', {
      sid: 's-runtime',
      runtimeActivityActiveCount: 1,
      runtimeActivityObservedAt: 1_000,
      runtimeActivityExpiresAt: 2_000,
      runtimeActivitySourceClass: 'provider_detached_task',
    });
    expect(sessionSocketStub.emit).not.toHaveBeenCalledWith(
      'session-alive',
      expect.objectContaining({ thinking: true }),
    );
    expect(sessionSocketStub.emitWithAck.mock.calls.map((call) => call[0])).not.toContain('update-state');
    expect(sessionSocketStub.emitWithAck.mock.calls.map((call) => call[0])).not.toContain('update-metadata');

    await client.close();
  });
});
