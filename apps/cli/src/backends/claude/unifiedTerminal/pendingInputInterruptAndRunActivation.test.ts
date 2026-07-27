import { describe, expect, it } from 'vitest';

import { isClaudeUnifiedPendingInputInterruptAndRunEnabled } from './pendingInputInterruptAndRunActivation';

describe('Claude Unified pending-input interrupt-and-run activation', () => {
  it('enables the provider control only for the real-Claude-proven tmux host', () => {
    expect(isClaudeUnifiedPendingInputInterruptAndRunEnabled('tmux')).toBe(true);
    expect(isClaudeUnifiedPendingInputInterruptAndRunEnabled('zellij')).toBe(false);
  });
});
