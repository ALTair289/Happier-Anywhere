import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { RestartSessionRunnerResultV1 } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { registerMachineRpcHandlers } from './rpcHandlers';

const { requestDaemonSessionRunnerRestartMock } = vi.hoisted(() => ({
  requestDaemonSessionRunnerRestartMock: vi.fn(async (_request: unknown): Promise<RestartSessionRunnerResultV1> => ({
    ok: true,
    status: 'restarted',
    sessionId: 'sess_1',
  })),
}));

vi.mock('@/daemon/controlClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/daemon/controlClient')>();
  return {
    ...actual,
    requestDaemonSessionRunnerRestart: requestDaemonSessionRunnerRestartMock,
  };
});

function registerHandlersForTest(): Map<string, (raw: unknown) => Promise<unknown>> {
  const registered = new Map<string, (raw: unknown) => Promise<unknown>>();
  registerMachineRpcHandlers({
    rpcHandlerManager: {
      registerHandler: (method: string, handler: (raw: unknown) => Promise<unknown>) => {
        registered.set(method, handler);
      },
    } as any,
    handlers: {
      spawnSession: async () => ({ type: 'success', sessionId: 's1' } as const),
      stopSession: async () => true,
      requestShutdown: () => {},
    },
  });
  return registered;
}

describe('registerMachineRpcHandlers session runner restart', () => {
  beforeEach(() => {
    requestDaemonSessionRunnerRestartMock.mockReset();
    requestDaemonSessionRunnerRestartMock.mockResolvedValue({
      ok: true,
      status: 'restarted',
      sessionId: 'sess_1',
    });
  });

  it('registers daemon.sessionRunner.restart and forwards protocol requests to daemon local control', async () => {
    const registered = registerHandlersForTest();
    const handler = registered.get(RPC_METHODS.DAEMON_SESSION_RUNNER_RESTART);
    expect(handler).toBeDefined();

    const response = await handler!({
      sessionId: 'sess_1',
      mode: 'force_current_cli',
      dryRun: false,
      reason: 'ui_stale_runner_banner',
      expectedRunnerPid: 12345,
      expectedProcessCommandHash: 'cmd_hash',
      expectedRunnerEntrypointIdentity: 'entrypoint_hash',
    });

    expect(response).toEqual({
      ok: true,
      status: 'restarted',
      sessionId: 'sess_1',
    });
    expect(requestDaemonSessionRunnerRestartMock).toHaveBeenCalledWith({
      sessionId: 'sess_1',
      mode: 'force_current_cli',
      dryRun: false,
      reason: 'ui_stale_runner_banner',
      expectedRunnerPid: 12345,
      expectedProcessCommandHash: 'cmd_hash',
      expectedRunnerEntrypointIdentity: 'entrypoint_hash',
    });
  });

  it('rejects malformed daemon.sessionRunner.restart requests before local control', async () => {
    const registered = registerHandlersForTest();
    const handler = registered.get(RPC_METHODS.DAEMON_SESSION_RUNNER_RESTART);
    expect(handler).toBeDefined();

    await expect(handler!({
      sessionId: '',
      reason: 'ui_stale_runner_banner',
    })).rejects.toThrow('Invalid daemon session runner restart request');
    expect(requestDaemonSessionRunnerRestartMock).not.toHaveBeenCalled();
  });

  it.each([
    [{ ok: true, status: 'restarted', sessionId: 'sess_success' }],
    [{ ok: false, status: 'version_unknown', sessionId: 'sess_skip', reasonCode: 'current_entrypoint_unknown' }],
    [{ ok: false, status: 'spawn_failed', sessionId: 'sess_fail', diagnostics: { error: 'spawn failed' } }],
  ] satisfies ReadonlyArray<readonly [RestartSessionRunnerResultV1]>)(
    'preserves daemon local control result mapping for %s',
    async (result) => {
      requestDaemonSessionRunnerRestartMock.mockResolvedValueOnce(result);
      const registered = registerHandlersForTest();
      const handler = registered.get(RPC_METHODS.DAEMON_SESSION_RUNNER_RESTART);
      expect(handler).toBeDefined();

      await expect(handler!({
        sessionId: result.sessionId,
        mode: 'if_stale',
        reason: 'ui_stale_runner_banner',
      })).resolves.toEqual(result);
    },
  );
});
