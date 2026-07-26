import { describe, expect, it } from 'vitest';

import { mergeToolCallSnapshot } from '../mergeToolCallSnapshot';
import { resolveBestToolCallIdentity } from '../resolveToolCallIdentity';
import type { AcpToolCallSnapshot } from '../types';

describe('mergeToolCallSnapshot', () => {
  it('retains omitted fields and replaces only fields present in the ACP patch', () => {
    const previous = {
      toolCallId: 'call-1',
      title: 'Editing a.ts',
      kind: 'other',
      status: 'pending',
      rawInput: { path: 'a.ts' },
      locations: [{ path: 'a.ts', line: 1 }],
      content: [{ type: 'content', content: { type: 'text', text: 'old' } }],
    } satisfies AcpToolCallSnapshot;

    expect(mergeToolCallSnapshot(previous, {
      toolCallId: 'call-1',
      status: 'in_progress',
      rawOutput: { progress: 50 },
    })).toEqual({
      ...previous,
      status: 'in_progress',
      rawOutput: { progress: 50 },
    });
  });

  it('honors schema-defined null clears and empty collection replacement', () => {
    const merged = mergeToolCallSnapshot({
      toolCallId: 'call-1',
      title: 'Old title',
      kind: 'edit',
      status: 'in_progress',
      rawInput: { path: 'a.ts' },
      locations: [{ path: 'a.ts' }],
      content: [{ type: 'content' }],
    }, {
      toolCallId: 'call-1',
      title: null,
      kind: null,
      status: null,
      rawInput: null,
      locations: [],
      content: null,
    });

    expect(merged).toMatchObject({
      title: null,
      kind: null,
      status: null,
      rawInput: null,
      locations: [],
      content: null,
    });
  });

  it('rejects patches that attempt to change the logical call id', () => {
    expect(() => mergeToolCallSnapshot(
      { toolCallId: 'call-1', title: 'Read' },
      { toolCallId: 'call-2', status: 'completed' },
    )).toThrow(/toolCallId/i);
  });
});

describe('resolveBestToolCallIdentity', () => {
  it('upgrades generic identities but never downgrades a known semantic name', () => {
    expect(resolveBestToolCallIdentity({ previous: 'other', candidate: 'edit' })).toBe('edit');
    expect(resolveBestToolCallIdentity({ previous: 'edit', candidate: 'other' })).toBe('edit');
    expect(resolveBestToolCallIdentity({ previous: 'SubAgent', candidate: 'unknown' })).toBe('SubAgent');
    expect(resolveBestToolCallIdentity({ previous: null, candidate: null })).toBe('unknown');
  });
});
