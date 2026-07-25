import { describe, expect, it } from 'vitest';

import {
  ExecutionRunTurnStreamReadResponseSchema,
  ExecutionRunTurnStreamStartResponseSchema,
  ExecutionRunTurnStreamStartV2RequestSchema,
  ExecutionRunUserTranscriptCommitRequestSchema,
} from './executionRuns.js';

describe('execution run streaming schemas', () => {
  it('parses start response', () => {
    const parsed = ExecutionRunTurnStreamStartResponseSchema.parse({ streamId: 'stream-1' });
    expect(parsed.streamId).toBe('stream-1');
  });

  it('preserves the exact opaque outer-turn identity and distinguishes internal follow-up turns', () => {
    const outer = ExecutionRunTurnStreamStartV2RequestSchema.parse({
      runId: 'run-1',
      message: 'outer prompt',
      userTranscript: {
        mode: 'persist',
        localId: ' durable-outer-id ',
      },
    });
    const followUp = ExecutionRunTurnStreamStartV2RequestSchema.parse({
      runId: 'run-1',
      message: 'VOICE_TOOL_RESULTS_JSON:[]',
      userTranscript: { mode: 'suppress' },
    });

    expect(outer.userTranscript).toEqual({
      mode: 'persist',
      localId: ' durable-outer-id ',
    });
    expect(followUp.userTranscript).toEqual({ mode: 'suppress' });
    expect(() => ExecutionRunTurnStreamStartV2RequestSchema.parse({
      runId: 'run-1',
      message: 'invalid',
      userTranscript: { mode: 'persist', localId: ' \t\n ' },
    })).toThrow();
  });

  it('preserves the exact opaque identity for transcript-only shortcut commits', () => {
    const parsed = ExecutionRunUserTranscriptCommitRequestSchema.parse({
      runId: 'run-1',
      message: 'Approve the pending permission request.',
      localId: ' shortcut-durable-id ',
    });

    expect(parsed.localId).toBe(' shortcut-durable-id ');
  });

  it('parses read response with deltas + done actions', () => {
    const parsed = ExecutionRunTurnStreamReadResponseSchema.parse({
      streamId: 'stream-1',
      events: [
        { t: 'delta', textDelta: 'hello ' },
        { t: 'delta', textDelta: 'world' },
        { t: 'done', assistantText: 'hello world', actions: [{ t: 'sendSessionMessage', args: { message: 'do X' } }] },
      ],
      nextCursor: 3,
      done: true,
    });
    expect(parsed.done).toBe(true);
    expect(parsed.events[2]).toEqual(
      expect.objectContaining({ t: 'done', assistantText: 'hello world' }),
    );
  });
});
