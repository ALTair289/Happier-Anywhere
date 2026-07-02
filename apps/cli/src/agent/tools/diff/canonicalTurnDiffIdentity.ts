import { createHash } from 'node:crypto';

import type { TurnChangeSet } from '@happier-dev/protocol';

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

function stableJsonStringify(value: JsonValue): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJsonStringify(item)).join(',')}]`;
  }
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJsonStringify(value[key] ?? null)}`)
    .join(',')}}`;
}

/**
 * Replaces potentially multi-megabyte file texts with `{length, sha256}` digests so the identity
 * hash never has to stable-stringify the full payload. Content sensitivity is preserved via the
 * per-text digest.
 */
function digestOptionalText(text: string | null | undefined): JsonValue {
  if (typeof text !== 'string') return null;
  return {
    length: text.length,
    sha256: createHash('sha256').update(text).digest('hex'),
  };
}

function normalizeFileEvidence(file: TurnChangeSet['files'][number]): JsonValue {
  return {
    binary: file.binary === true,
    changeKind: file.changeKind,
    confidence: file.confidence,
    description: file.description ?? null,
    filePath: file.filePath,
    newText: digestOptionalText(file.newText),
    oldText: digestOptionalText(file.oldText),
    previousFilePath: file.previousFilePath ?? null,
    provider: file.provider,
    providerMessageId: file.providerMessageId ?? null,
    providerTurnId: file.providerTurnId ?? null,
    source: file.source,
    unifiedDiff: digestOptionalText(file.unifiedDiff),
  };
}

export function resolveCanonicalTurnDiffCallId(turnChangeSet: TurnChangeSet): string {
  const payload: JsonValue = {
    files: turnChangeSet.files.map(normalizeFileEvidence),
    provider: turnChangeSet.provider,
    seqRange: {
      endSeqInclusive: turnChangeSet.seqRange.endSeqInclusive,
      startSeqInclusive: turnChangeSet.seqRange.startSeqInclusive,
    },
    sessionId: turnChangeSet.sessionId,
    status: turnChangeSet.status,
    turnId: turnChangeSet.turnId,
  };
  const digest = createHash('sha256')
    .update(stableJsonStringify(payload))
    .digest('hex')
    .slice(0, 32);
  return `turn-diff-${digest}`;
}

export function resolveCanonicalTurnDiffSyntheticMessageUuid(
  callId: string,
  role: 'assistant' | 'user',
): string {
  return `${callId}-${role}`;
}
