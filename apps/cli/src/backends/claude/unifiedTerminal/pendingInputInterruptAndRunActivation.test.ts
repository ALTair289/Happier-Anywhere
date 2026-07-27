import { describe, expect, it } from 'vitest';

import { isClaudeUnifiedPendingInputInterruptAndRunEnabled } from './pendingInputInterruptAndRunActivation';

describe('Claude Unified pending-input interrupt-and-run activation', () => {
  it('enables the provider control for terminal hosts that implement the interrupt contract', () => {
    expect(isClaudeUnifiedPendingInputInterruptAndRunEnabled('tmux')).toBe(true);
    expect(isClaudeUnifiedPendingInputInterruptAndRunEnabled('zellij')).toBe(true);
  });
});
