import { describe, expect, it } from 'vitest';

import { createToolCallTranscriptIdentity } from '../toolCallTranscriptIdentity';

describe('createToolCallTranscriptIdentity', () => {
  const base = {
    provider: 'cursor',
    namespace: { type: 'main' as const },
    toolCallId: 'opaque-call-id',
  };

  it('is deterministic, bounded, persistence-safe, and does not expose the opaque call id', () => {
    const first = createToolCallTranscriptIdentity({ ...base, message: 'call' });
    const second = createToolCallTranscriptIdentity({ ...base, message: 'call' });

    expect(first).toBe(second);
    expect(first.length).toBeLessThanOrEqual(96);
    expect(first).toMatch(/^[A-Za-z0-9_-]+$/u);
    expect(first).not.toContain(base.toolCallId);
  });

  it('separates call/result, provider, and main/sidechain identity domains', () => {
    const call = createToolCallTranscriptIdentity({ ...base, message: 'call' });
    const result = createToolCallTranscriptIdentity({ ...base, message: 'result' });
    const provider = createToolCallTranscriptIdentity({ ...base, provider: 'gemini', message: 'call' });
    const sidechain = createToolCallTranscriptIdentity({
      ...base,
      namespace: { type: 'sidechain', sidechainId: 'parent-call' },
      message: 'call',
    });

    expect(new Set([call, result, provider, sidechain])).toHaveLength(4);
  });

  it('keeps hostile long and newline-containing ids bounded and unambiguous', () => {
    const first = createToolCallTranscriptIdentity({
      ...base,
      toolCallId: `line-one\nline-two:${'x'.repeat(20_000)}`,
      message: 'call',
    });
    const second = createToolCallTranscriptIdentity({
      ...base,
      toolCallId: `line-one\nline-two:${'x'.repeat(19_999)}y`,
      message: 'call',
    });

    expect(first).not.toBe(second);
    expect(first.length).toBeLessThanOrEqual(96);
    expect(first).toMatch(/^[A-Za-z0-9_-]+$/u);
  });
});
