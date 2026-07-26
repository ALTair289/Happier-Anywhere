import { describe, expect, it } from 'vitest';

import type { AgentMessage } from '@/agent/core';
import type { TransportHandler } from '@/agent/transport';

import { handleCurrentModeUpdate, handleSessionInfoUpdate, handleThinkingUpdate } from '../events';
import type { HandlerContext } from '../types';
import { createAcpToolCallLifecycle } from '../toolCalls/createAcpToolCallLifecycle';

function createHandlerContext(): Readonly<{
  ctx: HandlerContext;
  emitted: AgentMessage[];
}> {
  const emitted: AgentMessage[] = [];
  const transport: TransportHandler = {
    agentName: 'test',
    getInitTimeout: () => 1_000,
    getToolPatterns: () => [],
  };

  const ctx: HandlerContext = {
    transport,
    toolCalls: createAcpToolCallLifecycle({
      transport,
      emit: (msg) => emitted.push(msg),
      getToolNameContext: () => ({ recentPromptHadChangeTitle: false, toolCallCountSincePrompt: 0 }),
    }),
    idleTimeout: null,
    toolCallCountSincePrompt: 0,
    emit: (msg) => emitted.push(msg),
    emitIdleStatus: () => {},
    clearIdleTimeout: () => {},
    setIdleTimeout: () => {},
  };

  return { ctx, emitted };
}

describe('handleThinkingUpdate', () => {
  it('normalizes string thinking payloads into a {text} object', () => {
    const { ctx, emitted } = createHandlerContext();
    const result = handleThinkingUpdate({ thinking: 'Hello' }, ctx);
    expect(result.handled).toBe(true);
    expect(emitted).toEqual([{ type: 'event', name: 'thinking', payload: { text: 'Hello' } }]);
  });

  it('normalizes object thinking payloads with message into text', () => {
    const { ctx, emitted } = createHandlerContext();
    const result = handleThinkingUpdate({ thinking: { message: 'Hello' } }, ctx);
    expect(result.handled).toBe(true);
    expect(emitted).toEqual([{ type: 'event', name: 'thinking', payload: { text: 'Hello' } }]);
  });
});

describe('handleSessionInfoUpdate', () => {
  it('preserves directionally meaningful partial fields and explicit clears', () => {
    const { ctx, emitted } = createHandlerContext();

    expect(handleSessionInfoUpdate({
      sessionUpdate: 'session_info_update',
      title: null,
      updatedAt: '2026-07-11T10:00:00.000Z',
      _meta: { privateProviderPayload: 'must not be forwarded' },
    }, ctx)).toEqual({ handled: true });

    expect(emitted).toEqual([{
      type: 'event',
      name: 'session_info_update',
      payload: { title: null, updatedAt: '2026-07-11T10:00:00.000Z' },
    }]);
  });

  it('handles malformed fields without forwarding unbounded provider payloads', () => {
    const { ctx, emitted } = createHandlerContext();
    expect(handleSessionInfoUpdate({
      sessionUpdate: 'session_info_update',
      title: 'x'.repeat(1_025),
      updatedAt: 'not-a-timestamp',
      _meta: { nested: { secret: 'provider-private' } },
    }, ctx)).toEqual({ handled: true });
    expect(emitted).toEqual([]);
  });

  it('keeps a valid partial title when a date-like but non-ISO timestamp is rejected', () => {
    const { ctx, emitted } = createHandlerContext();
    expect(handleSessionInfoUpdate({
      sessionUpdate: 'session_info_update',
      title: 'Provider title',
      updatedAt: 'July 11, 2026',
    }, ctx)).toEqual({ handled: true });
    expect(emitted).toEqual([{
      type: 'event',
      name: 'session_info_update',
      payload: { title: 'Provider title' },
    }]);
  });
});

describe('handleCurrentModeUpdate directionality', () => {
  it('accepts currentModeId and does not treat outbound modeId as an inbound alias', () => {
    const valid = createHandlerContext();
    expect(handleCurrentModeUpdate({ currentModeId: 'plan' }, valid.ctx)).toEqual({ handled: true });
    expect(valid.emitted).toEqual([{
      type: 'event',
      name: 'current_mode_update',
      payload: { currentModeId: 'plan' },
    }]);

    const crossDirection = createHandlerContext();
    expect(handleCurrentModeUpdate({ modeId: 'code' }, crossDirection.ctx)).toEqual({ handled: false });
    expect(crossDirection.emitted).toEqual([]);

    const malformed = createHandlerContext();
    expect(handleCurrentModeUpdate({ currentModeId: '   ' }, malformed.ctx)).toEqual({ handled: false });
    expect(malformed.emitted).toEqual([]);
  });

  it('preserves the exact nonblank provider-owned currentModeId bytes', () => {
    const { ctx, emitted } = createHandlerContext();
    expect(handleCurrentModeUpdate({ currentModeId: ' plan\t' }, ctx)).toEqual({ handled: true });
    expect(emitted).toEqual([{
      type: 'event',
      name: 'current_mode_update',
      payload: { currentModeId: ' plan\t' },
    }]);
  });
});
