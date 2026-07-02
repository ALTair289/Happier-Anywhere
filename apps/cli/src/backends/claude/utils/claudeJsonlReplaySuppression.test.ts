import { describe, expect, it } from 'vitest';

import { createClaudeJsonlResetReplaySuppressor } from './claudeJsonlReplaySuppression';

describe('createClaudeJsonlResetReplaySuppressor', () => {
  it('suppresses reset replay rows only until the first fresh row proves the follower caught up', () => {
    const suppressor = createClaudeJsonlResetReplaySuppressor({
      nowMs: Date.parse('2026-06-25T12:00:30.000Z'),
    });

    suppressor.markReset();

    expect(suppressor.shouldSuppress({
      timestamp: '2026-06-25T11:59:00.000Z',
      type: 'assistant',
    })).toBe(true);
    expect(suppressor.shouldSuppress({
      type: 'assistant',
    })).toBe(true);
    expect(suppressor.shouldSuppress({
      timestamp: '2026-06-25T12:00:05.000Z',
      type: 'assistant',
    })).toBe(false);

    expect(suppressor.shouldSuppress({
      timestamp: '2026-06-25T11:59:30.000Z',
      type: 'assistant',
    })).toBe(false);
  });
});
