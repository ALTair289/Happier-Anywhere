import { describe, expect, it } from 'vitest';

import { parseRawJsonLinesLine, parseRawJsonLinesObject } from './parseRawJsonLines';

describe('parseRawJsonLines', () => {
  it('returns null for empty lines', () => {
    expect(parseRawJsonLinesLine('')).toBeNull();
    expect(parseRawJsonLinesLine('   ')).toBeNull();
  });

  it('returns null for invalid JSON', () => {
    expect(parseRawJsonLinesLine('{')).toBeNull();
    expect(parseRawJsonLinesLine('not json')).toBeNull();
  });

  it('parses a valid assistant message and preserves unknown fields', () => {
    const line = JSON.stringify({
      type: 'assistant',
      uuid: 'u1',
      message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
      extra_field: { nested: true },
    });
    const parsed = parseRawJsonLinesLine(line);
    expect(parsed?.type).toBe('assistant');
    expect((parsed as any).uuid).toBe('u1');
    expect((parsed as any).extra_field).toEqual({ nested: true });
  });

  it('parses a valid user message', () => {
    const parsed = parseRawJsonLinesObject({
      type: 'user',
      uuid: 'u2',
      message: { role: 'user', content: 'hello' },
    });
    expect(parsed?.type).toBe('user');
    expect((parsed as any).uuid).toBe('u2');
  });

  it('parses a progress message', () => {
    const parsed = parseRawJsonLinesObject({
      type: 'progress',
      uuid: 'p1',
      status: 'running',
    });
    expect(parsed?.type).toBe('progress');
    expect((parsed as any)?.uuid).toBe('p1');
  });

  it('parses a goal_status attachment record and preserves the inner attachment object', () => {
    const parsed = parseRawJsonLinesObject({
      type: 'attachment',
      uuid: 'a1',
      sessionId: 's1',
      timestamp: '2026-06-19T14:39:26.067Z',
      attachment: { type: 'goal_status', met: false, condition: 'ship it', sentinel: true },
    });
    expect(parsed?.type).toBe('attachment');
    expect((parsed as any)?.uuid).toBe('a1');
    expect((parsed as any)?.attachment).toEqual({
      type: 'goal_status',
      met: false,
      condition: 'ship it',
      sentinel: true,
    });
  });

  it('parses an attachment with an unknown subtype (forward-compatible)', () => {
    const parsed = parseRawJsonLinesObject({
      type: 'attachment',
      attachment: { type: 'agent_listing_delta', agents: [] },
    });
    expect(parsed?.type).toBe('attachment');
    expect((parsed as any)?.attachment?.type).toBe('agent_listing_delta');
  });

  it('does not drop assistant messages when usage schema changes (invalid usage is ignored)', () => {
    const parsed = parseRawJsonLinesObject({
      type: 'assistant',
      uuid: 'u3',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'hi' }],
        usage: {
          // Missing required token counts for our structured usage parser.
          output_tokens: 5,
          service_tier: null,
          something_new: true,
        },
      },
    });

    expect(parsed?.type).toBe('assistant');
    expect((parsed as any)?.uuid).toBe('u3');
    expect((parsed as any)?.message?.usage).toBeUndefined();
  });
});
