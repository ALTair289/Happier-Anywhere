import { describe, expect, it } from 'vitest';

import { assertCurrentDaemonSelfRestartAuthorization } from './selfRestartAuthorization';

describe('assertCurrentDaemonSelfRestartAuthorization', () => {
  it('rejects a delayed successor after its authorization deadline', () => {
    expect(() => assertCurrentDaemonSelfRestartAuthorization({
      startupSource: 'self-restart',
      correlationId: 'restart-1',
      deadlineMs: '1000',
      nowMs: 1001,
    })).toThrow(/authorization expired/);
  });

  it('accepts a successor-specific authorization within its deadline', () => {
    expect(() => assertCurrentDaemonSelfRestartAuthorization({
      startupSource: 'self-restart',
      correlationId: 'restart-1',
      deadlineMs: '1000',
      nowMs: 1000,
    })).not.toThrow();
  });
});
