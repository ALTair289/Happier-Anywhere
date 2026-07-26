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
    revision?: number;
    sidechainId?: string;
  }>): boolean;
  publishResult(params: Readonly<{
    callId: string;
    toolName: string;
    input?: unknown;
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
  const activeCallIds = new Map<string, number | null>();
  const finalizedCallIds = new Map<string, number | null>();
  const maxFinalizedCalls = Math.max(1, Math.trunc(params.maxFinalizedCalls ?? 1_000));
  let disposed = false;

  const rememberFinalized = (callId: string, revision: number | null): void => {
    // Updating an existing value intentionally preserves its original bounded-tombstone order.
    finalizedCallIds.set(callId, revision);
    while (finalizedCallIds.size > maxFinalizedCalls) {
      const oldest = finalizedCallIds.keys().next().value;
      if (typeof oldest !== 'string') break;
      finalizedCallIds.delete(oldest);
    }
  };

  const publishCall = (call: Readonly<{
    callId: string;
    toolName: string;
    input: unknown;
    revision?: number;
    sidechainId?: string;
  }>): boolean => {
    if (disposed) return false;
    const revision = typeof call.revision === 'number' && Number.isSafeInteger(call.revision) && call.revision > 0
      ? call.revision
      : null;
    const finalizedRevision = finalizedCallIds.get(call.callId);
    if (finalizedCallIds.has(call.callId)) {
      if (
        revision === null
        || finalizedRevision === null
        || finalizedRevision === undefined
        || revision <= finalizedRevision
      ) {
        return false;
      }
      const localId = createToolCallTranscriptIdentity({
        provider: params.provider,
        namespace: params.namespace,
        toolCallId: call.callId,
        message: 'call',
      });
      params.sendAcp(params.provider, {
        type: 'tool-call',
        callId: call.callId,
        name: call.toolName,
        input: call.input,
        id: localId,
        ...(call.sidechainId ? { sidechainId: call.sidechainId } : {}),
      }, { localId });
      finalizedCallIds.set(call.callId, revision);
      return true;
    }
    const previousRevision = activeCallIds.get(call.callId);
    if (
      (typeof previousRevision === 'number' && revision === null)
      || (typeof previousRevision === 'number' && revision !== null && revision <= previousRevision)
    ) {
      return false;
    }
    const localId = createToolCallTranscriptIdentity({
      provider: params.provider,
      namespace: params.namespace,
      toolCallId: call.callId,
      message: 'call',
    });
    activeCallIds.delete(call.callId);
    activeCallIds.set(call.callId, revision);
    params.sendAcp(params.provider, {
      type: 'tool-call',
      callId: call.callId,
      name: call.toolName,
      input: call.input,
      id: localId,
      ...(call.sidechainId ? { sidechainId: call.sidechainId } : {}),
    }, { localId });
    return true;
  };

  return {
    publishCall,
    publishResult(result) {
      if (disposed || finalizedCallIds.has(result.callId)) return false;
      const activeRevision = activeCallIds.get(result.callId) ?? null;
      if (!activeCallIds.has(result.callId)) {
        publishCall({
          callId: result.callId,
          toolName: result.toolName,
          input: result.input ?? {},
          ...(result.sidechainId ? { sidechainId: result.sidechainId } : {}),
        });
      }
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
        rememberFinalized(result.callId, activeRevision);
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
