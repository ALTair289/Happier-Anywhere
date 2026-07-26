import { describe, expect, it } from 'vitest';

import type { AgentMessage } from '@/agent/core';
import { defaultTransport } from '@/agent/transport';
import type { ACPMessageData } from '@/api/session/sessionMessageTypes';
import { handleToolCall, handleToolCallUpdate } from '@/agent/acp/sessionUpdateHandlers';
import type { HandlerContext } from '@/agent/acp/updates/types';
import { createAcpToolCallLifecycle } from '@/agent/acp/updates/toolCalls/createAcpToolCallLifecycle';

import { createAcpAgentMessageForwarder } from '../createAcpAgentMessageForwarder';

function createContext(emit: (message: AgentMessage) => void): HandlerContext {
  const toolCalls = createAcpToolCallLifecycle({
    transport: defaultTransport,
    emit,
    getToolNameContext: () => ({ recentPromptHadChangeTitle: false, toolCallCountSincePrompt: 0 }),
  });
  return {
    transport: defaultTransport,
    toolCalls,
    idleTimeout: null,
    toolCallCountSincePrompt: 0,
    emit,
    emitIdleStatus: () => undefined,
    clearIdleTimeout: () => undefined,
    setIdleTimeout: () => undefined,
  };
}

describe('ACP update lifecycle → stable transcript revision integration', () => {
  it('retains omitted snapshot fields, upgrades semantic identity, and uses one durable call localId', () => {
    const sent: Array<{ body: ACPMessageData; localId?: string }> = [];
    const forwarder = createAcpAgentMessageForwarder({
      provider: 'cursor',
      makeId: () => 'random-id',
      sendAcp: (_provider, body, options) => sent.push({ body, localId: options?.localId }),
    });
    const ctx = createContext(forwarder.forward);

    handleToolCall({
      sessionUpdate: 'tool_call',
      toolCallId: 'edit-1',
      title: 'Edit a.ts',
      kind: 'other',
      status: 'pending',
      rawInput: { path: 'a.ts' },
    }, ctx);
    handleToolCallUpdate({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'edit-1',
      kind: 'edit',
      status: 'in_progress',
      rawInput: { diff: '@@ -1 +1 @@' },
    }, ctx);
    handleToolCallUpdate({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'edit-1',
      status: 'completed',
      rawOutput: { ok: true },
    }, ctx);

    const callWrites = sent.filter((entry) => entry.body.type === 'tool-call');
    const resultWrites = sent.filter((entry) => entry.body.type === 'tool-result');
    expect(new Set(callWrites.map((entry) => entry.localId))).toHaveLength(1);
    expect(resultWrites).toHaveLength(1);
    const enriched = callWrites.at(-1)?.body;
    expect(enriched).toMatchObject({
      type: 'tool-call',
      name: 'edit',
      input: {
        diff: '@@ -1 +1 @@',
        _acp: { title: 'Edit a.ts', kind: 'edit' },
      },
    });
  });

  it('publishes a truthful synthetic result when a completed call has no provider output', () => {
    const sent: Array<{ body: ACPMessageData; localId?: string }> = [];
    const forwarder = createAcpAgentMessageForwarder({
      provider: 'cursor',
      makeId: () => 'random-id',
      sendAcp: (_provider, body, options) => sent.push({ body, localId: options?.localId }),
    });
    const ctx = createContext(forwarder.forward);

    handleToolCallUpdate({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'result-less-plan',
      title: 'Create plan',
      kind: 'other',
      status: 'completed',
    }, ctx);

    expect(sent.map((entry) => entry.body.type)).toEqual(['tool-call', 'tool-result']);
    expect(sent.at(-1)?.body).toMatchObject({
      type: 'tool-result',
      callId: 'result-less-plan',
      output: { status: 'completed' },
      isError: false,
    });
  });

  it('publishes a terminal-only call before its streamed terminal output', () => {
    const sent: Array<{ body: ACPMessageData; localId?: string }> = [];
    const forwarder = createAcpAgentMessageForwarder({
      provider: 'cursor',
      makeId: () => 'random-id',
      sendAcp: (_provider, body, options) => sent.push({ body, localId: options?.localId }),
    });
    const ctx = createContext(forwarder.forward);

    handleToolCallUpdate({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'terminal-only-exec',
      kind: 'execute',
      status: 'in_progress',
      meta: { terminal_output: { data: 'first chunk' } },
    }, ctx);

    expect(sent.map((entry) => entry.body.type)).toEqual(['tool-call', 'tool-result']);
  });

  it('retains terminal output carried by a completed terminal-only update', () => {
    const sent: Array<{ body: ACPMessageData; localId?: string }> = [];
    const forwarder = createAcpAgentMessageForwarder({
      provider: 'cursor',
      makeId: () => 'random-id',
      sendAcp: (_provider, body, options) => sent.push({ body, localId: options?.localId }),
    });
    const ctx = createContext(forwarder.forward);

    handleToolCallUpdate({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'terminal-complete-exec',
      kind: 'execute',
      status: 'completed',
      meta: { terminal_output: { data: 'final chunk' } },
    }, ctx);

    expect(sent.map((entry) => entry.body.type)).toEqual(['tool-call', 'tool-result']);
  });

  it('preserves exact opaque call ids instead of collapsing whitespace-distinct identities', () => {
    const sent: Array<{ body: ACPMessageData; localId?: string }> = [];
    const forwarder = createAcpAgentMessageForwarder({
      provider: 'cursor',
      makeId: () => 'random-id',
      sendAcp: (_provider, body, options) => sent.push({ body, localId: options?.localId }),
    });
    const ctx = createContext(forwarder.forward);

    for (const toolCallId of [' opaque\ncall ', 'opaque\ncall']) {
      handleToolCall({
        sessionUpdate: 'tool_call',
        toolCallId,
        kind: 'read',
        status: 'in_progress',
      }, ctx);
    }

    const calls = sent.filter((entry) => entry.body.type === 'tool-call');
    expect(calls.map((entry) => entry.body.type === 'tool-call' ? entry.body.callId : null))
      .toEqual([' opaque\ncall ', 'opaque\ncall']);
    expect(new Set(calls.map((entry) => entry.localId))).toHaveLength(2);
  });
});
