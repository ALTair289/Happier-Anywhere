import type { ACPProvider } from '@/api/session/sessionMessageTypes';

import type { AcpSendFn } from './acpSessionForwarding';
import {
  createToolCallTranscriptIdentity,
  type ToolCallTranscriptNamespace,
} from './toolCallTranscriptIdentity';

export type AcpToolCallRevisionPublisher = Readonly<{
  publishCall(params: Readonly<{
    callId: string;
    toolName: string;
    input: unknown;
    sidechainId?: string;
  }>): boolean;
  publishResult(params: Readonly<{
    callId: string;
    output: unknown;
    isError?: boolean;
    sidechainId?: string;
    meta?: Record<string, unknown>;
  }>): boolean;
  dispose(): void;
  readonly activeSize: number;
  readonly finalizedSize: number;
}>;

function isStreamingResult(output: unknown): boolean {
  return !!output
    && typeof output === 'object'
    && !Array.isArray(output)
    && (output as { _stream?: unknown })._stream === true;
}

export function createAcpToolCallRevisionPublisher(params: Readonly<{
  provider: ACPProvider;
  namespace: ToolCallTranscriptNamespace;
  sendAcp: AcpSendFn;
  maxFinalizedCalls?: number;
}>): AcpToolCallRevisionPublisher {
  const activeCallIds = new Set<string>();
  const finalizedCallIds = new Map<string, true>();
  const maxFinalizedCalls = Math.max(1, Math.trunc(params.maxFinalizedCalls ?? 1_000));
  let disposed = false;

  const rememberFinalized = (callId: string): void => {
    finalizedCallIds.delete(callId);
    finalizedCallIds.set(callId, true);
    while (finalizedCallIds.size > maxFinalizedCalls) {
      const oldest = finalizedCallIds.keys().next().value;
      if (typeof oldest !== 'string') break;
      finalizedCallIds.delete(oldest);
    }
  };

  return {
    publishCall(call) {
      if (disposed || finalizedCallIds.has(call.callId)) return false;
      const localId = createToolCallTranscriptIdentity({
        provider: params.provider,
        namespace: params.namespace,
        toolCallId: call.callId,
        message: 'call',
      });
      activeCallIds.add(call.callId);
      params.sendAcp(params.provider, {
        type: 'tool-call',
        callId: call.callId,
        name: call.toolName,
        input: call.input,
        id: localId,
        ...(call.sidechainId ? { sidechainId: call.sidechainId } : {}),
      }, { localId });
      return true;
    },
    publishResult(result) {
      if (disposed || finalizedCallIds.has(result.callId)) return false;
      const localId = createToolCallTranscriptIdentity({
        provider: params.provider,
        namespace: params.namespace,
        toolCallId: result.callId,
        message: 'result',
      });
      params.sendAcp(
        params.provider,
        {
          type: 'tool-result',
          callId: result.callId,
          output: result.output,
          id: localId,
          ...(result.isError !== undefined ? { isError: result.isError } : {}),
          ...(result.sidechainId ? { sidechainId: result.sidechainId } : {}),
        },
        {
          localId,
          ...(result.meta ? { meta: result.meta } : {}),
        },
      );
      if (!isStreamingResult(result.output)) {
        activeCallIds.delete(result.callId);
        rememberFinalized(result.callId);
      }
      return true;
    },
    dispose() {
      disposed = true;
      activeCallIds.clear();
      finalizedCallIds.clear();
    },
    get activeSize() {
      return activeCallIds.size;
    },
    get finalizedSize() {
      return finalizedCallIds.size;
    },
  };
}
