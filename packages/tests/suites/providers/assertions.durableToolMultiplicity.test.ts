import { describe, expect, it } from 'vitest';

import { assertSingleDurableToolCallPerLogicalId } from '../../src/testkit/providers/assertions';

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

  it('does not collapse identical call ids across main and sidechain namespaces', () => {
    const messages = [
      { content: { type: 'tool-call', callId: 'call-1', name: 'Edit' }, meta: {} },
      { content: { type: 'tool-call', callId: 'call-1', name: 'Edit' }, meta: { sidechainId: 'side-1' } },
    ];

    expect(() => assertSingleDurableToolCallPerLogicalId(messages)).not.toThrow();
  });
});
