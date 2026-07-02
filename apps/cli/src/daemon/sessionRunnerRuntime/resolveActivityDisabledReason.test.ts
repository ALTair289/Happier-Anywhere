import { describe, expect, it } from 'vitest';

import { resolveSessionRunnerActivityDisabledReason } from './resolveActivityDisabledReason';

describe('resolveSessionRunnerActivityDisabledReason', () => {
  it('prioritizes active turns before approval and terminal blockers', () => {
    expect(resolveSessionRunnerActivityDisabledReason('sess-1', {
      isTurnInProgress: () => true,
      hasPendingApproval: () => true,
      isTerminalDetached: () => true,
      isTerminalHostAttached: () => true,
    })).toBe('turn_in_progress');
  });

  it('reports pending approvals before terminal blockers', () => {
    expect(resolveSessionRunnerActivityDisabledReason('sess-1', {
      hasPendingApproval: () => true,
      isTerminalDetached: () => true,
      isTerminalHostAttached: () => true,
    })).toBe('approval_pending');
  });

  it('reports terminal detached before terminal-host attached', () => {
    expect(resolveSessionRunnerActivityDisabledReason('sess-1', {
      isTerminalDetached: () => true,
      isTerminalHostAttached: () => true,
    })).toBe('terminal_detached');
  });

  it('returns null when every activity reader reports safe', () => {
    expect(resolveSessionRunnerActivityDisabledReason('sess-1', {
      isTurnInProgress: () => false,
      hasPendingApproval: () => false,
      isTerminalDetached: () => false,
      isTerminalHostAttached: () => false,
    })).toBeNull();
  });
});
