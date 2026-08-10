import { readPendingLocalId, type DirectTranscriptRawMessageV1 } from '@happier-dev/protocol';

import type { CodexRolloutAction } from '../localControl/rolloutMapper';
import { projectCodexRolloutActions } from '../rollout/projectCodexRolloutActions';

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function readDirectUserMessageEvent(value: unknown): { text: string; clientId: string | null } | null {
  const envelope = asRecord(value);
  if (envelope?.type !== 'event_msg') return null;
  const payload = asRecord(envelope.payload);
  if (payload?.type !== 'user_message' || typeof payload.message !== 'string' || !payload.message.trim()) {
    return null;
  }
  return {
    text: payload.message,
    // Pending/client identities are opaque. Validate, but never normalize them.
    clientId: readPendingLocalId(payload.client_id),
  };
}

function isModelInputResponseItem(value: unknown): boolean {
  const envelope = asRecord(value);
  if (envelope?.type !== 'response_item') return false;
  const payload = asRecord(envelope.payload);
  return payload?.type === 'message' && payload.role === 'user';
}

function shouldFilterHarnessBlob(text: string): boolean {
  const t = text.trim();
  if (!t) return true;
  // Known harness/system blobs embedded as user content (replay sessions, agent harness, etc).
  const patterns = [
    '# AGENTS.md instructions',
    '<environment_context>',
    '<turn_aborted>',
    '<INSTRUCTIONS>',
    '<subagent_notification>',
    'You are GPT-',
    'Codex CLI is an open source project',
  ];
  return patterns.some((p) => t.includes(p));
}

function extractEnvelopeTimestampMs(value: unknown): number {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 0;
  const ts = typeof (value as any).timestamp === 'string' ? String((value as any).timestamp) : '';
  if (!ts.trim()) return 0;
  const ms = Date.parse(ts);
  return Number.isFinite(ms) && ms >= 0 ? Math.trunc(ms) : 0;
}

function stableOffsetId(prefix: string, offset: number, actionIndex: number): string {
  const padded = Math.max(0, Math.trunc(offset)).toString().padStart(12, '0');
  const idx = Math.max(0, Math.trunc(actionIndex)).toString().padStart(3, '0');
  return `${prefix}:${padded}:${idx}`;
}

export function mapCodexRolloutLineToDirectMessages(params: Readonly<{
  fileRelPath: string;
  lineStartOffsetBytes: number;
  lineValue: unknown;
  actions: ReadonlyArray<CodexRolloutAction>;
  sidechainId?: string | null;
  hasMatchingEventUserMessage?: boolean;
  localIdOverride?: string | null;
}>): DirectTranscriptRawMessageV1[] {
  const createdAtMs = extractEnvelopeTimestampMs(params.lineValue);
  const idPrefix = `codex:${params.fileRelPath}`;
  const directUserMessage = readDirectUserMessageEvent(params.lineValue);
  if (
    directUserMessage
    && !params.sidechainId
    && !shouldFilterHarnessBlob(directUserMessage.text)
  ) {
    const stableId = stableOffsetId(idPrefix, params.lineStartOffsetBytes, 0);
    return [{
      id: stableId,
      localId: params.localIdOverride ?? directUserMessage.clientId ?? stableId,
      createdAtMs,
      raw: {
        role: 'user',
        content: { type: 'text', text: directUserMessage.text },
      },
    }];
  }
  // Direct transcript rendering should include "debug-only" tool calls (e.g., Codex-internal read/write tools),
  // but must still filter harness/system blobs that Codex sometimes embeds as user messages.
  const projected = projectCodexRolloutActions(
    params.actions,
    { sidechainId: params.sidechainId ?? null },
  );

  const out: DirectTranscriptRawMessageV1[] = [];
  for (let i = 0; i < projected.length; i++) {
    const action = projected[i]!;
    const stableId = stableOffsetId(idPrefix, params.lineStartOffsetBytes, i);

    if (action.type === 'user-text') {
      if (params.hasMatchingEventUserMessage && isModelInputResponseItem(params.lineValue)) continue;
      if (shouldFilterHarnessBlob(action.text)) continue;
      out.push({
        id: stableId,
        localId: params.localIdOverride ?? stableId,
        createdAtMs,
        raw: {
          role: 'user',
          content: { type: 'text', text: action.text },
        },
      });
      continue;
    }

    if (action.type === 'assistant-text') {
      out.push({
        id: stableId,
        localId: stableId,
        createdAtMs,
        raw: {
          role: 'agent',
          content: {
            type: 'codex',
            data: {
              type: 'message',
              message: action.text,
              ...(action.sidechainId ? { sidechainId: action.sidechainId } : {}),
            },
          },
        },
      });
      continue;
    }

    if (action.type === 'context-compaction') {
      if (action.sidechainId) continue;
      out.push({
        id: stableId,
        localId: stableId,
        createdAtMs,
        raw: {
          role: 'agent',
          content: {
            type: 'event',
            id: stableId,
            data: {
              type: 'context-compaction',
              phase: action.phase,
              lifecycleId: action.lifecycleId,
              provider: 'codex',
              source: action.source,
              ...(action.providerEventId ? { providerEventId: action.providerEventId } : {}),
            },
          },
        },
      });
      continue;
    }

    if (action.type === 'tool-call') {
      out.push({
        id: stableId,
        localId: stableId,
        createdAtMs,
        raw: {
          role: 'agent',
          content: {
            type: 'codex',
            data: {
              type: 'tool-call',
              callId: action.callId,
              name: action.name,
              input: action.input,
              id: stableId,
              ...(action.sidechainId ? { sidechainId: action.sidechainId } : {}),
            },
          },
        },
      });
      continue;
    }

    if (action.type === 'tool-result') {
      out.push({
        id: stableId,
        localId: stableId,
        createdAtMs,
        raw: {
          role: 'agent',
          content: {
            type: 'codex',
            data: {
              type: 'tool-call-result',
              callId: action.callId,
              output: action.output,
              id: stableId,
              ...(action.sidechainId ? { sidechainId: action.sidechainId } : {}),
              ...(action.isError ? { isError: action.isError } : {}),
            },
          },
        },
      });
      continue;
    }
  }

  return out;
}
