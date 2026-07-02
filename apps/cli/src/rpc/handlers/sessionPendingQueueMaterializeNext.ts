import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';

import type { RpcHandlerRegistrar } from '@/api/rpc/types';
import type {
  MaterializeNextPendingResult,
} from '@/api/session/sessionClientPort';
import type { PendingQueueReconcileWhenEmpty } from '@/api/session/pendingQueueReadPolicy';
import type { SessionRuntimeControls } from './sessionControls';

export type SessionPendingQueueMaterializeNextResponse =
  | Readonly<{
      ok: true;
      didMaterialize: boolean;
      result: MaterializeNextPendingResult;
    }>
  | Readonly<{
      ok: false;
      error: 'pending_materializer_unavailable';
      errorCode: 'pending_materializer_unavailable';
    }>;

function readReconcileWhenEmpty(raw: unknown): PendingQueueReconcileWhenEmpty {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'force';
  const value = (raw as { reconcileWhenEmpty?: unknown }).reconcileWhenEmpty;
  return value === 'skip' || value === 'throttled' || value === 'force' ? value : 'force';
}

export function registerSessionPendingQueueMaterializeNextHandler(
  rpc: RpcHandlerRegistrar,
  opts: Readonly<{
    sessionRuntimeControls?: Pick<SessionRuntimeControls, 'materializeNextPendingMessageSafely'> | null;
  }>,
): void {
  rpc.registerHandler(SESSION_RPC_METHODS.SESSION_PENDING_QUEUE_MATERIALIZE_NEXT, async (
    raw: unknown,
  ): Promise<SessionPendingQueueMaterializeNextResponse> => {
    if (typeof opts.sessionRuntimeControls?.materializeNextPendingMessageSafely !== 'function') {
      return {
        ok: false,
        error: 'pending_materializer_unavailable',
        errorCode: 'pending_materializer_unavailable',
      };
    }

    return await opts.sessionRuntimeControls.materializeNextPendingMessageSafely({
      reconcileWhenEmpty: readReconcileWhenEmpty(raw),
    });
  });
}
