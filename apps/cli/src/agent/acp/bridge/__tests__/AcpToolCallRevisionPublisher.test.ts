import { describe, expect, it, vi } from 'vitest';

import { createAcpToolCallRevisionPublisher } from '../AcpToolCallRevisionPublisher';

describe('createAcpToolCallRevisionPublisher', () => {
  it('publishes enriched call snapshots through one stable body id and localId', () => {
    const sendAcp = vi.fn();
    const publisher = createAcpToolCallRevisionPublisher({
      provider: 'cursor',
      namespace: { type: 'main' },
      sendAcp,
    });

    publisher.publishCall({ callId: 'opaque-1', toolName: 'other', input: {} });
    publisher.publishCall({ callId: 'opaque-1', toolName: 'edit', input: { path: 'a.ts' } });

    expect(sendAcp).toHaveBeenCalledTimes(2);
    const [firstProvider, firstBody, firstOptions] = sendAcp.mock.calls[0]!;
    const [secondProvider, secondBody, secondOptions] = sendAcp.mock.calls[1]!;
    expect(firstProvider).toBe('cursor');
    expect(secondProvider).toBe('cursor');
    expect(firstBody.id).toBe(secondBody.id);
    expect(firstOptions.localId).toBe(firstBody.id);
    expect(secondOptions.localId).toBe(firstBody.id);
    expect(firstBody.id).not.toContain('opaque-1');
    expect(secondBody).toMatchObject({ type: 'tool-call', callId: 'opaque-1', name: 'edit' });
  });

  it('rejects a locally stale call snapshot revision before it reaches the session writer', () => {
    const sendAcp = vi.fn();
    const publisher = createAcpToolCallRevisionPublisher({
      provider: 'cursor',
      namespace: { type: 'main' },
      sendAcp,
    });

    expect(publisher.publishCall({ callId: 'opaque-1', toolName: 'edit', input: {}, revision: 2 })).toBe(true);
    expect(publisher.publishCall({ callId: 'opaque-1', toolName: 'other', input: {}, revision: 1 })).toBe(false);
    expect(publisher.publishCall({ callId: 'opaque-1', toolName: 'edit', input: {}, revision: 2 })).toBe(false);
    expect(sendAcp).toHaveBeenCalledTimes(1);
  });

  it('separates call and result identities and ignores late call/result duplicates after terminalization', () => {
    const sendAcp = vi.fn();
    const publisher = createAcpToolCallRevisionPublisher({
      provider: 'cursor',
      namespace: { type: 'main' },
      sendAcp,
    });
    publisher.publishCall({ callId: 'opaque-1', toolName: 'edit', input: {} });
    publisher.publishResult({ callId: 'opaque-1', toolName: 'edit', output: { ok: true } });
    publisher.publishCall({ callId: 'opaque-1', toolName: 'late-edit', input: { stale: true } });
    publisher.publishResult({ callId: 'opaque-1', toolName: 'edit', output: { ok: false }, isError: true });

    expect(sendAcp).toHaveBeenCalledTimes(2);
    const call = sendAcp.mock.calls[0]![1];
    const result = sendAcp.mock.calls[1]![1];
    expect(call.id).not.toBe(result.id);
    expect(result).toMatchObject({ type: 'tool-result', callId: 'opaque-1', output: { ok: true } });
  });

  it('allows only a strictly newer versioned call to enrich the stable call after its terminal result', () => {
    const sendAcp = vi.fn();
    const publisher = createAcpToolCallRevisionPublisher({
      provider: 'cursor',
      namespace: { type: 'main' },
      sendAcp,
    });
    const callId = 'opaque\n task ID ';

    expect(publisher.publishCall({ callId, toolName: 'other', input: {}, revision: 1 })).toBe(true);
    expect(publisher.publishResult({ callId, toolName: 'other', output: { ok: true } })).toBe(true);
    expect(publisher.publishCall({
      callId,
      toolName: 'Task',
      input: { description: 'Enriched completion' },
      revision: 2,
    })).toBe(true);

    expect(publisher.publishCall({ callId, toolName: 'stale', input: {}, revision: 1 })).toBe(false);
    expect(publisher.publishCall({ callId, toolName: 'equal', input: {}, revision: 2 })).toBe(false);
    expect(publisher.publishCall({ callId, toolName: 'unversioned', input: {} })).toBe(false);
    expect(publisher.publishResult({ callId, toolName: 'Task', output: { duplicate: true } })).toBe(false);

    expect(sendAcp.mock.calls.map((call) => call[1].type)).toEqual([
      'tool-call',
      'tool-result',
      'tool-call',
    ]);
    expect(sendAcp.mock.calls[0]?.[1].id).toBe(sendAcp.mock.calls[2]?.[1].id);
    expect(sendAcp.mock.calls[0]?.[2].localId).toBe(sendAcp.mock.calls[2]?.[2].localId);
    expect(publisher.activeSize).toBe(0);
    expect(publisher.finalizedSize).toBe(1);
  });

  it('revises streaming results in place until the first terminal result', () => {
    const sendAcp = vi.fn();
    const publisher = createAcpToolCallRevisionPublisher({
      provider: 'cursor',
      namespace: { type: 'main' },
      sendAcp,
    });
    publisher.publishCall({ callId: 'opaque-1', toolName: 'execute', input: {} });
    publisher.publishResult({ callId: 'opaque-1', toolName: 'execute', output: { stdoutChunk: 'a', _stream: true } });
    publisher.publishResult({ callId: 'opaque-1', toolName: 'execute', output: { stdoutChunk: 'ab', _stream: true } });
    publisher.publishResult({ callId: 'opaque-1', toolName: 'execute', output: { stdout: 'ab' } });
    publisher.publishResult({ callId: 'opaque-1', toolName: 'execute', output: { stdout: 'late' } });

    expect(sendAcp).toHaveBeenCalledTimes(4);
    const resultCalls = sendAcp.mock.calls.slice(1);
    const ids = resultCalls.map((call) => call[1].id);
    const localIds = resultCalls.map((call) => call[2].localId);
    expect(new Set(ids)).toHaveLength(1);
    expect(new Set(localIds)).toHaveLength(1);
  });

  it('bounds finalized tombstones and clears active state on disposal', () => {
    const publisher = createAcpToolCallRevisionPublisher({
      provider: 'cursor',
      namespace: { type: 'main' },
      sendAcp: vi.fn(),
      maxFinalizedCalls: 2,
    });
    for (const callId of ['one', 'two', 'three']) {
      publisher.publishCall({ callId, toolName: 'read', input: {} });
      publisher.publishResult({ callId, toolName: 'read', output: { ok: true } });
    }

    expect(publisher.finalizedSize).toBe(2);
    publisher.dispose();
    expect(publisher.activeSize).toBe(0);
    expect(publisher.finalizedSize).toBe(0);
  });

  it('does not replace a rich unfinished call with a synthetic empty call after later active calls', () => {
    const sendAcp = vi.fn();
    const publisher = createAcpToolCallRevisionPublisher({
      provider: 'cursor',
      namespace: { type: 'main' },
      sendAcp,
    });

    publisher.publishCall({
      callId: 'first',
      toolName: 'edit',
      input: { path: 'kept.ts', replacement: 'rich input' },
      revision: 1,
    });
    for (let index = 0; index < 2_000; index += 1) {
      publisher.publishCall({
        callId: `later-${index}`,
        toolName: 'read',
        input: { path: `${index}.ts` },
        revision: 1,
      });
    }
    publisher.publishResult({
      callId: 'first',
      toolName: 'edit',
      output: { ok: true },
    });

    const firstMessages = sendAcp.mock.calls
      .map((call) => call[1])
      .filter((message) => message.callId === 'first');
    expect(firstMessages).toEqual([
      expect.objectContaining({
        type: 'tool-call',
        name: 'edit',
        input: { path: 'kept.ts', replacement: 'rich input' },
      }),
      expect.objectContaining({
        type: 'tool-result',
        output: { ok: true },
      }),
    ]);
  });

  it('keeps captured-session-scale revisions at 271 call and 270 result identities', () => {
    const localIds: Array<{ type: string; localId: string }> = [];
    const publisher = createAcpToolCallRevisionPublisher({
      provider: 'cursor',
      namespace: { type: 'main' },
      sendAcp: (_provider, body, options) => {
        if (options?.localId) localIds.push({ type: body.type, localId: options.localId });
      },
    });

    for (let index = 0; index < 271; index += 1) {
      const callId = `logical-call-${index}`;
      publisher.publishCall({ callId, toolName: 'other', input: {} });
      publisher.publishCall({ callId, toolName: 'edit', input: { revision: 2 } });
      if (index < 270) publisher.publishResult({ callId, toolName: 'edit', output: { ok: true } });
    }

    const callIds = new Set(localIds.filter((entry) => entry.type === 'tool-call').map((entry) => entry.localId));
    const resultIds = new Set(localIds.filter((entry) => entry.type === 'tool-result').map((entry) => entry.localId));
    expect(callIds).toHaveLength(271);
    expect(resultIds).toHaveLength(270);
    expect([...callIds].some((id) => resultIds.has(id))).toBe(false);
  });
});
