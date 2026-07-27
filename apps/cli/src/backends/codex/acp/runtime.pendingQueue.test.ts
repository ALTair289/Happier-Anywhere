import { describe, expect, it, vi } from 'vitest';

import type { AgentBackend, AgentMessageHandler } from '@/agent/core';
import type { ApiSessionClient } from '@/api/session/sessionClient';
import type { MaterializeNextPendingResult } from '@/api/session/sessionClientPort';
import type { Metadata } from '@/api/types';
import type { AcpPermissionHandler } from '@/agent/acp/AcpBackend';
import type { MessageBuffer } from '@/ui/ink/messageBuffer';
import type { CodexAcpBackendOptions, CodexAcpBackendResult } from './backend';
import { createSessionProviderInputConsumerFixture } from '@/testkit/backends/catalogAcpRuntime';

function makeFakeBackend() {
  const handlers: AgentMessageHandler[] = [];
  const backend: AgentBackend = {
    async startSession() {
      return { sessionId: 'codex-acp-session-1' };
    },
    async sendPrompt() {},
    async cancel() {},
    onMessage(handler: AgentMessageHandler) {
      handlers.push(handler);
    },
    async dispose() {
      handlers.length = 0;
    },
  };
  return backend;
}

vi.mock('@/backends/codex/acp/backend', async () => {
  const actual = await vi.importActual<typeof import('./backend')>('@/backends/codex/acp/backend');
  return {
    ...actual,
    createCodexAcpBackend: (_opts: CodexAcpBackendOptions): CodexAcpBackendResult => ({
      backend: makeFakeBackend(),
      spawn: { command: 'codex-acp', args: [] },
    }),
  };
});

describe('Codex ACP runtime pending queue wiring', () => {
  it('drains pending messages through the injected full input consumer', async () => {
    let metadata = {} as Metadata;
    const materializeNextPendingMessageSafely = vi
      .fn<() => Promise<MaterializeNextPendingResult>>()
      .mockResolvedValue({ type: 'no_pending' });
    const popPendingMessage = vi.fn(async () => {
      throw new Error('legacy popPendingMessage should not be called by Codex ACP runtime');
    });

    const session: Pick<
      ApiSessionClient,
      | 'sessionId'
      | 'sendAgentMessage'
      | 'updateMetadata'
      | 'getMetadataSnapshot'
      | 'keepAlive'
      | 'waitForMetadataUpdate'
      | 'materializeNextPendingMessageSafely'
      | 'popPendingMessage'
      | 'shouldAttemptPendingMaterialization'
      | 'reconcilePendingQueueState'
    > = {
      sessionId: 'happier-session-1',
      sendAgentMessage(_provider, _body, _opts) {},
      async updateMetadata(updater) {
        metadata = updater(metadata);
      },
      getMetadataSnapshot() {
        return metadata;
      },
      keepAlive(_thinking, _mode) {},
      waitForMetadataUpdate: async () => false,
      materializeNextPendingMessageSafely,
      popPendingMessage,
      shouldAttemptPendingMaterialization: () => true,
      reconcilePendingQueueState: vi.fn(async () => false),
    };

    const messageBuffer: Pick<MessageBuffer, 'addMessage' | 'removeLastMessage' | 'updateLastMessage'> = {
      addMessage(_content, _type) {},
      removeLastMessage(_type) {
        return false;
      },
      updateLastMessage(_contentDelta, _type) {},
    };
    const permissionHandler: Pick<AcpPermissionHandler, 'handleToolCall'> = {
      handleToolCall: async (_toolCallId, _toolName, _input) => ({ decision: 'approved' }),
    };
    const providerInputConsumer = createSessionProviderInputConsumerFixture();
    const drainPending = vi.spyOn(providerInputConsumer, 'drainPending');

    const { createCodexAcpRuntime } = await import('./runtime');
    const runtime = createCodexAcpRuntime({
      directory: '/tmp',
      session: session as ApiSessionClient,
      messageBuffer: messageBuffer as MessageBuffer,
      mcpServers: {},
      permissionHandler: permissionHandler as AcpPermissionHandler,
      onThinkingChange() {},
      permissionMode: 'default',
      providerInputConsumer,
    });

    await expect(runtime.startOrLoad({ resumeId: null })).resolves.toBe('codex-acp-session-1');
    expect(drainPending).toHaveBeenCalledWith(expect.objectContaining({
      abortSignal: expect.any(AbortSignal),
      logPrefix: '[ACP]',
      reason: 'acp-pending-pump',
    }));
    expect(materializeNextPendingMessageSafely).not.toHaveBeenCalled();
    expect(popPendingMessage).not.toHaveBeenCalled();

    await runtime.reset();
  });
});
