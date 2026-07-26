import { describe, expect, it, vi } from 'vitest';

import { AcpBackend } from '../AcpBackend';
import { defaultTransport } from '../../transport';
import { logger } from '@/ui/logger';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createAcpToolCallLifecycle } from '../updates/toolCalls/createAcpToolCallLifecycle';

const envScope = createEnvKeyScope(['HAPPIER_ACP_MAX_UPDATES_PER_NOTIFICATION']);

describe('AcpBackend session/update max updates guard', () => {
  it('truncates excessive updates per notification using an env override', () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    envScope.patch({ HAPPIER_ACP_MAX_UPDATES_PER_NOTIFICATION: '1' });
    try {
      const emitted: any[] = [];
      const toolCalls = createAcpToolCallLifecycle({
        transport: defaultTransport,
        emit: (msg) => emitted.push(msg),
        getToolNameContext: () => ({ recentPromptHadChangeTitle: false, toolCallCountSincePrompt: 0 }),
      });
      const fakeBackend: any = {
        options: { agentName: 'test' },
        transport: defaultTransport,
        replayCapture: null,
        sessionUpdateShapeLogger: { log: () => {} },
        toolCalls,
        idleTimeout: null,
        turnGeneration: 1,
        dispatchedPromptTurnGeneration: 1,
        toolCallCountSincePrompt: 0,
        emit: (msg: any) => emitted.push(msg),
        emitIdleStatus: () => emitted.push({ type: 'status', status: 'idle' }),
        isCurrentTurnGenerationClosed: () => false,
      };
      fakeBackend.filterPromptTurnUpdatesByDispatch = (AcpBackend as any).prototype.filterPromptTurnUpdatesByDispatch;
      fakeBackend.createHandlerContext = (AcpBackend as any).prototype.createHandlerContext;

      const handleSessionUpdate = (AcpBackend as any).prototype.handleSessionUpdate as (params: any) => void;
      handleSessionUpdate.call(fakeBackend, {
        updates: [
          {
            sessionUpdate: 'tool_call',
            toolCallId: 'call_1',
            status: 'in_progress',
            kind: 'execute',
            title: 'Run 1',
            content: { command: 'echo 1' },
          },
          {
            sessionUpdate: 'tool_call',
            toolCallId: 'call_2',
            status: 'in_progress',
            kind: 'execute',
            title: 'Run 2',
            content: { command: 'echo 2' },
          },
        ],
      });

      expect(toolCalls.get('call_1')).not.toBeNull();
      expect(toolCalls.get('call_2')).toBeNull();
      expect(emitted.filter((m) => m.type === 'tool-call').length).toBe(1);
      expect(warnSpy).toHaveBeenCalledTimes(1);
    } finally {
      envScope.restore();
      warnSpy.mockRestore();
    }
  });

  it('captures replay updates before the live prompt-generation filter rejects them', async () => {
    const captured: unknown[] = [];
    const fakeBackend: any = {
      options: { agentName: 'test' },
      replayCapture: { handleUpdate: (update: unknown) => captured.push(update) },
      sessionUpdateShapeLogger: { log: () => {} },
      waitingForResponse: false,
      turnGeneration: 0,
      dispatchedPromptTurnGeneration: null,
      filterPromptTurnUpdatesByDispatch: (AcpBackend as any).prototype.filterPromptTurnUpdatesByDispatch,
    };

    await (AcpBackend as any).prototype.handleSessionUpdate.call(fakeBackend, {
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'restored transcript' },
      },
    });

    expect(captured).toEqual([
      expect.objectContaining({ sessionUpdate: 'agent_message_chunk' }),
    ]);
  });
});
