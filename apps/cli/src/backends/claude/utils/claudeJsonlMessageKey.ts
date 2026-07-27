import { randomUUID } from 'node:crypto';

import { RawJSONLinesSchema, type RawJSONLines } from '../types';
import { readNonBlankOpaqueIdentifier } from '@/utils/opaqueIdentifiers';

export const CLAUDE_JSONL_LOCAL_ID_PREFIX = 'claude-jsonl:';

/**
 * Committed Claude JSONL dedupe baseline (Lane N4). `keys` are the claude-jsonl message keys
 * already committed to the Happier transcript within the fetched window. `complete` is true when
 * the window covered the session's entire transcript history; otherwise `oldestCoveredAtMs` is
 * the server commit time of the oldest covered row — rows older than that cannot be proven
 * uncommitted and must not replay-as-new.
 */
export type CommittedClaudeJsonlMessageBaseline = Readonly<{
  keys: ReadonlySet<string>;
  complete: boolean;
  oldestCoveredAtMs: number | null;
}>;

function readClaudeJsonlRawId(body: RawJSONLines): string | null {
  if (body.type === 'summary') {
    return readNonBlankOpaqueIdentifier((body as Record<string, unknown>).leafUuid);
  }
  return readNonBlankOpaqueIdentifier((body as Record<string, unknown>).uuid);
}

export function buildClaudeJsonlMessageKey(body: RawJSONLines): string | null {
  const rawId = readClaudeJsonlRawId(body);
  if (!rawId) return null;
  const sidechainId = readNonBlankOpaqueIdentifier((body as Record<string, unknown>).sidechainId);
  return `${sidechainId ?? 'main'}:${body.type}:${rawId}`;
}

export function buildClaudeJsonlLocalId(body: RawJSONLines): string {
  const key = buildClaudeJsonlMessageKey(body);
  return key ? buildClaudeJsonlLocalIdFromMessageKey(key) : randomUUID();
}

export function buildClaudeJsonlLocalIdFromMessageKey(key: string): string {
  return `${CLAUDE_JSONL_LOCAL_ID_PREFIX}${key}`;
}

export function extractClaudeJsonlMessageKeyFromLocalId(localId: string | null | undefined): string | null {
  const exactLocalId = readNonBlankOpaqueIdentifier(localId);
  if (!exactLocalId?.startsWith(CLAUDE_JSONL_LOCAL_ID_PREFIX)) return null;
  const key = exactLocalId.slice(CLAUDE_JSONL_LOCAL_ID_PREFIX.length);
  return key.length > 0 ? key : null;
}

export function extractClaudeJsonlMessageKeyFromSessionContent(content: unknown): string | null {
  if (!content || typeof content !== 'object' || Array.isArray(content)) return null;
  const record = content as Record<string, unknown>;
  if (record.role !== 'agent') return null;
  const body = record.content;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const bodyRecord = body as Record<string, unknown>;
  if (bodyRecord.type !== 'output') return null;
  const parsed = RawJSONLinesSchema.safeParse(bodyRecord.data);
  return parsed.success ? buildClaudeJsonlMessageKey(parsed.data) : null;
}
