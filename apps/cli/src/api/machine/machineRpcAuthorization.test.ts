import { describe, expect, it } from 'vitest';
import { RPC_ERROR_CODES, RPC_METHODS } from '@happier-dev/protocol/rpc';

import { authorizeMachineRpcRequest } from './machineRpcAuthorization';

describe('authorizeMachineRpcRequest', () => {
  it('allows machine RPC methods that do not require session-write authorization', () => {
    expect(authorizeMachineRpcRequest({
      method: 'machine-1:daemon.sessionRunner.status.get',
      params: { sessionId: 's1' },
    })).toEqual({ ok: true });
  });

  it('rejects session-runner restart without server-provided session-write authorization', () => {
    expect(authorizeMachineRpcRequest({
      method: `machine-1:${RPC_METHODS.DAEMON_SESSION_RUNNER_RESTART}`,
      params: { sessionId: 's1' },
    })).toEqual({
      ok: false,
      error: 'Forbidden',
      errorCode: RPC_ERROR_CODES.FORBIDDEN,
    });
  });

  it('rejects session-runner restart when decrypted params target a different session', () => {
    expect(authorizeMachineRpcRequest({
      method: `machine-1:${RPC_METHODS.DAEMON_SESSION_RUNNER_RESTART}`,
      params: { sessionId: 's2' },
      authorization: { kind: 'session.write', sessionId: 's1' },
    })).toEqual({
      ok: false,
      error: 'Forbidden',
      errorCode: RPC_ERROR_CODES.FORBIDDEN,
    });
  });

  it('allows session-runner restart when decrypted params match server authorization', () => {
    expect(authorizeMachineRpcRequest({
      method: `machine-1:${RPC_METHODS.DAEMON_SESSION_RUNNER_RESTART}`,
      params: { sessionId: 's1' },
      authorization: { kind: 'session.write', sessionId: 's1' },
    })).toEqual({ ok: true });
  });
});
