import { describe, expect, it, vi } from 'vitest';

vi.mock('@/ui/logger', () => {
  return { logger: { debug: vi.fn() } };
});

import { logger } from '@/ui/logger';

import type { AgentMessage } from '@/agent/core';
import type { TransportHandler } from '@/agent/transport';

import { handleAgentMessageChunk, handleAgentThoughtChunk } from '../messages';
import type { HandlerContext } from '../types';
import { createAcpToolCallLifecycle } from '../toolCalls/createAcpToolCallLifecycle';

function createHandlerContext(options?: Readonly<{
  transport?: Partial<TransportHandler>;
  toolCallCountSincePrompt?: number;
}>): Readonly<{
  ctx: HandlerContext;
  emitted: AgentMessage[];
  idleTimeoutMs: { current: number | null };
}> {
  const emitted: AgentMessage[] = [];
  const idleTimeoutMs = { current: null as number | null };
  const transport: TransportHandler = {
    agentName: 'test',
    getInitTimeout: () => 1_000,
    getToolPatterns: () => [],
    ...(options?.transport ?? {}),
  };

  const ctx: HandlerContext = {
    transport,
    toolCalls: createAcpToolCallLifecycle({
      transport,
      emit: (msg) => emitted.push(msg),
      getToolNameContext: () => ({
        recentPromptHadChangeTitle: false,
        toolCallCountSincePrompt: options?.toolCallCountSincePrompt ?? 0,
      }),
    }),
    idleTimeout: null,
    toolCallCountSincePrompt: options?.toolCallCountSincePrompt ?? 0,
    emit: (msg) => emitted.push(msg),
    emitIdleStatus: () => {},
    clearIdleTimeout: () => {},
    setIdleTimeout: (_callback, ms) => {
      idleTimeoutMs.current = ms;
    },
  };

  return { ctx, emitted, idleTimeoutMs };
}

