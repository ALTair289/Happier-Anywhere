import { describe, expect, it } from 'vitest';

import {
  TERMINAL_INPUT_MAX_WRITE_TIMEOUT_MS,
  resolveTerminalPromptWriteBudget,
  resolveTerminalPromptWriteTimeoutMs,
} from './promptWriteTimeout';

describe('resolveTerminalPromptWriteTimeoutMs', () => {
  it('keeps the base timeout for ordinary prompts', () => {
    expect(resolveTerminalPromptWriteTimeoutMs('hello', { baseTimeoutMs: 15_000 })).toBe(15_000);
  });

  it('scales the timeout for large terminal prompts', () => {
    expect(resolveTerminalPromptWriteTimeoutMs('x'.repeat(128_000), { baseTimeoutMs: 15_000 })).toBeGreaterThan(15_000);
  });

  it('uses a conservative large-prompt byte budget for terminal host writes', () => {
    expect(resolveTerminalPromptWriteTimeoutMs('x'.repeat(128_000), { baseTimeoutMs: 15_000 })).toBe(125_000);
  });

  it('returns diagnostic-safe write budget metadata without prompt text', () => {
    const budget = resolveTerminalPromptWriteBudget('alpha\nbeta', { baseTimeoutMs: 15_000 });

    expect(budget).toEqual({
      timeoutMs: 15_000,
      byteLength: 10,
      newlineCount: 1,
      byteBudgetMs: 1_000,
      newlineBudgetMs: 50,
    });
    expect(JSON.stringify(budget)).not.toContain('alpha');
    expect(JSON.stringify(budget)).not.toContain('beta');
  });

  it('caps the timeout for pathological prompt sizes', () => {
    expect(TERMINAL_INPUT_MAX_WRITE_TIMEOUT_MS).toBe(300_000);
    expect(resolveTerminalPromptWriteTimeoutMs('x'.repeat(5_000_000))).toBe(300_000);
  });
});
