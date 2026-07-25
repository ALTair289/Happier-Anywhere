import { describe, expect, it } from 'vitest';

import {
  parseSocketRpcAuthorizationContext,
  resolveSocketRpcSessionWriteAuthorizationMethod,
  RPC_METHODS,
} from './rpc.js';

describe('RPC_METHODS (session runner)', () => {
  it('includes daemon session runner status and planned restart methods', () => {
    expect((RPC_METHODS as Record<string, string>).DAEMON_SESSION_RUNNER_STATUS_GET).toBe('daemon.sessionRunner.status.get');
    expect((RPC_METHODS as Record<string, string>).DAEMON_SESSION_RUNNER_RESTART).toBe('daemon.sessionRunner.restart');
    expect((RPC_METHODS as Record<string, string>).DAEMON_SESSION_RUNNER_RESTART_ALL).toBe('daemon.sessionRunner.restartAll');
  });

  it('requires session-write authorization for session-runner restart and explicit Stop RPCs', () => {
    expect(resolveSocketRpcSessionWriteAuthorizationMethod(RPC_METHODS.DAEMON_SESSION_RUNNER_RESTART))
      .toBe(RPC_METHODS.DAEMON_SESSION_RUNNER_RESTART);
    expect(resolveSocketRpcSessionWriteAuthorizationMethod(`machine-1:${RPC_METHODS.DAEMON_SESSION_RUNNER_RESTART}`))
      .toBe(RPC_METHODS.DAEMON_SESSION_RUNNER_RESTART);
    expect(resolveSocketRpcSessionWriteAuthorizationMethod(RPC_METHODS.STOP_SESSION))
      .toBe(RPC_METHODS.STOP_SESSION);
    expect(resolveSocketRpcSessionWriteAuthorizationMethod(`machine-1:${RPC_METHODS.STOP_SESSION}`))
      .toBe(RPC_METHODS.STOP_SESSION);
    expect(resolveSocketRpcSessionWriteAuthorizationMethod(RPC_METHODS.DAEMON_SESSION_RUNNER_STATUS_GET))
      .toBeNull();
    expect(resolveSocketRpcSessionWriteAuthorizationMethod(RPC_METHODS.DAEMON_SESSION_RUNNER_RESTART_ALL))
      .toBeNull();
  });

  it('parses restart RPC authorization fail-closed and normalizes session ids', () => {
    expect(parseSocketRpcAuthorizationContext({ kind: 'session.write', sessionId: ' sess_1 ' })).toEqual({
      kind: 'session.write',
      sessionId: 'sess_1',
    });
    expect(parseSocketRpcAuthorizationContext({ kind: 'session.write', sessionId: '' })).toBeNull();
    expect(parseSocketRpcAuthorizationContext({ kind: 'session.read', sessionId: 'sess_1' })).toBeNull();
    expect(parseSocketRpcAuthorizationContext({ kind: 'session.write', sessionId: 'x'.repeat(513) })).toBeNull();
    expect(parseSocketRpcAuthorizationContext(null)).toBeNull();
  });
});
