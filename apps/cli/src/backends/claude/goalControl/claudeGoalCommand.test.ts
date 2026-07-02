import { describe, expect, it } from 'vitest';

import { buildClaudeGoalCommand } from './claudeGoalCommand';

describe('buildClaudeGoalCommand', () => {
  it('formats a set command as `/goal <objective>`', () => {
    expect(buildClaudeGoalCommand({ type: 'set', objective: 'ship the goal feature' }))
      .toBe('/goal ship the goal feature');
  });

  it('trims surrounding whitespace from the objective', () => {
    expect(buildClaudeGoalCommand({ type: 'set', objective: '   tidy up   ' }))
      .toBe('/goal tidy up');
  });

  it('preserves interior whitespace in the objective', () => {
    expect(buildClaudeGoalCommand({ type: 'set', objective: 'a   b' }))
      .toBe('/goal a   b');
  });

  it('collapses embedded newlines so the objective stays on a single `/goal` line (LOW-1)', () => {
    // User-controlled multiline input must not turn into a multi-line / garbled TUI command.
    expect(buildClaudeGoalCommand({ type: 'set', objective: 'line one\nline two' }))
      .toBe('/goal line one line two');
    expect(buildClaudeGoalCommand({ type: 'set', objective: 'a\r\nb\rc' }))
      .toBe('/goal a b c');
    expect(buildClaudeGoalCommand({ type: 'set', objective: 'first\n\n\n  second' }))
      .toBe('/goal first second');
    const result = buildClaudeGoalCommand({ type: 'set', objective: 'multi\nline\ngoal' });
    expect(result.includes('\n')).toBe(false);
    expect(result.includes('\r')).toBe(false);
  });

  it('formats a clear command as `/goal clear`', () => {
    expect(buildClaudeGoalCommand({ type: 'clear' })).toBe('/goal clear');
  });
});
