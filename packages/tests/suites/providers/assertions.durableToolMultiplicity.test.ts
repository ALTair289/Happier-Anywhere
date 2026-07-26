import { describe, expect, it } from 'vitest';

import {
  assertDurableToolCardinality,
  assertSingleDurableToolCallPerLogicalId,
  summarizeDurableToolRows,
} from '../../src/testkit/providers/assertions';

describe('provider assertions: durable tool-call multiplicity', () => {
  it('rejects two raw durable rows carrying the same logical call id', () => {
    const messages = [
      { content: { type: 'tool-call', id: 'body-1', callId: 'call-1', name: 'Edit' } },
      { content: { type: 'tool-call', id: 'body-2', callId: 'call-1', name: 'Edit' } },
    ];

    expect(() => assertSingleDurableToolCallPerLogicalId(messages)).toThrow(
      'logical tool call "call-1" has 2 durable rows',
    );
  });

  it('accepts revised storage represented by one raw row and a paired result', () => {
    const messages = [
      { content: { type: 'tool-call', id: 'body-1', callId: 'call-1', name: 'Edit' } },
      { content: { type: 'tool-result', id: 'result-1', callId: 'call-1', name: 'Edit' } },
    ];

    expect(() => assertSingleDurableToolCallPerLogicalId(messages)).not.toThrow();
  });

  it('reads the real decrypted ACP envelope used by durable session rows', () => {
    const messages = [
      { content: { type: 'acp', provider: 'cursor', data: { type: 'tool-call', callId: 'call-1', name: 'Edit' } } },
      { content: { type: 'acp', provider: 'cursor', data: { type: 'tool-call', callId: 'call-1', name: 'Edit' } } },
      { content: { type: 'acp', provider: 'cursor', data: { type: 'tool-result', callId: 'call-1' } } },
    ];

    expect(summarizeDurableToolRows(messages)).toMatchObject({
      rawCallRows: 2,
      logicalCallIds: 1,
      resultRows: 1,
      duplicateCallIds: ['main\u0000call-1'],
    });
  });

  it('does not collapse identical call ids across main and sidechain namespaces', () => {
    const messages = [
      { content: { type: 'tool-call', callId: 'call-1', name: 'Edit' }, meta: {} },
      { content: { type: 'tool-call', callId: 'call-1', name: 'Edit' }, meta: { sidechainId: 'side-1' } },
    ];

    expect(() => assertSingleDurableToolCallPerLogicalId(messages)).not.toThrow();
  });

  it('reads sidechain identity from the real nested ACP tool payload', () => {
    const messages = [
      { content: { type: 'acp', data: { type: 'tool-call', callId: 'call-1', name: 'Edit' } } },
      { content: { type: 'acp', data: { type: 'tool-call', callId: 'call-1', name: 'Edit', sidechainId: 'side-1' } } },
    ];

    expect(() => assertSingleDurableToolCallPerLogicalId(messages)).not.toThrow();
  });

  it('reports raw rows, logical ids, paired results, and orphan results independently', () => {
    const messages = [
      { content: { type: 'tool-call', callId: 'call-1', name: 'Edit' } },
      { content: { type: 'tool-call', callId: 'call-1', name: 'Edit' } },
      { content: { type: 'tool-call', callId: 'call-2', name: 'Read' } },
      { content: { type: 'tool-result', callId: 'call-1', name: 'Edit' } },
      { content: { type: 'tool-result', callId: 'orphan', name: 'Read' } },
    ];

    expect(summarizeDurableToolRows(messages)).toEqual({
      rawCallRows: 3,
      logicalCallIds: 2,
      resultRows: 2,
      uniqueResultIds: 2,
      duplicateCallIds: ['main\u0000call-1'],
      duplicateResultIds: [],
      orphanResultIds: ['main\u0000orphan'],
    });
  });

  it('asserts exact post-fix call/result cardinality without requiring a result for every call', () => {
    const messages = [
      { content: { type: 'tool-call', callId: 'call-1', name: 'Edit' } },
      { content: { type: 'tool-call', callId: 'call-2', name: 'ExitPlanMode' } },
      { content: { type: 'tool-result', callId: 'call-1', name: 'Edit' } },
    ];

    expect(() => assertDurableToolCardinality(messages, { calls: 2, results: 1 })).not.toThrow();
    expect(() => assertDurableToolCardinality(messages, { calls: 2, results: 2 })).toThrow(
      'expected 2 result rows, got 1',
    );
  });
});
