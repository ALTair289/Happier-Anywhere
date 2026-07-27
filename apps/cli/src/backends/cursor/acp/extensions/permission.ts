import type {
  AcpExtensionHandlerContext,
  AcpPermissionHandler,
} from '@/agent/acp/AcpBackend';

export type CursorPermissionDecision = Awaited<ReturnType<AcpPermissionHandler['handleToolCall']>>;

export function isApprovedCursorPermission(decision: CursorPermissionDecision): boolean {
  return decision.decision === 'approved'
    || decision.decision === 'approved_for_session'
    || decision.decision === 'approved_execpolicy_amendment';
}

export function isCursorExtensionCancellation(
  error: unknown,
  context: AcpExtensionHandlerContext,
): boolean {
  return context.signal.aborted || (error instanceof Error && error.name === 'AbortError');
}

export async function awaitCursorPermissionDecision(
  startDecision: () => Promise<CursorPermissionDecision>,
  context: AcpExtensionHandlerContext,
): Promise<CursorPermissionDecision> {
  if (context.signal.aborted) {
    throw context.signal.reason instanceof Error
      ? context.signal.reason
      : new Error('Cursor extension request aborted');
  }

  const promise = startDecision();

  return await new Promise<CursorPermissionDecision>((resolve, reject) => {
    let settled = false;
    const settle = (complete: () => void): void => {
      if (settled) return;
      settled = true;
      context.signal.removeEventListener('abort', onAbort);
      complete();
    };
    const onAbort = () => {
      settle(() => reject(context.signal.reason instanceof Error
        ? context.signal.reason
        : new Error('Cursor extension request aborted')));
    };
    context.signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (decision) => settle(() => resolve(decision)),
      (error) => settle(() => reject(error)),
    );
  });
}
