import {
  RPC_ERROR_CODES,
  RPC_ERROR_MESSAGES,
  parseSocketRpcAuthorizationContext,
  resolveSocketRpcSessionWriteAuthorizationMethod,
  type SocketRpcAuthorizationContext,
} from '@happier-dev/protocol';

type MachineRpcAuthorizationRequest = Readonly<{
  method: string;
  params: unknown;
  authorization?: SocketRpcAuthorizationContext;
}>;

type MachineRpcAuthorizationResult =
  | { ok: true }
  | { ok: false; error: string; errorCode: string };

function readSessionIdFromParams(params: unknown): string | null {
  if (!params || typeof params !== 'object') return null;
  const sessionId = (params as { sessionId?: unknown }).sessionId;
  if (typeof sessionId !== 'string') return null;
  const trimmed = sessionId.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function authorizeMachineRpcRequest(
  request: MachineRpcAuthorizationRequest,
): MachineRpcAuthorizationResult {
  const sessionWriteMethod = resolveSocketRpcSessionWriteAuthorizationMethod(request.method);
  if (!sessionWriteMethod) return { ok: true };

  const authorization = parseSocketRpcAuthorizationContext(request.authorization);
  const authorizedSessionId = authorization?.sessionId ?? null;
  const requestSessionId = readSessionIdFromParams(request.params);
  if (!authorizedSessionId || !requestSessionId || requestSessionId !== authorizedSessionId) {
    return {
      ok: false,
      error: RPC_ERROR_MESSAGES.FORBIDDEN,
      errorCode: RPC_ERROR_CODES.FORBIDDEN,
    };
  }

  return { ok: true };
}
