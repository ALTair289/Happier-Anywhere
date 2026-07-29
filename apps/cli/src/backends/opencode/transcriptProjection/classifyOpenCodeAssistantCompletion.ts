import { classifyOpenCodeMessageForProjection } from './classifyOpenCodeMessageForProjection';
import {
  normalizeOpenCodeProjectionLowerString,
  normalizeOpenCodeProjectionString,
  readOpenCodeNestedRecord,
  readOpenCodeTimestampMs,
} from './openCodeProjectionParsing';
import type { OpenCodeAssistantCompletion } from './openCodeTranscriptProjectionTypes';
import { readNonBlankOpaqueIdentifier } from '@/utils/opaqueIdentifiers';

const CONTINUATION_FINISHES = new Set([
  'tool-calls',
  'tool_calls',
  'function-call',
  'function_call',
  'continue',
]);

const TERMINAL_SUCCESS_FINISHES = new Set([
  'stop',
  'end-turn',
  'end_turn',
  'complete',
  'completed',
  'success',
  'length',
]);

function normalizeFinish(value: unknown): string | null {
  const finish = normalizeOpenCodeProjectionLowerString(value);
  return finish ? finish : null;
}

export function classifyOpenCodeAssistantCompletion(messageOrInfo: unknown): OpenCodeAssistantCompletion {
  const projection = classifyOpenCodeMessageForProjection(messageOrInfo);
  const info = projection.info;
  const finish = normalizeFinish(info?.finish);
  const messageId = projection.messageId || readNonBlankOpaqueIdentifier(normalizeOpenCodeProjectionString(info?.id)) || '';

  if (projection.kind === 'compaction_internal' || projection.kind === 'ignored_internal') {
    return { kind: 'ignored_internal', messageId, completedAtMs: null, finish };
  }

  if (projection.kind !== 'assistant_transcript') {
    return { kind: 'non_terminal', messageId, completedAtMs: null, finish };
  }

  // Provider failures are settled by the runtime's existing session-error or authoritative-history
  // reconciliation owner. Never let a completed error envelope manufacture terminal success first.
  if (info?.error != null) {
    return { kind: 'non_terminal', messageId, completedAtMs: null, finish };
  }

  if (finish && CONTINUATION_FINISHES.has(finish)) {
    return { kind: 'continuation', messageId, completedAtMs: null, finish };
  }

  const time = readOpenCodeNestedRecord(info, 'time');
  const completedAtMs = readOpenCodeTimestampMs(time?.completed, { allowSecondsNumber: false });
  if (completedAtMs === null) {
    return { kind: 'non_terminal', messageId, completedAtMs: null, finish };
  }

  if (finish && !TERMINAL_SUCCESS_FINISHES.has(finish)) {
    return { kind: 'non_terminal', messageId, completedAtMs, finish };
  }

  return { kind: 'terminal_success', messageId, completedAtMs, finish };
}
