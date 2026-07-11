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

  it('separates call and result identities and ignores late call/result duplicates after terminalization', () => {
    const sendAcp = vi.fn();
    const publisher = createAcpToolCallRevisionPublisher({
      provider: 'cursor',
      namespace: { type: 'main' },
      sendAcp,
    });
    publisher.publishCall({ callId: 'opaque-1', toolName: 'edit', input: {} });
    publisher.publishResult({ callId: 'opaque-1', output: { ok: true } });
    publisher.publishCall({ callId: 'opaque-1', toolName: 'late-edit', input: { stale: true } });
    publisher.publishResult({ callId: 'opaque-1', output: { ok: false }, isError: true });

    expect(sendAcp).toHaveBeenCalledTimes(2);
    const call = sendAcp.mock.calls[0]![1];
    const result = sendAcp.mock.calls[1]![1];
    expect(call.id).not.toBe(result.id);
    expect(result).toMatchObject({ type: 'tool-result', callId: 'opaque-1', output: { ok: true } });
  });

  it('revises streaming results in place until the first terminal result', () => {
    const sendAcp = vi.fn();
    const publisher = createAcpToolCallRevisionPublisher({
      provider: 'cursor',
      namespace: { type: 'main' },
      sendAcp,
    });
    publisher.publishResult({ callId: 'opaque-1', output: { stdoutChunk: 'a', _stream: true } });
    publisher.publishResult({ callId: 'opaque-1', output: { stdoutChunk: 'ab', _stream: true } });
    publisher.publishResult({ callId: 'opaque-1', output: { stdout: 'ab' } });
    publisher.publishResult({ callId: 'opaque-1', output: { stdout: 'late' } });

    expect(sendAcp).toHaveBeenCalledTimes(3);
    const ids = sendAcp.mock.calls.map((call) => call[1].id);
    const localIds = sendAcp.mock.calls.map((call) => call[2].localId);
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
      publisher.publishResult({ callId, output: { ok: true } });
    }

    expect(publisher.finalizedSize).toBe(2);
    publisher.dispose();
    expect(publisher.activeSize).toBe(0);
    expect(publisher.finalizedSize).toBe(0);
  });
});
