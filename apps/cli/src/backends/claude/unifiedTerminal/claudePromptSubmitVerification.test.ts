import { describe, expect, it } from 'vitest';

import { createClaudePromptSubmitVerificationPolicy } from './claudePromptSubmitVerification';

describe('createClaudePromptSubmitVerificationPolicy', () => {
  it('verifies every non-empty prompt after submit', () => {
    const policy = createClaudePromptSubmitVerificationPolicy();

    expect(policy.shouldVerifyAfterSubmit('first line\nsecond line')).toBe(true);
    expect(policy.shouldVerifyAfterSubmit('first line\r\nsecond line')).toBe(true);
    expect(policy.shouldVerifyAfterSubmit('single line prompt')).toBe(true);
    expect(policy.shouldVerifyAfterSubmit('   ')).toBe(false);
  });

  it('detects a single-line prompt that remains exactly in the composer after submit', () => {
    const policy = createClaudePromptSubmitVerificationPolicy();
    const prompt = 'Reply exactly with WIN-CLAUDE-UNIFIED-CS-AFTERFIX2-FIRST-20260629T1535Z and nothing else.';

    expect(policy.shouldVerifyAfterSubmit(prompt)).toBe(true);
    expect(policy.isPromptStillPendingAfterSubmit({
      promptText: prompt,
      screenText: `Claude Code\n> ${prompt}`,
    })).toBe(true);
    expect(policy.isPromptStillPendingAfterSubmit({
      promptText: prompt,
      screenText: [
        prompt,
        '',
        '│ > │',
      ].join('\n'),
    })).toBe(false);
  });

  it('detects a single-line prompt that remains visually wrapped in the composer after submit', () => {
    const policy = createClaudePromptSubmitVerificationPolicy();
    const prompt = [
      'can you please give me a complete report as an assistant message of everything you analysed, all the reports,',
      'all the issues, improvements, suggestions, and your recommendations',
    ].join(' ');

    expect(policy.isPromptStillPendingAfterSubmit({
      promptText: prompt,
      screenText: [
        '─'.repeat(120),
        '❯ can you please give me a complete report as an assistant message of everything you analysed, all the reports,',
        '  all the issues, improvements, suggestions, and your recommendations',
        '─'.repeat(120),
      ].join('\n'),
    })).toBe(true);
  });

  it('recognizes a current collapsed pasted prompt after submit with footer rows below it', () => {
    const policy = createClaudePromptSubmitVerificationPolicy();
    const prompt = Array.from({ length: 41 }, (_, index) => `line ${index}`).join('\n');

    expect(policy.isPromptStillPendingAfterSubmit({
      promptText: prompt,
      screenText: [
        '┄'.repeat(20),
        '› [Pasted text #1 +40 lines]',
        '─'.repeat(20),
        '⏵⏵ auto mode on (shift+tab to cycle)',
      ].join('\n'),
    })).toBe(true);
  });

  it('does not treat a stale submitted marker above an empty composer as pending after submit', () => {
    const policy = createClaudePromptSubmitVerificationPolicy();
    const prompt = Array.from({ length: 41 }, (_, index) => `line ${index}`).join('\n');

    expect(policy.isPromptStillPendingAfterSubmit({
      promptText: prompt,
      screenText: [
        'earlier submitted prompt',
        '❯ [Pasted text #1 +40 lines]',
        '',
        '│ > │',
      ].join('\n'),
    })).toBe(false);
  });
});