describe('ACP update message handlers', () => {
  it('does not log message chunk contents', () => {
    const { ctx } = createHandlerContext();

    handleAgentMessageChunk({ content: { text: 'SUPER_SECRET_VALUE' } }, ctx);

    expect(JSON.stringify((logger as any).debug.mock.calls)).not.toContain('SUPER_SECRET_VALUE');
  });

  it('treats bold-header message chunks as model output (not thinking events)', () => {
    const { ctx, emitted } = createHandlerContext();
    const text = '**Question**\nPlease choose an option to continue.';

    const result = handleAgentMessageChunk(
      { content: { text } },
      ctx,
    );

    expect(result.handled).toBe(true);
    expect(emitted).toEqual([{ type: 'model-output', textDelta: text }]);
  });

  it('preserves newline-only message chunks as model output', () => {
    const { ctx, emitted } = createHandlerContext();
    const text = '\n\n';

    const result = handleAgentMessageChunk(
      { content: { text } },
      ctx,
    );

    expect(result.handled).toBe(true);
    expect(emitted).toEqual([{ type: 'model-output', textDelta: text }]);
  });

  it('emits ACP image content blocks as transient session media without interrupting text streaming', () => {
    const { ctx, emitted } = createHandlerContext();

    const result = handleAgentMessageChunk(
      {
        content: [
          { type: 'text', text: 'Generated image:' },
          { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png', uri: 'file:///tmp/generated.png' },
        ],
      },
      ctx,
    );

    expect(result.handled).toBe(true);
    expect(emitted[0]).toEqual({ type: 'model-output', textDelta: 'Generated image:' });
    expect(emitted[1]).toMatchObject({
      type: 'session-media',
      source: 'acp-content',
      media: [
        {
          kind: 'base64',
          data: 'iVBORw0KGgo=',
          mimeType: 'image/png',
          uri: 'file:///tmp/generated.png',
          origin: {
            source: 'acp-content',
            contentIndex: 1,
          },
        },
      ],
    });
  });

  it('records ACP audio blocks diagnostically without failing the turn', () => {
    const { ctx, emitted } = createHandlerContext();

    const result = handleAgentMessageChunk(
      { content: [{ type: 'audio', data: 'AAAA', mimeType: 'audio/wav' }] },
      ctx,
    );

    expect(result.handled).toBe(true);
    expect(emitted).toEqual([
      {
        type: 'event',
        name: 'session_media_diagnostics',
        payload: {
          diagnostics: [
            {
              code: 'unsupported_audio',
              contentIndex: 0,
              message: 'ACP/MCP audio content is diagnostic-only in this version',
            },
          ],
        },
      },
    ]);
  });

  it('rejects HTTP image URI blocks diagnostically without failing the turn', () => {
    const { ctx, emitted } = createHandlerContext();

    const result = handleAgentMessageChunk(
      { content: [{ type: 'image', uri: 'https://example.test/generated.png', mimeType: 'image/png' }] },
      ctx,
    );

    expect(result.handled).toBe(true);
    expect(emitted).toEqual([
      {
        type: 'event',
        name: 'session_media_diagnostics',
        payload: {
          diagnostics: [
            {
              code: 'http_uri_unavailable',
              contentIndex: 0,
              message: 'HTTP(S) media URI ingestion is unavailable in this version',
            },
          ],
        },
      },
    ]);
  });

  it('keeps explicit thought chunks mapped to thinking events', () => {
    const { ctx, emitted } = createHandlerContext();
    const text = 'reasoning content';

    const result = handleAgentThoughtChunk(
      { content: { text } },
      ctx,
    );

    expect(result.handled).toBe(true);
    expect(emitted).toEqual([{ type: 'event', name: 'thinking', payload: { text } }]);
  });

  it('arms the pre-tool idle timeout for thought chunks before the first tool call has started', () => {
    const { ctx, idleTimeoutMs } = createHandlerContext({
      transport: {
        getIdleTimeout: () => 500,
        getPreToolCallIdleTimeoutMs: () => 1_000,
      },
      toolCallCountSincePrompt: 0,
    });

    const result = handleAgentThoughtChunk(
      { content: { text: 'reasoning content' } },
      ctx,
    );

    expect(result.handled).toBe(true);
    expect(idleTimeoutMs.current).toBe(1_000);
  });

  it('falls back to the regular idle timeout for thought chunks after a tool call has started', () => {
    const { ctx, idleTimeoutMs } = createHandlerContext({
      transport: {
        getIdleTimeout: () => 500,
        getPreToolCallIdleTimeoutMs: () => 1_000,
      },
      toolCallCountSincePrompt: 1,
    });

    const result = handleAgentThoughtChunk(
      { content: { text: 'reasoning content' } },
      ctx,
    );

    expect(result.handled).toBe(true);
    expect(idleTimeoutMs.current).toBe(500);
  });

  it('uses the pre-tool idle timeout before the first tool call has started', () => {
    const { ctx, idleTimeoutMs } = createHandlerContext({
      transport: {
        getIdleTimeout: () => 500,
        getPreToolCallIdleTimeoutMs: () => 1_000,
      },
      toolCallCountSincePrompt: 0,
    });

    const result = handleAgentMessageChunk({ content: { text: 'Planning...' } }, ctx);

    expect(result.handled).toBe(true);
    expect(idleTimeoutMs.current).toBe(1_000);
  });

  it('falls back to the regular idle timeout after a tool call has started', () => {
    const { ctx, idleTimeoutMs } = createHandlerContext({
      transport: {
        getIdleTimeout: () => 500,
        getPreToolCallIdleTimeoutMs: () => 1_000,
      },
      toolCallCountSincePrompt: 1,
    });

    const result = handleAgentMessageChunk({ content: { text: 'Done.' } }, ctx);

    expect(result.handled).toBe(true);
    expect(idleTimeoutMs.current).toBe(500);
  });
});
