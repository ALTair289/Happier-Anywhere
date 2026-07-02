import { describe, expect, it, vi } from 'vitest';

import type { RpcHandler, RpcHandlerRegistrar } from '@/api/rpc/types';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';

import { registerSessionHandlers } from './registerSessionHandlers';

function createRegistrar(): { handlers: Map<string, RpcHandler>; registrar: RpcHandlerRegistrar } {
  const handlers = new Map<string, RpcHandler>();
  return {
    handlers,
    registrar: {
      registerHandler(method, handler) {
        handlers.set(method, handler);
      },
    },
  };
}

describe('registerSessionHandlers pending queue materialization', () => {
  it('exposes a retryable pending materializer RPC even before the safe materializer owner is ready', async () => {
    const { handlers, registrar } = createRegistrar();

    registerSessionHandlers(registrar, process.cwd());

    expect(handlers.has(SESSION_RPC_METHODS.SESSION_PENDING_QUEUE_MATERIALIZE_NEXT)).toBe(true);
    await expect(handlers.get(SESSION_RPC_METHODS.SESSION_PENDING_QUEUE_MATERIALIZE_NEXT)?.({
      reconcileWhenEmpty: 'force',
    })).resolves.toEqual({
      ok: false,
      error: 'pending_materializer_unavailable',
      errorCode: 'pending_materializer_unavailable',
    });
  });

  it('delegates pending materialization RPC through session runtime controls', async () => {
    const { handlers, registrar } = createRegistrar();
    const materializeNextPendingMessageSafely = vi.fn(async () => ({
      ok: true as const,
      didMaterialize: true,
      result: {
        type: 'materialized' as const,
        localId: 'local-1',
        seq: 3,
        content: { t: 'plain' as const, v: { text: 'hello' } },
      },
    }));

    registerSessionHandlers(registrar, process.cwd(), {
      sessionRuntimeControls: {
        materializeNextPendingMessageSafely,
      },
    });

    await expect(handlers.get(SESSION_RPC_METHODS.SESSION_PENDING_QUEUE_MATERIALIZE_NEXT)?.({
      reconcileWhenEmpty: 'force',
    })).resolves.toMatchObject({
      ok: true,
      didMaterialize: true,
      result: {
        type: 'materialized',
        localId: 'local-1',
        seq: 3,
      },
    });
    expect(materializeNextPendingMessageSafely).toHaveBeenCalledWith({ reconcileWhenEmpty: 'force' });
  });
});
