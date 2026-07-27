import type { SessionEventMessage } from '@/api/session/sessionMessageTypes';

export type ClaudeCompletionEvent = string | SessionEventMessage;

export function buildClaudeCompactionLifecycleId(params: Readonly<{
  sessionId: string | null | undefined;
  sequence: number;
}>): string {
  const sessionPart = typeof params.sessionId === 'string' && params.sessionId.trim()
    ? params.sessionId.trim()
    : 'pending';
  return `claude:context-compaction:${sessionPart}:${Math.max(1, Math.trunc(params.sequence))}`;
}

function encodeIdentityPart(value: string): string {
  return encodeURIComponent(value.trim());
}

function readIdentityPart(label: string, value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return `${label}:${encodeIdentityPart(trimmed)}`;
}

export function buildClaudeCompactBoundaryEventIdentity(params: Readonly<{
  providerSessionId?: string | null;
  uuid?: string | null;
  timestamp?: string | null;
}>): string | null {
  const boundaryParts = [
    readIdentityPart('uuid', params.uuid),
    readIdentityPart('timestamp', params.timestamp),
  ].filter((part): part is string => typeof part === 'string');
  if (boundaryParts.length === 0) return null;
  const parts = [
    readIdentityPart('session', params.providerSessionId),
    ...boundaryParts,
  ].filter((part): part is string => typeof part === 'string');
  return `claude:context-compaction:boundary:${parts.join(':')}`;
}

export function buildClaudeCompactionStartedEvent(params: Readonly<{
  lifecycleId: string;
}>): SessionEventMessage {
  return {
    type: 'context-compaction',
    phase: 'started',
    provider: 'claude',
    source: 'user-command',
    trigger: 'manual',
    lifecycleId: params.lifecycleId,
  };
}

export function buildClaudeCompactionCompletedEvent(params: Readonly<{
  lifecycleId: string;
  source?: 'provider-event' | 'runtime';
  trigger?: 'manual' | 'auto' | 'threshold' | 'overflow' | 'unknown';
  providerEventId?: string;
  providerSessionId?: string;
  tokenCountBefore?: number;
  tokenCountSource?: string;
}>): SessionEventMessage {
  return {
    type: 'context-compaction',
    phase: 'completed',
    provider: 'claude',
    source: params.source ?? 'provider-event',
    trigger: params.trigger ?? 'manual',
    lifecycleId: params.lifecycleId,
    ...(params.providerEventId ? { providerEventId: params.providerEventId } : {}),
    ...(params.providerSessionId ? { providerSessionId: params.providerSessionId } : {}),
    ...(typeof params.tokenCountBefore === 'number' ? { tokenCountBefore: params.tokenCountBefore } : {}),
    ...(params.tokenCountSource ? { tokenCountSource: params.tokenCountSource } : {}),
  };
}
