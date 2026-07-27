import { describe, expect, it, vi } from 'vitest';

import { createFakeControlPort } from './fakeControlPort';
import { answerClaudeResumeChoiceDialog } from './resumeChoice';

const RESUME_DIALOG = [
  'This session is 18h 2m old and 560.4k tokens.',
  'To reduce startup time, Claude can resume from the saved summary or load the full session.',
  '',
  '❯ 1. Resume from summary',
  '  2. Resume full session',
].join('\n');

const IDLE = [
  '──────────────────────────────',
  '❯ ',
  '──────────────────────────────',
].join('\n');

const UNKNOWN_NUMBERED_DIALOG = [
  'Reset conversation cache?',
  '',
  '❯ 1. Yes, reset it',
  '  2. No, go back',
].join('\n');

describe('answerClaudeResumeChoiceDialog', () => {
  it('answers resume-from-summary by selecting option 1 and pressing Enter after a fresh capture', async () => {
    const port = createFakeControlPort({ captures: [RESUME_DIALOG, IDLE] });

    const result = await answerClaudeResumeChoiceDialog({
      port,
      choice: 'resume_from_summary',
      wait: async () => undefined,
      settleMs: 1,
    });

    expect(result).toEqual({ kind: 'answered', choice: 'resume_from_summary' });
    expect(port.log).toEqual([
      { type: 'capture', index: 0 },
      { type: 'literal', text: '1' },
      { type: 'key', key: 'Enter' },
      { type: 'capture', index: 1 },
    ]);
  });

  it('answers full-session resume by selecting option 2 and pressing Enter after a fresh capture', async () => {
    const port = createFakeControlPort({ captures: [RESUME_DIALOG, IDLE] });

    const result = await answerClaudeResumeChoiceDialog({
      port,
      choice: 'resume_full_session',
      wait: async () => undefined,
      settleMs: 1,
    });

    expect(result).toEqual({ kind: 'answered', choice: 'resume_full_session' });
    expect(port.sentLiteral).toEqual(['2']);
    expect(port.sentKeys).toEqual(['Enter']);
  });

  it('sends zero keys when the dialog was already resolved before the fresh capture', async () => {
    const port = createFakeControlPort({ captures: [IDLE] });

    const result = await answerClaudeResumeChoiceDialog({
      port,
      choice: 'resume_from_summary',
      wait: async () => undefined,
      settleMs: 1,
    });

    expect(result).toEqual({ kind: 'not_visible' });
    expect(port.sentLiteral).toEqual([]);
    expect(port.sentKeys).toEqual([]);
  });

  it('sends zero keys for unknown numbered dialogs', async () => {
    const port = createFakeControlPort({ captures: [UNKNOWN_NUMBERED_DIALOG] });

    const result = await answerClaudeResumeChoiceDialog({
      port,
      choice: 'resume_full_session',
      wait: async () => undefined,
      settleMs: 1,
    });

    expect(result).toEqual({ kind: 'not_visible' });
    expect(port.sentLiteral).toEqual([]);
    expect(port.sentKeys).toEqual([]);
  });

  it('reports failure when the dialog remains visible after the selection is sent', async () => {
    const port = createFakeControlPort({ captures: [RESUME_DIALOG, RESUME_DIALOG] });

    const result = await answerClaudeResumeChoiceDialog({
      port,
      choice: 'resume_from_summary',
      wait: async () => undefined,
      settleMs: 1,
    });

    expect(result).toEqual({ kind: 'failed', reason: 'resume_choice_dialog_still_visible' });
    expect(port.sentLiteral).toEqual(['1']);
    expect(port.sentKeys).toEqual(['Enter']);
  });

  it('publishes the exact submission boundary even when post-Enter recapture fails', async () => {
    const onSubmitted = vi.fn();
    const port = createFakeControlPort({
      captures: [RESUME_DIALOG],
      failCaptureAtIndexes: [1],
    });

    const result = await answerClaudeResumeChoiceDialog({
      port,
      choice: 'resume_from_summary',
      wait: async () => undefined,
      settleMs: 1,
      onSubmitted,
    });

    expect(result).toEqual({ kind: 'failed', reason: 'host_dead:unrecoverable' });
    expect(onSubmitted).toHaveBeenCalledTimes(1);
  });

  it('does not publish submission when Enter fails', async () => {
    const onSubmitted = vi.fn();
    const port = createFakeControlPort({
      captures: [RESUME_DIALOG],
      failSendKeys: ['Enter'],
    });

    await answerClaudeResumeChoiceDialog({
      port,
      choice: 'resume_from_summary',
      wait: async () => undefined,
      settleMs: 1,
      onSubmitted,
    });

    expect(onSubmitted).not.toHaveBeenCalled();
  });
});
