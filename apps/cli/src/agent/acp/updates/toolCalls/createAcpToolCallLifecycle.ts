import type { AgentMessage } from '@/agent/core';
import type { ToolNameContext, TransportHandler } from '@/agent/transport';

import { DEFAULT_TOOL_CALL_TIMEOUT_MS } from '../types';
import { createAcpToolCallTracker, type AcpToolCallTracker } from './AcpToolCallTracker';
import { buildToolNameInferenceInput, isGenericToolCallIdentity } from './resolveToolCallIdentity';
import {
  emitAcpToolCallPublication,
  emitAcpToolResultPublication,
} from './toolCallMessages';
import type { AcpToolCallCloseReason } from './types';

export function createAcpToolCallLifecycle(params: Readonly<{
  transport: TransportHandler;
  emit: (message: AgentMessage) => void;
  getToolNameContext: () => ToolNameContext;
  onCallClosed?: (event: Readonly<{
    callId: string;
    reason: AcpToolCallCloseReason;
    activeSize: number;
  }>) => void;
}>): AcpToolCallTracker {
  let tracker: AcpToolCallTracker;
  tracker = createAcpToolCallTracker({
    determineToolName: ({ callId, currentName, snapshot }) => {
      const snapshotKind = typeof snapshot.kind === 'string' ? snapshot.kind.trim() : '';
      const baseName = params.transport.extractToolNameFromId?.(callId)
        ?? (snapshotKind && !isGenericToolCallIdentity(snapshotKind) ? snapshotKind : currentName);
      return params.transport.determineToolName?.(
        baseName,
        callId,
        buildToolNameInferenceInput(snapshot),
        params.getToolNameContext(),
      ) ?? baseName;
    },
    publishCall: (publication) => emitAcpToolCallPublication(publication, params.emit),
    publishResult: (publication) => emitAcpToolResultPublication(publication, params.emit),
    resolveTimeoutMs: (publication) => params.transport.getToolCallTimeout
      ? params.transport.getToolCallTimeout(
        publication.callId,
        typeof publication.snapshot.kind === 'string' ? publication.snapshot.kind : publication.toolName,
      )
      : DEFAULT_TOOL_CALL_TIMEOUT_MS,
    scheduleTimer: (callback, delayMs) => {
      const timer = setTimeout(callback, delayMs);
      timer.unref?.();
      return timer;
    },
    clearTimer: clearTimeout,
    onCallClosed: ({ callId, reason }) => {
      params.onCallClosed?.({ callId, reason, activeSize: tracker.activeSize });
    },
  });
  return tracker;
}
