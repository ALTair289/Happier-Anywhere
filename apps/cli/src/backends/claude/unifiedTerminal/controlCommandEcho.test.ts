import { describe, expect, it } from 'vitest';

import { createClaudeUnifiedControlCommandEchoBookkeeper } from './controlCommandEcho';
import type { RawJSONLines } from '../types';

function userRow(content: string): RawJSONLines {
  return {
    type: 'user',
    message: { role: 'user', content },
    uuid: 'u-1',
    timestamp: '2026-06-11T09:00:00.000Z',
  } as unknown as RawJSONLines;
}

const EFFORT_COMMAND_ROW = userRow(
  '<command-name>/effort</command-name>\n<command-message>effort</command-message>\n<command-args>medium</command-args>',
);
const EMPTY_ARGS_MODEL_COMMAND_ROW = userRow(
  '<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args></command-args>',
);
const EFFORT_STDOUT_ROW = userRow('<local-command-stdout>Set effort level to medium</local-command-stdout>');
const MULTILINE_STDOUT_ROW = userRow(
  [
    '<local-command-stdout>Set model to Opus 4.8 and saved as your default for new sessions',
    'Additional Claude Code local-command output detail</local-command-stdout>',
  ].join('\n'),
);

describe('createClaudeUnifiedControlCommandEchoBookkeeper (incident 2026-06-11, L3)', () => {
  it('marks every Claude local-command transcript row as consumed without a registration gate', () => {
    const consumed: RawJSONLines[] = [];
    const bookkeeper = createClaudeUnifiedControlCommandEchoBookkeeper({
      onConsumed: (message) => consumed.push(message),
    });

    bookkeeper.recordTypedControlCommand('/effort medium');

    expect(bookkeeper.markConsumedTranscriptMessage(EFFORT_COMMAND_ROW)).toBe(true);
    expect(bookkeeper.markConsumedTranscriptMessage(EMPTY_ARGS_MODEL_COMMAND_ROW)).toBe(true);
    expect(bookkeeper.markConsumedTranscriptMessage(EFFORT_STDOUT_ROW)).toBe(true);
    expect(bookkeeper.markConsumedTranscriptMessage(MULTILINE_STDOUT_ROW)).toBe(true);
    expect(consumed).toEqual([
      EFFORT_COMMAND_ROW,
      EMPTY_ARGS_MODEL_COMMAND_ROW,
      EFFORT_STDOUT_ROW,
      MULTILINE_STDOUT_ROW,
    ]);
  });

  it('does not treat the marker decision as a visible-transcript suppression policy', () => {
    const bookkeeper = createClaudeUnifiedControlCommandEchoBookkeeper();

    expect(bookkeeper.markConsumedTranscriptMessage(EFFORT_COMMAND_ROW)).toBe(true);
    expect(bookkeeper.markConsumedTranscriptMessage(EFFORT_COMMAND_ROW)).toBe(true);
  });

  it('ignores assistant rows and non-command user rows', () => {
    const bookkeeper = createClaudeUnifiedControlCommandEchoBookkeeper();
    bookkeeper.recordTypedControlCommand('/model sonnet');

    expect(bookkeeper.markConsumedTranscriptMessage({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
    } as unknown as RawJSONLines)).toBe(false);
    expect(bookkeeper.markConsumedTranscriptMessage(userRow('plain user prompt'))).toBe(false);
  });
});
