import { describe, expect, it, vi } from 'vitest';

vi.mock('@/ui/logger', () => {
  return { logger: { debug: vi.fn() } };
});

import { logger } from '@/ui/logger';
import { createGeminiBackendMessageHandler } from './createGeminiBackendMessageHandler';

describe('createGeminiBackendMessageHandler (logging)', () => {
  it('does not log tool call objectives verbatim', () => {
    const session = {
      sendAgentMessage: vi.fn(),
      keepAlive: vi.fn(),
    } as any;
    const messageBuffer = { addMessage: vi.fn() } as any;
    const state = {
      thinking: false,
      accumulatedResponse: '',
      isResponseInProgress: false,
      hadToolCallInTurn: false,
      changeTitleCompleted: false,
      availableCommands: [],
    } as any;
    const diffProcessor = {
      processToolResult: vi.fn(),
      processFsEdit: vi.fn(),
    } as any;

    const handler = createGeminiBackendMessageHandler({
      session,
      messageBuffer,
      state,
      diffProcessor,
    });

    handler({
      type: 'tool-call',
      toolName: 'codebase_investigator',
      callId: 'c1',
      args: { objective: 'SUPER_SECRET_OBJECTIVE' },
    } as any);

    expect(JSON.stringify((logger as any).debug.mock.calls)).not.toContain('SUPER_SECRET_OBJECTIVE');
  });

  it('forwards stable ACP transcript identity options to the session writer', () => {
    const session = { sendAgentMessage: vi.fn(), keepAlive: vi.fn() } as any;
    const handler = createGeminiBackendMessageHandler({
      session,
      messageBuffer: { addMessage: vi.fn() } as any,
      state: {
        thinking: false,
        accumulatedResponse: '',
        isResponseInProgress: false,
        hadToolCallInTurn: false,
        changeTitleCompleted: false,
        availableCommands: [],
      } as any,
      diffProcessor: { processToolResult: vi.fn(), processFsEdit: vi.fn() } as any,
    });

    handler({ type: 'tool-call', toolName: 'read', callId: 'same-call', args: { path: 'a' } } as any);
    handler({ type: 'tool-call', toolName: 'read', callId: 'same-call', args: { path: 'b' } } as any);

    const options = session.sendAgentMessage.mock.calls.map((call: unknown[]) => call[2]);
    expect(options[0]?.localId).toBeTruthy();
    expect(options[1]?.localId).toBe(options[0]?.localId);
  });
});
