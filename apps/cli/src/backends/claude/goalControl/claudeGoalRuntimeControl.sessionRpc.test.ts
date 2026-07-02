import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import { describe, expect, it, vi } from 'vitest';

import type { RpcHandler, RpcHandlerRegistrar } from '@/api/rpc/types';
import { registerSessionControlHandlers } from '@/rpc/handlers/sessionControls';

import { createClaudeGoalRuntimeControls } from './claudeGoalRuntimeControl';

/**
 * Integration: an ACTIVE Claude session receives `SESSION_GOAL_SET` / `SESSION_GOAL_CLEAR` via the
 * live session RPC, which calls the registered Claude runtime controls, which inject a literal
 * `/goal` user turn. Only the arbiter boundary is mocked (`injectGoalCommand`).
 */
function createRegistrar(): { rpc: RpcHandlerRegistrar; handlers: Map<string, RpcHandler> } {
  const handlers = new Map<string, RpcHandler>();
  const rpc: RpcHandlerRegistrar = {
    registerHandler: (method, handler) => {
      handlers.set(method, handler as RpcHandler);
    },
  };
  return { rpc, handlers };
}

describe('Claude active-session goal live RPC', () => {
  it('injects `/goal <objective>` when SESSION_GOAL_SET is invoked', async () => {
    const injectGoalCommand = vi.fn(async () => ({ kind: 'sent-to-terminal' } as const));
    const { rpc, handlers } = createRegistrar();
    registerSessionControlHandlers(rpc, {
      getSessionMetadata: () => null,
      sessionRuntimeControls: createClaudeGoalRuntimeControls({ injectGoalCommand }),
    });

    const setHandler = handlers.get(SESSION_RPC_METHODS.SESSION_GOAL_SET);
    expect(setHandler).toBeTypeOf('function');
    const response = await setHandler?.({ objective: 'pursue the goal' });

    expect(injectGoalCommand).toHaveBeenCalledWith('/goal pursue the goal');
    // Success => the router keeps the live path and does not fall back to the metadata adapter.
    expect((response as { ok?: boolean }).ok).not.toBe(false);
  });

  it('injects `/goal clear` when SESSION_GOAL_CLEAR is invoked', async () => {
    const injectGoalCommand = vi.fn(async () => ({ kind: 'sent-to-terminal' } as const));
    const { rpc, handlers } = createRegistrar();
    registerSessionControlHandlers(rpc, {
      getSessionMetadata: () => null,
      sessionRuntimeControls: createClaudeGoalRuntimeControls({ injectGoalCommand }),
    });

    const clearHandler = handlers.get(SESSION_RPC_METHODS.SESSION_GOAL_CLEAR);
    await clearHandler?.({});

    expect(injectGoalCommand).toHaveBeenCalledWith('/goal clear');
  });
});
