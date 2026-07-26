import { fetchAllSidechainMessages, type SessionMessageRow } from '../sessions';
import { decryptLegacyBase64 } from '../messageCrypto';
import { sleep } from '../timing';
import { normalizeDecodedTranscriptValue } from './normalizeDecodedTranscriptValue';

export function hasStringSubstring(value: unknown, needle: string): boolean {
  if (typeof value === 'string') return value.includes(needle);
  if (Array.isArray(value)) return value.some((v) => hasStringSubstring(v, needle));
  if (value && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).some((v) => hasStringSubstring(v, needle));
  }
  return false;
}

export type DecryptedSessionMessage = {
  role?: string;
  content?: any;
  meta?: Record<string, unknown>;
};

type DurableToolCallMultiplicity = {
  logicalKey: string;
  callId: string;
  namespace: string;
  rows: number;
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function durableToolCallNamespace(message: Record<string, unknown>, content: Record<string, unknown>): string {
  const meta = record(message.meta);
  const data = record(content.data);
  const sidechainId = typeof meta?.sidechainId === 'string'
    ? meta.sidechainId
    : typeof content.sidechainId === 'string'
      ? content.sidechainId
    : typeof data?.sidechainId === 'string'
      ? data.sidechainId
      : null;
  return sidechainId ? `sidechain:${sidechainId}` : 'main';
}

type DurableToolRow = {
  kind: 'call' | 'result';
  callId: string;
  namespace: string;
  logicalKey: string;
};

function readDurableToolRow(value: unknown): DurableToolRow | null {
  const message = record(value);
  const envelope = record(message?.content);
  if (!message || !envelope) return null;
  const content = envelope.type === 'acp' ? record(envelope.data) : envelope;
  if (!content) return null;
  const kind = content.type === 'tool-call'
    ? 'call'
    : content.type === 'tool-result' || content.type === 'tool-call-result'
      ? 'result'
      : null;
  if (!kind) return null;
  const callId = typeof content.callId === 'string'
    ? content.callId
    : typeof content.toolCallId === 'string'
      ? content.toolCallId
      : null;
  if (!callId) return null;
  const namespace = durableToolCallNamespace(message, content);
  return { kind, callId, namespace, logicalKey: `${namespace}\u0000${callId}` };
}

export function findDurableToolCallMultiplicities(messages: readonly unknown[]): DurableToolCallMultiplicity[] {
  const counts = new Map<string, DurableToolCallMultiplicity>();

  for (const value of messages) {
    const row = readDurableToolRow(value);
    if (!row || row.kind !== 'call') continue;
    const prior = counts.get(row.logicalKey);
    counts.set(row.logicalKey, {
      logicalKey: row.logicalKey,
      callId: row.callId,
      namespace: row.namespace,
      rows: (prior?.rows ?? 0) + 1,
    });
  }

  return [...counts.values()].filter((entry) => entry.rows > 1);
}

export function assertSingleDurableToolCallPerLogicalId(messages: readonly unknown[]): void {
  const duplicates = findDurableToolCallMultiplicities(messages);
  if (duplicates.length === 0) return;
  const detail = duplicates
    .sort((a, b) => a.logicalKey.localeCompare(b.logicalKey))
    .map((entry) => `logical tool call ${JSON.stringify(entry.callId)} has ${entry.rows} durable rows in ${entry.namespace}`)
    .join('; ');
  throw new Error(`Expected one durable tool-call row per logical id: ${detail}`);
}

export type DurableToolRowSummary = {
  rawCallRows: number;
  logicalCallIds: number;
  resultRows: number;
  uniqueResultIds: number;
  duplicateCallIds: string[];
  duplicateResultIds: string[];
  orphanResultIds: string[];
};

export function summarizeDurableToolRows(messages: readonly unknown[]): DurableToolRowSummary {
  const callCounts = new Map<string, number>();
  const resultCounts = new Map<string, number>();
  let rawCallRows = 0;
  let resultRows = 0;

  for (const value of messages) {
    const row = readDurableToolRow(value);
    if (!row) continue;
    const counts = row.kind === 'call' ? callCounts : resultCounts;
    counts.set(row.logicalKey, (counts.get(row.logicalKey) ?? 0) + 1);
    if (row.kind === 'call') rawCallRows += 1;
    else resultRows += 1;
  }

  const duplicateKeys = (counts: ReadonlyMap<string, number>) => [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([key]) => key)
    .sort();

  return {
    rawCallRows,
    logicalCallIds: callCounts.size,
    resultRows,
    uniqueResultIds: resultCounts.size,
    duplicateCallIds: duplicateKeys(callCounts),
    duplicateResultIds: duplicateKeys(resultCounts),
    orphanResultIds: [...resultCounts.keys()].filter((key) => !callCounts.has(key)).sort(),
  };
}

export function assertDurableToolCardinality(
  messages: readonly unknown[],
  expected: { calls: number; results: number },
): void {
  const summary = summarizeDurableToolRows(messages);
  if (summary.rawCallRows !== expected.calls) {
    throw new Error(`Expected durable tool cardinality: expected ${expected.calls} call rows, got ${summary.rawCallRows}`);
  }
  if (summary.resultRows !== expected.results) {
    throw new Error(`Expected durable tool cardinality: expected ${expected.results} result rows, got ${summary.resultRows}`);
  }
  if (summary.duplicateCallIds.length > 0) {
    throw new Error(`Expected durable tool cardinality: duplicate call ids ${summary.duplicateCallIds.join(', ')}`);
  }
  if (summary.duplicateResultIds.length > 0) {
    throw new Error(`Expected durable tool cardinality: duplicate result ids ${summary.duplicateResultIds.join(', ')}`);
  }
  if (summary.orphanResultIds.length > 0) {
    throw new Error(`Expected durable tool cardinality: orphan result ids ${summary.orphanResultIds.join(', ')}`);
  }
}

export function decryptSessionMessageLegacy(row: SessionMessageRow, secret: Uint8Array): DecryptedSessionMessage | null {
  const ciphertext = row?.content?.c;
  if (typeof ciphertext !== 'string' || ciphertext.length === 0) return null;
  const decoded = decryptLegacyBase64(ciphertext, secret);
  const normalized = normalizeDecodedTranscriptValue(decoded);
  if (!normalized || typeof normalized !== 'object') return null;
  return normalized as DecryptedSessionMessage;
}

export function isAcpSidechainMessage(msg: unknown, sidechainId: string): boolean {
  const normalized = normalizeDecodedTranscriptValue(msg);
  const content = normalized && typeof normalized === 'object' && !Array.isArray(normalized)
    ? (normalized as Record<string, unknown>).content
    : null;
  if (!content || typeof content !== 'object') return false;
  const contentRecord = content as Record<string, unknown>;
  if (contentRecord.type !== 'acp') return false;
  const data = contentRecord.data;
  if (!data || typeof data !== 'object') return false;
  return (data as Record<string, unknown>).sidechainId === sidechainId;
}

export async function waitForAcpSidechainMessages(params: {
  baseUrl: string;
  token: string;
  sessionId: string;
  secret: Uint8Array;
  sidechainId: string;
  timeoutMs: number;
}): Promise<{ rows: SessionMessageRow[]; messages: DecryptedSessionMessage[] }> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < params.timeoutMs) {
    const rows = await fetchAllSidechainMessages({
      baseUrl: params.baseUrl,
      token: params.token,
      sessionId: params.sessionId,
      sidechainId: params.sidechainId,
    });
    const messages = rows
      .map((row) => decryptSessionMessageLegacy(row, params.secret))
      .filter((m): m is DecryptedSessionMessage => Boolean(m))
      .filter((m) => isAcpSidechainMessage(m, params.sidechainId));
    if (messages.length > 0) return { rows, messages };
    await sleep(500);
  }
  const rows = await fetchAllSidechainMessages({
    baseUrl: params.baseUrl,
    token: params.token,
    sessionId: params.sessionId,
    sidechainId: params.sidechainId,
  });
  const messages = rows
    .map((row) => decryptSessionMessageLegacy(row, params.secret))
    .filter((m): m is DecryptedSessionMessage => Boolean(m))
    .filter((m) => isAcpSidechainMessage(m, params.sidechainId));
  return { rows, messages };
}
